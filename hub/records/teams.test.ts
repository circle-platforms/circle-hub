import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TeamId } from '../../contracts/api.ts';
import { openTestRecords } from '../testing/records.ts';
import { Database, createPool } from './db.ts';
import { AccessError, ConflictError } from './errors.ts';
import { captureRequestPermissions, withRequestPermissions } from './request-permissions.ts';
import { sha256Hex } from './digest.ts';

async function world(t: import('node:test').TestContext) {
  const kit=await openTestRecords();t.after(()=>kit.close());
  const db=new Database(createPool(kit.database));t.after(()=>db.end());
  const {user:admin}=await kit.principals.bootstrapAdmin('synthetic-admin');
  const alice=await kit.principals.createUser(admin,'synthetic-alice'),bob=await kit.principals.createUser(admin,'synthetic-bob');
  const teams=kit.teams;assert.ok(teams,'openRecords wires the real team service');
  return {kit,db,admin,alice,bob,teams};
}

test('team definitions have retained digest-bound bytes and projections never become the authority',async t=>{
  const w=await world(t),team=await w.teams.create(w.admin,'合成团队');
  assert.equal(TeamId.safeParse(team.id).success,true);
  const decision=await w.kit.authorizations.latest('assign','*',team.id);assert.ok(decision?.body.bound);
  const bytes=await w.kit.objects.get(decision.body.bound);assert.ok(bytes);
  assert.equal(sha256Hex(bytes),decision.body.bound);assert.deepEqual(JSON.parse(Buffer.from(bytes).toString()),{id:team.id,name:team.name});
  await w.db.query('UPDATE teams SET name=$2 WHERE id=$1',[team.id,'合成投影错误']);
  assert.equal((await w.teams.get(w.admin,team.id))?.name,team.name);
  await assert.rejects(w.teams.create(w.alice,'不能创建'),AccessError);
  assert.equal(await w.teams.get(w.alice,team.id),null);
  await w.teams.add(w.admin,team.id,w.alice.id);
  assert.deepEqual((await w.teams.list(w.alice)).map(row=>row.id),[team.id]);
  await assert.rejects(w.teams.members(w.alice,team.id),AccessError);
  await assert.rejects(w.teams.memberships(w.alice,w.bob.id),AccessError);
  assert.deepEqual((await w.teams.members(w.admin,team.id)).map(row=>row.user.id),[w.alice.id]);
  await w.kit.authorizations.assignTeam(w.admin,team.id,'synthetic-workflow');
  await w.kit.authorizations.assignResource(w.admin,'synthetic-resource',team.id);
  const deleted=await w.teams.delete(w.admin,team.id);
  for(const [permission,subject,object]of [['assign',w.alice.id,team.id],['assign',team.id,'synthetic-workflow'],['resource_assign',team.id,'synthetic-resource']] as const)assert.equal((await w.kit.authorizations.latest(permission,subject,object))?.body.revoked,true);assert.ok(deleted.deleted_at);
  assert.equal(await w.teams.get(w.admin,team.id),null);
  const recreated=await w.teams.create(w.admin,'合成团队');assert.notEqual(recreated.id,team.id);
  assert.deepEqual(await w.teams.memberships(w.alice),[]);
  await assert.rejects(w.kit.authorizations.grant(w.admin,{permission:'assign',subject:'*',object:team.id,bound:decision.body.bound}),ConflictError);
});

