import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommandArgv, commandParameterShape, parseCommandParameters } from './command-parameters.ts';
import { createCommandBridge } from './command-bridge.ts';
import { packCommand } from './cli-pack.ts';
import { leaseCommand } from './cli-admin.ts';
import { bedCommand, type JobCommandSession } from './cli-job.ts';
import type { Session } from './cli-session.ts';
import type { Principal } from '../records/api.ts';
import { UsageError } from './errors.ts';
import { COMMAND_METADATA } from './command-registry.ts';
import { commandStep } from '../telemetry/api.ts';

const reason = '合成维护理由';
const cases = [
  ['pack.activate', { pack: 'synthetic-product' }, ['pack', 'activate', 'synthetic-product']],
  ['pack.deactivate', { pack: 'synthetic-product' }, ['pack', 'deactivate', 'synthetic-product']],
  ['pack.retire', { pack: 'synthetic-workflow@1.0.0' }, ['pack', 'retire', 'synthetic-workflow@1.0.0']],
  ['lease.register', { prefix: 'synthetic/environment/', owner: '合成成员', reason }, ['lease', 'register', 'synthetic/environment/', '--owner=合成成员', '--reason=' + reason]],
  ['lease.unregister', { prefix: 'synthetic/environment/', reason }, ['lease', 'unregister', 'synthetic/environment/', '--reason=' + reason]],
  ['lease.release', { key: 'synthetic/environment/a', reason }, ['lease', 'release', 'synthetic/environment/a', '--reason=' + reason]],
  ['bed.baseline.record', { executor: 'synthetic-executor', probe: 'synthetic-probe' }, ['bed', 'baseline', 'record', 'synthetic-executor', '--probe=synthetic-probe']],
  ['bed.hold.clear', { executor: 'synthetic-executor', reason }, ['bed', 'hold', 'clear', 'synthetic-executor', '--reason=' + reason]],
] as const;
const admin: Principal = { id: 'usr_' + '0'.repeat(26), name: '合成管理员', role: 'admin' };

test('management parameter registrations map to existing CLI layouts and only authorized bridge groups', async () => {
  const seen: string[][] = [];
  const bridge = createCommandBridge({ env: {}, cwd: '/synthetic/commands', main: async argv => { seen.push([...argv]); return 0; } });
  for (const [id, values, expected] of cases) {
    const argv = buildCommandArgv(id, values);
    assert.deepEqual(argv, expected);
    const shape = commandParameterShape(id);
    parseCommandParameters(id, argv.slice(shape.path.length));
    assert.equal((await bridge.run(argv, { token: 'synthetic-token' })).code, 0, id);
  }
  assert.equal(seen.length, cases.length);
  for (const name of ['pack', 'bed', 'lease']) {
    assert.equal(COMMAND_METADATA.find(command => command.name === name)?.step, commandStep(name));
    assert.equal(COMMAND_METADATA.find(command => command.name === name)?.bridge, true);
  }
  for (const argv of [['job', 'dispatch', '--run=synthetic-run'], ['job', 'dispose', 'synthetic-job', '--mark-failed'], ['backup'], ['restore'], ['deploy'], ['rollback'], ['serve']]) assert.equal((await bridge.run(argv, { token: 'synthetic-token' })).code, 2);
  assert.equal(seen.length, cases.length, 'job and platform commands never reach CLI dispatch');
});

test('management forms require their existing reason, owner and probe inputs', () => {
  for (const [id, values] of [
    ['lease.register', { prefix: 'synthetic/environment/', owner: '合成成员' }],
    ['lease.register', { prefix: 'synthetic/environment/', reason }],
    ['lease.unregister', { prefix: 'synthetic/environment/' }],
    ['lease.release', { key: 'synthetic/environment/a' }],
    ['bed.baseline.record', { executor: 'synthetic-executor' }],
    ['bed.hold.clear', { executor: 'synthetic-executor' }],
  ] as const) assert.throws(() => buildCommandArgv(id, values), UsageError);
});

