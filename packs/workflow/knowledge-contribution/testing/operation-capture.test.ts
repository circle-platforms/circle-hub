import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PathLike } from 'node:fs';
import fsPromises, { chmod, lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, join } from 'node:path';
import { SESSION, TOKEN, scratch, fakeHub, enable, execute, hook, hookInput, skill } from './operation-support.ts';
import { appendCapture, readEvents, withLock } from '../tools/operation-capture/lib/state.ts';
import { sessionDirectory } from '../tools/operation-capture/lib/common.ts';

test('the capture hook is silent and writes nothing while session sharing is disabled', async t => {
  const local = await scratch(t);
  const result = await hook(local, 'ORBIT synthetic status: ready\n');
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, '');
  assert.equal(result.err, '');
  assert.equal(await lstat(join(local.home, 'operation-capture')).catch(() => null), null);
});

test('an enabled hook redacts before storage and uploads complete bytes as client_captured without model output', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  const secret = ['Synth', '3tic!'].join('');
  const result = await hook(local, `ORBIT synthetic status: ready\npassword = "${secret}"\n`, { bed: 'bed-synthetic', device_id: 'device-synthetic' });
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, '');
  assert.equal(result.err, '');
  assert.equal(hub.uploads.size, 1);
  const [digest, upload] = [...hub.uploads.entries()][0]!;
  assert.equal(upload.provenance, 'client_captured');
  assert.equal(upload.bytes.toString('utf8'), 'ORBIT synthetic status: ready\npassword = ***\n');
  assert.ok(!upload.bytes.toString('utf8').includes(secret));
  const call = hub.requests.find(row => row.body.method === 'tools/call' && row.body.params.name === 'upload_file')!;
  assert.equal(call.headers['circle-session-id'], SESSION);
  assert.match(String(call.headers.traceparent), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  const events = await readEvents(dir, SESSION);
  assert.deepEqual(events.map(event => event.kind), ['capture', 'upload']);
  assert.equal(events[0].digest, events[1].previous);
  assert.equal(events[1].previous, events[0].digest);
  assert.equal(events[0].kind === 'capture' && events[0].output.sha256, digest);
  assert.equal(events[0].kind === 'capture' && events[0].redaction.status, 'redacted');
  assert.deepEqual(events[0].kind === 'capture' ? events[0].targets : null, { bed: 'bed-synthetic', device_id: 'device-synthetic' });
  assert.equal((await skill(local, ['verify', '--session', SESSION])).code, 0);
  const disabled = await skill(local, ['disable', '--session', SESSION]);
  assert.equal(disabled.code, 0, disabled.err);
  assert.equal((await hook(local, 'COMET synthetic status: closed\n')).code, 0);
  assert.equal(hub.uploads.size, 1);
  assert.equal((await readEvents(dir, SESSION)).length, 2);
});

test('an output that cannot be inspected completely is skipped whole and remains silent', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  const result = await hook(local, `ORBIT ${'\u0001'.repeat(30)}`);
  assert.equal(result.code, 0);
  assert.equal(result.out, '');
  assert.equal(result.err, '');
  assert.equal(hub.uploads.size, 0);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  assert.deepEqual(await readEvents(dir, SESSION), []);
  const errors = await readFile(join(dir, 'errors.jsonl'), 'utf8');
  assert.match(errors, /credential_scan_incomplete/);
  assert.ok(!errors.includes('ORBIT'));
});

test('token permissions are checked before sharing is enabled', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  await chmod(local.tokenFile, 0o644);
  const refused = await enable(local, hub.url);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /invalid_token_permissions/);
  assert.equal(await lstat(join(local.home, 'operation-capture')).catch(() => null), null);
  await chmod(local.tokenFile, 0o600);
  assert.equal((await enable(local, hub.url)).code, 0);
});

test('file edits and a broken predecessor hash are both refused by verification', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  const events = await readEvents(dir, SESSION);
  const capture = events[0];
  assert.ok(capture.kind === 'capture');
  const path = join(dir, capture.output.file);
  const original = await readFile(path);
  await writeFile(path, 'COMET changed bytes\n');
  const changed = await skill(local, ['verify', '--session', SESSION]);
  assert.equal(changed.code, 1);
  assert.match(changed.err, /capture_tampered/);
  await writeFile(path, original);
  const manifest = (await readFile(join(dir, 'manifest.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  manifest[1].previous = '0'.repeat(64);
  await writeFile(join(dir, 'manifest.jsonl'), `${manifest.map(row => JSON.stringify(row)).join('\n')}\n`);
  const broken = await skill(local, ['verify', '--session', SESSION]);
  assert.equal(broken.code, 1);
  assert.match(broken.err, /manifest_tampered|invalid_manifest/);
});

test('two concurrent hooks preserve one continuous chain and two independent uploads', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  const results = await Promise.all([
    hook(local, 'ORBIT synthetic status: ready\n', { target: 'bed-one' }),
    hook(local, 'COMET synthetic status: ready\n', { target: 'bed-two' }),
  ]);
  for (const result of results) {
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, '');
    assert.equal(result.err, '');
  }
  assert.equal(hub.uploads.size, 2);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  const events = await readEvents(dir, SESSION);
  assert.equal(events.length, 4);
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
  assert.deepEqual(events.map(event => event.kind), ['capture', 'upload', 'capture', 'upload']);
  for (let index = 1; index < events.length; index++) assert.equal(events[index].previous, events[index - 1].digest);
  const verified = await skill(local, ['verify', '--session', SESSION]);
  assert.equal(verified.code, 0, verified.err);
});

