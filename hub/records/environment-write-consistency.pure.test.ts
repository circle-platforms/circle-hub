import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestEnvironment } from '../../contracts/api.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { definition } from '../dispatch/testing/definition.ts';
import { newId } from './ids.ts';
import { assertNoNewEnvironmentOverlap, EnvironmentWriteError } from './environment-write-consistency.ts';
import { resolveTestEnvironmentExecutorTarget, type TestEnvironmentVariableReader } from './test-environment-executor-target.ts';
import type { Transaction } from './api.ts';

const owner = newId('usr'), at = '2026-11-14T00:00:00.000Z';
function environment(name: string, prefixes: string[], keys: string[]) {
  return TestEnvironment.parse({ schema: 'test-environment@1', id: newId('env'), name, target: name, prefixes: prefixes.map(prefix => ({ prefix, owner, registered_at: at })), resources: keys.map(key => ({ key, owner, registered_at: at })), executors: [], enabled: true, missing_facts: [] });
}

test('new cross-environment exact keys, prefixes and both cross forms are refused', () => {
  for (const [candidate, other] of [
    [environment('a', [], ['pool/key']), environment('b', [], ['pool/key'])],
    [environment('a', ['pool/'], []), environment('b', ['pool/sub/'], [])],
    [environment('a', [], ['pool/sub/key']), environment('b', ['pool/'], [])],
    [environment('a', ['pool/'], []), environment('b', [], ['pool/sub/key'])],
  ]) assert.throws(() => assertNoNewEnvironmentOverlap(candidate, [other]), error => error instanceof EnvironmentWriteError && error.code === 'SUBMISSION_SCHEMA_VIOLATION');
});

test('same-object coverage, ordinary prefixes and unrelated old contradictions do not become a global repair precondition', () => {
  const candidate = environment('a', ['new/'], ['new/key']);
  const oldB = environment('b', ['old/'], []), oldC = environment('c', [], ['old/key']);
  assert.doesNotThrow(() => assertNoNewEnvironmentOverlap(candidate, [candidate, oldB, oldC]));
  const ordinary = TestEnvironment.parse({ ...candidate, id: newId('env'), name: null, target: null, resources: [], executors: [] });
  assert.doesNotThrow(() => assertNoNewEnvironmentOverlap(candidate, [ordinary]));
});

test('an existing overlap can be retained or narrowed during local repair but cannot expand', () => {
  const previous = environment('a', ['pool/sub/'], []), other = environment('b', ['pool/'], []);
  assert.doesNotThrow(() => assertNoNewEnvironmentOverlap({ ...previous, name: 'repaired-name' }, [other], previous));
  assert.doesNotThrow(() => assertNoNewEnvironmentOverlap({ ...previous, prefixes: [{ ...previous.prefixes[0], prefix: 'pool/sub/narrow/' }] }, [other], previous));
  assert.throws(() => assertNoNewEnvironmentOverlap({ ...previous, prefixes: [{ ...previous.prefixes[0], prefix: 'pool/' }] }, [other], previous), EnvironmentWriteError);
});

test('target overlays use the not-yet-written value or revocation instead of validating the old snapshot', async () => {
  const source = ExecutorSource.parse({ ...definition('http://127.0.0.1:9/mcp'), id: newId('exe'), target: '${var:SYNTHETIC_TARGET}', credential: '${secret:SYNTHETIC_KEY}' });
  const tx: Transaction = { transactionId: 1 };
  let reads = 0;
  const reader: TestEnvironmentVariableReader = { resolveVariables: async () => { reads++; return { value: { target: 'old-target' }, uses: [] }; } };
  const result = await resolveTestEnvironmentExecutorTarget(source, reader, tx, new Map([['SYNTHETIC_TARGET', { value: 'new-target' }]]));
  assert.equal(result.target, 'new-target');
  assert.deepEqual(result.uses, [], 'a proposed value does not invent an authorization digest');
  assert.equal(reads, 0);
  await assert.rejects(resolveTestEnvironmentExecutorTarget(source, reader, tx, new Map([['SYNTHETIC_TARGET', { revoked: true as const }]])), /候选变量撤回/);
  await assert.rejects(resolveTestEnvironmentExecutorTarget(source, reader, tx, new Map([['SYNTHETIC_TARGET', { value: 42 }]])), /不是字符串/);
  assert.equal(reads, 0);
});
