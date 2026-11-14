import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BookingPrefix, DeploymentDefinition, TestEnvironment, TestEnvironmentInput } from '../api.ts';

const owner = 'usr_0' + 'a'.repeat(25);
const registration = () => ({
  schema: 'test-environment@1', id: 'env_0' + 'b'.repeat(25), name: null, target: null,
  prefixes: [{ prefix: 'synthetic/booking/', owner, registered_at: '2026-11-14T17:10:00.000Z' }],
  resources: [], executors: [], enabled: true, missing_facts: [],
});

test('public bookingPrefixes use owner names only and never import registration timestamps or environment identities', () => {
  const prefix = { prefix: 'synthetic/booking/', owner: '合成责任人' };
  assert.deepEqual(BookingPrefix.parse(prefix), prefix);
  const definition = DeploymentDefinition.parse({ schema: 'deployment@3', bookingPrefixes: [prefix] });
  assert.deepEqual(definition.bookingPrefixes, [prefix]);
  assert.deepEqual(definition.testEnvironments, []);
  assert.deepEqual(definition.environmentAssignments, []);
  assert.deepEqual(DeploymentDefinition.parse(JSON.parse(JSON.stringify(definition))), definition);
  for (const bad of [
    { ...prefix, owner }, { ...prefix, registered_at: '2026-11-14T17:10:00.000Z' },
    { ...prefix, id: registration().id }, { ...prefix, target: 'guessed-target' },
    { ...prefix, executors: [] }, { ...prefix, owner: null }, { prefix: 'missing-slash', owner: '合成责任人' },
  ]) assert.equal(BookingPrefix.safeParse(bad).success, false);
  assert.equal(DeploymentDefinition.safeParse({ schema: 'deployment@3', bookingPrefixes: [prefix, prefix] }).success, false);
});

test('known owner-held targetless prefixes are confirmed non-environments rather than invented missing facts', () => {
  const value = registration();
  assert.deepEqual(TestEnvironment.parse(value), value);
  assert.deepEqual(TestEnvironment.parse(value).missing_facts, []);
  assert.equal(TestEnvironmentInput.safeParse({ name: null, target: null, prefixes: value.prefixes, resources: [], executors: [], enabled: true, missing_facts: [] }).success, false, 'ordinary new environment input still needs a name and target');
});

test('the confirmed booking-only exception does not hide other unknown responsibility or target facts', () => {
  const value = registration();
  for (const unknown of [
    { ...value, prefixes: [{ ...value.prefixes[0], owner: null }] },
    { ...value, prefixes: [{ ...value.prefixes[0], registered_at: null }] },
    { ...value, name: '非空名称但目标未知' }, { ...value, target: 'known-target' },
    { ...value, prefixes: [] },
    { ...value, resources: [{ key: 'synthetic/device/a', owner, registered_at: value.prefixes[0].registered_at }] },
  ]) {
    assert.equal(TestEnvironment.safeParse(unknown).success, false);
    assert.equal(TestEnvironment.safeParse({ ...unknown, missing_facts: ['本次事实缺口'] }).success, true);
  }
  assert.equal(TestEnvironment.safeParse({ ...value, executors: ['exe_0' + 'c'.repeat(25)], missing_facts: ['归属未知'] }).success, false);
});
