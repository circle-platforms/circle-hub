import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestEnvironment } from '../../contracts/api.ts';
import { newId } from './ids.ts';
import { adoptUnregisteredPrefixes } from './test-environment-adoption.ts';
import { prepareTestEnvironmentRegistration } from './test-environment-registration.ts';

const owner = newId('usr'), admin = newId('usr'), at = '2026-11-13T00:00:00.000Z';
const old = TestEnvironment.parse({ schema: 'test-environment@1', id: newId('env'), name: null, target: null, prefixes: [{ prefix: 'ordinary/', owner, registered_at: at }], resources: [], executors: [], enabled: true, missing_facts: ['未登记为测试环境'] });
const input = { name: '合成新环境', target: 'synthetic-target', prefixes: [{ prefix: 'ordinary/', owner, registered_at: '2026-11-14T00:00:00.000Z' }], resources: [], executors: [], enabled: true, missing_facts: [] };

test('formal target adoption creates a fresh identity and archives the complete old prefix while preserving its actual owner and time', () => {
  const value = prepareTestEnvironmentRegistration(input, admin, '2026-11-14T00:00:00.000Z');
  const adopted = adoptUnregisteredPrefixes(value, input, [old]);
  assert.notEqual(adopted.environment.id, old.id);
  assert.deepEqual(adopted.environment.prefixes, old.prefixes);
  assert.deepEqual(adopted.archived, [old.id]);
  assert.deepEqual(adopted.retained, []);
});

test('partial adoption retains other non-environment facts but no duplicate live copy of the adopted prefix', () => {
  const other = TestEnvironment.parse({ ...old, prefixes: [...old.prefixes, { prefix: 'other/', owner, registered_at: at }] });
  const value = prepareTestEnvironmentRegistration(input, admin, '2026-11-14T00:00:00.000Z');
  const adopted = adoptUnregisteredPrefixes(value, input, [other]);
  assert.deepEqual(adopted.archived, []);
  assert.deepEqual(adopted.retained[0].prefixes, [{ prefix: 'other/', owner, registered_at: at }]);
  assert.equal(adopted.retained[0].target, null);
});

test('adoption cannot quietly reassign an existing prefix owner', () => {
  const changed = { ...input, prefixes: [{ ...input.prefixes[0], owner: admin }] };
  assert.throws(() => adoptUnregisteredPrefixes(prepareTestEnvironmentRegistration(changed, admin, '2026-11-14T00:00:00.000Z'), changed, [old]), /责任人不能/);
});
