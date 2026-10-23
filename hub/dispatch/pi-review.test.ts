import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setupJournal} from './testing/journal.ts';

test('PI03 conformance sends nothing until the target clock proves expiry with the declared margin',async t=>{
  const c=await setupJournal({uncertified:true,clockLagMs:2000});t.after(()=>c.close());
  const state=await c.service.conformance(c.admin,c.executor.id);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
  assert.equal(state.outcome,'not_dispatched');assert.equal(state.frozen,false);
  assert.match(state.missing_fact!,/目标时刻未越过探测截止/);
  assert.match(state.next_action!,/时钟/);
});
