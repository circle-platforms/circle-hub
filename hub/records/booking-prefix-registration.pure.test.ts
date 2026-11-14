import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from './ids.ts';
import { prepareBookingPrefixRegistration, isBookingPrefixRegistration } from './booking-prefix-registration.ts';

const owner = newId('usr'), at = '2026-11-14T00:00:00.000Z';

test('formal booking prefixes preserve explicit responsibility without inventing a target, environment or missing evidence', () => {
  const value = prepareBookingPrefixRegistration({ prefix: 'ordinary/', owner }, at);
  assert.deepEqual(value.prefixes, [{ prefix: 'ordinary/', owner, registered_at: at }]);
  assert.equal(value.target, null);
  assert.equal(value.name, null);
  assert.deepEqual(value.resources, []);
  assert.deepEqual(value.executors, []);
  assert.deepEqual(value.missing_facts, []);
  assert.equal(isBookingPrefixRegistration(value), true);
});

test('a malformed owner or prefix cannot become a formal registration', () => {
  assert.throws(() => prepareBookingPrefixRegistration({ prefix: 'ordinary', owner }, at));
  assert.throws(() => prepareBookingPrefixRegistration({ prefix: 'ordinary/', owner: 'not-an-account' }, at));
});

test('unknown target resource facts and missing owners are not silently classified as ordinary booking prefixes', () => {
  const value = prepareBookingPrefixRegistration({ prefix: 'ordinary/', owner }, at);
  assert.equal(isBookingPrefixRegistration({ ...value, prefixes: [{ ...value.prefixes[0], owner: null }] }), false);
  assert.equal(isBookingPrefixRegistration({ ...value, resources: [{ key: 'ordinary/key', owner, registered_at: at }] }), false);
  assert.equal(isBookingPrefixRegistration({ ...value, missing_facts: ['责任未知'] }), false);
});
