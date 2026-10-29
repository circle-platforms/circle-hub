import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../records/api.ts';
import { startPostgres } from './test-support.ts';
import { world } from './testing/feeding-bounds-fixture.ts';

test('a node read authorizes only structurally relevant feeding sources and retains frozen validity', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const xml = '<commands><menu name="system"><item name="show"><arguments/></item><item name="status"><arguments/></item></menu></commands>';
  const w = await world(pg, false, undefined, xml);
  t.after(() => w.close());
  const layer = w.knowledge.feeding!;
  const receipt = await layer.observeSource(w.user, w.document.body.sha256, w.scope);
  assert.equal(receipt.objects.length, 40);
  const frozen = await layer.freeze(w.user, newId('run'), w.root.root);
  await layer.retract(w.admin, { schema: 'retraction@1', objects: [receipt.objects[0]], by: w.admin.id, at: new Date().toISOString(), reason: 'Synthetic withdrawal' });

  let sourceReads = 0;
  const source = w.kit.artifacts.source.bind(w.kit.artifacts);
  t.mock.method(w.kit.artifacts, 'source', async (...args: Parameters<typeof source>) => {
    if (args[1] === w.document.body.sha256) sourceReads++;
    return source(...args);
  });
  const unrelated = await w.knowledge.getNodes({ root: w.root.root, paths: ['/commands/system/status'], depth: 0 }, w.user);
  assert.ok(unrelated);
  assert.equal(unrelated.nodes.length, 1);
  assert.equal(unrelated.nodes[0].feeding_objects?.length ?? 0, 0);
  assert.ok(sourceReads <= 1, `unrelated case-source reads: ${sourceReads}`);
  const unrelatedReads = sourceReads;

  sourceReads = 0;
  const current = await w.knowledge.getNodes({ root: w.root.root, paths: ['/commands/system/show'], depth: 0 }, w.user);
  assert.ok(current);
  assert.equal(current.nodes[0].feeding_objects?.length, 39);
  assert.equal(sourceReads, 40, 'each candidate still checks its own exact source');
  const previous = await w.knowledge.getNodes({ root: w.root.root, paths: ['/commands/system/show'], depth: 0, feeding_offset: frozen }, w.user);
  assert.ok(previous);
  assert.equal(previous.nodes[0].feeding_objects?.length, 40);
  const store = w.kit.store, descriptor = Object.getOwnPropertyDescriptor(store, 'findIndexed');
  Object.defineProperty(store, 'findIndexed', { value: undefined, configurable: true });
  try {
    const fallback = await w.knowledge.getNodes({ root: w.root.root, paths: ['/commands/system/show'], depth: 0 }, w.user);
    assert.deepEqual(fallback?.nodes[0].feeding_objects, current.nodes[0].feeding_objects);
  } finally { if (descriptor) Object.defineProperty(store, 'findIndexed', descriptor); else delete (store as {findIndexed?:unknown}).findIndexed; }
  sourceReads = 0;
  assert.equal(await w.knowledge.getNodes({ root: w.root.root, paths: ['/commands/system/show'], depth: 0 }, w.outsider), null);
  assert.equal(sourceReads, 0);
  t.diagnostic(`synthetic unrelated source reads ${unrelatedReads}; related candidates each checked separately`);
});
