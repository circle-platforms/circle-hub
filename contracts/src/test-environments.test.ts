import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCHEMA_REGISTRY, TestEnvironment, TestEnvironmentId, TestEnvironmentInput, TestEnvironmentInheritanceCompletion,
  TEST_ENVIRONMENT_CONFIG_PREFIX, TEST_ENVIRONMENT_INHERITANCE_KEY, TEST_ENVIRONMENT_INHERITANCE_RULE_VERSION,
} from '../api.ts';

const at = '2026-11-14T16:30:00.000Z';
const owner = 'usr_0' + 'a'.repeat(25), id = 'env_0' + 'b'.repeat(25), exe = 'exe_0' + 'c'.repeat(25);
const input = () => ({
  name: '合成测试环境', target: 'synthetic-target',
  prefixes: [{ prefix: 'synthetic/environment/', owner, registered_at: at }],
  resources: [{ key: 'synthetic/device/a', owner, registered_at: at }],
  executors: [exe, 'exe_0' + 'd'.repeat(25)], enabled: true, missing_facts: [],
});
const registered = () => ({ ...input(), schema: 'test-environment@1', id });

test('public API exports one stable independent environment identity and registered schemas', () => {
  assert.equal(TestEnvironmentId.parse(id), id);
  for (const value of [exe, owner, 'synthetic-target', id.toUpperCase(), 'env_8' + 'b'.repeat(25)]) assert.equal(TestEnvironmentId.safeParse(value).success, false);
  assert.equal(TEST_ENVIRONMENT_CONFIG_PREFIX, 'environment.');
  assert.equal(TEST_ENVIRONMENT_INHERITANCE_KEY, 'environment-inheritance');
  assert.equal(SCHEMA_REGISTRY['test-environment-id@1'], TestEnvironmentId);
  assert.equal(SCHEMA_REGISTRY['test-environment-input@1'], TestEnvironmentInput);
  assert.equal(SCHEMA_REGISTRY['test-environment@1'], TestEnvironment);
  assert.equal(SCHEMA_REGISTRY['test-environment-inheritance-completion@1'], TestEnvironmentInheritanceCompletion);
});

test('one registration retains multiple executor links and exact prefix and resource responsibility facts', () => {
  assert.deepEqual(TestEnvironmentInput.parse(input()), input());
  assert.deepEqual(TestEnvironment.parse(registered()), registered());
  const precise = { ...registered(), name: ' 合成名称 ', prefixes: [{ prefix: 'legacy/bed/', owner, registered_at: '2026-10-01T00:00:00.000Z' }] };
  assert.deepEqual(TestEnvironment.parse(precise), precise, 'no owner/time/name normalization substitutes historical facts');
  assert.equal(TestEnvironmentInput.safeParse({ ...input(), prefixes: [] }).success, true, 'exact resources can stand alone');
  assert.equal(TestEnvironmentInput.safeParse({ ...input(), resources: [] }).success, true, 'prefix declarations can stand alone');
});

test('unresolved legacy registration remains in the same shape without a guessed target or executor', () => {
  const unresolved = { ...registered(), name: null, target: null, executors: [], resources: [], missing_facts: ['旧前缀没有可核验的目标归属'] };
  assert.deepEqual(TestEnvironment.parse(unresolved), unresolved);
  assert.equal(TestEnvironmentInput.safeParse({ ...input(), target: null, executors: [], missing_facts: unresolved.missing_facts }).success, false);
  assert.equal(TestEnvironmentInput.safeParse({ ...input(), name: null, missing_facts: ['旧登记没有名称'] }).success, false);
  assert.equal(TestEnvironment.safeParse({ ...unresolved, executors: [exe] }).success, false, 'candidate executors cannot become bindings to an unknown target');
  assert.equal(TestEnvironment.safeParse({ ...unresolved, missing_facts: [] }).success, false);
  const unknownOwner = { ...registered(), prefixes: [{ prefix: 'legacy/bed/', owner: null, registered_at: null }], missing_facts: ['旧登记责任人和时刻未能核对'] };
  assert.deepEqual(TestEnvironment.parse(unknownOwner), unknownOwner);
  assert.equal(TestEnvironment.safeParse({ ...unknownOwner, missing_facts: [] }).success, false);
});

test('new registration requires actual mapping declarations and rejects malformed or duplicate facts', () => {
  assert.equal(TestEnvironmentInput.safeParse({ ...input(), prefixes: [], resources: [] }).success, false);
  assert.equal(TestEnvironmentInput.safeParse({ ...input(), name: '   ' }).success, false);
  for (const bad of [
    { ...input(), prefixes: [{ ...input().prefixes[0], prefix: 'missing-slash' }] },
    { ...input(), resources: [{ ...input().resources[0], key: 'UPPER/key' }] },
    { ...input(), prefixes: [...input().prefixes, ...input().prefixes] },
    { ...input(), resources: [...input().resources, ...input().resources] },
    { ...input(), executors: [exe, exe] },
    { ...input(), prefixes: [{ prefix: 'legacy/bed/' }] },
    { ...input(), legacy_directory: [] },
  ]) assert.equal(TestEnvironmentInput.safeParse(bad).success, false);
});

test('completion binds rule version and exact source, grant and environment references including a genuine empty cutover', () => {
  const empty = { schema: 'test-environment-inheritance-completion@1', rule_version: TEST_ENVIRONMENT_INHERITANCE_RULE_VERSION, completed_at: at, source_records: [], grant_records: [], environment_ids: [] };
  assert.deepEqual(TestEnvironmentInheritanceCompletion.parse(empty), empty);
  const full = { ...empty, source_records: ['a'.repeat(64)], grant_records: ['b'.repeat(64)], environment_ids: [id] };
  assert.deepEqual(TestEnvironmentInheritanceCompletion.parse(full), full);
  for (const bad of [
    { ...full, rule_version: 2 }, { ...full, environment_ids: [exe] },
    { ...full, source_records: ['rec:' + 'a'.repeat(64)] },
    { ...full, source_records: ['a'.repeat(64), 'a'.repeat(64)] },
    { ...full, grant_records: ['b'.repeat(64), 'b'.repeat(64)] },
    { ...full, environment_ids: [id, id] }, { ...full, role: 'admin' },
  ]) assert.equal(TestEnvironmentInheritanceCompletion.safeParse(bad).success, false);
});
