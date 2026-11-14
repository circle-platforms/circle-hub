import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDefinitionOwners, withDefinitionAssignment, restoresDisabledOwner, restoresDisabledAssignment } from './definition-restoration.ts';
import type { Transaction } from './api.ts';

const tx: Transaction = { transactionId: 1 }, other: Transaction = { transactionId: 2 };

test('definition owner authority is confined to the exact transaction, selected owner and async restore chain', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const operation = withDefinitionOwners(tx, ['synthetic-selected-owner'], async () => {
    assert.equal(restoresDisabledOwner(tx, 'synthetic-selected-owner'), true);
    assert.equal(restoresDisabledOwner(tx, 'other-owner'), false);
    assert.equal(restoresDisabledOwner(other, 'synthetic-selected-owner'), false);
    assert.equal(restoresDisabledAssignment(tx, 'synthetic-selected-owner', 'environment'), false);
    entered(); await gate;
  });
  await started;
  assert.equal(restoresDisabledOwner(tx, 'synthetic-selected-owner'), false, 'concurrent ordinary operations sharing a transaction do not inherit restoration authority');
  release(); await operation;
  assert.equal(restoresDisabledOwner(tx, 'synthetic-selected-owner'), false);
});

test('definition grant authority is bounded to one exact environment and subject and disappears after failure', async () => {
  await assert.rejects(withDefinitionAssignment(tx, 'selected-subject', 'selected-environment', async () => {
    assert.equal(restoresDisabledAssignment(tx, 'selected-subject', 'selected-environment'), true);
    assert.equal(restoresDisabledAssignment(tx, 'other-subject', 'selected-environment'), false);
    assert.equal(restoresDisabledAssignment(tx, 'selected-subject', 'other-environment'), false);
    assert.equal(restoresDisabledAssignment(other, 'selected-subject', 'selected-environment'), false);
    assert.equal(restoresDisabledOwner(tx, 'selected-subject'), false);
    throw new Error('synthetic restoration failure');
  }), /synthetic restoration failure/);
  assert.equal(restoresDisabledAssignment(tx, 'selected-subject', 'selected-environment'), false);
});
