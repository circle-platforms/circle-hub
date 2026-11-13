import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmationStatus, confirmationChip, taskChip } from './status.ts';

test('run-page confirmation status uses only 未确认 / 已确认 / 未知', () => {
  assert.equal(confirmationStatus(null), '未知');
  assert.equal(confirmationStatus('awaiting'), '未知');
  assert.equal(confirmationStatus('incomplete'), '未知');
  assert.equal(confirmationStatus('held'), '未确认');
  assert.equal(confirmationStatus('delivered_pending'), '未确认');
  assert.equal(confirmationStatus('passed', 1), '未确认');
  assert.equal(confirmationStatus('passed'), '已确认');
  assert.equal(confirmationStatus('rejected'), '已确认');
  assert.equal(confirmationStatus('abandoned'), '已确认');
  assert.equal(confirmationStatus('delivered_unsatisfied'), '已确认');
  assert.match(String(confirmationChip(null)), /未知/);
  assert.match(String(taskChip('passed')), /已确认/);
  assert.doesNotMatch(String(taskChip('passed')), />已通过</);
});
