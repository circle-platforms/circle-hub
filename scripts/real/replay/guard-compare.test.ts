import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capture, inspectBundle } from './bundle.ts';
import { compareReplay, validateGuardContext, type GuardCase, type GuardContextInput } from './compare.ts';
import { runReplay } from './run.ts';
import { assistant, call, fixture, parallelFixture, result, user, type FixtureSession } from './fixture.ts';
import { main } from '../replay-circle.ts';
import type { Bundle } from './types.ts';

const app = process.env.CIRCLE_HUB_REPLAY_CIRCLE_APP;
const installed = { skip: app === undefined ? '需要显式指定 CIRCLE_HUB_REPLAY_CIRCLE_APP 的已安装 Circle 1.17.0' : false, timeout: 120000 };
// A guard that refuses one command and has no opinion on the rest, like the recorded history of the parallel fixture.
const guard = "let raw='';for await(const c of process.stdin)raw+=c;const p=JSON.parse(raw);process.stdout.write(JSON.stringify(p.tool_input.command==='NEVER_EXECUTE_ME'?{decision:'deny',reason:'synthetic refusal'}:{}));";
const none = { decision: 'none' as const, reason: '' };

type Fixture = ReturnType<typeof fixture>;
/** Captures the fixture's session twice: plainly, then with the context `build` makes from the first bundle. */
function guarded(f: Fixture, session: string, build: (b: Bundle) => GuardContextInput, candidate?: string, name = 'guard') {
  capture({ home: f.home, session, app: f.app, out: join(f.dir, `${name}-plain`) });
  const context = build(inspectBundle(join(f.dir, `${name}-plain`)));
  writeFileSync(join(f.dir, `${name}-context.json`), JSON.stringify(context));
  const bundle = join(f.dir, `${name}-bundle`);
  capture({ home: f.home, session, app: f.app, out: bundle, guardContext: join(f.dir, `${name}-context.json`) });
  let file: string | undefined;
  if (candidate !== undefined) {
    file = join(f.dir, `${name}-candidate.mjs`);
    writeFileSync(file, candidate);
  }
  return { bundle, file };
}
/** One case per call of the bundle, in the shared set `g`; `change` adjusts a case or drops it. */
function parallelCases(b: Bundle, change: (c: GuardCase) => GuardCase | undefined = c => c): GuardCase[] {
  return [...b.pairs.values()].map(p => ({ session: p.session, call: p.call.id, input: { event: 'before_tool', tool_name: p.call.name, tool_input: p.call.args }, entry: 'guard.mjs', set: 'g', baseline: p.denied ? { decision: 'deny' as const, reason: p.denied.reason!, evidence: 'record' } : { ...none, evidence: 'log' }, provenance: 'scripted' as const })).map(change).filter((c): c is GuardCase => c !== undefined);
}
const withSet = (cases: GuardCase[], extra: Partial<GuardContextInput> = {}): GuardContextInput => ({ schema: 'circle-replay-guard-context@1', sets: { g: { 'guard.mjs': guard } }, cases, ...extra });

