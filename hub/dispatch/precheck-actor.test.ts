import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './testing/context.ts';

test('the generic precheck fixture explicitly grants its actual administrator actor', { timeout: 60000 }, async t => {
  const c = await setup(); t.after(() => c.close());
  assert.equal(await c.environmentAccess.canUse(c.admin, c.executor.id), true);
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(state.job_facts.operation, 'precheck');
  assert.equal(state.job_facts.readonly_verified, true);
  assert.equal(state.dispatch_attempt, undefined);
  assert.ok(c.calls.includes('inspect_slot'));
  assert.equal(c.calls.includes('send_blob'), false);
});

test('administrator role alone never bypasses the explicit precheck environment assignment', { timeout: 60000 }, async t => {
  const c = await setup(); t.after(() => c.close());
  await c.kit.teams.remove(c.admin, c.environmentTeam.id, c.admin.id);
  assert.equal(await c.environmentAccess.canUse(c.admin, c.executor.id), false);
  assert.equal(await c.environmentAccess.canUse(c.owner, c.executor.id), true, 'the runner retains its own grant');
  const state = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(state.job_facts.admission_error?.code, 'SOURCE_NOT_PERMITTED');
  assert.equal(state.dispatch_attempt, undefined);
  assert.deepEqual(c.calls, []);
});
