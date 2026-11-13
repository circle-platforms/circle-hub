import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { CODE_ROOT, createContext } from '../../platform/api.ts';
import { ensureLayout, layoutAt } from '../../platform/api.ts';
import { newSettingsFile, writeSettingsFile } from '../../platform/api.ts';
import type { CommandOptions } from '../../platform/api.ts';
import { launchReset, acknowledgeReset, readResetStatus, runResetWorker } from './worker.ts';
import type { ResetReport } from './types.ts';

const AUTH = 'admin:synthetic-user:action-one';
const request = { scopes: 'all', keepConfig: false } as const;
const report: ResetReport = { archive: 'synthetic_archive', backup: 'synthetic_backup', counts: [], notices: [] };
async function fixture(t: TestContext, platform: NodeJS.Platform = 'linux') {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-reset-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const layout = layoutAt(root);
  await ensureLayout(layout);
  await writeSettingsFile(layout, newSettingsFile({ environment: 'test' }));
  let clock = Date.parse('2026-11-13T00:00:00.000Z');
  const calls: Array<{ command: string; args: readonly string[]; options?: CommandOptions }> = [];
  const context = createContext({}, { layout, platform, home: root, user: 'synthetic', uid: 501,
    now: () => new Date(clock), runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: '', stderr: '' };
    } });
  return { root, context, calls, advance: () => { clock += 60_000; } };
}

test('Linux launch is a fixed independent unit with private files, authenticated status and idempotent POST/ACK', async t => {
  const f = await fixture(t);
  const { operationId: id } = await launchReset(f.context, request, AUTH);
  assert.deepEqual(await launchReset(f.context, request, AUTH), { operationId: id });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0]!;
  assert.equal(call.command, '/usr/bin/systemd-run');
  assert.ok(call.args.includes('--user'));
  assert.ok(call.args.includes('--collect'));
  assert.ok(call.args.includes('--property=StandardOutput=null'));
  assert.deepEqual(call.args.slice(-5), [process.execPath, join(CODE_ROOT, 'bin', 'circle-hub'), 'reset', '--worker', id]);
  assert.ok(call.args.includes(`--setenv=CIRCLE_HUB_DATA_DIR=${f.root}`));
  assert.equal(call.options?.env?.CIRCLE_HUB_DATA_DIR, undefined);
  assert.equal(call.options?.env?.XDG_RUNTIME_DIR, '/run/user/501');
  assert.equal((await stat(join(f.context.layout.run, 'reset'))).mode & 0o777, 0o700);
  for (const suffix of ['request.json', 'status.json']) assert.equal((await stat(join(f.context.layout.run, 'reset', `${id}.${suffix}`))).mode & 0o777, 0o600);
  await assert.rejects(readResetStatus(f.context, id, 'setup:other'), /无权/);
  await assert.rejects(acknowledgeReset(f.context, id, 'setup:other'), /无权/);
  await assert.rejects(launchReset(f.context, { scopes: ['history'], keepConfig: false }, AUTH), /已有初始化/);
  await acknowledgeReset(f.context, id, AUTH);
  await acknowledgeReset(f.context, id, AUTH);
  assert.equal(f.calls.length, 1);
  let runs = 0;
  assert.equal(await runResetWorker(f.context, id, async value => { runs++; assert.deepEqual(value, request); return report; }), 0);
  assert.equal(await runResetWorker(f.context, id, async () => { runs++; return report; }), 1);
  assert.equal(runs, 1);
  assert.deepEqual(await readResetStatus(f.context, id, AUTH), { operationId: id, acknowledged: true, running: false, completed: true, report });
  assert.deepEqual(await launchReset(f.context, request, AUTH), { operationId: id });
  const next = await launchReset(f.context, request, 'admin:synthetic-user:action-two');
  assert.notEqual(next.operationId, id);
  assert.equal(f.calls.length, 2);
});

test('macOS launches a separate one-shot launchd job and discards child output', async t => {
  const f = await fixture(t, 'darwin');
  const { operationId: id } = await launchReset(f.context, request, AUTH);
  assert.equal(f.calls[0]!.command, '/bin/launchctl');
  assert.deepEqual(f.calls[0]!.args.slice(0, 2), ['bootstrap', 'gui/501']);
  const plist = await readFile(join(f.context.layout.run, 'reset', `${id}.plist`), 'utf8');
  assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.ok(plist.includes(join(CODE_ROOT, 'bin', 'circle-hub')));
  assert.ok(plist.includes('/dev/null'));
  assert.ok(!plist.includes('<string>serve</string>'));
});

