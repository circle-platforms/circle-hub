import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RequestPermissions } from './request-permissions.ts';
import { newId } from './ids.ts';
import type { AuthorizationRecord, User } from './api.ts';

const at = new Date('2026-11-14T00:00:00.000Z');
const user: User = { id: newId('usr'), name: 'synthetic-member', role: 'user', disabled: false, deleted_at: null, created_at: at.toISOString(), updated_at: at.toISOString() };
const environment = newId('env');
function decision(subject: string, object: string, overrides: Partial<AuthorizationRecord['body']> = {}): AuthorizationRecord {
  return { id: newId('rcd'), digest: 'a'.repeat(64), kind: 'authorization', schema: 'authorization@1', provenance: 'declared', created_at: at.toISOString(), body: { permission: 'resource_assign', subject, object, bound: null, decided_by: user.id, decided_at: at.toISOString(), expires_at: null, note: null, supersedes: null, revoked: false, ...overrides } };
}

test('direct account environment grants do not broaden the older business resource subject boundary', () => {
  const other = 'synthetic-resource';
  const snapshot = new RequestPermissions(user.id, user, at, [decision(user.id, environment), decision(user.id, other)]);
  assert.equal(snapshot.canUseResource(environment), true);
  assert.equal(snapshot.canUseResource(other), false);
});

test('latest expired or revoked environment grants never reveal an older grant', () => {
  for (const overrides of [{ revoked: true }, { expires_at: '2026-11-13T00:00:00.000Z' }]) {
    const snapshot = new RequestPermissions(user.id, user, at, [decision(user.id, environment), decision(user.id, environment, overrides)]);
    assert.equal(snapshot.canUseResource(environment), false);
  }
});

test('whole-Hub environment grants still require a live current account', () => {
  for (const account of [null, { ...user, disabled: true }, { ...user, deleted_at: at.toISOString() }]) {
    assert.equal(new RequestPermissions(user.id, account, at, [decision('*', environment)]).canUseResource(environment), false);
  }
  assert.equal(new RequestPermissions(user.id, user, at, [decision('*', environment)]).canUseResource(environment), true);
});
