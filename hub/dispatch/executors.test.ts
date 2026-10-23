import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { ExecutorRegistry } from './executors.ts';
import { definition } from './testing/definition.ts';

test('executor definitions are canonical, authorized by digest, versioned and disabled without changing history', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
  const registry = new ExecutorRegistry(kit);
  const first = await registry.add(admin, definition('http://127.0.0.1:1/mcp'), 'synthetic-secret');
  assert.ok(await kit.vault.has(`executor.${first.id}.bearer`));
  assert.equal((await registry.get(first.id))?.digest, first.digest);
  const next = await registry.update(admin, first.id, { ...first.definition, max_run_ms: 6000 });
  assert.notEqual(next.digest, first.digest);
  assert.deepEqual(JSON.parse(new TextDecoder().decode((await kit.objects.get(first.digest))!)), first.definition);
  await registry.disable(admin, first.id);
  assert.equal((await registry.get(first.id))?.definition.enabled, false);
  assert.equal((await registry.list(admin)).length, 1);
  const user = await kit.principals.createUser(admin, '合成用户');
  await assert.rejects(registry.update(user, first.id, first.definition));
});

test('definitions reject external plaintext, unlisted calls, invalid mapping values and missing fixed CAs', async t => {
  const kit = await openTestRecords(); t.after(() => kit.close());
  const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
  const registry = new ExecutorRegistry(kit);
  for (const input of [definition('http://192.0.2.1/mcp'), definition('https://192.0.2.1/mcp'),
    { ...definition('http://127.0.0.1:1/mcp'), allowed_tools: [] },
    { ...definition('http://127.0.0.1:1/mcp'), status: { pointer: '/state', map: { fake: { effect_outcome: 'invented' } } } },
  ]) await assert.rejects(registry.add(admin, input, 'synthetic-secret'));
});
