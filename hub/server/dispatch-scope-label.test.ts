import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DispatchAttemptScopeSchema } from '../../contracts/api.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { dispatchScopeLabel } from './dispatch-scope-label.ts';

test('formal dispatch labels identify the actual round without printing internal job identities', () => {
  const job = 'a'.repeat(64);
  for (const round of [1, 2]) {
    const scope = DispatchAttemptScopeSchema.parse({ operation: 'dispatch', job, round });
    assert.equal(dispatchScopeLabel(scope), `第${round}轮${labelOf('dispatch_operation', 'dispatch')}`);
    assert.equal(dispatchScopeLabel(scope).includes(job), false);
  }
});

test('conformance uses its declared operation without synthesizing a round', () => {
  const scope = DispatchAttemptScopeSchema.parse({ operation: 'conformance', job: 'b'.repeat(64) });
  assert.equal(dispatchScopeLabel(scope), labelOf('dispatch_operation', 'conformance'));
  assert.equal(dispatchScopeLabel(scope).includes('轮'), false);
});
