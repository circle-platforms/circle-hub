// One reading that could not see the whole process tree is no breach (decision 116): the function is stopped only when the
// tree stays out of view for UNSEEN_POLLS readings in a row; a breach stops it at once and a clean reading resets the count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { residentFailure, unseenGrace, UNSEEN_POLLS, RESIDENT_EXITED } from './resident.ts';

test('the tree must stay out of view for several readings in a row before the function is stopped', () => {
  const grace = unseenGrace();
  for (let poll = 1; poll < UNSEEN_POLLS; poll++) assert.equal(grace(residentFailure(null, 256, 1)), undefined, `poll ${poll}`);
  assert.equal(grace(residentFailure(null, 256, 1))?.detail.reason, 'resident_observation_unavailable', 'the last reading in the row stops it');
});

test('a clean reading or an exit resets the count, and a breach is never deferred', () => {
  const grace = unseenGrace(3);
  assert.equal(grace(residentFailure(null, 256, 1)), undefined);
  assert.equal(grace(residentFailure(100, 256, 1)), undefined);
  assert.equal(grace(residentFailure(null, 256, 1)), undefined);
  assert.equal(grace(residentFailure(RESIDENT_EXITED, 256, 1)), undefined);
  assert.equal(grace(residentFailure(null, 256, 1)), undefined);
  assert.equal(grace(residentFailure(null, 256, 1)), undefined, 'two in a row after the reset');
  assert.equal(grace(residentFailure(257, 256, 1))?.code, 'SANDBOX_VIOLATION', 'a breach stops at once');
});
