import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';

test('standalone precheck acquires, reads and releases without an intent or submission', async t => {
  const c = await setup(); t.after(() => c.close());
  const state = await c.service.precheck(c.admin, c.executor.id);
  const events = await c.service.journal.events(state.job);
  assert.ok(events.some(e => e.body.detail.readonly_verified === true));
  assert.ok(c.calls.includes('open_slot') && c.calls.includes('inspect_slot') && c.calls.includes('close_slot'));
  assert.equal(c.calls.includes('send_blob'), false);
  assert.equal(events.some(e => e.body.detail.phase === 'intent'), false);
});

test('failed read-only precheck releases the lease and records not-dispatched, never unknown', async t => {
  const c = await setup({ mode: 'build' }); t.after(() => c.close());
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched'); assert.equal(state.frozen, false);
  assert.ok(c.calls.includes('close_slot'));
  assert.ok((await c.service.journal.events(state.job)).some(e => e.body.detail.readonly_verified === false));
});
