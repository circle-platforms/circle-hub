import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorManifest, SubmitRequest, TaskId, InputRevisionId, OperationStatus,
  canonicalHash, newId, STANDARD_OPERATIONS, LEASE_TTL_MS, HEARTBEAT_MS } from '../../packages/contracts/src/index.ts';

test('state identities and the execution vocabulary have one definition', () => {
  assert.ok(TaskId.safeParse(newId('task')).success);
  assert.ok(InputRevisionId.safeParse(newId('inrev')).success);
  assert.equal(TaskId.safeParse('tsk_123').success, false);
  assert.equal(InputRevisionId.safeParse('rev_123').success, false);
  assert.equal(OperationStatus.safeParse('stop-unconfirmed').success, false);
  assert.ok(OperationStatus.safeParse('reconciled').success);
  assert.equal(LEASE_TTL_MS, 60_000);
  assert.equal(HEARTBEAT_MS, 20_000);
});

test('submission strips self-declared identity and uses canonical content hashes', () => {
  const content = { scopeId: 'scp_lab', title: 'Inspect synthetic resource', idempotencyKey: 'synthetic-key-1',
    input: { product: 'SYNTH', version: '8.4.2' }, principal: 'admin', role: 'admin' };
  const parsed = SubmitRequest.parse(content);
  assert.equal('principal' in parsed, false);
  assert.equal('role' in parsed, false);
  assert.equal(canonicalHash({ a: 1, b: { c: 2, d: 3 } }), canonicalHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('connector manifests require declared effects, idempotency and independent reconciliation', () => {
  const base = { id: 'record-feed-a', version: '1.0.0', synthetic: true, roles: ['defects'],
    operations: [{ name: 'defects.comment', effects: STANDARD_OPERATIONS['defects.comment'],
      idempotency: 'marker', reconciliation: 'read-back' }], events: { mode: 'cursor-poll' } };
  assert.ok(ConnectorManifest.safeParse(base).success);
  assert.equal(ConnectorManifest.safeParse({ ...base, operations: [{ name: 'defects.comment' }] }).success, false);
  assert.equal(ConnectorManifest.safeParse({ ...base, operations: [{ ...base.operations[0],
    name: 'vendor.magic' }] }).success, false);
  assert.equal(ConnectorManifest.safeParse({ ...base, operations: [{ ...base.operations[0],
    effects: { reads: ['external-system'], writes: [] } }] }).success, false);
});
