import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
