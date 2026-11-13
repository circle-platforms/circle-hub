import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { MemberEnvironments } from '../../dispatch/api.ts';
import { definition } from '../../dispatch/testing/definition.ts';
import { writePack } from '../../runs/api.ts';
import { createTestHub } from '../testing-real.ts';
import { locatePack } from './test-packs.ts';

test('real assembly shares assigned environment access with member projection and preserves every occupied lease', { timeout: 60000 }, async t => {
  const hub = await createTestHub({ repositoryPacks: false, stubs: false, requireOsIsolation: false });
  t.after(() => hub.close());
  const alice = await hub.createUser('合成甲');
  const bob = await hub.createUser('合成乙');
  const admin = hub.admin.principal;
  const registry = hub.hub.dispatch!.registry;
  const assigned = await registry.add(admin, {
    ...definition('http://127.0.0.1:1/mcp'), target: '已分配合成环境', resources: ['synthetic/one', 'synthetic/two'],
  });
  const hidden = await registry.add(admin, {
    ...definition('http://127.0.0.1:1/mcp'), target: '未分配合成环境', resources: ['synthetic/hidden'],
  });
  const team = await hub.records.teams.create(admin, '合成环境组');
  await hub.records.teams.add(admin, team.id, alice.principal.id);
  await hub.records.authorizations.assignResource(admin, assigned.id, team.id);
  const environments = hub.hub.dispatch!.options.environmentAccess;
  assert.ok(environments instanceof MemberEnvironments, 'dispatch receives the real member environment provider');
  assert.equal(await environments.canUse(alice.principal, assigned.id), true);
  assert.equal(await environments.canUse(admin, assigned.id), false, 'management privilege is not use permission');
  assert.equal(await environments.authorizeKeys(alice.principal, ['synthetic/one', 'synthetic/two']), null);
  assert.equal((await environments.authorizeKeys(alice.principal, ['synthetic/hidden']))?.code, 'SOURCE_NOT_PERMITTED');
  const before = await hub.deps.memberCapabilities(alice.principal);
  assert.equal(before.environmentAccess.ready, true);
  assert.deepEqual(before.environments[0].occupancy, []);
  assert.ok(before.environments[0].missing.some(reason => reason.includes('不代表环境空闲')));
  const run = 'run_0' + 'a'.repeat(25);
  const otherRun = 'run_0' + 'b'.repeat(25);
  for (const [key, holder] of [
    ['synthetic/one', { user: alice.principal.id, run }],
    ['synthetic/two', { user: bob.principal.id, run: otherRun }],
    ['synthetic/hidden', { user: admin.id, run: otherRun }],
  ] as const) assert.equal((await hub.leases.acquire({ keys: [key], prefix: 'synthetic/', holder, ttlSeconds: 300, maxTtlSeconds: 600 })).ok, true);
  const preview = await hub.deps.memberCapabilities(admin, alice.principal.id);
  assert.deepEqual(preview.teams, ['合成环境组']);
  assert.equal(preview.environments.length, 1);
  const occupancy = preview.environments[0].occupancy;
  assert.equal(occupancy?.length, 2, 'other member occupancy must not disappear or collapse into the first holder');
  assert.ok(occupancy?.some(row => row.mine && row.name === alice.user.name));
  assert.ok(occupancy?.some(row => !row.mine && row.name === '其他成员'));
  assert.ok(occupancy?.every(row => row.since && row.until));
  const serialized = JSON.stringify(preview);
  for (const secret of [assigned.id, hidden.id, team.id, bob.principal.id, run, otherRun, 'synthetic/hidden', '未分配合成环境']) assert.equal(serialized.includes(secret), false);
  const unassigned = await hub.deps.memberCapabilities(bob.principal);
  assert.deepEqual(unassigned.environments, []);
  assert.ok(unassigned.denials.some(row => row.reason.includes('运行环境') && row.nextAction.includes('分配')));
  const client = await hub.client(alice.token); t.after(() => client.close());
  const answer = await client.call('list_task_packs', {});
  assert.equal(answer.isError, false);
  assert.deepEqual(answer.structuredContent.member_capabilities, await hub.deps.memberCapabilities(alice.principal));
  const originalView = hub.leases.view.bind(hub.leases);
  hub.leases.view = async () => { throw new Error('synthetic lease read failure'); };
  try {
    const unknown = await hub.deps.memberCapabilities(alice.principal);
    assert.equal(unknown.environments[0].occupancy, null, 'unknown reads are never an empty/free lease state');
    assert.ok(unknown.environments[0].missing.some(reason => reason.includes('未能读取')));
  } finally { hub.leases.view = originalView; }
  await hub.records.authorizations.unassignResource(admin, assigned.id, team.id);
  assert.equal(await environments.canUse(alice.principal, assigned.id), false);
  assert.deepEqual((await hub.deps.memberCapabilities(alice.principal)).environments, []);
});

test('unassigned workflow count uses distinct current public publications and target permissions through revocation and retirement', { timeout: 60000 }, async t => {
  const hub = await createTestHub({ repositoryPacks: false, stubs: false, requireOsIsolation: false });
  t.after(() => hub.close());
  const alice = await hub.createUser('合成计数成员');
  const admin = hub.admin.principal;
  const registry = hub.hub.registry;
  const one = 'synthetic-count-one', two = 'synthetic-count-two';
  for (const [id, version] of [[one, '1.0.0'], [one, '2.0.0'], [two, '1.0.0']] as const) {
    const source = await writePack(join(hub.records.dataDir, 'count-fixtures', id, version), { ...locatePack(version), id, title: '合成计数工作流' });
    await hub.publishPack(source.dir);
  }
  const count = async () => (await hub.deps.memberCapabilities(admin, alice.principal.id)).unassigned_workflows_count;
  assert.equal(await count(), 2, 'versions count once and installed format skills are excluded');
  await hub.records.authorizations.assign(admin, alice.principal.id, one);
  assert.equal(await count(), 1, 'preview subtracts the target grant, not administrator access');
  await registry.retire(admin, one, '2.0.0');
  assert.equal(await count(), 1, 'retired newest version falls back to the still-published version');
  await hub.records.authorizations.unassign(admin, alice.principal.id, one);
  assert.equal(await count(), 2, 'revoked assignments become unassigned again');
  await registry.retire(admin, two, '1.0.0');
  assert.equal(await count(), 1, 'a fully retired workflow is no longer in the available public set');
  await registry.retire(admin, one, '1.0.0');
  assert.equal(await count(), 0);
  await hub.records.principals.setDisabled(admin, alice.principal.id, true);
  assert.equal(await count(), 0, 'disabled accounts receive no catalog projection');
});
