import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newId } from '../records/api.ts';
import { runRecord } from '../../contracts/src/fixtures.ts';
import { RunRecord } from '../../contracts/src/run.ts';
import { putRun } from '../runs/engine/store.ts';
import { startPostgres } from './test-support.ts';
import { mapBytes, readCapture, world } from './testing/feeding-bounds-fixture.ts';
import type { FeedingCut } from './feeding-types.ts';

/** Frozen and live cuts should differ only in the explicitly returned horizon. */
function contents(value: FeedingCut | null) {
  if (value === null) return null;
  const { offset: _offset, ...rest } = value;
  return rest;
}

test('a frozen feeding cut preserves visibility and retractions without per-object index scans', async t => {
  const pg = await startPostgres();
  let closeWorld = async (): Promise<void> => {};
  t.after(async () => { await closeWorld(); await pg.stop(); });
  const w = await world(pg);
  const layer = w.knowledge.feeding!;
  closeWorld = async () => { await layer.drain(); await w.close(); };
  const run = newId('run');
  await putRun(w.kit.store, RunRecord.parse({...runRecord,run,runner:w.user.id}), new Date().toISOString());
  const projected = await layer.observeSource(w.user, w.document.body.sha256, {...w.scope,run});
  assert.equal(projected.objects.length, 40);
  const firstFreeze = await layer.freeze(w.user, newId('run'), w.root.root);
  const before = await layer.cut(w.product.id, null, w.user);
  assert.equal(before?.objects.size, 40);
  assert.ok([...before!.bindings.values()].some(values => values.length > 0));
  assert.equal(before?.usages.length, 40);

  await layer.retract(w.admin, { schema: 'retraction@1', objects: [projected.objects[0]], by: w.admin.id, at: new Date().toISOString(), reason: 'Synthetic retraction' });
  const secondFreeze = await layer.freeze(w.user, newId('run'), w.root.root);
  const after = await layer.cut(w.product.id, null, w.user);
  assert.equal(after?.objects.size, 39);
  assert.deepEqual(contents(await layer.cut(w.product.id, firstFreeze.offset, w.user)), contents(before));

  let perObjectReads = 0;
  const find = w.kit.store.find.bind(w.kit.store);
  t.mock.method(w.kit.store, 'find', async (...args: Parameters<typeof find>) => {
    if (['knowledge.feeding.retraction', 'knowledge.feeding.binding', 'knowledge.feeding.usage.object', 'knowledge.feeding.head'].includes(args[0].key)) perObjectReads++;
    return find(...args);
  });
  const frozen = await layer.cut(w.product.id, secondFreeze.offset, w.user);
  assert.deepEqual(contents(frozen), contents(after));
  assert.ok(perObjectReads <= 4, `per-object index reads: ${perObjectReads}`);
});

test('frozen cuts preserve source-head history and recheck current account access', async t => {
  const pg = await startPostgres();
  let closeWorld = async (): Promise<void> => {};
  t.after(async () => { await closeWorld(); await pg.stop(); });
  const w = await world(pg);
  const layer = w.knowledge.feeding!;
  closeWorld = async () => { await layer.drain(); await w.close(); };
  const original = await readCapture(w, 'agile:mindmap:SYN-DOC', mapBytes);
  await layer.observeSource(w.user, original.content.body.sha256, original.scope);
  const first = await layer.freeze(w.user, newId('run'), w.root.root);
  const originalCut = await layer.cut(w.product.id, null, w.user);
  const changed = JSON.parse(mapBytes.toString());
  changed.root.children[0].children[0].data.text = 'system show changed';
  const newer = await readCapture(w, 'agile:mindmap:SYN-DOC', Buffer.from(JSON.stringify(changed)));
  await layer.observeSource(w.user, newer.content.body.sha256, newer.scope);
  const second = await layer.freeze(w.user, newId('run'), w.root.root);
  const newerCut = await layer.cut(w.product.id, null, w.user);
  assert.deepEqual(contents(await layer.cut(w.product.id, first.offset, w.user)), contents(originalCut));
  assert.deepEqual(contents(await layer.cut(w.product.id, second.offset, w.user)), contents(newerCut));
  assert.ok(newerCut?.retracted.size);
  await w.kit.principals.setDisabled(w.admin, w.user.id, true);
  assert.equal(await layer.cut(w.product.id, null, w.user), null);
  assert.equal(await layer.cut(w.product.id, second.offset, w.user), null);
});