test('without a candidate the context\'s own guard is checked against the recorded decisions, through a shared file set', installed, async () => {
  const f = parallelFixture(app);
  try {
    const { bundle } = guarded(f, 's0', b => withSet(parallelCases(b)));
    const r = await compareReplay({ bundle, app: f.app, out: join(f.dir, 'baseline') });
    assert.equal(r.exit, 0, JSON.stringify(r));
    assert.deepEqual([r.mode, r.compared, r.attempted, r.matched, r.mismatched, r.unknown], ['baseline', 5, 5, 5, 0, 0]);
    assert.deepEqual(r.roles, { reference: { match: 5, mismatch: 0, unknown: 0 } });
    assert.deepEqual(r.evidence, { record: { match: 1, mismatch: 0, unknown: 0 }, log: { match: 4, mismatch: 0, unknown: 0 } });
    assert.equal(readFileSync(join(f.dir, 'baseline', 'calls.jsonl'), 'utf8').trim().split('\n').length, 5);
    const cli: string[] = [];
    assert.equal(await main(['compare', '--bundle', bundle, '--circle-app', f.app, '--out', join(f.dir, 'cli'), '--survey'], line => cli.push(line)), 0);
    assert.deepEqual(JSON.parse(cli.join('')).counts, { compared: 5, attempted: 5, matched: 5, mismatched: 0, unknown: 0 });
    assert.equal(JSON.parse(cli.join('')).mode, 'baseline');
  }
  finally {
    f.close();
  }
});
test('a survey judges every call: matches, a mismatch and a call without context are counted apart', installed, async () => {
  const f = parallelFixture(app);
  try {
    // c1 is claimed to have been allowed outright (the guard gives no opinion), and the second child's task call has no case at all
    const { bundle } = guarded(f, 's0', b => withSet(parallelCases(b, c => c.call === 't2' ? undefined : c.call === 'c1' ? { ...c, baseline: { decision: 'allow', reason: '', evidence: 'log' } } : c)));
    const survey = await compareReplay({ bundle, app: f.app, out: join(f.dir, 'survey'), survey: true });
    assert.deepEqual([survey.exit, survey.status, survey.compared, survey.attempted, survey.matched, survey.mismatched, survey.unknown], [1, 'different', 4, 4, 3, 1, 1]);
    assert.equal((survey.firstDifference as { call: string }).call, 'c1');
    assert.deepEqual([(survey.firstUnknown as { cause: string }).cause, (survey.firstUnknown as { call: string }).call], ['no-context', 't2']);
    assert.equal(readFileSync(join(f.dir, 'survey', 'calls.jsonl'), 'utf8').trim().split('\n').length, 5);
    // without a survey the first call that cannot be judged ends the comparison
    const stopped = await compareReplay({ bundle, app: f.app, out: join(f.dir, 'stopped') });
    assert.deepEqual([stopped.exit, stopped.status, stopped.compared, stopped.attempted], [2, 'unavailable', 1, 1]);
  }
  finally {
    f.close();
  }
});
test('a case marked as not for the candidate keeps running its own files', installed, async () => {
  const f = parallelFixture(app);
  try {
    // The candidate gives no opinion on anything, so it would let the recorded denial through; that case belongs to another guard.
    const silent = 'process.stdout.write("{}");';
    const marked = guarded(f, 's0', b => withSet(parallelCases(b, c => c.call === 'bad' ? { ...c, candidate: false } : c)), silent, 'marked');
    const r = await compareReplay({ bundle: marked.bundle, app: f.app, guard: marked.file, out: join(f.dir, 'mixed'), survey: true });
    assert.equal(r.exit, 0, JSON.stringify(r));
    assert.deepEqual(r.roles, { candidate: { match: 4, mismatch: 0, unknown: 0 }, reference: { match: 1, mismatch: 0, unknown: 0 } });
    assert.equal(r.mode, 'candidate');
    const plain = guarded(f, 's0', b => withSet(parallelCases(b)), silent, 'plain');
    const all = await compareReplay({ bundle: plain.bundle, app: f.app, guard: plain.file, out: join(f.dir, 'all'), survey: true });
    assert.deepEqual([all.exit, all.mismatched, all.roles.candidate.mismatch], [1, 1, 1]);
  }
  finally {
    f.close();
  }
});
test('a difference found after the guard read outside its sandbox is not a mismatch, and a match after such a read is counted apart', installed, async () => {
  const f = parallelFixture(app);
  try {
    // Every call reads a path the context does not hold. c1 is claimed to have been allowed outright, which this guard does not say.
    const outside = "import fs from 'node:fs';let raw='';for await(const c of process.stdin)raw+=c;const p=JSON.parse(raw);try{fs.readFileSync('/etc/hosts','utf8')}catch{}process.stdout.write(JSON.stringify(p.tool_input.command==='NEVER_EXECUTE_ME'?{decision:'deny',reason:'synthetic refusal'}:{}));";
    const { bundle } = guarded(f, 's0', b => ({ schema: 'circle-replay-guard-context@1', sets: { g: { 'guard.mjs': outside } }, cases: parallelCases(b, c => c.call === 'c1' ? { ...c, baseline: { decision: 'allow', reason: '', evidence: 'log' } } : c) }));
    const r = await compareReplay({ bundle, app: f.app, out: join(f.dir, 'outside'), survey: true });
    assert.deepEqual([r.exit, r.matched, r.mismatched, r.unknown, r.matchedWithOutsideReads, r.compared], [2, 4, 0, 1, 4, 4]);
    assert.deepEqual([(r.firstUnknown as { cause: string }).cause, (r.firstUnknown as { call: string }).call], ['outside-read', 'c1']);
    assert.equal(r.firstDifference, undefined);
  }
  finally {
    f.close();
  }
});
test('the candidate can replace any file of the context, chosen when the comparison is started', installed, async () => {
  const f = parallelFixture(app);
  try {
    const entry = "import { decide } from './lib.mjs';let raw='';for await(const c of process.stdin)raw+=c;process.stdout.write(JSON.stringify(decide(JSON.parse(raw))));";
    const lib = "export const decide = p => p.tool_input.command === 'NEVER_EXECUTE_ME' ? { decision: 'deny', reason: 'synthetic refusal' } : {};";
    const { bundle, file } = guarded(f, 's0', b => ({ schema: 'circle-replay-guard-context@1', sets: { g: { 'guard.mjs': entry, 'lib.mjs': lib } }, cases: parallelCases(b) }), lib);
    const same = await compareReplay({ bundle, app: f.app, guard: file, replace: 'lib.mjs', out: join(f.dir, 'same') });
    assert.equal(same.exit, 0, JSON.stringify(same));
    assert.deepEqual(same.roles, { candidate: { match: 5, mismatch: 0, unknown: 0 } });
    const cli: string[] = [];
    assert.equal(await main(['compare', '--bundle', bundle, '--circle-app', f.app, '--candidate-guard', file!, '--replace', 'lib.mjs', '--out', join(f.dir, 'cli')], line => cli.push(line)), 0);
    // the same file replaces the entry when nothing is chosen: a library prints nothing, so it has no opinion and only the recorded refusal differs
    const asEntry = await compareReplay({ bundle, app: f.app, guard: file, out: join(f.dir, 'as-entry'), survey: true });
    assert.deepEqual([asEntry.exit, asEntry.matched, asEntry.mismatched], [1, 4, 1]);
    // a library that refuses everything differs on every call
    writeFileSync(file!, "export const decide = () => ({ decision: 'deny', reason: 'changed' });");
    const changed = await compareReplay({ bundle, app: f.app, guard: file, replace: 'lib.mjs', out: join(f.dir, 'changed'), survey: true });
    assert.deepEqual([changed.exit, changed.mismatched, changed.matched], [1, 5, 0]);
    // a name that is no file of the context is refused before anything runs; a replacement needs a candidate
    const missing = await compareReplay({ bundle, app: f.app, guard: file, replace: 'nowhere.mjs', out: join(f.dir, 'missing') });
    assert.deepEqual([missing.exit, missing.attempted], [1, 0]);
    const orphan = await compareReplay({ bundle, app: f.app, replace: 'lib.mjs', out: join(f.dir, 'orphan') });
    assert.deepEqual([orphan.exit, orphan.attempted], [1, 0]);
  }
  finally {
    f.close();
  }
});
test('arguments in a context are the recorded ones, or those with declared variables applied, and nothing else', installed, async () => {
  const sessions = (): FixtureSession[] => [{ id: 'root', messages: [user('u', 'synthetic'), assistant('a', '', [call('x', 'execute', { command: 'echo %HUB_URL% %OTHER%' })]), result('r', 'execute', 'x', 'synthetic output'), assistant('done', 'done')] }];
  const contextFor = (command: string) => (): GuardContextInput => ({ schema: 'circle-replay-guard-context@1', variables: { HUB_URL: 'http://192.0.2.7:7420' }, sets: { g: { 'guard.mjs': guard } }, cases: [{ session: 'root', call: 'x', input: { event: 'before_tool', session_id: 'root', tool_name: 'execute', tool_input: { command }, cwd: '/recorded/work' }, entry: 'guard.mjs', set: 'g', baseline: none, provenance: 'operator' }] });
  const f = fixture(app, sessions());
  try {
    const { bundle } = guarded(f, 'root', contextFor('echo http://192.0.2.7:7420 %OTHER%'));
    const ok = await compareReplay({ bundle, app: f.app, out: join(f.dir, 'ok') });
    assert.equal(ok.exit, 0, JSON.stringify(ok));
    for (const [name, command] of [['rewritten', 'echo rewritten'], ['an undeclared variable expanded', 'echo http://192.0.2.7:7420 secret-value']] as const) {
      const other = guarded(f, 'root', contextFor(command), undefined, name.replace(/ /g, '-'));
      const refused = await compareReplay({ bundle: other.bundle, app: f.app, out: join(f.dir, `refused-${name.replace(/ /g, '-')}`) });
      assert.equal(refused.exit, 1, name);
      assert.match(JSON.stringify(refused.firstDifference), /守卫上下文改变了模型工具参数/);
    }
  }
  finally {
    f.close();
  }
});
test('with a mirror the guard sees every recorded path at a private prefix of equal length and its messages come back in recorded form', installed, async () => {
  const base = realpathSync(tmpdir());
  const from = '/' + 'q'.repeat(base.length + 12);
  const f = fixture(app, [{ id: 'root', messages: [user('u', 'synthetic'), assistant('a', '', [call('x', 'execute', { command: `ls ${from}/data` })]), result('r', 'execute', 'x', 'synthetic output'), assistant('done', 'done')] }]);
  try {
    // the guard says where it is and what it was asked, in its own words
    const echo = "let raw='';for await(const c of process.stdin)raw+=c;const i=JSON.parse(raw);process.stdout.write(JSON.stringify({decision:'allow',reason:i.cwd+'|'+i.tool_input.command+'|'+process.cwd()}));";
    const { bundle } = guarded(f, 'root', () => ({
      schema: 'circle-replay-guard-context@1', mirror: from, sets: { g: { 'home/guard.mjs': echo } },
      cases: [{ session: 'root', call: 'x', input: { event: 'before_tool', session_id: 'root', tool_name: 'execute', tool_input: { command: `ls ${from}/data` }, cwd: `${from}/work` }, entry: 'home/guard.mjs', set: 'g', baseline: { decision: 'allow', reason: `${from}/work|ls ${from}/data|${from}/work` }, provenance: 'scripted' }],
    }));
    const r = await compareReplay({ bundle, app: f.app, out: join(f.dir, 'mirror'), mirrorBase: base });
    assert.equal(r.exit, 0, JSON.stringify(r));
    assert.equal(r.matched, 1);
    const seen = JSON.parse(readFileSync(join(f.dir, 'mirror', 'guard-0', 'input.json'), 'utf8'));
    assert.equal(seen.cwd.length, `${from}/work`.length);
    assert.ok(seen.cwd.startsWith(base + '/'));
    assert.ok(!JSON.stringify(seen).includes(from));
    // a base too long for the recorded prefix leaves no room for the private one: unavailable, never a comparison without the mirror
    const tooLong = await compareReplay({ bundle, app: f.app, out: join(f.dir, 'long'), mirrorBase: f.dir });
    assert.equal(tooLong.exit, 2);
  }
  finally {
    f.close();
  }
});
test('a call refused before any hook is not a recorded decision and is not judged', installed, async () => {
  const invalid = (name: string, detail: string) => `${name} was called with invalid arguments: ${detail}. Re-issue the call with arguments that satisfy the declared schema; no work was done.`;
  const f = fixture(app, [{ id: 'root', messages: [
    user('u', 'synthetic'),
    assistant('a', '', [call('r1', 'read_file', { path: 'a.txt' }), call('r2', 'mystery_tool', { x: 1 }), call('r3', 'execute', { command: 'synthetic' })]),
    result('o1', 'read_file', 'r1', invalid('read_file', "<root>.file_path: must have required property 'file_path'; <root>: must NOT have additional properties"), 'error'),
    result('o2', 'mystery_tool', 'r2', invalid('mystery_tool', "<root>.query: must have required property 'query'"), 'error'),
    result('o3', 'execute', 'r3', 'synthetic output'),
    assistant('done', 'done'),
  ] }]);
  try {
    const { bundle } = guarded(f, 'root', b => ({ schema: 'circle-replay-guard-context@1', sets: { g: { 'guard.mjs': guard } }, cases: [...b.pairs.values()].filter(p => p.call.id === 'r3').map(p => ({ session: 'root', call: 'r3', input: { event: 'before_tool', tool_name: 'execute', tool_input: p.call.args }, entry: 'guard.mjs', set: 'g', baseline: none, provenance: 'scripted' as const })) }));
    const run = await runReplay({ bundle, app: f.app, out: join(f.dir, 'run') });
    assert.equal(run.exit, 0, JSON.stringify(run));
    assert.equal((run.coverage.invocationOrder as unknown[]).length, 3);
    assert.deepEqual(run.coverage.hookOrder, [{ session: 'root', call: 'r3' }]);
    const r = await compareReplay({ bundle, app: f.app, out: join(f.dir, 'compare') });
    assert.equal(r.exit, 0, JSON.stringify(r));
    assert.deepEqual([r.compared, r.attempted, r.unknown], [1, 1, 0]);
  }
  finally {
    f.close();
  }
});
test('a context is refused when it gives both files and a set, a missing entry, a foreign session or changed arguments', () => {
  const f = parallelFixture(undefined);
  try {
    capture({ home: f.home, session: 's0', app: f.app, out: f.bundle });
    const b = inspectBundle(f.bundle);
    const good = withSet(parallelCases(b));
    validateGuardContext(good, b);
    const broken: [string, (c: GuardCase) => GuardCase][] = [
      ['files and set', c => ({ ...c, files: { 'guard.mjs': guard } })],
      ['unknown set', c => ({ ...c, set: 'nowhere' })],
      ['inherited entry name', c => ({ ...c, entry: 'constructor' })],
      ['replace target missing', c => ({ ...c, replace: 'other.mjs' })],
      ['another session', c => ({ ...c, input: { ...c.input, session_id: 'elsewhere' } })],
      ['changed arguments', c => ({ ...c, input: { ...c.input, tool_input: { command: 'something else' } } })],
      ['entry that leaves the sandbox', c => ({ ...c, entry: '../guard.mjs' })],
    ];
    for (const [name, change] of broken)
      assert.throws(() => validateGuardContext(withSet(parallelCases(b, c => c.call === 'bad' ? change(c) : c)), b), name);
    assert.throws(() => validateGuardContext({ ...good, sets: { g: { '../escape': 'x' } } }, b));
    assert.throws(() => validateGuardContext({ ...good, variables: { lowercase: 'x' } }, b));
    assert.throws(() => validateGuardContext({ ...good, mirror: 'relative' }, b));
  }
  finally {
    f.close();
  }
});
test('the inspect command says whether a bundle carries a guard context', async () => {
  const f = parallelFixture(undefined);
  try {
    capture({ home: f.home, session: 's0', app: f.app, out: f.bundle });
    const plain: string[] = [];
    assert.equal(await main(['inspect', '--bundle', f.bundle], line => plain.push(line)), 0);
    assert.equal(JSON.parse(plain.join('')).guardContext, false);
    const { bundle } = guarded(f, 's0', b => withSet(parallelCases(b)));
    const withContext: string[] = [];
    assert.equal(await main(['inspect', '--bundle', bundle], line => withContext.push(line)), 0);
    assert.equal(JSON.parse(withContext.join('')).guardContext, true);
  }
  finally {
    f.close();
  }
});

