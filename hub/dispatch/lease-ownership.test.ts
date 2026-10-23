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
  await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id),/血缘/);
  assert.equal(c.calls.filter(name=>name==='send_blob').length,0);
});
