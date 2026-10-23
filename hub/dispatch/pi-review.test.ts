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

test('PI04 an admitted conformance probe freezes the resources and never sends the second probe',async t=>{
  const c=await setupJournal({uncertified:true,admitExpired:true});t.after(()=>c.close());
  const state=await c.service.conformance(c.admin,c.executor.id);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
  assert.equal(state.outcome,'unknown');assert.equal(state.frozen,true);
  assert.match(state.missing_fact!,/探测|开始/);assert.match(state.next_action!,/dispose/);
  assert.ok((await c.service.list(c.admin,c.executor.id)).some(s=>s.job===state.job));
  const before=c.calls.filter(n=>n==='send_blob').length;
  await assert.rejects(c.service.conformance(c.admin,c.executor.id),/占用/);
  await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id),/占用/);
  await c.service.resume(c.admin,state.job);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,before);
  assert.ok(c.calls.filter(n=>n==='lookup_blob').length>=2);
  await c.service.dispose(c.admin,state.job,{choice:'mark_failed',reason:'synthetic operator confirmed physical recovery',acceptPossibleDuplicateEffects:true});
  assert.equal((await c.service.status(c.admin,state.job)).frozen,false);
});

test('PI04 a probe with a lost response remains frozen even before an unknown explanation is recorded',async t=>{
  const c=await setupJournal({uncertified:true,lost:true});t.after(()=>c.close());
  const state=await c.service.conformance(c.admin,c.executor.id);
  assert.equal(c.calls.filter(n=>n==='send_blob').length,1);assert.equal(state.frozen,true);
  const events=await c.service.journal.events(state.job);
  const read=c.service.journal.events.bind(c.service.journal);
  c.service.journal.events=async job=>job===state.job?events.filter(e=>!['unknown','complete'].includes(String(e.body.detail.phase))):read(job);
  assert.equal((await c.service.status(c.admin,state.job)).frozen,true);
});