test('no ACK expires without invoking reset, and malformed requests never launch', async t => {
  const f = await fixture(t);
  await assert.rejects(launchReset(f.context, { ...request, scopes: ['all', 'history'] } as never, AUTH));
  assert.equal(f.calls.length, 0);
  const { operationId: id } = await launchReset(f.context, request, AUTH);
  f.advance();
  let runs = 0;
  assert.equal(await runResetWorker(f.context, id, async () => { runs++; return report; }), 1);
  assert.equal(runs, 0);
  const state = await readResetStatus(f.context, id, AUTH);
  assert.equal(state.completed, true);
  assert.equal(state.acknowledged, false);
  assert.match(state.error!.reason, /未执行/);
  await assert.rejects(readResetStatus(f.context, '../outside', AUTH), /编号/);
});

test('worker waits for ACK and keeps running while the reset callback is rolling back', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const { operationId: id } = await launchReset(f.context, request, AUTH);
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let rollbackDone!: () => void;
  const rollback = new Promise<void>(resolve => { rollbackDone = resolve; });
  let runs = 0;
  const worker = runResetWorker(f.context, id, async () => { runs++; started(); await rollback; throw new Error('synthetic secret must not escape'); });
  const claim = join(f.context.layout.run, 'reset', `${id}.claim`);
  while (!(await stat(claim).catch(() => null))) await delay(5);
  assert.equal(runs, 0);
  assert.equal((await readResetStatus(f.context, id, AUTH)).running, false);
  await acknowledgeReset(f.context, id, AUTH);
  await entered;
  assert.equal((await readResetStatus(f.context, id, AUTH)).running, true);
  assert.equal(await runResetWorker(f.context, id, async () => report), 1);
  rollbackDone();
  assert.equal(await worker, 1);
  const state = await readResetStatus(f.context, id, AUTH);
  assert.equal(state.running, false);
  assert.equal(state.completed, true);
  assert.equal(state.report, undefined);
  assert.ok(!JSON.stringify(state).includes('synthetic secret'));
});


test('a confirmed dead worker is finalized privately and a new authorized action can recover', async t => {
  const f = await fixture(t);
  const { operationId: id } = await launchReset(f.context, request, AUTH);
  await acknowledgeReset(f.context, id, AUTH);
  const directory = join(f.context.layout.run, 'reset');
  await writeFile(join(directory, `${id}.claim`), id, { mode: 0o600 });
  await writeFile(join(directory, `${id}.status.json`), JSON.stringify({ operationId: id, acknowledged: true, running: true, completed: false, workerPid: 12345 }), { mode: 0o600 });
  t.mock.method(process, 'kill', (pid: number, signal?: NodeJS.Signals | number) => {
    assert.equal(pid, 12345); assert.equal(signal, 0);
    throw Object.assign(new Error('synthetic dead process'), { code: 'ESRCH' });
  });
  const state = await readResetStatus(f.context, id, AUTH);
  assert.equal(state.completed, true);
  assert.equal(state.running, false);
  assert.match(state.error!.nextAction, /恢复/);
  assert.equal('workerPid' in state, false);
  let executed = false;
  assert.equal(await runResetWorker(f.context, id, async () => { executed = true; return report; }), 1);
  assert.equal(executed, false);
  const next = await launchReset(f.context, request, 'admin:synthetic-user:recovery-action');
  assert.notEqual(next.operationId, id);
});

test('EPERM does not declare a worker dead and a lost launch without a PID expires', async t => {
  const f = await fixture(t);
  const { operationId: id } = await launchReset(f.context, request, AUTH);
  const path = join(f.context.layout.run, 'reset', `${id}.status.json`);
  await writeFile(path, JSON.stringify({ operationId: id, acknowledged: true, running: true, completed: false, workerPid: 12345 }), { mode: 0o600 });
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('synthetic inaccessible process'), { code: 'EPERM' }); });
  const active = await readResetStatus(f.context, id, AUTH);
  assert.equal(active.running, true); assert.equal(active.completed, false);
  assert.equal('workerPid' in active, false);
  await assert.rejects(launchReset(f.context, request, 'admin:synthetic-user:new-action'), /已有初始化/);
  await writeFile(path, JSON.stringify({ operationId: id, acknowledged: false, running: false, completed: false }), { mode: 0o600 });
  f.advance();
  const lost = await readResetStatus(f.context, id, AUTH);
  assert.equal(lost.completed, true); assert.equal(lost.running, false);
  assert.match(lost.error!.reason, /未执行/);
  assert.notEqual((await launchReset(f.context, request, 'admin:synthetic-user:new-action')).operationId, id);
});
