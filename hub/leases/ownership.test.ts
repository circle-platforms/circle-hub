import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownsLeaseKeys, registrationsOf, type LeaseOwnership } from './ownership.ts';

const ownership: LeaseOwnership = {
  prefixes: [{ prefix: 'bed/alpha/', owner: 'owner-a' }, { prefix: 'bed/beta/', owner: 'owner-b' }],
  resources: [{ key: 'synthetic/exact', owner: 'owner-a' }],
};

test('only explicitly registered prefixes and exact resources establish cleanup responsibility', () => {
  assert.equal(ownsLeaseKeys(ownership, 'owner-a', ['bed/alpha/seat', 'synthetic/exact']), true);
  for (const keys of [[], ['bed/alphabeta/seat'], ['bed/alpha'], ['synthetic/exact/child'], ['unknown/key'], ['bed/alpha/seat', 'bed/beta/seat']]) {
    assert.equal(ownsLeaseKeys(ownership, 'owner-a', keys), false);
  }
});

test('overlapping or exact conflicting responsibility never grants forced cleanup', () => {
  assert.equal(ownsLeaseKeys({ ...ownership, resources: [{ key: 'bed/alpha/seat', owner: 'owner-b' }] }, 'owner-a', ['bed/alpha/seat']), false);
  assert.equal(ownsLeaseKeys({ ...ownership, prefixes: [...ownership.prefixes, { prefix: 'bed/alpha/nested/', owner: 'owner-b' }] }, 'owner-a', ['bed/alpha/nested/seat']), false);
  assert.equal(ownsLeaseKeys({ prefixes: [{ prefix: 'bed/alpha', owner: 'owner-a' }], resources: [] }, 'owner-a', ['bed/alphabeta']), false);
});

test('duplicate facts for the same owner are not a new permission or a conflict', () => {
  assert.equal(ownsLeaseKeys({ ...ownership, resources: [{ key: 'bed/alpha/seat', owner: 'owner-a' }] }, 'owner-a', ['bed/alpha/seat']), true);
});

test('registration views are sorted copies, include only declared prefixes and never synthesize them from resource keys', () => {
  const projection = registrationsOf(ownership, 'bed/');
  assert.deepEqual(projection, [{ prefix: 'bed/alpha/', owner: 'owner-a' }, { prefix: 'bed/beta/', owner: 'owner-b' }]);
  projection[0].owner = 'mutated';
  assert.equal(ownership.prefixes[0].owner, 'owner-a');
  assert.deepEqual(registrationsOf(ownership, 'bed/alpha/'), [{ prefix: 'bed/alpha/', owner: 'owner-a' }]);
  assert.deepEqual(registrationsOf(ownership, 'synthetic/'), []);
});