// ---- a candidate Circle 1.18 guard: spoken to in the fields of 1.18, heard as 1.18 hears a hook, in a folder of its own files
const HOOKS = 'home/hooks';
/** Cases whose guard sits in a folder under a home, as a guard of the real ops home does. */
function folderCases(b: Bundle, change: (c: GuardCase) => GuardCase | undefined = c => c): GuardCase[] {
  return parallelCases(b, c => change({ ...c, entry: `${HOOKS}/guard.mjs` })).filter((c): c is GuardCase => c !== undefined);
}
const folderContext = (cases: GuardCase[], extra: Partial<GuardContextInput> = {}): GuardContextInput => ({ schema: 'circle-replay-guard-context@1', sets: { g: { [`${HOOKS}/guard.mjs`]: guard, [`${HOOKS}/stale.txt`]: 'a file of the baseline guard', 'home/settings.json': '{"variables":{}}' } }, cases, ...extra });
const answer = (decision: 'allow' | 'deny' | 'ask', reason?: string) => `process.stdout.write(${JSON.stringify(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, ...(reason === undefined ? {} : { permissionDecisionReason: reason }) } }))});`;
/** A 1.18 guard that checks what it is told and denies, in its own words, what it finds wrong or the one command it refuses. */
const checking118 = `import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let raw = '';
for await (const c of process.stdin) raw += c;
const i = JSON.parse(raw);
const problems = [];
if (i.hook_event_name !== 'PreToolUse') problems.push('event');
if (i.session_id !== 's0') problems.push('session ' + i.session_id);
if (typeof i.tool_use_id !== 'string') problems.push('call id');
if (i.permission_mode !== 'bypassPermissions') problems.push('mode');
if (!Array.isArray(i.paths)) problems.push('paths');
if (i.event !== undefined || i.hook !== undefined || i.source !== undefined) problems.push('fields of the format before');
// the two calls made inside a subagent carry its own session as the agent's; the others carry no agent
const agent = { c1: 's1', c2: 's2' }[i.tool_use_id];
if (i.agent_id !== agent) problems.push('agent ' + i.agent_id);
if (agent && (i.agent_type !== 'general-purpose' || process.env.CIRCLE_AGENT_ID !== agent)) problems.push('agent type or environment');
if (!agent && (i.agent_type !== undefined || process.env.CIRCLE_AGENT_ID !== undefined)) problems.push('a root call with an agent');
if (process.env.CIRCLE_SESSION_ID !== 's0' || !process.env.CIRCLE_PROJECT_DIR) problems.push('environment');
const own = readdirSync(fileURLToPath(new URL('.', import.meta.url))).sort().join(',');
if (own !== 'guard.mjs') problems.push('folder ' + own);
const say = (reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
if (problems.length) say('wrong: ' + problems.join(', '));
else if (i.tool_input.command === 'NEVER_EXECUTE_ME') say('refused in other words');
else process.stdout.write('{}');
`;
test('a candidate Circle 1.18 guard is given PreToolUse fields, the agent of a subagent call and a folder of its own, and is compared by decision', installed, async () => {
  const f = parallelFixture(app);
  try {
    const { bundle } = guarded(f, 's0', b => folderContext(folderCases(b)));
    mkdirSync(join(f.dir, 'candidate'));
    writeFileSync(join(f.dir, 'candidate', 'guard.mjs'), checking118);
    const r = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'candidate'), protocol: '1.18', decisionOnly: true, out: join(f.dir, 'c118'), survey: true });
    assert.equal(r.exit, 0, JSON.stringify(r));
    assert.deepEqual([r.matched, r.mismatched, r.unknown, r.reasonChanged], [5, 0, 0, 1]);
    assert.deepEqual([r.candidate?.protocol, r.candidate?.form, r.candidate?.hook?.onFailure], ['1.18', 'folder', 'block']);
    assert.deepEqual(r.roles, { candidate: { match: 5, mismatch: 0, unknown: 0 } });
    const calls = readFileSync(join(f.dir, 'c118', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.deepEqual(calls.map((c: { expectedKind: string; actualKind: string }) => `${c.expectedKind}>${c.actualKind}`).sort(), ['deny>deny', 'go>go', 'go>go', 'go>go', 'go>go']);
    // by the words of the reason, the same guard differs on the refusal
    const exact = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'candidate'), protocol: '1.18', out: join(f.dir, 'c118-exact'), survey: true });
    assert.deepEqual([exact.exit, exact.mismatched], [1, 1]);
    assert.equal(r.legacyAnswers, undefined);
    // a guard that still answers in the format before is counted: Circle reads it, and says once that its format is old
    mkdirSync(join(f.dir, 'old-words'));
    writeFileSync(join(f.dir, 'old-words', 'guard.mjs'), "let raw='';for await(const c of process.stdin)raw+=c;const i=JSON.parse(raw);process.stdout.write(i.tool_input.command==='NEVER_EXECUTE_ME'?JSON.stringify({decision:'block',reason:'old words'}):'{}');");
    const oldWords = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'old-words'), protocol: '1.18', decisionOnly: true, out: join(f.dir, 'c118-old'), survey: true });
    assert.deepEqual([oldWords.exit, oldWords.matched, oldWords.legacyAnswers], [0, 5, 1]);
    // the seen input is the one of Circle 1.18 for a call in a subagent
    const seen = JSON.parse(readFileSync(join(f.dir, 'c118', `guard-${calls.find((c: { tool: string; session: string }) => c.tool === 'read_file').index}`, 'input.json'), 'utf8'));
    assert.deepEqual([seen.session_id, seen.agent_id, seen.agent_type, seen.hook_event_name, seen.tool_use_id], ['s0', 's1', 'general-purpose', 'PreToolUse', 'c1']);
  }
  finally {
    f.close();
  }
});
test('the tools of the hub get the names of Circle 1.18, and the cases marked for another guard get the candidate only when asked', installed, async () => {
  const f = fixture(app, [{ id: 'root', messages: [user('u', 'synthetic'), assistant('a', '', [call('x', 'hub_start_run', { pack: 'synthetic' }), call('y', 'execute', { command: 'ls' })]), result('o1', 'hub_start_run', 'x', 'synthetic result'), result('o2', 'execute', 'y', 'synthetic output'), assistant('done', 'done')] }]);
  try {
    // the candidate allows the hub's tool by its 1.18 name only, and refuses everything else it does not know
    const server = `let raw='';for await(const c of process.stdin)raw+=c;const i=JSON.parse(raw);process.stdout.write(i.tool_name==='mcp__hub__start_run'||i.tool_name==='execute'?'{}':JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'unknown tool '+i.tool_name}}));`;
    const { bundle } = guarded(f, 'root', b => ({ schema: 'circle-replay-guard-context@1', sets: { g: { [`${HOOKS}/guard.mjs`]: guard } }, cases: [...b.pairs.values()].map(p => ({ session: 'root', call: p.call.id, input: { event: 'before_tool', tool_name: p.call.name, tool_input: p.call.args }, entry: `${HOOKS}/guard.mjs`, set: 'g', ...(p.call.id === 'y' ? { candidate: false } : {}), baseline: none, provenance: 'scripted' as const })) }));
    mkdirSync(join(f.dir, 'server'));
    writeFileSync(join(f.dir, 'server', 'guard.mjs'), server);
    const named = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'server'), protocol: '1.18', decisionOnly: true, out: join(f.dir, 'named'), survey: true });
    assert.equal(named.exit, 0, JSON.stringify(named));
    assert.deepEqual(named.roles, { candidate: { match: 1, mismatch: 0, unknown: 0 }, reference: { match: 1, mismatch: 0, unknown: 0 } });
    const calls = readFileSync(join(f.dir, 'named', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(calls.find((c: { tool: string }) => c.tool === 'hub_start_run').candidateTool, 'mcp__hub__start_run');
    // another server key names no tool of this session: the 1.17.0 name reaches the candidate and is refused
    const other = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'server'), protocol: '1.18', mcpServer: 'other', decisionOnly: true, out: join(f.dir, 'other'), survey: true });
    assert.deepEqual([other.exit, other.mismatched], [1, 1]);
    // the call marked for another guard runs the candidate when all cases are asked for
    const everywhere = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'server'), protocol: '1.18', allCases: true, decisionOnly: true, out: join(f.dir, 'everywhere'), survey: true });
    assert.deepEqual(everywhere.roles, { candidate: { match: 2, mismatch: 0, unknown: 0 } });
  }
  finally {
    f.close();
  }
});
test('a failure of the candidate hook denies when its settings say so, and lets the call go ahead when they do not', installed, async () => {
  const f = parallelFixture(app);
  try {
    const { bundle } = guarded(f, 's0', b => folderContext(folderCases(b)));
    mkdirSync(join(f.dir, 'crash'));
    writeFileSync(join(f.dir, 'crash', 'guard.mjs'), "throw new Error('synthetic crash');");
    const settings = (onFailure?: string) => JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', name: 'synthetic guard', command: "node 'home/hooks/guard.mjs'", ...(onFailure ? { onFailure } : {}) }] }] } });
    writeFileSync(join(f.dir, 'blocks.json'), settings('block'));
    writeFileSync(join(f.dir, 'goes-on.json'), settings());
    const blocks = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'crash'), candidateSettings: join(f.dir, 'blocks.json'), protocol: '1.18', decisionOnly: true, out: join(f.dir, 'blocks'), survey: true });
    // every call is refused: the four that were let through differ, the refused one agrees
    assert.deepEqual([blocks.exit, blocks.mismatched, blocks.matched, blocks.failedHooks], [1, 4, 1, 5]);
    assert.deepEqual(blocks.candidate?.hook, { name: 'synthetic guard', onFailure: 'block', source: 'settings' });
    // carrying on lets every call through: only the recorded refusal differs
    const goesOn = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'crash'), candidateSettings: join(f.dir, 'goes-on.json'), protocol: '1.18', decisionOnly: true, out: join(f.dir, 'goes-on'), survey: true });
    assert.deepEqual([goesOn.exit, goesOn.mismatched, goesOn.matched, goesOn.failedHooks], [1, 1, 4, 5]);
    // the option says what the settings do not; it also overrides them
    const option = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'crash'), protocol: '1.18', onFailure: 'continue', decisionOnly: true, out: join(f.dir, 'option'), survey: true });
    assert.deepEqual([option.mismatched, option.candidate?.hook?.source], [1, 'option']);
  }
  finally {
    f.close();
  }
});
test('the settings of a candidate replace the settings beside its folder, with the recorded prefix written as the private one', installed, async () => {
  const base = realpathSync(tmpdir());
  const from = '/' + 'q'.repeat(base.length + 12);
  const f = fixture(app, [{ id: 'root', messages: [user('u', 'synthetic'), assistant('a', '', [call('x', 'execute', { command: 'ls' })]), result('r', 'execute', 'x', 'synthetic output'), assistant('done', 'done')] }]);
  try {
    // the guard has no opinion when the settings it reads name the folder it was started in, and refuses when they do not
    const reads = "import { readFileSync } from 'node:fs';let raw='';for await(const c of process.stdin)raw+=c;const i=JSON.parse(raw);const settings=JSON.parse(readFileSync(new URL('../settings.json', import.meta.url),'utf8'));process.stdout.write(settings.trusted_folders?.[0]===i.cwd?'{}':JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'settings say '+settings.trusted_folders?.[0]}}));";
    const { bundle } = guarded(f, 'root', () => ({ schema: 'circle-replay-guard-context@1', mirror: from, sets: { g: { [`${HOOKS}/guard.mjs`]: guard, 'home/settings.json': '{}' } }, cases: [{ session: 'root', call: 'x', input: { event: 'before_tool', session_id: 'root', tool_name: 'execute', tool_input: { command: 'ls' }, cwd: `${from}/work` }, entry: `${HOOKS}/guard.mjs`, set: 'g', baseline: none, provenance: 'scripted' }] }));
    mkdirSync(join(f.dir, 'reads'));
    writeFileSync(join(f.dir, 'reads', 'guard.mjs'), reads);
    writeFileSync(join(f.dir, 'settings.json'), JSON.stringify({ trusted_folders: [`${from}/work`] }));
    const ok = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'reads'), candidateSettings: join(f.dir, 'settings.json'), protocol: '1.18', decisionOnly: true, out: join(f.dir, 'with'), mirrorBase: base });
    assert.equal(ok.exit, 0, JSON.stringify(ok));
    const without = await compareReplay({ bundle, app: f.app, guard: join(f.dir, 'reads'), protocol: '1.18', decisionOnly: true, out: join(f.dir, 'without'), mirrorBase: base });
    assert.deepEqual([without.exit, without.mismatched], [1, 1]);
  }
  finally {
    f.close();
  }
});
test('options for a candidate that is not there, or do not fit it, are refused before anything runs', installed, async () => {
  const f = parallelFixture(app);
  try {
    const { bundle } = guarded(f, 's0', b => folderContext(folderCases(b)));
    mkdirSync(join(f.dir, 'folder'));
    writeFileSync(join(f.dir, 'folder', 'guard.mjs'), 'process.stdout.write("{}");');
    writeFileSync(join(f.dir, 'one.mjs'), 'process.stdout.write("{}");');
    const refused = async (name: string, options: Partial<Parameters<typeof compareReplay>[0]>) => {
      const r = await compareReplay({ bundle, app: f.app, out: join(f.dir, name), ...options });
      assert.deepEqual([r.exit, r.attempted], [1, 0], `${name}: ${JSON.stringify(r.firstDifference)}`);
    };
    await refused('protocol-alone', { protocol: '1.18' });
    await refused('entry-alone', { candidateEntry: 'guard.mjs' });
    await refused('settings-alone', { candidateSettings: join(f.dir, 'one.mjs') });
    await refused('unknown-protocol', { guard: join(f.dir, 'folder'), protocol: '2.0' as '1.18' });
    await refused('entry-of-a-file', { guard: join(f.dir, 'one.mjs'), candidateEntry: 'guard.mjs' });
    await refused('replace-of-a-folder', { guard: join(f.dir, 'folder'), replace: `${HOOKS}/guard.mjs` });
    await refused('no-entry-in-the-folder', { guard: join(f.dir, 'folder'), candidateEntry: 'missing.mjs' });
  }
  finally {
    f.close();
  }
});
test('the compare command takes several candidate paths and the options of a 1.18 candidate', installed, async () => {
  const f = parallelFixture(app);
  try {
    const { bundle } = guarded(f, 's0', b => folderContext(folderCases(b)));
    writeFileSync(join(f.dir, 'guard.mjs'), checking118);
    writeFileSync(join(f.dir, 'notes.txt'), 'a second file of the candidate folder');
    const lines: string[] = [];
    // the guard checks its folder holds only guard.mjs: the second file must show up and be refused by that check
    const code = await main(['compare', '--bundle', bundle, '--circle-app', f.app, '--candidate-guard', join(f.dir, 'guard.mjs'), '--candidate-guard', join(f.dir, 'notes.txt'), '--candidate-protocol', '1.18', '--mcp-server', 'hub', '--permission-mode', 'bypassPermissions', '--on-failure', 'block', '--decision-only', '--candidate-all-cases', '--survey', '--out', join(f.dir, 'cli')], line => lines.push(line));
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(lines.join('')).counts, { compared: 5, attempted: 5, matched: 1, mismatched: 4, unknown: 0 });
    const bad = await main(['compare', '--bundle', bundle, '--circle-app', f.app, '--candidate-protocol', '3', '--out', join(f.dir, 'cli-bad')], () => { });
    assert.equal(bad, 1);
    assert.equal(await main(['compare', '--bundle', bundle, '--circle-app', f.app, '--on-failure', 'sometimes', '--out', join(f.dir, 'cli-bad2')], () => { }), 1);
  }
  finally {
    f.close();
  }
});
