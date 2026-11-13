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

test('fresh environment snapshots reuse the outer transaction and see its uncommitted revocation', {timeout:60000}, async t => {
  const { Database, createPool } = await import('./db.ts');
  const { RecordArtifacts } = await import('./artifacts.ts');
  const { capturePermissionSnapshots, captureRequestPermissions, requestPermissions, withRequestPermissions } = await import('./request-permissions.ts');
  const { canUseEnvironment } = await import('./environment-permissions.ts');
  const records = await openTestRecords(); t.after(()=>records.close());
  const db = new Database(createPool(records.database,1)); t.after(()=>db.end());
  const admin = (await records.principals.bootstrapAdmin('合成管理员')).user;
  const actor = await records.principals.createUser(admin,'合成事务成员');
  await records.authorizations.assignResource(admin,ENV,actor.id);
  const artifacts = new RecordArtifacts(db,records.store,records.objects,records.authorizations,{maxBytes:1_000_000,now:()=>new Date()});
  await withRequestPermissions(records.artifacts,actor,async()=>{
    await db.transaction(async tx=>{
      assert.equal(db.stats().limit,1);assert.equal(db.stats().total,1);assert.equal(db.stats().idle,0);
      const original = db.pool.query;
      db.pool.query = (()=>{throw new Error('permission snapshot escaped the occupied outer transaction');}) as typeof db.pool.query;
      try {
        const batch = (await capturePermissionSnapshots(db,[actor.id],new Date(),tx)).get(actor.id)!;
        assert.equal(batch.enabled(batch.latest('resource_assign',actor.id,ENV)),true);
        assert.equal((await captureRequestPermissions(db,actor,new Date(),tx)).user?.id,actor.id);
        assert.equal((await artifacts.capturePermissionSnapshot(actor,tx)).user?.id,actor.id);
        assert.equal(await canUseEnvironment({artifacts},actor,ENV,tx),true);
        await records.authorizations.revoke(admin,{permission:'resource_assign',subject:actor.id,object:ENV},tx);
        assert.equal(await canUseEnvironment({artifacts},actor,ENV,tx),false,'uncommitted revocation is visible in the same transaction');
        const oldRequest = requestPermissions(actor.id)!;
        assert.equal(oldRequest.enabled(oldRequest.latest('resource_assign',actor.id,ENV)),true,'fresh TX checks do not rewrite the surrounding request snapshot');
        await records.authorizations.grant(admin,{permission:'resource_assign',subject:actor.id,object:ENV},tx);
        assert.equal(await canUseEnvironment({artifacts},actor,ENV,tx),true);
        await db.query('UPDATE users SET disabled=true WHERE id=$1',[actor.id],tx);
        assert.equal(await canUseEnvironment({artifacts},actor,ENV,tx),false,'uncommitted account disable is visible');
        assert.equal(db.stats().waiting,0);
      } finally { db.pool.query = original; }
    });
  });
});

test('non-transaction requests still capture once and fresh environment checks each read once', {timeout:60000}, async t=>{
  const { Database, createPool } = await import('./db.ts');
  const { RecordArtifacts } = await import('./artifacts.ts');
  const { withRequestPermissions } = await import('./request-permissions.ts');
  const { canUseEnvironment } = await import('./environment-permissions.ts');
  const records = await openTestRecords(); t.after(()=>records.close());
  const db = new Database(createPool(records.database,1)); t.after(()=>db.end());
  const admin = (await records.principals.bootstrapAdmin('合成管理员')).user;
  const actor = await records.principals.createUser(admin,'合成缓存成员');
  await records.authorizations.assignResource(admin,ENV,actor.id);
  const artifacts = new RecordArtifacts(db,records.store,records.objects,records.authorizations,{maxBytes:1_000_000,now:()=>new Date()});
  let queries = 0;
  const original = db.pool.query;
  db.pool.query = function(...args: unknown[]) { queries++; return Reflect.apply(original,db.pool,args); } as typeof db.pool.query;
  await withRequestPermissions(artifacts,actor,async()=>{
    await withRequestPermissions(artifacts,actor,async()=>{});
    assert.equal(queries,1,'the nested request reuses its original snapshot');
    assert.equal(await canUseEnvironment({artifacts},actor,ENV),true);
    assert.equal(queries,2,'a fresh guard uses one statement');
    assert.equal(await canUseEnvironment({artifacts},actor,ENV),true);
    assert.equal(queries,3,'each fresh guard still rereads');
  });
  db.pool.query = original;
});
