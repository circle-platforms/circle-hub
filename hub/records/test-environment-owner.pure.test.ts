import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareBookingPrefixRegistration } from './booking-prefix-registration.ts';
import { prepareTestEnvironmentOwnerChange } from './test-environment-owner.ts';
import { newId } from './ids.ts';

const oldOwner = newId('usr'), replacement = newId('usr');
const before = '2026-11-13T00:00:00.000Z', at = '2026-11-14T00:00:00.000Z';

test('explicit owner reassignment appends a new responsibility fact without mutating the previous declaration or identity', () => {
  const old = prepareBookingPrefixRegistration({ prefix: 'ordinary/', owner: oldOwner }, before);
  const saved = structuredClone(old);
  const changed = prepareTestEnvironmentOwnerChange(old, { prefix: 'ordinary/', owner: replacement }, at);
  assert.equal(changed.id, old.id);
  assert.equal(changed.target, null);
  assert.deepEqual(changed.prefixes, [{ prefix: 'ordinary/', owner: replacement, registered_at: at }]);
  assert.deepEqual(old, saved);
  assert.deepEqual(changed.resources, old.resources);
  assert.deepEqual(changed.executors, old.executors);
});

test('owner reassignment cannot invent an absent key or a non-account responsibility', () => {
  const old = prepareBookingPrefixRegistration({ prefix: 'ordinary/', owner: oldOwner }, before);
  assert.throws(() => prepareTestEnvironmentOwnerChange(old, { key: 'absent/key', owner: replacement }, at), /没有这个登记资源键/);
  assert.throws(() => prepareTestEnvironmentOwnerChange(old, { prefix: 'ordinary/', owner: '*' }, at));
});
