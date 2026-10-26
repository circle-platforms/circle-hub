import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryRead, type ReadAttempt } from './retry-read.ts';

test('read retries use real bounded backoff and expose fixed reasons only', async () => {
  let calls = 0; const attempts: Array<ReadAttempt & { observedAt: number }> = [];
  const result = await retryRead(async () => { if (++calls < 3) throw new Error('SyntheticPrivateDetail'); return 'recovered'; }, () => null,
    attempt => attempts.push({ ...attempt, observedAt: performance.now() }));
  assert.equal(result, 'recovered'); assert.equal(calls, 3);
  assert.deepEqual(attempts.map(attempt => attempt.delayMs), [50, 100, 0]);
  assert.ok(attempts[1].observedAt - attempts[0].observedAt >= 45);
  assert.ok(attempts[2].observedAt - attempts[1].observedAt >= 95);
  assert.ok(!JSON.stringify(attempts).includes('SyntheticPrivateDetail'));
});
test('a permanent classified read failure is not retried', async () => {
  let calls = 0;
  const result = await retryRead(async () => { calls++; return 'invalid'; }, () => ({ reason: 'REFERENCE_UNRESOLVED', retry: false }));
  assert.equal(result, 'invalid'); assert.equal(calls, 1);
});
test('retry preserves a returned objects internal nonenumerable reason and its identity', async () => {
  const result = Object.defineProperty({}, 'reason', { value: 'integrity_unproven', enumerable: false }) as { reason: string }; let calls = 0;
  assert.equal(await retryRead(async () => { calls++; return result; }, () => ({ reason: 'integrity_unproven', retry: true })), result);
  assert.equal(calls, 3); assert.equal(result.reason, 'integrity_unproven');
});
test('an observer failure cannot abort retries and exhaustion keeps the original private exception', async () => {
  const error = new Error('SyntheticPrivateDetail'); let calls = 0;
  await assert.rejects(retryRead(async () => { calls++; throw error; }, () => null, () => { throw new Error('observer'); }), failure => failure === error);
  assert.equal(calls, 3);
});
