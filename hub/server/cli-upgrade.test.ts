import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalBytes, sha256Hex, type EnvironmentUpgradePreview, type Principal } from '../records/api.ts';
import type { HubConfig } from '../config/index.ts';
import { upgradeCommand, type UpgradeCommandPorts } from './cli-upgrade.ts';

const actor: Principal = { id: 'usr_' + '0'.repeat(26), name: '合成责任管理员', role: 'admin' };
const token = 'SyntheticOperatorTokenMustNeverBePrinted42';
function fixture() {
  const calls: unknown[][] = [], output: string[] = [];
  const config = { database: { user: 'synthetic_runtime' } } as HubConfig;
  const payload = { snapshot: { boundary: 'synthetic-cutover', at: '2026-11-14T00:00:00.000Z' }, plan: { grants: [], canApply: true }, sourceRecords: [], responsibleUser: actor.id } as unknown as NonNullable<EnvironmentUpgradePreview['payload']>;
  const preview: EnvironmentUpgradePreview = { freshDatabase: false, alreadyCompleted: false, canApply: true, problems: [], payload, sha256: sha256Hex(canonicalBytes(payload)), minimumReaderLevel: 2, downgradeNotice: '不能直接降回旧版' };
  const session = { ctx: { io: { cwd: '/synthetic/upgrade' } }, config: () => config, operatorToken: async () => token as string | null, out: (line: string) => output.push(line), records: async () => { throw new Error('must not open pending records'); }, admin: async () => { throw new Error('must not pick an administrator'); } };
  const ports: UpgradeCommandPorts = {
    authenticate: async (input, authorization) => { calls.push(['authenticate', input, authorization]); return actor; },
    preview: async (input, by) => { calls.push(['preview', input, by]); return preview; },
    readPreview: async file => { calls.push(['file', file]); return preview; },
    apply: async (input, by, expected, runtime) => { calls.push(['apply', input, by, expected, runtime]); return { freshDatabase: false, alreadyCompleted: false, grants: 0, authorizationRecords: [] }; },
    compatibility: async input => { calls.push(['compatibility', input]); return { status: 'compatible', compatible: true, expected: [], applied: [], problems: [] }; },
  };
  return { session, ports, preview, calls, output, config };
}

test('upgrade preview uses the actual token through read-only authentication and never opens normal records', async () => {
  const f = fixture();
  assert.equal(await upgradeCommand(f.session, ['preview'], f.ports), 0);
  assert.deepEqual(f.calls, [['authenticate', f.config, 'Bearer ' + token], ['preview', f.config, actor]]);
  assert.doesNotMatch(f.output.join('\n'), /SyntheticOperatorToken|usr_|sourceRecords/);
  assert.ok(f.output.join('\n').includes(f.preview.sha256!));
});

test('an unavailable, invalid, non-admin or missing token never previews or applies', async () => {
  const f = fixture(); f.ports.authenticate = async () => null;
  await assert.rejects(upgradeCommand(f.session, ['preview'], f.ports));
  f.ports.authenticate = async () => ({ ...actor, role: 'user' });
  await assert.rejects(upgradeCommand(f.session, ['preview'], f.ports));
  f.ports.authenticate = async () => { throw new Error(token); };
  await assert.rejects(upgradeCommand(f.session, ['preview'], f.ports), error => error instanceof Error && !error.message.includes(token));
  f.session.operatorToken = async () => null;
  await assert.rejects(upgradeCommand(f.session, ['preview'], f.ports));
  assert.equal(f.calls.length, 0);
});

test('explicit JSON preview preserves the full cutover for a later command without a preview-file write', async () => {
  const f = fixture();
  await upgradeCommand(f.session, ['preview', '--json'], f.ports);
  assert.deepEqual(JSON.parse(f.output[0]), f.preview);
  assert.equal(f.calls.filter(call => call[0] === 'apply' || call[0] === 'file').length, 0);
});