test('pack lifecycle forms retain existing registry handlers and administrator authority', async () => {
  const calls: unknown[][] = [];
  const session = { admin: async () => admin, out: () => {}, hub: async () => ({ registry: { activate: async (...args: unknown[]) => calls.push(['activate', ...args]), deactivate: async (...args: unknown[]) => calls.push(['deactivate', ...args]), retire: async (...args: unknown[]) => calls.push(['retire', ...args]) }, connectors: { refresh: () => calls.push(['refresh']) } }) };
  for (const [id, values] of cases.slice(0, 3)) assert.equal(await packCommand(session as unknown as Session, buildCommandArgv(id, values).slice(1)), 0);
  assert.deepEqual(calls, [['activate', admin, 'synthetic-product'], ['deactivate', admin, 'synthetic-product'], ['retire', admin, 'synthetic-workflow', '1.0.0'], ['refresh']]);
  session.admin = async () => { throw new Error('管理员已停用'); };
  await assert.rejects(packCommand(session as unknown as Session, ['activate', 'synthetic-product']), /管理员已停用/);
  assert.equal(calls.length, 4);
});

function leaseFixture() {
  const calls: unknown[][] = [];
  let active = false, probes = 0;
  const session = { viewer: async () => admin, user: async () => ({ id: 'synthetic-member', disabled: false }), out: () => {}, leases: async () => ({ register: async (input: unknown) => { calls.push(['register', input]); return { ok: true }; }, unregister: async (input: unknown) => { calls.push(['unregister', input]); return { ok: true }; }, forceRelease: async (input: { guard(): Promise<void> }) => { await input.guard(); calls.push(['release']); return { ok: true }; } }), hub: async () => ({ registry: { listPacks: async () => [{ kind: 'workflow', versions: [{ digest: 'a'.repeat(64) }] }] }, workflows: { byDigest: async () => ({ workflow: { leases: { prefix: 'synthetic/' } } }) }, dispatch: { activeLeaseJobs: async () => { probes++; return active ? [{ job: 'synthetic-job' }] : []; } } }) };
  return { session, calls, setActive: () => { active = true; }, probes: () => probes };
}

test('lease management forms preserve registration checks and both release guard checks', async () => {
  const f = leaseFixture();
  for (const [id, values] of cases.slice(3, 6)) assert.equal(await leaseCommand(f.session as unknown as Session, buildCommandArgv(id, values).slice(1)), 0);
  assert.deepEqual(f.calls[0], ['register', { prefix: 'synthetic/environment/', declaredPrefix: 'synthetic/', owner: 'synthetic-member', by: admin.id, admin: true, reason }]);
  assert.deepEqual(f.calls[1], ['unregister', { prefix: 'synthetic/environment/', by: admin.id, admin: true, reason }]);
  assert.deepEqual(f.calls[2], ['release']); assert.equal(f.probes(), 2);
  f.setActive();
  await assert.rejects(leaseCommand(f.session as unknown as Session, ['release', 'synthetic/environment/a', '--reason=' + reason]), /还没有终态/);
  assert.equal(f.calls.length, 3);
  f.session.viewer = async () => ({ ...admin, role: 'user' });
  await assert.rejects(leaseCommand(f.session as unknown as Session, ['unregister', 'synthetic/environment/', '--reason=' + reason]), /只有管理员/);
  assert.equal(f.calls.length, 3);
});

test('bed management forms keep original dispatch ownership and close the borrowed service', async () => {
  const calls: unknown[][] = []; let closed = 0;
  const session = { ctx: { io: { cwd: '/synthetic/commands' } }, options: {}, out: () => {}, err: () => {}, admin: async () => admin, hub: async () => ({ dispatch: { recordBaseline: async (...args: unknown[]) => { calls.push(['record', ...args]); return { executor: 'synthetic-executor', probe: 'synthetic-probe', sha256: 'a'.repeat(64), reference: 'src:' + 'a'.repeat(64) }; }, clearBedHold: async (...args: unknown[]) => { calls.push(['clear', ...args]); return { cleared: false }; }, close: async () => { closed++; } } }) };
  for (const [id, values] of cases.slice(6)) assert.equal(await bedCommand(session as unknown as JobCommandSession, buildCommandArgv(id, values).slice(1)), 0);
  assert.deepEqual(calls, [['record', admin, 'synthetic-executor', 'synthetic-probe', undefined], ['clear', admin, 'synthetic-executor', reason]]);
  assert.equal(closed, 2);
  session.admin = async () => { throw new Error('管理员已停用'); };
  await assert.rejects(bedCommand(session as unknown as JobCommandSession, ['hold', 'clear', 'synthetic-executor', '--reason=' + reason]), /管理员已停用/);
  assert.equal(calls.length, 2);
});
