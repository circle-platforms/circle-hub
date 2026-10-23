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
