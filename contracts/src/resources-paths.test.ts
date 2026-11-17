import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutorDefinition, ExecutorSource } from './resources.ts';
import { definition } from '../../hub/dispatch/testing/definition.ts';

test('executor endpoint and CA refusals identify fields without relaxing endpoint policy', () => {
  for (const schema of [ExecutorDefinition, ExecutorSource]) {
    assert.equal(schema.safeParse(definition('http://127.0.0.1/mcp')).success, true);
    for (const endpoint of ['http://192.0.2.1/mcp', 'http://user:password@127.0.0.1/mcp', 'http://127.0.0.1/mcp?key=hidden', 'http://127.0.0.1/mcp#hidden']) {
      const parsed = schema.safeParse(definition(endpoint));
      assert.equal(parsed.success, false);
      if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.path.join('/') === 'endpoint'), endpoint);
    }
    const parsed = schema.safeParse(definition('https://192.0.2.1/mcp'));
    assert.equal(parsed.success, false);
    if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.path.join('/') === 'ca'));
  }
});
