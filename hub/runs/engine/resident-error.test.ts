import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '../../rules/sandbox/errors.ts';
import { residentFailure, RESIDENT_UNAVAILABLE_MESSAGE } from '../../rules/sandbox/resident.ts';
import { builderFailure } from './evaluate.ts';

test('a subject builder discloses the unobserved resident fact and its next step', () => {
  const failure = residentFailure(null, 256, 1); assert.ok(failure);
  const error = new SandboxError(failure.code, failure.detail, {}, RESIDENT_UNAVAILABLE_MESSAGE);
  const result = builderFailure({ id: 'synthetic' } as never, error);
  assert.equal(result.verdict, 'unknown');
  assert.match(result.missing!, /内存观测/);
  assert.match(result.missing!, /下一步/);
  assert.equal(result.data?.sandbox, 'SANDBOX_UNAVAILABLE');
});
