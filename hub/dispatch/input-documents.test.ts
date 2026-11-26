import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../records/api.ts';
import { setup } from './testing/context.ts';
import { inspectInput } from './proof.ts';
import { ExecutorRegistry } from './executors.ts';
import { releaseNextStep } from './refusal-text.ts';

test('registering or updating document bindings accepts only slots marked in the declared workflow version', async t => {
  const c = await setup(); t.after(() => c.close());
  const inputs = [{slot:'rules',executor_document:true as const},{slot:'settings',executor_document:true as const},{slot:'inventory'}];
  const refs: string[] = [];
  const registry = new ExecutorRegistry(c.kit, async ref => { refs.push(ref); return inputs; });
  const proof = {...c.executor.source.proof, warrant_id:c.executor.source.proof.package+'.verify@2.1.0'};
  const base = {...c.executor.source, proof};
  for (const slot of ['inventory','other']) {
    const invalid = {...base,input_documents:{[slot]:'synthetic-doc'}};
    const refused = (error:unknown) => error instanceof Error && [slot,'rules','settings'].every(word=>error.message.includes(word));
    await assert.rejects(registry.add(c.admin,invalid),refused);
    await assert.rejects(registry.update(c.admin,c.executor.id,invalid),refused);
  }
  assert.equal((await registry.readSource(c.executor.id))!.digest,c.executor.digest);
  assert.equal((await registry.sources(c.admin)).length,1);
  assert.ok(await registry.add(c.admin,{...base,input_documents:{settings:'some-settings'}}));
  assert.deepEqual([...new Set(refs)],[proof.package+'@2.1.0']);
});

test('each active booking selects the documents of the executor whose resources it holds', async t => {
  const c = await setup();
  t.after(() => c.close());
  const registry = new ExecutorRegistry(c.kit, async () => [{slot:'rules',executor_document:true},{slot:'profile',executor_document:true}]);
  const pack = c.executor.definition.proof.package;
  const digest = c.executor.definition.manifest_sha256!;
  const current = 'b'.repeat(64);
  const first = { ...c.executor.source, input_documents: { rules: 'rules-a', profile: 'profile-a' } };
  const second = { ...first, target: 'other', resources: ['synthetic/other'], input_documents: { rules: 'rules-b', profile: 'profile-b' } };
  await registry.update(c.admin, c.executor.id, first);
  await registry.add(c.admin, second);
  await registry.add(c.admin, {...first, manifest_sha256:'f'.repeat(64)});
  for (const name of ['rules-a', 'rules-b', 'profile-a', 'profile-b']) {
    await c.kit.pointers.move({name:'doc:'+name, expected:null, next:current, by:c.admin});
  }
  const other = newId('run');
  const granted = await c.leases.acquire({keys:second.resources, prefix:'synthetic/', holder:{user:c.owner.id,run:other}, ttlSeconds:3600,maxTtlSeconds:3600});
  assert.ok(granted.ok);
  for (const [run, definition] of [[c.run,first],[other,second]] as const) {
    const holders = await c.leases.holderSnapshot(definition.resources);
    const detail = { ...c.detail.run, run, leases:[{lease:holders[0]!.lease, keys:definition.resources, until:holders[0]!.expires_at}],
      sources:c.detail.run.sources.map(source => source.reference === 'src:'+digest ? {...source,external:'doc:doc:inventory@'+digest} : source) };
    const result = await registry.bookingDocuments(c.owner, detail, pack, c.leases,c.now(),()=>{});
    assert.deepEqual(result,[{inputs:{rules:'doc:doc:'+definition.input_documents.rules+'@'+current,profile:'doc:doc:'+definition.input_documents.profile+'@'+current},manifest:'doc:doc:inventory@'+digest}]);
    const noLease = {code:'SOURCE_ABSENT',path:'/booking/run',message:'这次预订没有当前账户持有的有效租约',fix:'请重新预订测试环境'};
    assert.deepEqual(await registry.bookingDocuments(c.admin,detail,pack,c.leases,c.now(),()=>{}),noLease);
    const expired = new Date(Date.parse(holders[0]!.expires_at!));
    assert.deepEqual(await registry.bookingDocuments(c.owner,detail,pack,c.leases,expired,()=>{}),noLease);
    await c.leases.release({keys:definition.resources, holder:{user:c.owner.id,run}});
    assert.deepEqual(await registry.bookingDocuments(c.owner,detail,pack,c.leases,c.now(),()=>{}),noLease);
  }
});

test('the effect boundary checks the frozen document name even when the bytes match, without comparing to the current revision', async t => {
  const c = await setup();
  t.after(() => c.close());
  const registry = new ExecutorRegistry(c.kit, async () => [{slot:'rules',executor_document:true}]);
  const slot = 'rules';
  const frozen = 'a'.repeat(64);
  await c.kit.pointers.move({name:'doc:rules-a',expected:null,next:frozen,by:c.admin});
  await c.kit.pointers.move({name:'doc:rules-a',expected:frozen,next:'b'.repeat(64),by:c.admin});
  const definition = {...c.executor.definition, input_documents:{[slot]:'rules-a'}};
  const source = {...c.detail.run.sources[0]!,slot,external:'doc:doc:rules-a@'+frozen,reference:'src:'+frozen};
  c.detail.run.sources.push(source);
  const inspect = () => inspectInput(c.admin,c.run,definition,c.kit,c.runs,c.workflows,c.now());
  assert.ok((await inspect()).input, 'the run keeps its frozen revision');
  source.external = 'doc:doc:rules-b@'+frozen;
  const refused = await inspect();
  assert.equal(refused.input, undefined);
  const check = refused.checks.find(check => check.condition === 'proof.input_document.rules')!;
  assert.equal(check.satisfied,false);
  assert.equal(releaseNextStep(check,{callerIsAdmin:false}),'按测试环境声明的文档重新开始运行');
  await registry.update(c.admin,c.executor.id,{...c.executor.source,input_documents:definition.input_documents});
  const automatic = await c.service.dispatchAccepted(c.run);
  assert.equal(automatic.started,false);
  assert.match(automatic.reason ?? '',/按测试环境声明的文档重新开始运行/);
  const job = await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(job.outcome,'not_dispatched');
  const refusal = (await c.service.journal.events(job.job)).find(event => event.body.detail.phase === 'boundary_refused');
  assert.ok(refusal);
  assert.equal(refusal.body.detail.correctable,undefined);
  assert.equal(c.submitted.length,0);
});
