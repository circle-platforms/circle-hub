import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberCapabilities, type MemberCapabilitySources, type MemberCapabilities, type MemberEnvironmentCapability } from './permissions.ts';
import type { RecordsKit, User } from './api.ts';
import { RequestPermissions } from './request-permissions.ts';

test('member projection preserves independent unattributed own bookings without inventing target ownership or permission', async () => {
  const at = '2026-11-14T04:30:00.000Z';
  const alice: User = { id: 'usr_0' + 'a'.repeat(25), name: '合成成员', role: 'user', disabled: false, deleted_at: null, created_at: at, updated_at: at };
  const admin: User = { ...alice, id: 'usr_0' + 'b'.repeat(25), name: '合成管理员', role: 'admin' };
  const accounts = new Map([alice, admin].map(user => [user.id, user]));
  const captures: string[] = [];
  const records = {
    principals: { get: async (id: string) => accounts.get(id) ?? null },
    teams: { memberships: async () => [] },
    authorizations: { canUseResource: async () => false },
    artifacts: { capturePermissionSnapshot: async (actor: User) => {
      captures.push(actor.id);
      return new RequestPermissions(actor.id, accounts.get(actor.id) ?? null, new Date(at), []);
    } },
  } as unknown as Pick<RecordsKit, 'principals' | 'teams' | 'authorizations' | 'artifacts'>;
  let holdings: MemberCapabilities['unattributed_holdings'] = [at, '2026-11-14T04:31:00.000Z'].map((since, index): NonNullable<MemberCapabilities['unattributed_holdings']>[number] => ({
    booking_run: 'run_0' + (index === 0 ? 'c' : 'd').repeat(25), since, until: index === 0 ? '2026-11-14T05:00:00.000Z' : null,
    target: null, assigned: false, can_use: false,
    assignment_reason: '当前没有分配，不能续期或开始新的上机验证；预订仍由你持有',
    target_missing: '预订没有可核验的执行器绑定，目标归属未知',
  }));
  Object.assign(holdings[0], { executor: 'exe_hidden', key: 'synthetic/private', target_name: '不应出现的目标' });
  let enforcement: boolean | undefined;
  const environments: MemberEnvironmentCapability[] = [];
  const sources: MemberCapabilitySources = {
    publicWorkflowIds: async () => [], canUsePack: async () => false,
    packs: async () => [], connections: async () => [], personalPackUse: async () => false,
    environments: async actor => {
      assert.equal(actor.id, alice.id, 'administrator preview calls the provider as the target');
      return { ready: true, ...(enforcement === undefined ? {} : { enforceEnvironmentAssignments: enforcement }), items: environments, missing: null, nextAction: null };
    },
    unattributedHoldings: async actor => {
      assert.equal(actor.id, alice.id, 'unattributed bookings also query the target, never the admin previewer');
      return holdings;
    },
  };
  const view = await memberCapabilities(records, sources, admin, alice.id);
  assert.deepEqual(captures, [alice.id]);
  assert.equal(view.environmentAccess.enforced, false, 'omitted flag does not enable the assignment guard');
  assert.deepEqual(view.environments, []);
  assert.equal(view.unattributed_holdings?.length, 2);
  assert.ok(view.unattributed_holdings?.every(row => row.target === null && !row.assigned && !row.can_use));
  assert.equal(view.unattributed_holdings?.[0].booking_run, holdings[0].booking_run);
  assert.equal(view.unattributed_holdings?.[0].since, at);
  assert.equal(view.unattributed_holdings?.[1].until, null);
  assert.equal(view.denials.some(item => item.reason === '尚无已分配的运行环境'), false);
  assert.ok(view.unattributed_holdings?.every(row => /没有启用运行环境分配检查/.test(row.assignment_reason ?? '')));
  enforcement = true;
  const guarded = await memberCapabilities(records, sources, admin, alice.id);
  assert.ok(guarded.denials.some(item => item.reason === '尚无已分配的运行环境'));
  assert.ok(guarded.unattributed_holdings?.every(row => /不能续期或开始新的上机验证/.test(row.assignment_reason ?? '')));
  enforcement = undefined; captures.length = 1;
  assert.equal(JSON.stringify(view).includes(alice.id), false);
  for (const hidden of ['exe_hidden', 'synthetic/private', '不应出现的目标']) assert.equal(JSON.stringify(view).includes(hidden), false);
  holdings = null;
  assert.equal((await memberCapabilities(records, sources, admin, alice.id)).unattributed_holdings, null, 'unknown is not an empty booking set');
  holdings = [];
  assert.deepEqual((await memberCapabilities(records, sources, admin, alice.id)).unattributed_holdings, [], 'no own holdings is a distinct known empty set');
  environments.push({ name: '合成已停用预览', enabled: false, assigned: true, can_use: false, occupancy: [], missing: ['运行环境已停用'] });
  for (const flag of [false, true, undefined]) {
    enforcement = flag;
    const preview = await memberCapabilities(records, sources, admin, alice.id);
    assert.equal(preview.environmentAccess.enforced, flag === true, 'only explicit true represents enforcement');
    assert.deepEqual(preview.environments, environments, 'guard metadata cannot rewrite assignment or use permission');
    assert.equal(preview.environments[0].assigned, true);
    assert.equal(preview.environments[0].can_use, false);
  }
});
