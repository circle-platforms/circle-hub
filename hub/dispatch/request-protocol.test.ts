import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';

test('submission binds the intent request and deadline and rejects a different echoed request', async t => {
  const c = await setup({ alter: (name, value) => name === 'send_blob' ? { ...value, request: 'different' } : value }); t.after(() => c.close());
  const status = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(status.frozen, true);
  const events = await c.service.journal.events(status.job);
  const intent = events.find(e => e.body.detail.phase === 'intent')!;
  const sent = c.endpoint.calls.find(e => e.params.name === 'send_blob')!.params.arguments as Record<string, unknown>;
  assert.equal(sent.request, intent.body.detail.request_id);
  assert.equal(sent.until, intent.body.detail.not_after);
  assert.ok(!events.some(e => e.body.detail.phase === 'receipt'));
});

test('certified pre-device refusals permit a new numbered attempt but device-reaching refusals keep the target frozen', async t => {
  for (const reached of [false, true]) {
    const c = await setup({ mode: 'reject', alter: (name, value) => name === 'send_blob' ? { ...value, phase: 'admission', touched: reached } : value }); t.after(() => c.close());
    const proof = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode('synthetic request journal certification'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: c.admin.id }, provenanceType: 'declared', visibility: { readers: [c.admin.id], admins: true, packs: [], shareable: false } });
    await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, premises: { request_journal: { version: '1', evidence: [`src:${proof.body.sha256}`] } }, receipt: { ...c.executor.definition.receipt, stage: '/phase', reached_device: '/touched', stages: { admission: 'target_rejected' } } });
    const result = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(result.outcome, reached ? 'unknown' : 'target_rejected');
    assert.equal(result.frozen, reached);
    if (!reached) {
      const current=await c.registry.get(c.executor.id);
      await c.registry.update(c.admin,c.executor.id,{...current!.definition,poll_ms:current!.definition.poll_ms+1});
      const next = await c.service.dispatch(c.admin, c.run, c.executor.id);
      const intents = await c.kit.store.findMany({ kind: 'action', key: 'dispatch.lineage', values: [c.run] });
      assert.ok(next.job !== result.job);
      const all = [...await c.service.journal.events(result.job), ...await c.service.journal.events(next.job)].filter(e => e.body.detail.phase === 'intent');
      assert.equal(all.length, 2); assert.equal(all[1].body.detail.request_id, String(all[0].body.detail.intent_key) + ':2');
    } else await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id));
  }
});

test('a lost reply is reconciled by request without resubmission or requiring negative certification', async t => {
  let c: Awaited<ReturnType<typeof setup>>;
  c = await setup({ mode: 'disconnect', extraTools: ['lookup_blob'], alter: (name, value) => {
    if (name !== 'lookup_blob') return value;
    const sent = c.endpoint.calls.find(e => e.params.name === 'send_blob')!.params.arguments as Record<string, unknown>;
    return { found: true, state: 'started', request: sent.request, digest: c.payload.body.sha256, key: 'synthetic-remote', touched: true };
  } }); t.after(() => c.close());
  const { DispatchService } = await import('./service.ts');
  c.service = new DispatchService({ ...c.service.options, sleep: async ms => { c.clock.ms += ms; } });
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition,
    allowed_tools: [...c.executor.definition.allowed_tools, 'lookup_blob'],
    calls: { ...c.executor.definition.calls, query: { tool: 'lookup_blob', arguments: { request: { $value: 'request_id' } } } },
    reconciliation: { found: '/found', state: '/state', request_id: '/request', sha256: '/digest', id: '/key', stage: '/phase', reached_device: '/touched', gateway_time: '/clock', gc_before: '/floor', time_scale_ms: 1000, map: { started: 'issued', stopped: 'proven_not_executed', refused: 'target_rejected' } } });
  const result = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(result.outcome, 'effective'); assert.equal(result.frozen, false);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
  assert.ok(c.calls.includes('lookup_blob'));
  assert.equal((await c.service.resume(c.admin,result.job)).outcome,'effective');
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 1);
});

test('absence proves nonexecution only beyond the deadline and within certified retention coverage', async t => {
  const { setupJournal } = await import('./testing/journal.ts');
  for (const options of [{absent:true},{absent:true,uncertified:true},{absent:true,floorAtDeadline:true},{absent:true,clockBeforeDeadline:true},{absent:true,clockAsText:true},{stopped:true},{wrongIdentity:true}]) {
    const c = await setupJournal({lost:true,...options}); t.after(()=>c.close());
    const result = await c.service.dispatch(c.admin,c.run,c.executor.id);
    const proven = !('uncertified' in options || 'floorAtDeadline' in options || 'clockBeforeDeadline' in options || 'clockAsText' in options || 'wrongIdentity' in options);
    assert.equal(result.outcome,proven ? 'proven_not_executed' : 'unknown'); assert.equal(result.frozen,!proven);
    assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
    await c.close();
  }
});

test('conformance collects four harmless request journal observations in one lease', async t => {
  const { setupJournal } = await import('./testing/journal.ts'); const c = await setupJournal({uncertified:true}); t.after(()=>c.close());
  const result = await c.service.conformance(c.admin,c.executor.id);
  const events = await c.service.journal.events(result.job);
  assert.equal(events.at(-1)!.body.detail.conformance_verified,true);
  assert.deepEqual(c.calls,['open_slot','lookup_blob','send_blob','send_blob','lookup_blob','close_slot']);
  assert.equal(events.some(e=>e.body.detail.phase==='intent'),false);
  assert.ok(result.result);
});

test('conformance cannot mistake a precheck refusal for expired-request admission enforcement',async t=>{
  const {setupJournal}=await import('./testing/journal.ts');const c=await setupJournal({uncertified:true,deadlinePrecheck:true});t.after(()=>c.close());
  const state=await c.service.conformance(c.admin,c.executor.id);
  assert.equal((await c.service.journal.events(state.job)).at(-1)!.body.detail.conformance_verified,false);
});

test('a recognized pending request is polled automatically without another submission',async t=>{
  const {setupJournal}=await import('./testing/journal.ts');const c=await setupJournal({lost:true,pendingReads:1});t.after(()=>c.close());
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'effective');assert.equal(state.frozen,false);
  assert.equal(c.calls.filter(n=>n==='lookup_blob').length,2);assert.equal(c.calls.filter(n=>n==='send_blob').length,1);
});