test('multiple teams union with direct assignments in snapshots, batches and pack-user shares',async t=>{
  const w=await world(t),one=await w.teams.create(w.admin,'合成一组'),two=await w.teams.create(w.admin,'合成二组');
  for(const team of [one,two])await w.teams.add(w.admin,team.id,w.alice.id);
  await w.kit.authorizations.assignTeam(w.admin,one.id,'shared-workflow');
  await w.kit.authorizations.assignTeam(w.admin,two.id,'shared-workflow');
  await w.kit.authorizations.assign(w.admin,w.alice.id,'direct-workflow');
  assert.deepEqual(await w.kit.authorizations.packsFor(w.alice.id),['direct-workflow','shared-workflow']);
  assert.deepEqual((await w.teams.membershipsMany(w.admin,[w.alice.id,w.bob.id])).get(w.alice.id)?.map(team=>team.id).sort(),[one.id,two.id].sort());
  assert.deepEqual((await w.teams.membershipsMany(w.admin,[w.alice.id,w.bob.id])).get(w.bob.id),[]);
  const listed=await w.teams.list(w.admin);assert.equal(listed.find(team=>team.id===one.id)?.member_count,1);assert.equal(listed.find(team=>team.id===one.id)?.pack_count,1);
  assert.deepEqual((await w.kit.authorizations.teamsOf(w.admin,'pack','shared-workflow')).teams.map(team=>team.id).sort(),[one.id,two.id].sort());
  const sources=await w.kit.authorizations.packSources(w.admin,w.alice.id);
  assert.deepEqual(sources.filter(source=>source.pack==='direct-workflow').map(source=>source.via),['user']);
  assert.deepEqual(sources.filter(source=>source.pack==='shared-workflow').map(source=>typeof source.via==='string'?source.via:source.via.team).sort(),[one.id,two.id].sort());
  await assert.rejects(w.kit.authorizations.teamsOf(w.alice,'pack','shared-workflow'),AccessError);
  await assert.rejects(w.kit.authorizations.packSources(w.alice,w.alice.id),AccessError);

  assert.deepEqual((await w.kit.authorizations.packsForMany!([w.alice.id,w.bob.id])).get(w.alice.id),['direct-workflow','shared-workflow']);
  assert.deepEqual((await w.kit.authorizations.usersOfMany!(['shared-workflow'])).get('shared-workflow'),[w.alice.id]);
  await w.kit.authorizations.share(w.admin,'synthetic-shared-run',{kind:'pack_users',pack:'shared-workflow'});
  assert.equal(await w.kit.authorizations.isSharedWith(w.alice.id,'synthetic-shared-run'),true);
  await w.teams.remove(w.admin,one.id,w.alice.id);
  assert.equal(await w.kit.authorizations.canUse(w.alice.id,'shared-workflow'),true);
  await withRequestPermissions(w.kit.artifacts,w.alice,async()=>{
    assert.equal(await w.kit.authorizations.canUse(w.alice.id,'shared-workflow'),true);
    await w.teams.remove(w.admin,two.id,w.alice.id);
    assert.equal(await w.kit.authorizations.canUse(w.alice.id,'shared-workflow'),true);
  });
  assert.equal(await w.kit.authorizations.canUse(w.alice.id,'shared-workflow'),false);
  assert.equal(await w.kit.authorizations.isSharedWith(w.alice.id,'synthetic-shared-run'),false);
  assert.deepEqual(await w.kit.authorizations.packsFor(w.alice.id),['direct-workflow']);
  assert.deepEqual(await w.kit.authorizations.usersOf('shared-workflow'),[]);
});

test('resource team and all-account grants require current enabled accounts',async t=>{
  const w=await world(t),team=await w.teams.create(w.admin,'合成资源组');
  assert.equal(await w.kit.authorizations.canUseResource(w.admin.id,'synthetic-system'),false);await w.teams.add(w.admin,team.id,w.alice.id);
  await w.kit.authorizations.assignResource(w.admin,'synthetic-system',team.id);
  assert.equal(await w.kit.authorizations.canUseResource(w.alice.id,'synthetic-system'),true);
  assert.equal(await w.kit.authorizations.canUseResource(w.bob.id,'synthetic-system'),false);
  assert.equal((await captureRequestPermissions(w.db,w.alice,new Date())).canUseResource('synthetic-system'),true);
  await w.kit.authorizations.assignResource(w.admin,'synthetic-system','*');
  assert.equal(await w.kit.authorizations.canUseResource(w.bob.id,'synthetic-system'),true);
  assert.equal(await w.kit.authorizations.canUseResource(w.admin.id,'synthetic-system'),true);
  await w.kit.principals.setDisabled(w.admin,w.alice.id,true);
  assert.equal(await w.kit.authorizations.canUseResource(w.alice.id,'synthetic-system'),false);
  assert.deepEqual(await w.kit.authorizations.packsFor(w.alice.id),[]);
  await assert.rejects(w.teams.add(w.admin,team.id,w.alice.id),ConflictError);
  await w.kit.authorizations.unassignResource(w.admin,'synthetic-system','*');
  assert.equal(await w.kit.authorizations.canUseResource(w.bob.id,'synthetic-system'),false);
  await w.kit.principals.setDisabled(w.admin,w.alice.id,false);
  await w.teams.delete(w.admin,team.id);
  assert.equal(await w.kit.authorizations.canUseResource(w.alice.id,'synthetic-system'),false);
  await assert.rejects(w.kit.authorizations.assignResource(w.admin,'synthetic-system',w.bob.id));
});

test('membership started behind deactivation cannot commit from a stale enabled account',{timeout:60000},async t=>{
  const w=await world(t),team=await w.teams.create(w.admin,'合成定序组');
  const writer=(w.teams as import('./teams.ts').PgTeams).db;
  let held!:()=>void,release!:()=>void,started!:()=>void;
  const locked=new Promise<void>(resolve=>{held=resolve;}),continueUpdate=new Promise<void>(resolve=>{release=resolve;}),attempted=new Promise<void>(resolve=>{started=resolve;});
  const original=writer.query.bind(writer);
  writer.query=(async(...args:Parameters<typeof original>)=>{if(args[0].includes('ORDER BY id FOR SHARE'))started();return original(...args);}) as typeof writer.query;
  const blocker=w.db.transaction(async tx=>{await w.db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[w.alice.id],tx);held();await continueUpdate;await w.db.query('UPDATE users SET disabled=true WHERE id=$1',[w.alice.id],tx);});
  await locked;
  const adding=w.teams.add(w.admin,team.id,w.alice.id).then(()=>null,error=>error);
  try{await attempted;}finally{release();}
  await blocker;assert.ok(await adding instanceof ConflictError);
  assert.equal(await w.kit.authorizations.latest('assign',w.alice.id,team.id),null);
  assert.equal((await w.db.query('SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2',[team.id,w.alice.id])).rowCount,0);
});
