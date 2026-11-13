import assert from 'node:assert/strict';
import { copyFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { secretNameOf } from '../../contracts/src/variables.ts';
import { setup } from './testing/context.ts';

test('a new executor and records database use copied named vault material without consumer enrollment', async t => {
  const old = await setup();
  t.after(() => old.close());
  const name = secretNameOf(old.executor.source.credential!)!;
  const value = 'Synthetic-Copied-Executor-4242';
  await old.kit.variables.setSecrets(old.admin, [{ name, value }], '合成：密钥版本属于封存文件');
  const fresh = await setup();
  t.after(() => fresh.close());
  assert.notEqual(secretNameOf(fresh.executor.source.credential!)!, name);
  await copyFile(old.kit.keyProvider.path, fresh.kit.keyProvider.path);
  await rm(join(fresh.kit.dataDir, 'vault'), { recursive: true, force: true });
  await cp(join(old.kit.dataDir, 'vault'), join(fresh.kit.dataDir, 'vault'), { recursive: true });
  assert.equal(await fresh.kit.authorizations.resourceConfig('secret:' + name), null);
  await fresh.registry.update(fresh.admin, fresh.executor.id, { ...fresh.executor.source, credential: '${secret:' + name + '}' });
  await fresh.freezeExecutor();
  const state = await fresh.service.dispatch(fresh.admin, fresh.run, fresh.executor.id);
  assert.equal(state.outcome, 'effective');
  assert.equal(fresh.submitted.length, 1);
  assert.ok(fresh.endpoint.calls.every(call => call.headers.authorization === 'Bearer ' + value), 'all calls use the copied current version');
  const events = await fresh.service.journal.events(state.job);
  const used = events.find(event => event.body.detail.phase === 'credential_used')!;
  const identity = await fresh.kit.vault.secretIdentity(name);
  assert.ok(identity);
  assert.deepEqual(used.body.detail.variables, [{ kind: 'secret', at: fresh.executor.id + '#/credential', ...identity }]);
  assert.deepEqual(used.body.inputs, []);
  assert.ok(!JSON.stringify({ state, events }).includes(value), 'status and journal expose no material');
});

test('a referenced name missing from the vault prevents all executor calls', async t => {
  const c = await setup();
  t.after(() => c.close());
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.source, credential: '${secret:DEMO_MISSING}' });
  const status = await c.service.precheck(c.admin, c.executor.id);
  assert.equal(status.outcome, 'not_dispatched');
  assert.equal(c.endpoint.calls.length, 0);
  assert.match(status.missing_fact ?? status.reason ?? '', /DEMO_MISSING/);
});
