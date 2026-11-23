import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { memberCapabilities, type MemberCapabilitySources } from './api.ts';
import { AccessError } from './errors.ts';
import { requestPermissions, withRequestPermissions } from './request-permissions.ts';

test('member capabilities union assignments without leaking installed or other-team candidates', async t => {
  const records = await openTestRecords(); t.after(() => records.close());
  const { user: admin } = await records.principals.bootstrapAdmin('管理员');
  const alice = await records.principals.createUser(admin, '甲成员');
  const bob = await records.principals.createUser(admin, '乙成员');
  const one = await records.teams.create(admin, '甲组');
  const two = await records.teams.create(admin, '乙组');
  for (const team of [one, two]) await records.teams.add(admin, team.id, alice.id);
  await records.authorizations.assignTeam(admin, one.id, 'assigned-workflow');
  await records.authorizations.assignTeam(admin, two.id, 'assigned-skill');
  await records.authorizations.assign(admin, bob.id, 'hidden-skill');
  await records.authorizations.assignResource(admin, 'assigned-resource', one.id);
  const seen: string[] = [];
  const sources: MemberCapabilitySources = {
    publicWorkflowIds: async () => ['assigned-workflow', 'unassigned-workflow', 'unassigned-workflow'],
    canUsePack: async (by, pack) => {
      assert.equal(requestPermissions(by.id)?.principalId, by.id, 'projection uses the target request snapshot');
      return pack === 'generic-skill' || await records.authorizations.canUse(by.id, pack);
    },
    packs: async by => { seen.push(by.id); return [
      { id: 'assigned-workflow', version: '1.0.0', title: '可用工作流', kind: 'workflow' },
      { id: 'unassigned-workflow', version: '1.0.0', title: '同名可读个人工作流', kind: 'workflow', space: bob.id },
      { id: 'assigned-skill', version: '1.0.0', title: '可用技能', kind: 'skill' },
      { id: 'generic-skill', version: '1.0.0', title: '全局通用技能', kind: 'skill' },
      { id: 'hidden-skill', version: '1.0.0', title: '其他团队秘密技能', kind: 'skill' },
    ]; },
    connections: async by => { seen.push(by.id); return [
      { id: 'assigned-resource', name: '已分配连接', systemPack: 'synthetic-system', environment: '合成环境', enabled: true },
      { id: 'hidden-resource', name: '其他团队秘密连接', systemPack: 'synthetic-system', environment: '合成环境', enabled: false },
    ]; },
    personalPackUse: async (by, owner, pack) => by.id === alice.id && owner === bob.id && pack === 'unassigned-workflow',
    environments: async () => ({ ready: false, items: [{ name: '不该枚举的环境', enabled: true, assigned: false, can_use: false, occupancy: null, missing: [] }], missing: '权限接线未就绪', nextAction: '请管理员完成接线' }),
  };
  const view = await withRequestPermissions(records.artifacts, admin, () => memberCapabilities(records, sources, admin, alice.id));
  assert.deepEqual(view.teams, ['乙组', '甲组'].sort());
  assert.deepEqual(view.workflows.map(item => item.ref), ['assigned-workflow@1.0.0', 'unassigned-workflow@1.0.0']);
  assert.equal(view.unassigned_workflows_count, 1, 'distinct public workflows only, preview as target rather than administrator');
  assert.equal(view.workflows.find(item => item.owner !== undefined)?.owner, bob.name, 'a readable personal pack does not subtract a same-ID unassigned public workflow');
  assert.deepEqual(view.skills.map(item => item.ref), ['assigned-skill@1.0.0', 'generic-skill@1.0.0']);
  assert.equal(view.connections.length, 1);
  assert.deepEqual(view.environments, []);
  assert.ok(seen.every(id => id === alice.id), 'administrator preview queries candidates as the target');
  const bytes = JSON.stringify(view);
  for (const hidden of [alice.id, admin.id, one.id, two.id, 'assigned-resource', '其他团队秘密', '不该枚举']) assert.equal(bytes.includes(hidden), false);
  await assert.rejects(memberCapabilities(records, sources, { ...alice, role: admin.role }, bob.id), AccessError);
  await records.authorizations.unassignResource(admin, 'assigned-resource', one.id);
  await records.teams.remove(admin, two.id, alice.id);
  const revoked = await memberCapabilities(records, sources, alice);
  assert.deepEqual(revoked.skills.map(item => item.ref), ['generic-skill@1.0.0']);
  assert.deepEqual(revoked.connections, []);
  const unassigned = await records.principals.createUser(admin, '仅全局技能成员');
  const genericOnly = await memberCapabilities(records, sources, unassigned);
  assert.deepEqual(genericOnly.teams, []);
  assert.deepEqual(genericOnly.workflows, []);
  assert.equal(genericOnly.unassigned_workflows_count, 2);
  assert.deepEqual(genericOnly.skills.map(item => item.ref), ['generic-skill@1.0.0']);
  assert.ok(genericOnly.denials.some(item => item.reason.includes('工作流') && item.nextAction.includes('加入团队')));
  assert.equal(genericOnly.denials.some(item => item.reason.includes('技能')), false, 'global skill must not be reported missing');
  await records.principals.setDisabled(admin, alice.id, true);
  const disabled = await memberCapabilities(records, sources, admin, alice.id);
  assert.equal(disabled.member.enabled, false);
  assert.deepEqual(disabled.workflows, []);
  assert.equal(disabled.unassigned_workflows_count, 0, 'disabled accounts receive no catalog projection');
  assert.deepEqual(disabled.teams, []);
});
