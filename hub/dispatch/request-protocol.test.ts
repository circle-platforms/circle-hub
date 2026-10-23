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
