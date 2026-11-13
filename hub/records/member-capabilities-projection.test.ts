// Projection-only synthetic ports; no PostgreSQL, environment files, vault or network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberCapabilities, type MemberCapabilitySources, type MemberEnvironmentCapability } from './permissions.ts';
import type { RecordsKit, User } from './api.ts';
import { RequestPermissions } from './request-permissions.ts';

test('member projection retains provider-selected own holds after revocation without granting use or collapsing occupancy', async () => {
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
  let rows: MemberEnvironmentCapability[] = [{
    name: '本人仍占用的合成环境', enabled: true, assigned: false, can_use: false,
    occupancy: [
      { name: alice.name, since: at, until: '2026-11-14T05:00:00.000Z', mine: true },
      { name: alice.name, since: '2026-11-14T04:31:00.000Z', until: null, mine: true },
    ],
    missing: ['分配已收回；本人原有租约仍保留，不代表可以新开或续期'],
  }];
  const sources: MemberCapabilitySources = {
    publicWorkflowIds: async () => [], canUsePack: async () => false,
    packs: async () => [], connections: async () => [], personalPackUse: async () => false,
    environments: async actor => {
      assert.equal(actor.id, alice.id, 'administrator preview calls the provider as the target');
      return { ready: true, items: rows, missing: null, nextAction: null };
    },
  };
  const view = await memberCapabilities(records, sources, admin, alice.id);
  assert.deepEqual(captures, [alice.id]);
  assert.deepEqual(view.environments, rows);
  assert.notEqual(view.environments[0], rows[0]);
  assert.equal(view.environments[0].occupancy?.length, 2);
  assert.equal(view.environments[0].assigned, false);
  assert.equal(view.environments[0].can_use, false);
  assert.ok(view.denials.some(item => item.reason === '尚无已分配的运行环境'));
  assert.equal(JSON.stringify(view).includes(alice.id), false);
  rows = [];
  assert.deepEqual((await memberCapabilities(records, sources, admin, alice.id)).environments, [], 'no grant and no own hold remains invisible when omitted by the provider');
});
