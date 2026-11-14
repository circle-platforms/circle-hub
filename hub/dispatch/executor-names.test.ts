import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorNames } from './executor-names.ts';
import { setup } from './testing/context.ts';
import { canonicalBytes, sha256Hex, WHOLE_HUB, type AuthorizationRecord } from '../records/api.ts';
import { ExecutorNameBinding, ExecutorStableName, EXECUTOR_NAME_PREFIX } from '../../contracts/api.ts';

test('explicit adoption adds only a name declaration without rewriting executor source or frozen run bytes',async t=>{
  const c=await setup();t.after(()=>c.close());const names=new ExecutorNames(c.kit);
  const before=canonicalBytes(c.detail.run),source=await c.registry.readSource(c.executor.id);
  assert.deepEqual(await names.list(c.admin),[]);
  const named=await names.assign(c.admin,c.executor.id,'synthetic-runner');
  assert.equal(named.created,true);assert.equal(named.binding.name,'synthetic-runner');
  assert.deepEqual(await c.registry.readSource(c.executor.id),source);
  assert.deepEqual(canonicalBytes(c.detail.run),before);
  assert.equal((await names.assign(c.admin,c.executor.id,'synthetic-runner')).created,false);
  assert.deepEqual(await names.list(c.admin),[named.binding]);
  assert.equal(c.calls.includes('send_blob'),false);
});

test('names are exact administrator declarations and cannot be synthesized from a target or internal id',async t=>{
  const c=await setup();t.after(()=>c.close());const names=new ExecutorNames(c.kit);
  await assert.rejects(names.assign(c.owner,c.executor.id,'synthetic-runner'));
  await assert.rejects(names.list(c.owner));
  for(const name of ['', ' synthetic-runner','synthetic-runner ',c.executor.id,c.owner.id])assert.equal(ExecutorStableName.safeParse(name).success,false);
  await assert.rejects(names.assign(c.admin,'exe_'+ '0'.repeat(26),'synthetic-runner'));
  assert.deepEqual(await names.list(c.admin),[]);
});

test('concurrent claims of the same name cannot bind two different executors',async t=>{
  const c=await setup();t.after(()=>c.close());const names=new ExecutorNames(c.kit);
  const second=await c.registry.add(c.admin,{...c.executor.source,id:undefined,target:c.executor.source.target});
  const claims=await Promise.allSettled([names.assign(c.admin,c.executor.id,'synthetic-shared-name'),names.assign(c.admin,second.id,'synthetic-shared-name')]);
  assert.equal(claims.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(claims.filter(result=>result.status==='rejected').length,1);
  assert.equal((await names.list(c.admin)).length,1);
});

test('an existing name is never silently changed or reused when its declaration is withdrawn',async t=>{
  const c=await setup();t.after(()=>c.close());const names=new ExecutorNames(c.kit);
  await names.assign(c.admin,c.executor.id,'synthetic-runner');
  await assert.rejects(names.assign(c.admin,c.executor.id,'synthetic-other'));
  await c.kit.store.withTransaction(tx=>c.kit.authorizations.configureResourceInTransaction(c.admin,EXECUTOR_NAME_PREFIX+c.executor.id,null,'synthetic withdrawal',tx,true));
  assert.deepEqual(await names.list(c.admin),[]);
  const second=await c.registry.add(c.admin,{...c.executor.source,id:undefined});
  await assert.rejects(names.assign(c.admin,second.id,'synthetic-runner'));
  assert.equal((await names.assign(c.admin,c.executor.id,'synthetic-runner')).created,true);
});

test('name bindings are digest-checked and never require secret material',async t=>{
  const c=await setup();t.after(()=>c.close());const names=new ExecutorNames(c.kit);
  Object.defineProperty(c.kit,'vault',{get(){throw new Error('business secret read is forbidden');}});
  await names.assign(c.admin,c.executor.id,'synthetic-runner');
  const row=await c.kit.store.find<AuthorizationRecord['body']>({kind:'authorization',key:'authz.key',value:`resource_config|${WHOLE_HUB}|${EXECUTOR_NAME_PREFIX+c.executor.id}`,newestFirst:true,limit:1});
  const bytes=await c.kit.objects.get(row.items[0].body.bound!);assert.ok(bytes);
  assert.equal(sha256Hex(bytes),row.items[0].body.bound);
  assert.equal(ExecutorNameBinding.parse(JSON.parse(Buffer.from(bytes).toString())).executor,c.executor.id);
  const get=c.kit.objects.get.bind(c.kit.objects);c.kit.objects.get=async(hash,tx)=>hash===row.items[0].body.bound?null:get(hash,tx);
  await assert.rejects(names.list(c.admin),/缺失|摘要/);
});

test('corrupt name bytes are not echoed in administrative diagnostics',async t=>{
  const c=await setup();t.after(()=>c.close());const names=new ExecutorNames(c.kit);
  const bytes=await c.kit.objects.put(Buffer.from('private-synthetic-not-json'),'application/json');
  await c.kit.authorizations.configureResource(c.admin,EXECUTOR_NAME_PREFIX+c.executor.id,bytes.sha256,'synthetic corruption');
  await assert.rejects(names.list(c.admin),error=>error instanceof Error&&/不合格式/.test(error.message)&&!error.message.includes('private-synthetic'));
});

test('new named executors share a target without sharing identity and a name conflict leaves no config or object rows',async t=>{
  const c=await setup();t.after(()=>c.close());const names=new ExecutorNames(c.kit);
  const first=await c.registry.add(c.admin,{...c.executor.source,id:undefined},'synthetic-first');
  const second=await c.registry.add(c.admin,{...c.executor.source,id:undefined},'synthetic-second');
  assert.notEqual(first.id,second.id);assert.equal(first.source.target,second.source.target);
  assert.deepEqual((await names.list(c.admin)).map(row=>row.name).sort(),['synthetic-first','synthetic-second']);
  const counts=async()=>({objects:(await c.db.query('SELECT count(*)::int AS n FROM objects')).rows[0].n,records:(await c.db.query('SELECT count(*)::int AS n FROM records')).rows[0].n});
  const before=await counts();
  await assert.rejects(c.registry.add(c.admin,{...c.executor.source,id:undefined},'synthetic-first'),/已经被占用/);
  assert.deepEqual(await counts(),before);
});