test('the configured Hub token is replaced literally before capture and never uploaded as source bytes', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  const result = await hook(local, `ORBIT synthetic token ${TOKEN}\n`);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, '');
  assert.equal(result.err, '');
  const upload = [...hub.uploads.values()][0]!;
  assert.equal(upload.bytes.toString('utf8'), 'ORBIT synthetic token %HUB_TOKEN%\n');
  assert.ok(!upload.bytes.toString('utf8').includes(TOKEN));
  assert.equal((await skill(local, ['verify', '--session', SESSION])).code, 0);
});

test('disable waits for in-flight capture work and every waiter rechecks sharing', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t, { delayUploadMs: 300 });
  assert.equal((await enable(local, hub.url)).code, 0);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  const order: string[] = [];
  const capturing = hook(local, 'ORBIT synthetic status: ready\n').then(result => { order.push('hook'); return result; });
  const deadline = Date.now() + 2000;
  while (!hub.requests.some(row => row.body.method === 'tools/call' && row.body.params.name === 'upload_file')) {
    assert.ok(Date.now() < deadline, 'the capture reaches the delayed upload');
    await delay(5);
  }
  const disabling = skill(local, ['disable', '--session', SESSION]).then(result => { order.push('disable'); return result; });
  await delay(50);
  assert.ok(!order.includes('disable'), 'disable must not return while an upload holds the session lock');
  const [captured, disabled] = await Promise.all([capturing, disabling]);
  assert.equal(captured.code, 0, captured.err);
  assert.equal(disabled.code, 0, disabled.err);
  const events = await readEvents(dir, SESSION);
  assert.deepEqual(events.map(event => event.kind), ['capture', 'upload']);
  const before = { events: events.length, uploads: hub.uploads.size };
  assert.equal((await hook(local, 'COMET synthetic status: closed\n')).code, 0);
  assert.equal((await readEvents(dir, SESSION)).length, before.events);
  assert.equal(hub.uploads.size, before.uploads);
});

test('a lock owned by a dead process is recovered without deleting capture evidence', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  await mkdir(join(dir, '.lock'), { recursive: true });
  await writeFile(join(dir, '.lock', 'owner.json'), `${JSON.stringify({ id: 'synthetic-stale', pid: 999999, at: '2026-01-01T00:00:00.000Z' })}\n`);
  const result = await hook(local, 'ORBIT synthetic status: ready\n');
  assert.equal(result.code, 0, result.err);
  assert.equal(hub.uploads.size, 1);
  assert.equal(await lstat(join(dir, '.lock')).catch(() => null), null);
  assert.equal((await readEvents(dir, SESSION)).length, 2);
});

test('a symbolic link at the outputs directory itself is refused by verification', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  await rename(join(dir, 'outputs'), join(dir, 'outputs-actual'));
  await symlink(join(dir, 'outputs-actual'), join(dir, 'outputs'), 'dir');
  const verified = await skill(local, ['verify', '--session', SESSION]);
  assert.equal(verified.code, 1);
  assert.match(verified.err, /invalid_state_directory/);
});

test('metadata is checked before an output can be orphaned by a failed manifest append', async t => {
  const local = await scratch(t);
  const dir = join(local.home, 'metadata-check');
  await assert.rejects(appendCapture(dir, {
    session: 'password=Syn3tic!',
    captured_at: new Date().toISOString(),
    tool: { name: 'execute', status: 'success' },
    input: { summary: '{}', sha256: '0'.repeat(64), truncated: false },
    targets: {},
    redaction: { scanner: 'credential-scan@2', status: 'unchanged', detectors: [] },
    bytes: Buffer.from('ORBIT synthetic status: ready\n'),
  }), (error: any) => error.code === 'metadata_credential');
  assert.equal(await lstat(join(dir, 'outputs')).catch(() => null), null);
});

