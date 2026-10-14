import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { setup } from './harness.ts';

test('Act 1: authenticated identity, scope, tenant, expiration and bounded bodies', async t => {
  const h = await setup(t);
  const unauth = await h.raw('/v1/tasks/submit', { body: { principal: 'admin', role: 'admin' } });
  assert.equal(unauth.status, 401);
  await h.reject('/v1/tasks/submit', { scopeId: 'scp_lab', title: 'Forged identity', idempotencyKey: 'forged-identity',
    principal: 'prn_admin', role: 'admin', input: {} }, 'FORBIDDEN_SCOPE', 'limited');
  const task = await h.request('/v1/tasks/submit', { scopeId: 'scp_lab', title: 'Honest identity', input: {},
    idempotencyKey: 'honest-identity', principal: 'prn_admin', role: 'admin' });
  assert.equal(task.principalId, 'prn_alice');
  await h.reject(`/v1/tasks/${task.taskId}/status`, undefined, 'FORBIDDEN_SCOPE', 'outsider');
  const token = await h.login('alice', 20); await delay(40);
  const expired = await h.raw(`/v1/tasks/${task.taskId}/status`, { token });
  assert.equal(expired.body.error.code, 'UNAUTHENTICATED');
  const large = await h.raw('/v1/tasks/submit', { token: await h.login(), body: { input: 'x'.repeat(70_000) } });
  assert.equal(large.body.error.code, 'BODY_TOO_LARGE');
  await h.reject('/v1/admin/tasks', undefined, 'FORBIDDEN_ACTION','limited');
});
