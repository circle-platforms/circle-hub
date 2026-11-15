import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMirror, fromMirror, GuardSandbox, interpretGuardOutput, runGuard, safeName, toMirror, validGuardFile } from './guard.ts';
import { ReplayError } from './types.ts';

function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'circle-replay-guard-test-')));
  return { dir, evidence: () => { const d = mkdtempSync(join(dir, 'evidence-')); return d; }, close: () => rmSync(dir, { recursive: true, force: true }) };
}
/** A recorded prefix a little longer than the mirror base, so the private prefix has room for random characters. */
const prefixFor = (base: string) => '/' + 'p'.repeat(base.length + 12);

test('the mirror prefix has the length of the recorded one and maps whole directories only', () => {
  const s = scratch();
  try {
    const from = prefixFor(s.dir);
    const mirror = createMirror(from, s.dir);
    assert.equal(mirror.to.length, from.length);
    assert.ok(mirror.to.startsWith(s.dir + '/'));
    const input = { cwd: `${from}/work`, tool_input: { command: `cat '${from}/a b/c.txt' ${from}x ${from}` }, paths: [`${from}/a`, `/other${from}/a`, 'relative/path'] };
    const mapped = toMirror(input, mirror);
    assert.deepEqual(mapped, { cwd: `${mirror.to}/work`, tool_input: { command: `cat '${mirror.to}/a b/c.txt' ${from}x ${mirror.to}` }, paths: [`${mirror.to}/a`, `/other${from}/a`, 'relative/path'] });
    assert.equal(JSON.stringify(mapped).length, JSON.stringify(input).length);
    assert.equal(fromMirror(`refused ${mirror.to}/work and ${mirror.to}`, mirror), `refused ${from}/work and ${from}`);
  }
  finally {
    s.close();
  }
});
test('a recorded prefix without room for random characters, or with unplain characters, is refused', () => {
  const s = scratch();
  try {
    assert.throws(() => createMirror('/short', s.dir), (error: unknown) => error instanceof ReplayError && error.exit === 2);
    for (const bad of ['relative/path', '/with space/x', "/quote'd/prefix/for/the/mirror/directory/xxxxxxxx", '/dots/../x/for/the/mirror/directory/xxxxxxxxxxxxxxxxxxxx'])
      assert.throws(() => createMirror(bad, s.dir), (error: unknown) => error instanceof ReplayError);
  }
  finally {
    s.close();
  }
});
test('a sandbox holds text, base64 and replaced files, and refuses names that leave it', () => {
  for (const bad of ['', '/abs', '../up', 'a/../b', 'a//b', 'a\\b', './x'])
    assert.equal(safeName(bad), false, bad);
  assert.equal(safeName('dir/file name.txt'), true);
  assert.equal(validGuardFile({ base64: Buffer.from('x').toString('base64') }), true);
  assert.equal(validGuardFile({ base64: 'not base64!' }), false);
  assert.equal(validGuardFile({ base64: 'eA==', extra: 1 }), false);
  const sandbox = new GuardSandbox({ files: { 'a/text.txt': 'héllo', 'b.bin': { base64: Buffer.from([0, 255, 7]).toString('base64') }, 'entry.mjs': 'original' }, replace: { name: 'entry.mjs', bytes: Buffer.from('candidate') } });
  try {
    assert.equal(readFileSync(join(sandbox.root, 'a/text.txt'), 'utf8'), 'héllo');
    assert.deepEqual([...readFileSync(join(sandbox.root, 'b.bin'))], [0, 255, 7]);
    assert.equal(readFileSync(join(sandbox.root, 'entry.mjs'), 'utf8'), 'candidate');
    assert.equal(sandbox.input({ cwd: '/recorded/work', tool_name: 'x' }).cwd, join(sandbox.root, 'work'));
  }
  finally {
    sandbox.dispose();
  }
  assert.throws(() => new GuardSandbox({ files: { '../escape': 'x' } }), (error: unknown) => error instanceof ReplayError);
});
test('a gating hook is read the way Circle 1.17.0 reads it', () => {
  const cases: [number | null, string, string, ReturnType<typeof interpretGuardOutput>][] = [
    [0, '', '', { decision: 'none', reason: '', failed: false }],
    [0, '{}', 'a warning', { decision: 'none', reason: '', failed: false }],
    [0, '{"decision":"allow"}', '', { decision: 'allow', reason: '', failed: false }],
    [0, '{"decision":"deny","reason":"  no  "}', '', { decision: 'deny', reason: 'no', failed: false }],
    [0, '{"decision":"deny"}', '', { decision: 'deny', reason: 'hook denied', failed: false }],
    [0, '{"decision":"ask","reason":"sure?"}', '', { decision: 'ask', reason: 'sure?', failed: false }],
    [0, 'plain text', '', { decision: 'deny', reason: 'hook output is not JSON', failed: true }],
    [0, '["list"]', '', { decision: 'deny', reason: 'hook output is not JSON', failed: true }],
    [2, '', ' stop here \n', { decision: 'deny', reason: 'stop here', failed: false }],
    [2, '', '', { decision: 'deny', reason: 'hook denied', failed: false }],
    [1, '', 'crashed', { decision: 'deny', reason: 'crashed', failed: true }],
    [null, '', '', { decision: 'deny', reason: 'hook exited unknown', failed: true }],
  ];
  for (const [code, out, err, want] of cases)
    assert.deepEqual(interpretGuardOutput(code, out, err), want, JSON.stringify([code, out, err]));
});
async function run(source: string, files: Record<string, string> = {}, timeoutMs = 20000) {
  const s = scratch();
  const sandbox = new GuardSandbox({ files: { 'guard.mjs': source, ...files } });
  try {
    return await runGuard(sandbox, 'guard.mjs', sandbox.input({ event: 'before_tool', tool_name: 'x', tool_input: {} }), timeoutMs, s.evidence());
  }
  finally {
    sandbox.dispose();
    s.close();
  }
}
test('a guard process answers by its output, and a crash or unreadable output denies', async () => {
  assert.equal((await run("process.stdout.write('{}')")).decision, 'none');
  assert.deepEqual((await run("process.stdout.write(JSON.stringify({decision:'deny',reason:'synthetic'}))")).reason, 'synthetic');
  const exit2 = await run("process.stderr.write('by exit code');process.exitCode=2");
  assert.deepEqual([exit2.decision, exit2.reason, exit2.failed], ['deny', 'by exit code', false]);
  const crash = await run("throw new Error('synthetic crash')");
  assert.deepEqual([crash.decision, crash.failed], ['deny', true]);
  assert.deepEqual(await run("process.stdout.write('text')").then(r => [r.decision, r.failed]), ['deny', true]);
});
test('a guard process cannot start a process, write a file or reach the network, and the attempt is no decision', async () => {
  for (const [name, source, cause] of [
    ['write', "import fs from 'node:fs';fs.writeFileSync('x.txt','y');process.stdout.write('{}')", 'forbidden-operation'],
    ['child process', "import { execSync } from 'node:child_process';execSync('echo hi');process.stdout.write('{}')", 'forbidden-operation'],
    ['network', "await fetch('http://127.0.0.1:9');process.stdout.write('{}')", 'forbidden-operation'],
    ['limit', 'setInterval(() => {}, 1000)', 'timeout'],
  ] as const)
    await assert.rejects(run(source, {}, name === 'limit' ? 100 : 20000), (error: unknown) => error instanceof ReplayError && error.exit === 2 && error.detail.cause === cause, name);
});
test('a guard process sees no inherited secret and every read outside its sandbox is reported out of band', async () => {
  process.env.REPLAY_TEST_SECRET = 'synthetic-secret';
  try {
    const result = await run("import fs from 'node:fs';let seen='';try{fs.readFileSync('/etc/hosts','utf8')}catch(e){seen=e.code}try{fs.realpathSync.native('/opt/nobody-here/x')}catch{}process.stdout.write(JSON.stringify(process.env.REPLAY_TEST_SECRET?{decision:'deny',reason:'leak'}:{reason:seen}))");
    assert.equal(result.decision, 'none');
    assert.deepEqual(result.outsideReads, ['/etc/hosts', '/opt/nobody-here/x']);
  }
  finally {
    delete process.env.REPLAY_TEST_SECRET;
  }
  const quiet = await run("process.stdout.write('{}')");
  assert.deepEqual(quiet.outsideReads, []);
});
test('with a mirror the guard sees the recorded prefix at a private one of equal length and the work folder inside it', async () => {
  const s = scratch();
  try {
    const from = prefixFor(s.dir);
    const source = "let raw='';for await(const c of process.stdin)raw+=c;const i=JSON.parse(raw);process.stdout.write(JSON.stringify({decision:'allow',reason:`${i.cwd}|${i.tool_input.command}|${process.cwd()}|${import.meta.url.length}`}))";
    const sandbox = new GuardSandbox({ files: { 'home/guard.mjs': source }, mirror: { from, base: s.dir } });
    try {
      assert.equal(sandbox.root.length, from.length);
      const input = sandbox.input({ event: 'before_tool', tool_name: 'execute', tool_input: { command: `ls ${from}/work/a` }, cwd: `${from}/work` });
      assert.equal(input.cwd, `${sandbox.root}/work`);
      const run1 = await runGuard(sandbox, 'home/guard.mjs', input, 20000, s.evidence());
      const [cwd, command, processCwd] = fromMirror(run1.reason, sandbox.mirror!).split('|');
      assert.deepEqual([cwd, command], [`${from}/work`, `ls ${from}/work/a`]);
      assert.equal(processCwd, `${from}/work`);
      assert.doesNotMatch(run1.reason, new RegExp(from));
    }
    finally {
      sandbox.dispose();
    }
    // a recorded working folder outside the mirrored prefix cannot exist in the sandbox: the guard gets the sandbox's own work folder
    const other = new GuardSandbox({ files: { 'guard.mjs': 'x' }, mirror: { from, base: s.dir } });
    try {
      assert.equal(other.input({ cwd: '/elsewhere/work' }).cwd, join(other.root, 'work'));
    }
    finally {
      other.dispose();
    }
  }
  finally {
    s.close();
  }
});
test('the sandbox keeps the evidence of an attempt', async () => {
  const s = scratch();
  const sandbox = new GuardSandbox({ files: { 'guard.mjs': "process.stdout.write('{}')" } });
  try {
    const evidence = s.evidence();
    await runGuard(sandbox, 'guard.mjs', sandbox.input({ tool_name: 'x' }), 20000, evidence);
    assert.equal(readFileSync(join(evidence, 'stdout.txt'), 'utf8'), '{}');
    assert.equal(JSON.parse(readFileSync(join(evidence, 'input.json'), 'utf8')).tool_name, 'x');
    assert.equal(JSON.parse(readFileSync(join(evidence, 'receipt.json'), 'utf8')).exitCode, 0);
  }
  finally {
    sandbox.dispose();
    s.close();
  }
});
