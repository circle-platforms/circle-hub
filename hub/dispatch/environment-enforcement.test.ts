import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DispatchService } from './service.ts';
import { setup } from './testing/context.ts';

function permissionSpy() {
  let calls=0;
  return { port:{
    canUse:async()=>{calls++;throw new Error('the staged-off assignment guard must not run');},
    permission:async()=>{calls++;throw new Error('the staged-off transaction guard must not run');},
  }, get calls(){return calls;} };
}

for(const flag of [undefined,false] as const)test(`explicit stage-off ${String(flag)} preserves established dispatch without consulting new assignment permissions`,async t=>{
  const c=await setup();t.after(()=>c.close());
  await c.kit.authorizations.unassignResource(c.admin,c.executor.id,c.environmentTeam.id);
  assert.equal(await c.environmentAccess.canUse(c.owner,c.executor.id),false,'the new policy really would deny this existing user');
  const spy=permissionSpy();
  const service=new DispatchService({...c.service.options,enforceEnvironmentAssignments:flag,environmentAccess:spy.port});
  const state=await service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'effective');assert.equal(c.calls.filter(name=>name==='send_blob').length,1);
  await assert.rejects(service.dispatch(c.admin,c.run,c.executor.id),/已有派发意图|已派发成功/);
  assert.equal(c.calls.filter(name=>name==='send_blob').length,1,'turning off the new policy does not turn off durable deduplication');
  assert.equal(spy.calls,0);
});

test('stage-off never disables the existing administrator boundary',async t=>{
  const c=await setup();t.after(()=>c.close());const spy=permissionSpy();
  const service=new DispatchService({...c.service.options,enforceEnvironmentAssignments:false,environmentAccess:spy.port});
  await assert.rejects(service.dispatch(c.owner,c.run,c.executor.id));
  assert.equal(c.calls.length,0);assert.equal(spy.calls,0);
});

test('stage-off never bypasses the frozen workflow and verified-input release checks',async t=>{
  const c=await setup({mode:'wrong-package'});t.after(()=>c.close());const spy=permissionSpy();
  const service=new DispatchService({...c.service.options,enforceEnvironmentAssignments:false,environmentAccess:spy.port});
  const state=await service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(state.error_code,'EFFECT_RELEASE_UNMET');
  assert.equal(c.calls.length,0);assert.equal(spy.calls,0);
});

for(const mode of ['lineage','expiry'] as const)test(`stage-off preserves existing ${mode} lease protection`,async t=>{
  const c=await setup({mode});t.after(()=>c.close());const spy=permissionSpy();
  if(mode==='expiry')c.clock.ms+=2000;
  const service=new DispatchService({...c.service.options,enforceEnvironmentAssignments:false,environmentAccess:spy.port});
  const state=await service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.error_code,'LEASE_UNAVAILABLE');assert.equal(state.outcome,'not_dispatched');
  assert.equal(c.calls.length,0);assert.equal(spy.calls,0);
});

test('strong assignment-policy fixtures explicitly enable the new guard and retain denial assertions',async t=>{
  const c=await setup();t.after(()=>c.close());
  assert.equal(c.service.options.enforceEnvironmentAssignments,true);
  await c.kit.authorizations.unassignResource(c.admin,c.executor.id,c.environmentTeam.id);
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.error_code,'SOURCE_NOT_PERMITTED');assert.equal(state.outcome,'not_dispatched');
  assert.equal(c.calls.length,0);
});