test('upgrade apply uses explicit owner configuration, the original preview and actual runtime role', async () => {
  const f = fixture();
  assert.equal(await upgradeCommand(f.session, ['apply', '--preview=preview.json', '--expected-snapshot=' + f.preview.sha256, '--owner-role=synthetic_owner'], f.ports), 0);
  assert.equal(f.calls[0][0], 'authenticate'); assert.equal(f.calls[1][0], 'file');
  const apply = f.calls.find(call => call[0] === 'apply')!;
  assert.deepEqual(apply, ['apply', { database: { user: 'synthetic_owner' } }, actor, f.preview, 'synthetic_runtime']);
  assert.deepEqual(f.calls.at(-1), ['compatibility', f.config]);
  assert.equal(f.calls.filter(call => call[0] === 'preview').length, 0, 'apply cannot recompute a different preview timestamp');
});

test('modified or mismatched cutover snapshots never reach the owner writer', async () => {
  const f = fixture();
  await assert.rejects(upgradeCommand(f.session, ['apply', '--preview=preview.json', '--expected-snapshot=' + 'f'.repeat(64)], f.ports));
  f.preview.payload!.responsibleUser = 'other-admin';
  await assert.rejects(upgradeCommand(f.session, ['apply', '--preview=preview.json', '--expected-snapshot=' + f.preview.sha256], f.ports));
  assert.equal(f.calls.filter(call => call[0] === 'apply').length, 0);
});

test('compatibility failure after a completion receipt does not claim a complete runnable upgrade or advise reset', async () => {
  const f = fixture(); f.ports.compatibility = async () => ({ status: 'unavailable', compatible: null, expected: [], applied: null, problems: [] });
  await assert.rejects(upgradeCommand(f.session, ['apply', '--preview=preview.json', '--expected-snapshot=' + f.preview.sha256], f.ports), /已有完成回执/);
  assert.equal(f.calls.filter(call => call[0] === 'apply').length, 1);
  assert.ok(!f.output.some(line => line.includes('保权升级已完成')));
});

test('unknown arguments do not echo token-like values or use read-only identity fallbacks', async () => {
  const f = fixture();
  for (const argv of [['preview', '--as=' + actor.id], ['apply', '--preview=preview.json'], ['preview', '--password=' + token]]) await assert.rejects(upgradeCommand(f.session, argv, f.ports), error => error instanceof Error && !error.message.includes(token));
  assert.equal(f.calls.length, 0);
});

test('upgrade is registered with existing command telemetry and never exposed through the web management bridge', async () => {
  const { COMMAND_METADATA } = await import('./command-registry.ts');
  const { commandStep } = await import('../telemetry/api.ts');
  const { createCommandBridge } = await import('./command-bridge.ts');
  const registered = COMMAND_METADATA.find(command => command.name === 'upgrade');
  assert.ok(registered); assert.equal(registered.step, commandStep('upgrade')); assert.equal(registered.bridge, false);
  let invoked = false;
  const bridge = createCommandBridge({ env: {}, cwd: '/synthetic/upgrade', main: async () => { invoked = true; return 0; } });
  assert.equal((await bridge.run(['upgrade', 'apply', '--preview=preview.json', '--expected-snapshot=' + 'a'.repeat(64)], { token: 'synthetic-token' })).code, 2);
  assert.equal(invoked, false);
});

test('public CLI help lists the real upgrade command without opening records or selecting an administrator', async () => {
  const { main } = await import('./cli.ts');
  const output: string[] = [];
  const code = await main(['help'], { io: { env: {}, cwd: '/synthetic/upgrade', stdout: line => output.push(line), stderr: line => output.push(line) } });
  assert.equal(code, 0); assert.match(output.join('\n'), /upgrade.*preview/); assert.match(output.join('\n'), /--expected-snapshot/);
});

test('a lost owner-transaction response stays unknown and advises readonly receipt inspection without replaying writes', async () => {
  const f = fixture(); let attempts = 0;
  f.ports.apply = async () => { attempts++; throw new Error(token); };
  await assert.rejects(upgradeCommand(f.session, ['apply', '--preview=preview.json', '--expected-snapshot=' + f.preview.sha256], f.ports), error => error instanceof Error && error.message.includes('结果尚未确认') && !error.message.includes(token));
  assert.equal(attempts, 1); assert.equal(f.calls.filter(call => call[0] === 'compatibility').length, 0);
  assert.ok(!f.output.some(line => line.includes('升级已完成')));
});
