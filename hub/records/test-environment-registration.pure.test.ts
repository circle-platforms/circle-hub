import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareTestEnvironmentRegistration } from './test-environment-registration.ts';
import { newId } from './ids.ts';
import type { TestEnvironmentInput } from './api.ts';

const actor = newId('usr'), historicalOwner = newId('usr');
const then = '2026-11-13T00:00:00.000Z', now = '2026-11-14T00:00:00.000Z';
const input: TestEnvironmentInput = { name: '合成环境', target: 'synthetic-target', prefixes: [{ prefix: 'synthetic/', owner: historicalOwner, registered_at: then }], resources: [{ key: 'synthetic/key', owner: historicalOwner, registered_at: then }], executors: [], enabled: true, missing_facts: [] };

test('new keys preserve the administrator-selected owner but never accept supplied historical time', () => {
  const environment = prepareTestEnvironmentRegistration(input, actor, now);
  assert.equal(environment.prefixes[0].owner, historicalOwner);
  assert.equal(environment.prefixes[0].registered_at, now);
  assert.equal(environment.resources[0].owner, historicalOwner);
  assert.equal(environment.resources[0].registered_at, now);
});

test('renaming retains identity and exact old owner facts, while added keys record the current actor', () => {
  const previous = { ...prepareTestEnvironmentRegistration(input, historicalOwner, then) };
  const changed = prepareTestEnvironmentRegistration({ ...input, name: '合成新名字', prefixes: [...input.prefixes, { prefix: 'new/', owner: historicalOwner, registered_at: then }] }, actor, now, previous);
  assert.equal(changed.id, previous.id);
  assert.deepEqual(changed.prefixes[0], previous.prefixes[0]);
  assert.deepEqual(changed.resources[0], previous.resources[0]);
  assert.deepEqual(changed.prefixes[1], { prefix: 'new/', owner: historicalOwner, registered_at: now });
});

test('a target change cannot transfer existing grants and fresh registration allocates a different identity', () => {
  const previous = prepareTestEnvironmentRegistration(input, historicalOwner, then);
  assert.throws(() => prepareTestEnvironmentRegistration({ ...input, target: 'another-physical-target' }, actor, now, previous), /目标身份不能更换/);
  assert.notEqual(prepareTestEnvironmentRegistration(input, actor, now).id, previous.id);
});


test('same-key owner changes reject explicitly instead of silently overwriting responsibility', () => {
  const previous = prepareTestEnvironmentRegistration(input, actor, then);
  assert.throws(() => prepareTestEnvironmentRegistration({ ...input, prefixes: [{ ...input.prefixes[0], owner: actor }] }, actor, now, previous), /责任人不能/);
  assert.throws(() => prepareTestEnvironmentRegistration({ ...input, resources: [{ ...input.resources[0], owner: actor }] }, actor, now, previous), /责任人不能/);
});

test('an unspecified new owner defaults to the authenticated actor rather than an invented historical identity', () => {
  const environment = prepareTestEnvironmentRegistration({ ...input, prefixes: [{ ...input.prefixes[0], owner: null }], missing_facts: ['新登记责任由管理员确认'] }, actor, now);
  assert.equal(environment.prefixes[0].owner, actor);
  assert.equal(environment.prefixes[0].registered_at, now);
});
