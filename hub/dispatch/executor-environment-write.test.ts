import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { ExecutorRegistry } from './executors.ts';
import { ExecutorNames } from './executor-names.ts';
import { addSyntheticExecutor } from './testing/credentials.ts';
import { definition } from './testing/definition.ts';

test('linked executor edits refuse conflicting targets and resources before changing the registration', async t => {
  const records = await openTestRecords();
  t.after(() => records.close());
  const admin = (await records.principals.bootstrapAdmin('合成管理员')).user;
  const registry = new ExecutorRegistry(records);
  const first = await addSyntheticExecutor(records, registry, admin, definition('http://127.0.0.1:1/mcp'), 'synthetic-first');
  const second = await addSyntheticExecutor(records, registry, admin, definition('http://127.0.0.1:2/mcp'), 'synthetic-second');
  const names = new ExecutorNames(records);
  await names.assign(admin, first.id, 'first-reader');
  await names.assign(admin, second.id, 'second-reader');
  const environment = await records.testEnvironments.register(admin, {
    name: 'shared-bed', target: first.definition.target, prefixes: [],
    resources: first.source.resources.map(key => ({ key, owner: admin.id, registered_at: new Date().toISOString() })),
    executors: [first.id, second.id], enabled: true, missing_facts: [],
  });
  assert.equal(environment.executors.length, 2, 'one target may have multiple named executors');
  const before = (await registry.readSource(second.id))!;
  const history = async () => records.store.find({ kind: 'authorization', key: 'authz.key', value: `resource_config|*|executor.${second.id}`, limit: 100 });
  const count = (await history()).items.length;
  for (const change of [{ target: 'different-bed' }, { resources: ['other/device'] }]) {
    await assert.rejects(registry.update(admin, second.id, { ...before.source, ...change }));
    assert.equal((await registry.readSource(second.id))?.digest, before.digest);
    assert.equal((await history()).items.length, count);
  }
  const allowed = await registry.update(admin, second.id, { ...before.source, max_run_ms: before.source.max_run_ms + 1 });
  assert.notEqual(allowed.digest, before.digest, 'unrelated definition edits remain possible');
});
