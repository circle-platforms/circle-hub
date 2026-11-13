import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Database, createPool, type Principal } from '../records/api.ts';
import { canUseEnvironment } from '../records/environment-permissions.ts';
import { withRequestPermissions } from '../records/request-permissions.ts';
import { LeaseService } from '../leases/api.ts';
import { openTestRecords } from '../testing/records.ts';
import { ExecutorRegistry } from './executors.ts';
import { MemberEnvironments } from './member-environments.ts';
import { definition } from './testing/definition.ts';

async function world(t: import('node:test').TestContext) {
  const records = await openTestRecords(); t.after(()=>records.close());
  const db = new Database(createPool(records.database)); t.after(()=>db.end());
  const leases = new LeaseService(db);
  const admin = (await records.principals.bootstrapAdmin('合成管理员')).user;
  const alice = await records.principals.createUser(admin,'合成甲');
  const bob = await records.principals.createUser(admin,'合成乙');
  const team = await records.teams!.create(admin,'合成环境组');
  await records.teams!.add(admin,team.id,alice.id);
  const registry = new ExecutorRegistry(records);
  const first = await registry.add(admin,{...definition('http://127.0.0.1:1/mcp'),target:'synthetic-visible',resources:['synthetic/zone/allowed']});
  const second = await registry.add(admin,{...definition('http://127.0.0.1:1/mcp'),target:'synthetic-hidden',resources:['synthetic/zone/hidden','synthetic/zone/allowed']});
  const permission = (actor: Principal,id:string)=>canUseEnvironment(records,actor,id);
  const environments = new MemberEnvironments(records,registry,leases,permission);
  return {records,db,leases,admin,alice,bob,team,registry,first,second,permission,environments};
}

test('only assigned environments are visible and booking uses exact keys from enabled authorized providers', {timeout:60000}, async t => {
  const w = await world(t);
  assert.deepEqual(await w.environments.list(w.alice),[]);
  assert.deepEqual(await w.environments.list(w.admin),[]);
  assert.equal((await w.environments.authorizeKeys(w.alice,['synthetic/zone/allowed']))?.code,'SOURCE_NOT_PERMITTED');
  await w.records.authorizations.assignResource(w.admin,w.first.id,w.team.id);
  assert.deepEqual((await w.environments.list(w.alice)).map(row=>row.name),['synthetic-visible']);
  assert.deepEqual(await w.environments.list(w.bob),[]);
  assert.equal(await w.environments.authorizeKeys(w.alice,['synthetic/zone/allowed']),null);
  assert.equal((await w.environments.authorizeKeys(w.alice,['synthetic/zone/allowed','synthetic/zone/hidden']))?.code,'SOURCE_NOT_PERMITTED');
  assert.equal((await w.environments.authorizeKeys(w.alice,['synthetic/zone/allowed/child']))?.code,'SOURCE_NOT_PERMITTED');
  assert.equal((await w.environments.authorizeKeys(w.alice,['unregistered/non-environment']))?.code,'SOURCE_NOT_PERMITTED');
  assert.equal(await w.environments.canUse(w.alice,w.second.id),false,'overlapping keys do not authorize another provider');
  await w.records.authorizations.assignResource(w.admin,w.second.id,w.bob.id);
  assert.deepEqual((await w.environments.list(w.bob)).map(row=>row.name),['synthetic-hidden']);
  await withRequestPermissions(w.records.artifacts,w.alice,async()=>{
    await w.records.authorizations.unassignResource(w.admin,w.first.id,w.team.id);
    assert.equal(await w.environments.canUse(w.alice,w.first.id),false,'dispatch cannot borrow an older request snapshot');
    assert.deepEqual(await w.environments.list(w.alice),[]);
  });
  await w.records.authorizations.assignResource(w.admin,w.first.id,w.alice.id);
  await w.registry.disable(w.admin,w.first.id);
  assert.equal(await w.environments.canUse(w.alice,w.first.id),false);
  assert.equal((await w.environments.authorizeKeys(w.alice,['synthetic/zone/allowed']))?.code,'SOURCE_NOT_PERMITTED','unauthorized overlap cannot bypass disabled provider');
  const disabled = await w.environments.list(w.alice);
  assert.equal(disabled[0].enabled,false);assert.ok(disabled[0].missing.some(text=>text.includes('停用')));
});

test('member occupancy shows names and times only within assigned keys and never calls missing reads free', {timeout:60000}, async t => {
  const w = await world(t);
  await w.records.authorizations.assignResource(w.admin,w.first.id,w.alice.id);
  const run = 'run_0'+'a'.repeat(25), otherRun = 'run_0'+'b'.repeat(25);
  assert.equal((await w.leases.acquire({keys:['synthetic/zone/allowed'],prefix:'synthetic/',holder:{user:w.bob.id,run},ttlSeconds:300,maxTtlSeconds:600})).ok,true);
  assert.equal((await w.leases.acquire({keys:['synthetic/zone/hidden'],prefix:'synthetic/',holder:{user:w.admin.id,run:otherRun},ttlSeconds:300,maxTtlSeconds:600})).ok,true);
  const visible = await w.environments.list(w.alice);
  assert.equal(visible.length,1);assert.equal(visible[0].occupancy?.[0].name,'其他成员');
  assert.equal((await w.environments.list({...w.alice,role:'admin'}))[0].occupancy?.[0].name,'其他成员','claimed admin role cannot expose a holder');
  assert.equal((await w.leases.register({prefix:'synthetic/zone/',declaredPrefix:'synthetic/',owner:w.alice.id,by:w.alice.id,reason:'合成登记'})).ok,true);
  assert.equal((await w.environments.list(w.alice))[0].occupancy?.[0].name,w.bob.name,'the current registered prefix owner can see the name');
  assert.equal(visible[0].occupancy?.[0].mine,false);assert.ok(visible[0].occupancy?.[0].since);
  assert.ok(visible[0].occupancy?.[0].until);
  const text = JSON.stringify(visible);
  for (const hidden of [w.first.id,w.second.id,w.admin.id,w.alice.id,w.bob.id,w.team.id,run,otherRun,'synthetic/zone/allowed','synthetic/zone/hidden','synthetic-hidden']) assert.equal(text.includes(hidden),false,hidden);
  const failed = new MemberEnvironments(w.records,w.registry,{view:async()=>{throw new Error('synthetic unavailable');},registrations:async()=>[]} as unknown as Pick<LeaseService,'view'|'registrations'>,w.permission);
  const unknown = await failed.list(w.alice);
  assert.equal(unknown[0].occupancy,null);assert.ok(unknown[0].missing.some(text=>text.includes('未能读取')));
  await w.leases.release({keys:['synthetic/zone/allowed'],holder:{user:w.bob.id,run}});
  const released = await w.environments.list(w.alice);
  assert.deepEqual(released[0].occupancy,[]);assert.ok(released[0].missing.some(text=>text.includes('不代表环境空闲')));
});
