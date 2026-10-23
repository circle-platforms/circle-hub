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
  assert.equal(intent.body.detail.effect_class, 'job'); assert.equal(intent.body.detail.retry_safety, 'unsafe');
  assert.match(outcome.result!, /^src:[a-f0-9]{64}$/);
  assert.ok(events.findIndex(e => e.body.detail.phase === 'intent') < events.findIndex(e => e.body.detail.phase === 'receipt'));
  assert.ok(c.sawIntentAtSubmit);
});

test('preflight refuses unmet package requirements, incorrect manifest, wrong lineage and short expiry without submitting', async t => {
  for (const mode of ['wrong-package', 'manifest', 'requirement', 'lineage', 'expiry']) {
    const c = await setup({ mode }); t.after(() => c.close());
    await assert.rejects(c.service.dispatch(c.admin, c.run, c.executor.id));
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
  assert.equal(await c.kit.store.getByKey('action', `dispatch.bytes:${c.payload.body.sha256}`), null);
  assert.equal(c.calls.filter(n => n === 'send_blob').length, 0);
  assert.ok(c.calls.includes('close_slot'));
});
