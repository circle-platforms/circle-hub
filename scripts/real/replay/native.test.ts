import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { capture, inspectBundle } from './bundle.ts';
import { runReplay } from './run.ts';
import { compareReplay, type GuardContextInput } from './compare.ts';
import { assistant, call, fixture, parallelFixture, result, user } from './fixture.ts';
const app = process.env.CIRCLE_HUB_REPLAY_CIRCLE_APP;
const installed = { skip: app === undefined ? '需要显式指定 CIRCLE_HUB_REPLAY_CIRCLE_APP 的已安装 Circle 1.17.0' : false, timeout: 120000 };
test('installed Harness replays concurrent children, errors, hooks and host messages without executing commands', installed, async () => {
  const f = parallelFixture(app);
  try {
    capture({ home: f.home, session: 's0', app: f.app, out: f.bundle });
    const before = readFileSync(join(f.home, 'circle.sqlite'));
    const one = await runReplay({ bundle: f.bundle, app: f.app, out: join(f.dir, 'one') });
    assert.equal(one.exit, 0, JSON.stringify(one));
    const two = await runReplay({ bundle: f.bundle, app: f.app, out: join(f.dir, 'two') });
    assert.equal(two.exit, 0, JSON.stringify(two));
    assert.equal(one.semanticSha256, two.semanticSha256);
    assert.equal(one.actual!.sessions, 3);
    assert.equal(one.actual!.denials, 1);
    assert.equal(one.actual!.calls, 5);
    assert.equal(one.actual!.errors, 2);
    assert.deepEqual(before, readFileSync(join(f.home, 'circle.sqlite')));
  }
  finally {
    f.close();
  }
});
test('context projections remap tool result identities and remove recorded thinking', installed, async () => {
  const thinking = assistant('a1', '', [call('t1', 'read_file', { file_path: 'a.txt' })]);
  thinking.thinking = 'synthetic historical thought';
  const f = fixture(app, [{ id: 'root', messages: [user('u', 'synthetic'), thinking, result('r1', 'read_file', 't1', 'synthetic old output'), assistant('a2', 'done')], contexts: [{ at: 2, state: { prunedIds: ['r1'], stripThinkingIds: ['a1'], offloaded: {} } }] }]);
  try {
    capture({ home: f.home, session: 'root', app: f.app, out: f.bundle });
    const r = await runReplay({ bundle: f.bundle, app: f.app, out: join(f.dir, 'out') });
    assert.equal(r.exit, 0, JSON.stringify(r));
    assert.equal(r.actual!.messages, 4);
  }
  finally {
    f.close();
  }
});
test('background completion follows its start and can resume a stopped turn', installed, async () => {
  const notice = { id: 'jnotice', role: 'user' as const, internal: 'job_notice', display: '◆ j1 done · synthetic · 1s', content: '<system-reminder data-source="circle-jobs">\nj1 · shell · done, exit 0 · 1s · synthetic · output /background_jobs/synthetic/j1.log\nLast output:\nsynthetic\n\nThis is a background-job notice.\n</system-reminder>' };
  const f = fixture(app, [{ id: 'root', messages: [user('u', 'synthetic'), assistant('a', '', [call('j', 'execute', { command: 'NEVER_EXECUTE', background: true })]), result('r', 'execute', 'j', 'In background: j1 · shell · running · 0s · synthetic · output /background_jobs/synthetic/j1.log. A notice will arrive when it ends; do not poll or sleep.'), assistant('wait', 'waiting'), notice, assistant('done', 'done')] }]);
  try {
    capture({ home: f.home, session: 'root', app: f.app, out: f.bundle });
    const r = await runReplay({ bundle: f.bundle, app: f.app, out: join(f.dir, 'out') });
    assert.equal(r.exit, 0, JSON.stringify(r));
    assert.equal(r.actual!.background, 1);
    assert.equal(r.actual!.responses, 3);
  }
  finally {
    f.close();
  }
});
async function comparison(guard: string) {
  const f = parallelFixture(app);
  capture({ home: f.home, session: 's0', app: f.app, out: f.bundle });
  const b = inspectBundle(f.bundle);
  const contexts: GuardContextInput = { schema: 'circle-replay-guard-context@1', cases: [...b.pairs.values()].map(p => ({ session: p.session, call: p.call.id, input: { event: 'before_tool', tool_name: p.call.name, tool_input: p.call.args }, entry: 'guard.mjs', files: { 'guard.mjs': '// source fixture' }, baseline: p.denied ? { decision: 'deny', reason: p.denied.reason! } : { decision: 'none', reason: '' }, provenance: 'scripted' })) };
  writeFileSync(join(f.dir, 'contexts.json'), JSON.stringify(contexts));
  const bundle = join(f.dir, 'guard-bundle');
  capture({ home: f.home, session: 's0', app: f.app, out: bundle, guardContext: join(f.dir, 'contexts.json') });
  const file = join(f.dir, 'candidate.mjs');
  writeFileSync(file, guard);
  return { f, bundle, file };
}
const baselineGuard = "let raw='';for await(const c of process.stdin)raw+=c;const p=JSON.parse(raw);process.stdout.write(JSON.stringify(p.tool_input.command==='NEVER_EXECUTE_ME'?{decision:'deny',reason:'synthetic refusal'}:{}));";
test('guard comparison matches recorded decisions and stops at the first changed denial', installed, async () => {
  const { f, bundle, file } = await comparison(baselineGuard);
  try {
    const ok = await compareReplay({ bundle, app: f.app, guard: file, out: join(f.dir, 'equal') });
    assert.equal(ok.exit, 0, JSON.stringify(ok));
    assert.equal(ok.compared, 5);
    writeFileSync(file, 'process.stdout.write("{}");');
    const changed = await compareReplay({ bundle, app: f.app, guard: file, out: join(f.dir, 'changed') });
    assert.equal(changed.exit, 1, JSON.stringify(changed));
    assert.equal(changed.status, 'different');
    assert.equal(changed.compared, 5);
    const missing = await compareReplay({ bundle: f.bundle, app: f.app, guard: file, out: join(f.dir, 'missing') });
    assert.equal(missing.exit, 2);
    assert.equal(missing.compared, 0);
  }
  finally {
    f.close();
  }
});
test('candidate guards cannot read an inherited secret or start a network request', installed, async () => {
  const { f, bundle, file } = await comparison("if(process.env.REPLAY_TEST_SECRET)throw Error('inherited');process.stdout.write('{}');");
  try {
    process.env.REPLAY_TEST_SECRET = 'synthetic-secret';
    const noLeak = await compareReplay({ bundle, app: f.app, guard: file, out: join(f.dir, 'env') });
    assert.equal(noLeak.exit, 1);
    assert.equal(noLeak.compared, 5);
    writeFileSync(file, "await fetch('http://127.0.0.1:9');");
    const network = await compareReplay({ bundle, app: f.app, guard: file, out: join(f.dir, 'network') });
    assert.equal(network.exit, 2);
    assert.equal(network.compared, 0);
  }
  finally {
    delete process.env.REPLAY_TEST_SECRET;
    f.close();
  }
});
test('guard comparison stops before checking later calls after an early difference', installed, async () => {
  const { f, bundle, file } = await comparison('process.stdout.write(JSON.stringify({decision:"deny",reason:"changed"}));');
  try {
    const changed = await compareReplay({ bundle, app: f.app, guard: file, out: join(f.dir, 'early') });
    assert.equal(changed.exit, 1);
    assert.equal(changed.compared, 1);
  }
  finally {
    f.close();
  }
});
test('an injected candidate timeout is unavailable, never a matching denial', installed, async () => {
  const { f, bundle, file } = await comparison('setInterval(()=>{},1000);');
  try {
    const stopped = await compareReplay({ bundle, app: f.app, guard: file, out: join(f.dir, 'timeout'), guardTimeoutMs: 50 });
    assert.equal(stopped.exit, 2);
    assert.equal(stopped.compared, 0);
  }
  finally {
    f.close();
  }
});
