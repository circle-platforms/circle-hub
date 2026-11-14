import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { definition } from '../dispatch/testing/definition.ts';
import { newId } from './ids.ts';
import { resolveTestEnvironmentExecutorTarget, type TestEnvironmentVariableReader } from './test-environment-executor-target.ts';
import type { Transaction } from './api.ts';

const tx: Transaction = { transactionId: 1 };
const source = ExecutorSource.parse({ ...definition('http://127.0.0.1:9/mcp'), id: newId('exe'), target: '${var:SYNTHETIC_TARGET}', credential: '${secret:SYNTHETIC_KEY}' });
const uses = [{ kind: 'var' as const, at: source.id + '#/target', name: 'SYNTHETIC_TARGET', decision: 'a'.repeat(64) }];

test('catalog target resolution sends only the formal target object and same transaction, never the credential or unrelated conditions', async () => {
  const before = structuredClone(source);
  const port: TestEnvironmentVariableReader = { resolveVariables: async (value, at, snapshot, supplied) => {
    assert.deepEqual(value, { target: source.target });
    assert.equal(at, source.id);
    assert.equal(snapshot, undefined);
    assert.equal(supplied, tx);
    return { value: { target: 'synthetic-bed' }, uses };
  } };
  assert.deepEqual(await resolveTestEnvironmentExecutorTarget(source, port, tx), { target: 'synthetic-bed', uses });
  assert.deepEqual(source, before, 'the original executor source is not rewritten');
});

test('literal targets do not access a variable reader', async () => {
  const port: TestEnvironmentVariableReader = { resolveVariables: async () => { throw new Error('unexpected variable read'); } };
  assert.deepEqual(await resolveTestEnvironmentExecutorTarget({ ...source, target: 'literal-target' }, port, tx), { target: 'literal-target', uses: [] });
});

test('ordinary target values are not coerced from numbers, booleans, null, arrays or objects', async () => {
  for (const target of [42, false, null, [], {}]) {
    const port: TestEnvironmentVariableReader = { resolveVariables: async () => ({ value: { target }, uses }) };
    await assert.rejects(resolveTestEnvironmentExecutorTarget(source, port, tx), /当前值不是字符串/);
  }
  for (const target of ['', 'x'.repeat(201)]) {
    const port: TestEnvironmentVariableReader = { resolveVariables: async () => ({ value: { target }, uses }) };
    await assert.rejects(resolveTestEnvironmentExecutorTarget(source, port, tx), /字符串不符合/);
  }
});

test('secret references are not accepted as a target-resolution shortcut', async () => {
  const port: TestEnvironmentVariableReader = { resolveVariables: async () => { throw new Error('secret reader must not be reached'); } };
  await assert.rejects(resolveTestEnvironmentExecutorTarget({ ...source, target: '${secret:SYNTHETIC_KEY}' }, port, tx), /这一处不许引用变量/);
});
