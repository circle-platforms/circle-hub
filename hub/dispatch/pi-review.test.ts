import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupJournal} from './testing/journal.ts';

test('PI03 conformance never uses target wall-clock order to certify a sequence protocol',async t=>{
  const c=await setupJournal({uncertified:true,clockLagMs:2000});t.after(()=>c.close());
  const state=await c.service.conformance(c.admin,c.executor.id);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
  assert.equal(state.outcome,'not_dispatched');assert.equal(state.frozen,false);
  assert.match(state.missing_fact!,/序号回收拒收/);
  assert.match(state.next_action!,/受限审计/);
});

for(const mode of [{admitExpired:true},{lost:true}])test('PI04 conformance never attempts an unverified write even when the target would admit or lose it',async t=>{
 const c=await setupJournal({uncertified:true,...mode});t.after(()=>c.close());
 const state=await c.service.conformance(c.admin,c.executor.id);
 assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
 assert.equal(state.outcome,'not_dispatched');assert.equal(state.frozen,false);
 assert.match(state.missing_fact!,/受限审计/);assert.match(state.next_action!,/登记/);
 assert.equal((await c.service.journal.events(state.job)).some(e=>e.body.detail.phase==='probe_intent'),false);
});

test('PI05 a build-only definition without per-seat probes or a denied-tool declaration cannot dispatch',async t=>{
  const {setup}=await import('./testing/context.ts');const {registrationMissing}=await import('./definition.ts');
  for(const missing of ['probes','refused_tools'] as const) {
    const c=await setup();t.after(()=>c.close());const d=structuredClone(c.executor.definition);
    if(missing==='probes')delete d.probes;else d.refused_tools=[];
    d.conditions=[{pointer:'/build',equals:{$value:'build'}}];
    await c.registry.update(c.admin,c.executor.id,d);
    assert.ok(registrationMissing(d).includes(missing));
    await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id),/登记缺事实/);
    assert.equal(c.calls.includes('send_blob'),false);
    await c.close();
  }
});

test('PI05 every manifest device must have a distinct probe seat before submission',async t=>{
  const {setup}=await import('./testing/context.ts');const c=await setup();t.after(()=>c.close());
  await c.registry.update(c.admin,c.executor.id,{...c.executor.definition,probes:{...c.executor.definition.probes!,seats:[c.executor.definition.probes!.seats[0]]}});
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.includes('send_blob'),false);
});
