import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { memberCapabilities, type MemberCapabilitySources } from './api.ts';
import { AccessError } from './errors.ts';

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
    packs: async by => { seen.push(by.id); return [
      { id: 'assigned-workflow', version: '1.0.0', title: '可用工作流', kind: 'workflow' },
      { id: 'assigned-skill', version: '1.0.0', title: '可用技能', kind: 'skill' },
      { id: 'hidden-skill', version: '1.0.0', title: '其他团队秘密技能', kind: 'skill' },
    ]; },
    connections: async by => { seen.push(by.id); return [
      { id: 'assigned-resource', name: '已分配连接', systemPack: 'synthetic-system', environment: '合成环境', enabled: true },
      { id: 'hidden-resource', name: '其他团队秘密连接', systemPack: 'synthetic-system', environment: '合成环境', enabled: false },
    ]; },
    personalPackUse: async () => false,
    environments: async () => ({ ready: false, items: [{ name: '不该枚举的环境', occupancy: null }], missing: '权限接线未就绪', nextAction: '请管理员完成接线' }),
  };
  const view = await memberCapabilities(records, sources, admin, alice.id);
  assert.deepEqual(view.teams, ['乙组', '甲组'].sort());
  assert.deepEqual(view.workflows.map(item => item.ref), ['assigned-workflow@1.0.0']);
  assert.deepEqual(view.skills.map(item => item.ref), ['assigned-skill@1.0.0']);
  assert.equal(view.connections.length, 1);
  assert.deepEqual(view.environments, []);
  assert.ok(seen.every(id => id === alice.id), 'administrator preview queries candidates as the target');
  const bytes = JSON.stringify(view);
  for (const hidden of [alice.id, admin.id, one.id, two.id, 'assigned-resource', '其他团队秘密', '不该枚举']) assert.equal(bytes.includes(hidden), false);
  await assert.rejects(memberCapabilities(records, sources, { ...alice, role: admin.role }, bob.id), AccessError);
  await records.authorizations.unassignResource(admin, 'assigned-resource', one.id);
  await records.teams.remove(admin, two.id, alice.id);
  const revoked = await memberCapabilities(records, sources, alice);
  assert.deepEqual(revoked.skills, []);
  assert.deepEqual(revoked.connections, []);
  await records.principals.setDisabled(admin, alice.id, true);
  const disabled = await memberCapabilities(records, sources, admin, alice.id);
  assert.equal(disabled.member.enabled, false);
  assert.deepEqual(disabled.workflows, []);
  assert.deepEqual(disabled.teams, []);
});