test('whitespace and tilde forms of CIRCLE_HOME use the same install and state roots', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  const home = local.env.CIRCLE_HOME!;
  try {
    for (const [value, output] of [[` ${home} `, 'ORBIT synthetic status: ready\n'], ['~', 'COMET synthetic status: ready\n']] as const) {
      local.env.CIRCLE_HOME = value;
      const result = await hook(local, output);
      assert.equal(result.code, 0, result.err);
      assert.equal(result.out, '');
      assert.equal(result.err, '');
    }
  } finally { local.env.CIRCLE_HOME = home; }
  assert.equal(hub.uploads.size, 2);
  assert.equal((await skill(local, ['verify', '--session', SESSION])).code, 0);
});

test('invalid UTF-8 hook input is not decoded with replacement characters or captured', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  const raw = Buffer.from(JSON.stringify({ event: 'after_tool', session_id: SESSION, tool_name: 'execute', tool_input: {}, tool_output: 'ORBIT synthetic status: ready\n', tool_status: 'success' }));
  raw[10] = 0xff;
  const result = await hookInput(local, raw);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, '');
  assert.equal(result.err, '');
  assert.equal(hub.uploads.size, 0);
  assert.deepEqual(await readEvents(sessionDirectory(SESSION, { CIRCLE_HOME: local.home }), SESSION), []);
});

test('a token rotated between initialize and upload is rechecked before any upload request', async t => {
  const local = await scratch(t);
  const rotated = 'FictCaptureTokenRotated43';
  const hub = await fakeHub(t, { onRequest: async input => {
    if (input.method === 'initialize') await writeFile(local.tokenFile, `${rotated}\n`, { mode: 0o600 });
  } });
  assert.equal((await enable(local, hub.url)).code, 0);
  const result = await hook(local, `ORBIT synthetic token ${rotated}\n`);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out, '');
  assert.equal(result.err, '');
  assert.equal(hub.uploads.size, 0);
  assert.ok(!hub.attempts.some(row => row.body.method === 'tools/call' && row.body.params.name === 'upload_file'));
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  assert.deepEqual((await readEvents(dir, SESSION)).map(event => event.kind), ['capture']);
  assert.match(await readFile(join(dir, 'errors.jsonl'), 'utf8'), /credential_redaction_failed/);
});

test('two waiters recover one dead lock without losing mutual exclusion or the chain', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  await mkdir(join(dir, '.lock'), { recursive: true });
  await writeFile(join(dir, '.lock', 'owner.json'), `${JSON.stringify({ id: 'synthetic-stale', pid: 999999, at: '2026-01-01T00:00:00.000Z' })}\n`);
  const results = await Promise.all([
    hook(local, 'ORBIT synthetic status: ready\n', { target: 'bed-one' }),
    hook(local, 'COMET synthetic status: ready\n', { target: 'bed-two' }),
  ]);
  for (const result of results) assert.equal(result.code, 0, result.err);
  assert.equal(hub.uploads.size, 2);
  const events = await readEvents(dir, SESSION);
  assert.deepEqual(events.map(event => event.kind), ['capture', 'upload', 'capture', 'upload']);
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3, 4]);
  for (let index = 1; index < events.length; index++) assert.equal(events[index].previous, events[index - 1].digest);
  assert.equal((await skill(local, ['verify', '--session', SESSION])).code, 0);
});

test('recover preserves incomplete fragments without uploading them and later captures continue', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  assert.equal((await enable(local, hub.url)).code, 0);
  assert.equal((await hook(local, 'ORBIT synthetic status: ready\n')).code, 0);
  const dir = sessionDirectory(SESSION, { CIRCLE_HOME: local.home });
  const orphan = join(dir, 'outputs', 'unregistered.txt');
  await writeFile(orphan, 'ORBIT partial');
  const manifest = join(dir, 'manifest.jsonl');
  await writeFile(manifest, `${await readFile(manifest, 'utf8')}{"incomplete":`);
  const recovered = await skill(local, ['recover', '--session', SESSION]);
  assert.equal(recovered.code, 0, recovered.err);
  assert.match(recovered.out, /2 份未提交恢复件/);
  assert.equal(hub.uploads.size, 1);
  assert.equal(await lstat(orphan).catch(() => null), null);
  const parts = await readdir(join(dir, 'recovery'));
  const fragments = await Promise.all(parts.filter(name => name.endsWith('.part')).map(name => readFile(join(dir, 'recovery', name), 'utf8')));
  assert.deepEqual(new Set(fragments), new Set(['ORBIT partial', '{"incomplete":']));
  const verified = await skill(local, ['verify', '--session', SESSION]);
  assert.equal(verified.code, 0, verified.err);
  assert.match(verified.out, /2 份未提交恢复件/);
  const status = await skill(local, ['status', '--session', SESSION]);
  assert.equal(JSON.parse(status.out).recovered, 2);
  assert.equal((await hook(local, 'COMET synthetic status: ready\n')).code, 0);
  assert.equal(hub.uploads.size, 2);
});

