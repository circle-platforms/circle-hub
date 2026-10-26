import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';
import type { JobBinding } from './journal.ts';

test('the trusted resource query includes unfinished jobs and freezes, but excludes read-only and settled jobs', async t => {
  const c = await setup(); t.after(() => c.close());
  const key = c.executor.definition.resources[0]!;
  const binding: JobBinding = { job: 'synthetic-pending', initiated_by:c.admin.id, executor:c.executor.id,
    executor_digest:c.executor.digest, target_key:'synthetic', input:null, user:c.owner.id, resources:[key] };
  await c.service.journal.append(binding,'reservation','validate','completed',{binding});
  assert.deepEqual(await c.service.activeLeaseJobs([key]), [{key,job:binding.job}]);
  await c.service.journal.append(binding,'complete','validate','completed',{done:true});
  assert.deepEqual(await c.service.activeLeaseJobs([key]), []);
  const readOnly = {...binding,job:'synthetic-read-only'};
  await c.service.journal.append(readOnly,'reservation','validate','completed',{binding:readOnly,read_only:true});
  assert.deepEqual(await c.service.activeLeaseJobs([key]), []);
});

test('an unbounded current holder passes the full synthetic dispatch lifecycle', async t => {
  const c = await setup(); t.after(() => c.close());
  const keys = c.executor.definition.resources;
  const holder = {user:c.owner.id,run:c.run};
  assert.ok((await c.leases.release({keys,holder})).ok);
  assert.ok((await c.leases.acquire({keys,holder,prefix:'synthetic/'})).ok);
  assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'effective');
});

test('owner release increments the fence and rejects the former lineage before a synthetic executor submission', async t => {
  const c=await setup();t.after(()=>c.close());
  const owner=await c.kit.principals.createUser(c.admin,'合成登记主人');
  assert.ok((await c.leases.register({prefix:'synthetic/device/',declaredPrefix:'synthetic/',owner:owner.id,by:owner.id,reason:'合成登记'})).ok);
  const keys=c.executor.definition.resources;
  const before=await c.leases.holderSnapshot(keys);
  assert.ok((await c.leases.forceRelease({keys,by:owner.id,owner:owner.id,reason:'合成主人收回'})).ok);
  const after=await c.leases.holderSnapshot(keys);
  assert.ok(after.every((row,i)=>row.fencing>before[i]!.fencing&&row.released));
  assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'not_dispatched');
  assert.equal(c.calls.filter(name=>name==='send_blob').length,0);
});

test('a force release and a new reservation serialize through the same durable lock',{timeout:15000},async t=>{
  const c=await setup();t.after(()=>c.close());
  const owner=await c.kit.principals.createUser(c.admin,'合成并发主人');
  const keys=c.executor.definition.resources;
  assert.ok((await c.leases.register({prefix:'synthetic/device/',declaredPrefix:'synthetic/',owner:owner.id,by:owner.id,reason:'合成登记'})).ok);
  let checked!:()=>void;const checkReached=new Promise<void>(resolve=>checked=resolve);
  let release!:()=>void;const pause=new Promise<void>(resolve=>release=resolve);t.after(()=>release());
  const forcing=c.leases.forceRelease({keys,by:owner.id,owner:owner.id,reason:'合成并发释放',guard:async()=>{
    assert.deepEqual(await c.service.activeLeaseJobs(keys),[]);checked();await pause;
  }});
  await Promise.race([checkReached,forcing.then(()=>{throw new Error('force release skipped its atomic job guard');})]);
  let arrived!:()=>void;const reserving=new Promise<void>(resolve=>arrived=resolve);
  const lock=c.leases.withMutationLock.bind(c.leases);
  c.leases.withMutationLock=async fn=>{arrived();return lock(fn);};
  let reserved=false;
  const dispatching=c.service.dispatch(c.admin,c.run,c.executor.id,()=>{reserved=true;});
  const rejected=assert.rejects(dispatching,/围栏|血缘/);
  await reserving;
  assert.equal(reserved,false);assert.equal(c.calls.length,0);
  release();assert.ok((await forcing).ok);await rejected;
  assert.equal(reserved,false);assert.equal(c.calls.filter(name=>name==='send_blob').length,0);
});

test('a committed reservation wins the release race and the owner guard leaves its lease unchanged',{timeout:15000},async t=>{
  let finishTarget!:()=>void;const targetWait=new Promise<void>(resolve=>finishTarget=resolve);t.after(()=>finishTarget());
  const c=await setup({onSubmit:async()=>targetWait});t.after(()=>c.close());
  const owner=await c.kit.principals.createUser(c.admin,'合成等待主人');const keys=c.executor.definition.resources;
  assert.ok((await c.leases.register({prefix:'synthetic/device/',declaredPrefix:'synthetic/',owner:owner.id,by:owner.id,reason:'合成登记'})).ok);
  const before=await c.leases.holderSnapshot(keys);
  let committed!:()=>void;const commitReached=new Promise<void>(resolve=>committed=resolve);
  let releaseReservation!:()=>void;const reservationWait=new Promise<void>(resolve=>releaseReservation=resolve);t.after(()=>releaseReservation());
  const lock=c.leases.withMutationLock.bind(c.leases);
  c.leases.withMutationLock=fn=>lock(async tx=>{const value=await fn(tx);committed();await reservationWait;return value;});
  const dispatching=c.service.dispatch(c.admin,c.run,c.executor.id);
  await commitReached;
  const forcing=c.leases.forceRelease({keys,by:owner.id,owner:owner.id,reason:'合成并发释放',guard:async()=>{
    const jobs=await c.service.activeLeaseJobs(keys);if(jobs.length)throw new Error('unfinished synthetic job');
  }});
  const refused=assert.rejects(forcing,/unfinished synthetic job/);
  releaseReservation();await refused;
  assert.deepEqual(await c.leases.holderSnapshot(keys),before);
  finishTarget();assert.equal((await dispatching).outcome,'effective');
});

test('verified legacy record notes are not mistaken for missing job integrity',async t=>{
  const c=await setup();t.after(()=>c.close());const key=c.executor.definition.resources[0]!;
  const binding:JobBinding={job:'synthetic-legacy-pending',initiated_by:c.admin.id,executor:c.executor.id,executor_digest:c.executor.digest,target_key:'synthetic',input:null,user:c.owner.id,resources:[key]};
  await c.service.journal.append(binding,'reservation','validate','completed',{binding});
  const targets=c.service.journal.targets.bind(c.service.journal);const events=c.service.journal.events.bind(c.service.journal);
  c.service.journal.targets=async keys=>(await targets(keys)).map(row=>({...row,integrity_note:'正文不是规范写法、内容与摘要一致'}));
  c.service.journal.events=async job=>(await events(job)).map(row=>({...row,integrity_note:'正文不是规范写法、内容与摘要一致'}));
  assert.deepEqual(await c.service.activeLeaseJobs([key]),[{key,job:binding.job}]);
  c.service.journal.targets=async()=>{throw new Error('synthetic integrity unavailable');};
  await assert.rejects(c.service.activeLeaseJobs([key]),/synthetic integrity unavailable/);
});
