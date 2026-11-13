import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';

const ENV = 'exe_0' + 'a'.repeat(25);

test('environment resource assignments accept a direct account without loosening generic team assignments', {timeout:60000}, async t => {
  const records = await openTestRecords(); t.after(() => records.close());
  const admin = (await records.principals.bootstrapAdmin('合成管理员')).user;
  const user = await records.principals.createUser(admin, '合成成员');
  const grant = await records.authorizations.assignResource(admin, ENV, user.id);
  assert.equal(grant.body.permission, 'resource_assign');
  assert.equal(grant.body.subject, user.id);
  await assert.rejects(records.authorizations.assignResource(admin, 'synthetic-system', user.id));
  const revoke = await records.authorizations.unassignResource(admin, ENV, user.id);
  assert.equal(revoke.body.revoked, true);
});

test('environment use rereads accounts and grants, never borrowing admin or request snapshots', {timeout:60000}, async t => {
  const { canUseEnvironment } = await import('./environment-permissions.ts');
  const { withRequestPermissions } = await import('./request-permissions.ts');
  const records = await openTestRecords(); t.after(() => records.close());
  const admin = (await records.principals.bootstrapAdmin('合成管理员')).user;
  const alice = await records.principals.createUser(admin, '合成甲');
  const bob = await records.principals.createUser(admin, '合成乙');
  const team = await records.teams!.create(admin, '合成环境组');
  await records.teams!.add(admin, team.id, alice.id);
  assert.equal(await canUseEnvironment(records, admin, ENV), false, 'management grants no use');
  assert.equal(await canUseEnvironment(records, { ...bob, role:'admin' }, ENV), false, 'caller role grants no use');
  await records.authorizations.assignResource(admin, ENV, team.id);
  assert.equal(await canUseEnvironment(records, alice, ENV), true);
  assert.equal(await canUseEnvironment(records, bob, ENV), false);
  await withRequestPermissions(records.artifacts, alice, async () => {
    await records.teams!.remove(admin, team.id, alice.id);
    assert.equal(await canUseEnvironment(records, alice, ENV), false, 'fresh membership beats the read snapshot');
    await records.authorizations.assignResource(admin, ENV, alice.id);
    assert.equal(await canUseEnvironment(records, alice, ENV), true, 'fresh direct assignment');
    await records.authorizations.unassignResource(admin, ENV, alice.id);
    assert.equal(await canUseEnvironment(records, alice, ENV), false, 'fresh revocation');
  });
  await records.authorizations.assignResource(admin, ENV, bob.id, {expiresAt:'2000-01-01T00:00:00.000Z'});
  assert.equal(await canUseEnvironment(records, bob, ENV), false, 'expired direct assignment');
  await records.authorizations.assignResource(admin, ENV, '*');
  assert.equal(await canUseEnvironment(records, bob, ENV), true);
  await withRequestPermissions(records.artifacts, bob, async () => {
    await records.principals.setDisabled(admin, bob.id, true);
    assert.equal(await canUseEnvironment(records, bob, ENV), false, 'fresh deactivation');
  });
  await assert.rejects(records.authorizations.grant({...alice,role:'admin'}, {permission:'resource_assign',subject:alice.id,object:ENV}));
  assert.equal(await canUseEnvironment(records, alice, 'not-an-environment'), false);
});