test('a quarantined live owner releases by identity before another waiter can enter', async t => {
  const local = await scratch(t);
  const dir = join(local.home, 'session');
  await mkdir(dir, { recursive: true });
  const order: string[] = [];
  let release: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withLock(dir, async () => {
    order.push('first:start');
    await gate;
    order.push('first:end');
  });
  await delay(10);
  await rename(join(dir, '.lock', 'owner.json'), join(dir, '.lock', '.stale-deadbeef'));
  const second = withLock(dir, async () => { order.push('second'); });
  await delay(50);
  assert.deepEqual(order, ['first:start']);
  release!();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'first:end', 'second']);
  assert.equal(await lstat(join(dir, '.lock')).catch(() => null), null);
});

const DEAD_OWNER = `${JSON.stringify({ id: 'synthetic-stale', pid: 999999, at: '2026-01-01T00:00:00.000Z' })}\n`;

/** Enters the lock once while `name` of node:fs/promises is replaced, in state.ts's named imports too. */
async function enterWith<K extends 'lstat' | 'unlink'>(t: import('node:test').TestContext, name: K, replacement: (typeof fsPromises)[K], dir: string): Promise<void> {
  t.mock.method(fsPromises, name, replacement);
  syncBuiltinESMExports();
  try {
    let entered = false;
    await withLock(dir, async () => { entered = true; });
    assert.ok(entered);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(await lstat(join(dir, '.lock')).catch(() => null), null, 'the lock and every quarantined owner are gone');
}

test('a waiter whose quarantined owner another waiter quarantines in turn looks again instead of failing', async t => {
  const local = await scratch(t);
  const dir = join(local.home, 'session');
  await mkdir(join(dir, '.lock'), { recursive: true });
  await writeFile(join(dir, '.lock', 'owner.json'), DEAD_OWNER);
  const unlink = fsPromises.unlink;
  let taken = '';
  await enterWith(t, 'unlink', async (path: PathLike) => {
    // The other waiter read this quarantine as a stale owner and moved it to a quarantine of its own just before.
    if (taken === '' && basename(String(path)).startsWith('.stale-')) {
      taken = join(dirname(String(path)), `.stale-${randomUUID()}`);
      await rename(path, taken);
    }
    return unlink(path);
  }, dir);
  assert.notEqual(taken, '', 'the race happened');
});

test('a lock owner file that another waiter is removing reads as gone, not as an invalid owner', async t => {
  const local = await scratch(t);
  const dir = join(local.home, 'session');
  await mkdir(join(dir, '.lock'), { recursive: true });
  await writeFile(join(dir, '.lock', 'owner.json'), DEAD_OWNER);
  const real = fsPromises.lstat;
  let taken = '';
  await enterWith(t, 'lstat', (async (path: PathLike) => {
    const stats = await real(path);
    // The other waiter quarantines the owner while this one looks at it: at that moment the file has no links left.
    if (taken === '' && basename(String(path)) === 'owner.json') {
      taken = join(dirname(String(path)), `.stale-${randomUUID()}`);
      await rename(path, taken);
      stats.nlink = 0;
    }
    return stats;
  }) as typeof fsPromises.lstat, dir);
  assert.notEqual(taken, '', 'the race happened');
});

test('on Windows every command is refused and the hook captures nothing', async t => {
  const local = await scratch(t);
  const hub = await fakeHub(t);
  const windows = ['--import', 'data:text/javascript,Object.defineProperty(process,"platform",{value:"win32"})', local.entry];
  const enabled = await execute(process.execPath, [...windows, 'enable', '--session', SESSION, '--hub', hub.url, '--token-file', local.tokenFile], local.env, undefined, local.home);
  assert.equal(enabled.code, 1);
  assert.match(enabled.err, /Windows/);
  assert.equal((await enable(local, hub.url)).code, 0, 'sharing enabled on a supported platform');
  const input = JSON.stringify({ event: 'after_tool', session_id: SESSION, cwd: '/synthetic/workspace', hook: 'operation-capture', source: 'skill', source_label: 'operation-capture', tool_name: 'execute', tool_input: { command: 'orbit synthetic-status' }, paths: [], tool_output: 'ORBIT synthetic status: ready\n', tool_status: 'success' });
  const hooked = await execute(process.execPath, [...windows, 'hook'], local.env, input, local.home);
  assert.equal(hooked.code, 0);
  assert.equal(hooked.out + hooked.err, '');
  assert.equal(hub.uploads.size, 0, 'nothing captured or uploaded');
});
