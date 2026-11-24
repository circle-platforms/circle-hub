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
import { grantLeases } from '../runs/engine/start.ts';
import type { EngineContext } from '../runs/engine/deps.ts';
import type { LoadedWorkflow } from '../ports.ts';

async function world(t: import('node:test').TestContext, leaseNow?: () => Date) {
  const records = await openTestRecords(); t.after(()=>records.close());
  const db = new Database(createPool(records.database)); t.after(()=>db.end());
  const leases = new LeaseService(db, leaseNow ? {now:async()=>leaseNow()} : {});
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

test('only assigned environments are listed and a disabled one says so', {timeout:60000}, async t => {
  const w = await world(t);
  assert.deepEqual(await w.environments.list(w.alice),[]);
  assert.deepEqual(await w.environments.list(w.admin),[]);
  await w.records.authorizations.assignResource(w.admin,w.first.id,w.team.id);
  assert.deepEqual((await w.environments.list(w.alice)).map(row=>row.name),['synthetic-visible'],'an overlapping key lists no other provider');
  assert.deepEqual(await w.environments.list(w.bob),[]);
  await w.records.authorizations.assignResource(w.admin,w.second.id,w.bob.id);
  assert.deepEqual((await w.environments.list(w.bob)).map(row=>row.name),['synthetic-hidden']);
  await withRequestPermissions(w.records.artifacts,w.alice,async()=>{
    await w.records.authorizations.unassignResource(w.admin,w.first.id,w.team.id);
    assert.deepEqual(await w.environments.list(w.alice),[],'the list does not borrow an older request snapshot');
  });
  await w.records.authorizations.assignResource(w.admin,w.first.id,w.alice.id);
  await w.registry.disable(w.admin,w.first.id);
  const disabled = await w.environments.list(w.alice);
  assert.equal(disabled[0].enabled,false);assert.equal(disabled[0].can_use,false);assert.ok(disabled[0].missing.some(text=>text.includes('停用')));
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

test('withdrawing an assignment only removes the environment from the list; the holder still extends and releases', {timeout:60000}, async t => {
  const w = await world(t);
  await w.registry.update(w.admin,w.first.id,{...w.first.source,resources:['synthetic/zone/allowed','synthetic/zone/other']});
  await w.registry.update(w.admin,w.second.id,{...w.second.source,resources:['synthetic/zone/hidden']});
  await w.records.authorizations.assignResource(w.admin,w.first.id,w.team.id);
  const ownRun = 'run_0'+'c'.repeat(25), otherRun = 'run_0'+'d'.repeat(25);
  assert.equal((await w.leases.acquire({keys:['synthetic/zone/allowed'],prefix:'synthetic/',holder:{user:w.alice.id,run:ownRun},ttlSeconds:300,maxTtlSeconds:600})).ok,true);
  assert.equal((await w.leases.acquire({keys:['synthetic/zone/other','synthetic/zone/hidden'],prefix:'synthetic/',holder:{user:w.bob.id,run:otherRun},ttlSeconds:300,maxTtlSeconds:600})).ok,true);
  const leaseBytes = async () => JSON.stringify((await w.db.query('SELECT to_jsonb(l) AS row FROM leases l ORDER BY key')).rows);
  const before = await leaseBytes();
  assert.equal((await w.environments.list(w.alice))[0].occupancy?.length,2);
  await w.records.authorizations.unassignResource(w.admin,w.first.id,w.team.id);
  assert.deepEqual(await w.environments.list(w.alice),[],'no unassigned environment is inferred from a held key');
  const outsider = await w.records.principals.createUser(w.admin,'合成无关成员');
  assert.deepEqual(await w.environments.list(outsider),[]);
  assert.deepEqual(await w.environments.list(w.admin),[],'management alone lists no unassigned environment');
  assert.equal(await leaseBytes(),before,'withdrawing and listing change no lease byte');
  const ctx = {now:()=>new Date(),deps:{leases:w.leases}} as unknown as EngineContext;
  const workflow = {pack:{id:'synthetic-workflow'},workflow:{leases:{prefix:'synthetic/',max_ttl_seconds:600}}} as LoadedWorkflow;
  assert.equal((await grantLeases(ctx,w.alice,workflow,[{op:'extend',keys:['synthetic/zone/allowed'],ttl_seconds:60}],ownRun,undefined)).length,1,'the booking rules, not the assignment, decide an extension');
  assert.equal((await grantLeases(ctx,w.alice,workflow,[{op:'release',keys:['synthetic/zone/allowed']}],ownRun,undefined)).length,1);
  assert.equal((await w.leases.holders(['synthetic/zone/other']))[0].released,false,'another holder is never released');
});

test('a disabled assigned environment stays listed as disabled and an expired hold is no occupancy', {timeout:60000}, async t => {
  let at = new Date('2026-11-14T00:00:00.000Z');
  const w = await world(t,()=>at);
  await w.registry.update(w.admin,w.second.id,{...w.second.source,resources:['synthetic/zone/hidden']});
  await w.records.authorizations.assignResource(w.admin,w.first.id,w.alice.id);
  await w.registry.disable(w.admin,w.first.id);
  const assigned = (await w.environments.list(w.alice))[0];
  assert.equal(assigned.assigned,true);assert.equal(assigned.can_use,false);assert.equal(assigned.enabled,false);
  assert.equal(assigned.missing.some(reason=>reason.includes('没有分配')),false);
  assert.equal((await w.leases.acquire({keys:['synthetic/zone/allowed'],prefix:'synthetic/',holder:{user:w.alice.id,run:'run_0'+'e'.repeat(25)},ttlSeconds:30,maxTtlSeconds:60})).ok,true);
  assert.equal((await w.environments.list(w.alice))[0].occupancy?.length,1);
  const before = (await w.db.query('SELECT to_jsonb(l) AS row FROM leases l ORDER BY key')).rows;
  at = new Date(at.getTime()+31_000);
  assert.deepEqual((await w.environments.list(w.alice))[0].occupancy,[],'an expired hold is not a live hold');
  assert.deepEqual((await w.db.query('SELECT to_jsonb(l) AS row FROM leases l ORDER BY key')).rows,before,'expiry filtering writes nothing');
});

test('overlapping and nested resource declarations list no unassigned provider', {timeout:60000}, async t=>{
  const w = await world(t);
  const key = 'synthetic/zone/allowed', child = key+'/child';
  await w.registry.update(w.admin,w.second.id,{...w.second.source,resources:[key,child]});
  const third = await w.registry.add(w.admin,{...definition('http://127.0.0.1:1/mcp'),target:'synthetic-never-assigned-parent',resources:['synthetic/zone']});
  await w.records.authorizations.assignResource(w.admin,w.first.id,w.alice.id);
  const run = 'run_0'+'f'.repeat(25);
  assert.equal((await w.leases.acquire({keys:[key,child],prefix:'synthetic/',holder:{user:w.alice.id,run},ttlSeconds:300,maxTtlSeconds:600})).ok,true);
  const listed = await w.environments.list(w.alice);
  assert.deepEqual(listed.map(row=>row.name),[w.first.source.target]);
  assert.equal(listed[0].occupancy?.length,1,'only the exact declared key is occupancy');
  const text = JSON.stringify(listed);
  for (const hidden of [w.second.source.target,third.source.target,w.first.id,w.second.id,third.id,w.alice.id,w.bob.id,w.team.id,key,child,'synthetic/zone']) assert.equal(text.includes(hidden),false,hidden);
  await w.records.authorizations.unassignResource(w.admin,w.first.id,w.alice.id);
  assert.deepEqual(await w.environments.list(w.alice),[]);
  assert.deepEqual(await w.environments.list(w.bob),[]);
});
