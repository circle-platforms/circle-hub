import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestEnvironment } from '../../contracts/api.ts';
import { RequestPermissions } from './request-permissions.ts';
import { visibleTestEnvironments } from './test-environment-visibility.ts';
import { prepareBookingPrefixRegistration } from './booking-prefix-registration.ts';
import { newId } from './ids.ts';
import type { AuthorizationRecord, User } from './api.ts';

const at = '2026-11-14T00:00:00.000Z';
const member: User = { id: newId('usr'), name: 'synthetic-member', role: 'user', disabled: false, created_at: at, updated_at: at, deleted_at: null };
const assigned = TestEnvironment.parse({ schema: 'test-environment@1', id: newId('env'), name: 'assigned-disabled', target: 'assigned-target', prefixes: [{ prefix: 'assigned/', owner: member.id, registered_at: at }], resources: [], executors: [], enabled: false, missing_facts: [] });
const other = TestEnvironment.parse({ ...assigned, id: newId('env'), name: 'unassigned-other', target: 'other-target', enabled: true });
function grant(overrides: Partial<AuthorizationRecord['body']> = {}): AuthorizationRecord {
  return { id: newId('rcd'), digest: 'a'.repeat(64), kind: 'authorization', schema: 'authorization@1', provenance: 'declared', created_at: at, body: { permission: 'resource_assign', subject: member.id, object: assigned.id, revoked: false, bound: null, decided_by: newId('usr'), decided_at: at, expires_at: null, note: null, supersedes: null, ...overrides } };
}

test('an enabled account still sees its assigned disabled environment without learning unassigned targets', () => {
  const snapshot = new RequestPermissions(member.id, member, new Date(at), [grant()]);
  const visible = visibleTestEnvironments(member, [assigned, other], snapshot);
  assert.deepEqual(visible.map(value => value.id), [assigned.id]);
  assert.equal(visible[0].enabled, false);
  assert.equal(snapshot.enabled(snapshot.latest('resource_assign', member.id, assigned.id)), true);
});

test('disabled and deleted accounts or withdrawn and expired grants never gain visibility', () => {
  for (const user of [{ ...member, disabled: true }, { ...member, deleted_at: at }]) {
    assert.deepEqual(visibleTestEnvironments(member, [assigned], new RequestPermissions(member.id, user, new Date(at), [grant()])), []);
  }
  for (const decision of [grant({ revoked: true }), grant({ expires_at: '2026-11-13T00:00:00.000Z' })]) {
    assert.deepEqual(visibleTestEnvironments(member, [assigned], new RequestPermissions(member.id, member, new Date(at), [decision])), []);
  }
});

test('administrator management visibility includes disabled environments and ordinary prefixes without a use grant', () => {
  const admin: User = { ...member, id: newId('usr'), role: 'admin' };
  const prefix = prepareBookingPrefixRegistration({ prefix: 'ordinary/', owner: member.id }, at);
  const snapshot = new RequestPermissions(admin.id, admin, new Date(at), []);
  const visible = visibleTestEnvironments(admin, [assigned, prefix], snapshot);
  assert.equal(visible.length, 2);
  assert.equal(visible[0].enabled, false);
  assert.equal(visible[1].isTestEnvironment, false);
  assert.equal(snapshot.canUseResource(assigned.id), false);
});
