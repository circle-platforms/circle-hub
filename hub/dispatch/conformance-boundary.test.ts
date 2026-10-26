import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupJournal} from './testing/journal.ts';
test('conformance cannot submit administrator bytes or allocate an effect intent',async t=>{
 const c=await setupJournal({uncertified:true,admitExpired:true});t.after(()=>c.close());
 const state=await c.service.conformance(c.admin,c.executor.id);
 assert.equal(c.calls.filter(name=>name==='send_blob').length,0);
 const events=await c.service.journal.events(state.job);
 assert.equal(events.some(event=>['intent','probe_intent','probe_attempt'].includes(String(event.body.detail.phase))),false);
 assert.equal(state.outcome,'not_dispatched');assert.equal(state.frozen,false);
 assert.match(state.missing_fact!,/受限审计/);assert.match(state.next_action!,/登记/);
 assert.ok(state.result);
});
