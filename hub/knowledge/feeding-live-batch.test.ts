import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPostgres } from './test-support.ts';
import { world } from './testing/feeding-bounds-fixture.ts';

test('a live node read batches feeding retraction and source-head lookups without changing the visible entries', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  const receipt = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(receipt.objects.length, 40);
  await layer.retract(w.admin, { schema: 'retraction@1', objects: [receipt.objects[0]], by: w.admin.id, at: new Date().toISOString(), reason: 'Synthetic withdrawal' });

  const store = w.kit.store;
  const old = Object.getOwnPropertyDescriptor(store, 'findIndexed');
  Object.defineProperty(store, 'findIndexed', { value: undefined, configurable: true });
  let legacy: Awaited<ReturnType<typeof layer.entries>>;
  try { legacy = await layer.entries(w.user, w.product.id); }
  finally { if (old) Object.defineProperty(store, 'findIndexed', old); else delete (store as { findIndexed?: unknown }).findIndexed; }
  assert.equal(legacy.length, 40);
  assert.equal(legacy.filter(row => row.validity === 'invalid').length, 1);

  let perObjectReads = 0;
  const find = store.find.bind(store);
  t.mock.method(store, 'find', async (...args: Parameters<typeof find>) => {
    if (['knowledge.feeding.retraction', 'knowledge.feeding.head'].includes(args[0].key)) perObjectReads++;
    return find(...args);
  });
  const current = await layer.entries(w.user, w.product.id);
  assert.deepEqual(current, legacy);
  assert.ok(perObjectReads <= 4, `per-object retraction and source-head index reads: ${perObjectReads}`);

  perObjectReads = 0;
  const page = await w.knowledge.getNodes({ root: w.root.root, paths: ['/'], depth: 0 }, w.user);
  assert.ok(page);
  assert.equal(page.nodes[0]?.feeding_objects?.length, 39);
  assert.ok(perObjectReads <= 4, `node read per-object retraction and source-head index reads: ${perObjectReads}`);
  await w.kit.principals.setDisabled(w.admin, w.user.id, true);
  assert.deepEqual(await layer.entries(w.user, w.product.id), []);
});
