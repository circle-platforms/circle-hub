import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';

test('normal lifecycle stores intent before the one submission, observes twice, stores result and releases', async t => {
  const c = await setup(); t.after(() => c.close());
  const outcome = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(outcome.outcome, 'effective');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  assert.ok(c.calls.indexOf('inspect_slot') < c.calls.indexOf('send_blob'));
  assert.ok(c.calls.indexOf('close_slot') > c.calls.indexOf('read_blob'));
  const events = await c.service.journal.events(outcome.job);
  const intent = events.find(e => e.body.detail.phase === 'intent')!;
  assert.ok(intent.body.detail.intent_key);
  assert.equal(intent.body.detail.initiated_by, c.admin.id);
  assert.equal(intent.body.detail.on_behalf_of, c.owner.id);
  assert.equal(intent.body.detail.effect_class, 'job'); assert.equal(intent.body.detail.retry_safety, 'unsafe');
  assert.match(outcome.result!, /^src:[a-f0-9]{64}$/);
  assert.ok(events.findIndex(e => e.body.detail.phase === 'intent') < events.findIndex(e => e.body.detail.phase === 'receipt'));
  assert.ok(c.sawIntentAtSubmit);
  assert.equal((await import('../records/api.ts')).sha256Hex(c.submitted[0]), c.payload.body.sha256);
  assert.equal(new TextDecoder().decode(c.submitted[0]), 'synthetic verified bytes');
});

test('preflight refuses unmet package requirements, incorrect manifest, wrong lineage and short expiry without submitting', async t => {
  for (const mode of ['wrong-package', 'manifest', 'requirement', 'lineage', 'expiry']) {
    const c = await setup({ mode }); t.after(() => c.close());
    assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'not_dispatched');
    assert.equal(c.calls.filter(name => name === 'send_blob').length, 0);
  }
});

test('busy or failed read-only checks never write an intent and release only an acquired lease', async t => {
  for (const mode of ['busy', 'build', 'seats']) {
    const c = await setup({ mode }); t.after(() => c.close());
    const outcome = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(outcome.outcome, 'not_dispatched'); assert.equal(outcome.frozen, false);
    assert.equal(c.calls.filter(n => n === 'send_blob').length, 0);
    assert.equal(c.calls.includes('close_slot'), mode !== 'busy');
    assert.ok(!(await c.service.journal.events(outcome.job)).some(e => e.body.detail.phase === 'intent'));
  }
});

test('intent storage failure rolls back the business key and never submits', async t => {
  const c = await setup(); t.after(() => c.close());
  const put = c.kit.store.put.bind(c.kit.store);
  c.kit.store.put = async (input, tx) => {
    if (input.kind === 'action' && (input.body as any)?.detail?.phase === 'intent') throw new Error('synthetic intent storage failure');
    return put(input, tx);
  };
  const outcome = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(outcome.outcome, 'not_dispatched');
  assert.equal(await c.kit.store.getByKey('action', `dispatch.bytes:${c.payload.body.sha256}:1`), null);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 0);
  assert.ok(c.calls.includes('close_slot'));
});

test('plan_run must equal the verification predecessor and cannot be omitted', async t => {
  for (const value of [undefined, 'run_0123456789abcdefghjkmnpqrs']) {
    const c = await setup(); t.after(() => c.close());
    const proof = c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as any;
    proof.plan_run = value;
    assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'not_dispatched');
    assert.equal(c.calls.includes('send_blob'), false);
  }
});

test('wrapped artifact storage proves raw precheck bytes are committed before conditions run', async t => {
  const c = await setup(); t.after(() => c.close());
  let committed = false; const ingest = c.kit.artifacts.ingest.bind(c.kit.artifacts);
  c.kit.artifacts.ingest = async input => {
    const source = await ingest(input);
    if ('read' in input.origin && input.origin.read.object.endsWith(':precheck')) {
      assert.ok(await c.kit.store.get(source.digest)); committed = true;
    }
    return source;
  };
  const conditions = (c.service as any).conditions.bind(c.service);
  (c.service as any).conditions = (...args: unknown[]) => { assert.equal(committed, true); return conditions(...args); };
  assert.equal((await c.service.dispatch(c.admin, c.run, c.executor.id)).outcome, 'effective');
});

test('dispatch uses the latest accepted validation without relabeling an unrelated rejected submission', async t => {
  const c = await setup(); t.after(() => c.close());
  c.detail.submissions.push({ record: 'f'.repeat(64), received_at: c.now().toISOString(), acceptance: 'not_accepted', errors: [], result: null });
  assert.equal((await c.service.dispatch(c.admin, c.run, c.executor.id)).outcome, 'effective');
});

test('proof selects the declared function and ignores catalog and quote facts in the same requirement', async t => {
  const c = await setup(); t.after(() => c.close());
  const row = c.detail.latest!.result.partitions.delivered[0].requirements[0];
  const proof = row.claims[0];
  for (const id of ['catalog@1', 'quote@1']) row.claims.push({ ...structuredClone(proof), warrant: { ...proof.warrant, id }, statement: { verdict: 'support', text: '合成独立核对事实', data: { other: id } } });
  assert.equal((await c.service.dispatch(c.admin, c.run, c.executor.id)).outcome, 'effective');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
});


test('a different function cannot substitute for the declared verification function', async t => {
  const c = await setup(); t.after(() => c.close());
  c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].warrant.id = 'synthetic.other@1';
  assert.equal((await c.service.dispatch(c.admin,c.run,c.executor.id)).outcome,'not_dispatched');
  assert.equal(c.calls.includes('send_blob'), false);
});

test('verification support expiring during prechecks is rechecked before committing any intent',async t=>{
  let c:Awaited<ReturnType<typeof setup>>;
  c=await setup({alter:(name,value)=>{if(name==='inspect_slot')c.clock.ms+=2000;return value;}});t.after(()=>c.close());
  c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].validity.expires_at=new Date(c.clock.ms+1000).toISOString();
  const state=await c.service.dispatch(c.admin,c.run,c.executor.id);
  assert.equal(state.outcome,'not_dispatched');assert.equal(c.calls.filter(n=>n==='send_blob').length,0);
  assert.equal((await c.service.journal.events(state.job)).some(e=>e.body.detail.phase==='intent'),false);
});
