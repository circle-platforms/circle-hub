import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryFunction } from './retry.ts';
import { SandboxError } from './errors.ts';

for (const [optIn, limit, expected] of [[false, 'time', 1], [true, 'cpu', 1], [true, 'time', 2]] as const) {
  test(`timeout retry optIn=${optIn} limit=${limit} has ${expected} attempts`, async () => {
    let calls = 0; const attempts: unknown[] = [];
    const error = new SandboxError('SANDBOX_TIMEOUT', { limit });
    await assert.rejects(retryFunction(async () => { calls++; throw error; }, 200,
      attempt => attempts.push(attempt), { retryWallTimeout: optIn }), value => value === error);
    assert.equal(calls, expected); assert.equal(attempts.length, expected);
  });
}
