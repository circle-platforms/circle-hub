import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertOperationFields, CAPTURED_GROUND, declarationGroundRefusal, UNKNOWN_GROUND } from './declaration-grade.ts';
import { KnowledgeError } from './errors.ts';

test('operation target scanning handles 180000 siblings without spreading them onto the stack', () => {
  const input = { schema: 'fed-observation@1', device: 'device0', values: Array.from({ length: 180_000 }, (_, index) => index) };
  assert.doesNotThrow(() => assertOperationFields(input));
});

test('operation target scanning has explicit depth and width exits instead of a stack overflow', () => {
  let deep: Record<string, unknown> = { value: 'leaf' };
  for (let index = 0; index < 1100; index++) deep = { child: deep };
  assert.throws(() => assertOperationFields(deep), (error: unknown) => error instanceof KnowledgeError && error.code === 'SUBMISSION_SCHEMA_VIOLATION');
  const wide = { values: Array.from({ length: 200_001 }, (_, index) => index) };
  assert.throws(() => assertOperationFields(wide), (error: unknown) => error instanceof KnowledgeError && error.code === 'SUBMISSION_SCHEMA_VIOLATION');
});

test('non-string operation targets are refused before their nested text can be retained', () => {
  const secret = ['SECRET', 'KEY'].join('_') + '=' + ['Synth3tic', 'key', '42'].join('-');
  for (const key of ['device', 'bed']) {
    assert.throws(() => assertOperationFields({ schema: 'fed-observation@1', [key]: { value: secret } }), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'SUBMISSION_SCHEMA_VIOLATION');
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test('a source whose provenance is missing or not a known one cannot be grounds (round-seven review, item 3)', async () => {
  const none = async () => null;
  assert.equal(await declarationGroundRefusal({ scheme: 'src' }, none, [{ body: { provenance_type: 'declared' } }]), null);
  for (const body of [{}, { provenance_type: 'synthetic-unknown' }, { provenance_type: null }]) {
    assert.equal(await declarationGroundRefusal({ scheme: 'src' }, none, [{ body: { provenance_type: 'observed' } }, { body }]), UNKNOWN_GROUND, JSON.stringify(body));
  }
  assert.equal(await declarationGroundRefusal({ scheme: 'src' }, none, [{ body: { provenance_type: 'synthetic-unknown' } }, { body: { provenance_type: 'client_captured' } }]), CAPTURED_GROUND);
});
