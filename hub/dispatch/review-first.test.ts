import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';

test('R01 a failed lease heartbeat during prechecks prevents intent and submission',async t=>{
  const c=await setup({mode:'heartbeat-failure',ttl:60,delay:{inspect_slot:160}});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(state.frozen,false);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
  const events=await c.service.journal.events(state.job);
  assert.ok(events.some(e=>e.body.detail.phase==='heartbeat' && e.body.detail.lease_interrupted));
  assert.equal(events.some(e=>e.body.detail.phase==='intent'),false);
});

test('R01 heartbeat failures after submission do not permanently stop renewal attempts',async t=>{
  let sent=false,pulses=0;
  const c=await setup({ttl:600,delay:{inspect_blob:500},onSubmit:async()=>{sent=true;},alter:(name,v)=>name==='touch_slot' && sent && ++pulses===1?{...v,ok:false}:v});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'effective');assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
  assert.ok(pulses>=2);
  const beats=(await c.service.journal.events(state.job)).filter(e=>e.body.detail.phase==='heartbeat');
  const failed=beats.findIndex(e=>e.body.detail.lease_interrupted===true);
  assert.ok(failed>=0 && beats.slice(failed+1).some(e=>e.body.result==='completed'));
});
