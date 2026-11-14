import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TestEnvironment } from '../../contracts/api.ts';
import { newId } from './ids.ts';
import { workflowBooksTestEnvironments } from './test-environment-inheritance-policy.ts';

const environment = TestEnvironment.parse({ schema: 'test-environment@1', id: newId('env'), name: 'synthetic-target', target: 'synthetic-target', prefixes: [], resources: [{ key: 'synthetic/device/a', owner: newId('usr'), registered_at: '2026-11-14T00:00:00.000Z' }], executors: [], enabled: true, missing_facts: [] });

test('formal workflow prefix proves test-environment booking capability independently of the other cutover namespaces', () => {
  assert.equal(workflowBooksTestEnvironments('synthetic/', [environment]), true);
  assert.equal(workflowBooksTestEnvironments('unrelated/', [environment]), false);
});

test('an unbound legacy prefix alone is not evidence of a test-environment target', () => {
  const unbound = TestEnvironment.parse({ ...environment, name: null, target: null, resources: [], prefixes: [{ prefix: 'ordinary/', owner: newId('usr'), registered_at: '2026-11-14T00:00:00.000Z' }], missing_facts: ['目标尚未核对'] });
  assert.equal(workflowBooksTestEnvironments('ordinary/', [unbound]), false);
});
