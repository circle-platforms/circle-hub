import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupJournal} from './testing/journal.ts';

test('C4.2 a successful lookup of a certified admission refusal closes the lost submission',async t=>{
  const c=await setupJournal({lost:true,rejected:true});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'target_rejected');assert.equal(state.frozen,false);
  const events=await c.service.journal.events(state.job);
  assert.ok(events.some(e=>e.body.detail.phase==='rejection'));
  assert.ok(c.calls.includes('close_slot'));assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
  const next=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(next.outcome,'target_rejected');assert.equal(c.calls.filter(n=>n==='send_blob').length,2);
});

for(const invalid of [{uncertified:true},{deviceReached:null},{identityChange:'epoch' as const}]) {
  test(`C4.2 a refusal lookup remains unresolved without all required facts ${JSON.stringify(invalid)}`,async t=>{
    const c=await setupJournal({lost:true,rejected:true,...invalid});t.after(()=>c.close());
    const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
    assert.equal(state.outcome,'unknown');assert.equal(state.frozen,true);
  });
}
