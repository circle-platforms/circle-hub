// countIndexed: distinct records under any of several (key, value) pairs, by kind and creation time, up to a cap, in
// one query that reads no record body.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

test('records under any of the pairs are counted once each, within the kind, the time and the cap', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const store = kit.store;
  const put = (n: number, at: string, index: { key: string; value: string }[], kind: 'submission' | 'claim' = 'submission') =>
    store.put({ kind, schema: 'synthetic@1', provenance: 'declared', body: { n }, created_at: at, index });
  await put(1, '2026-10-01T00:00:00.000Z', [{ key: 'cites.node', value: 'a' }]);
  // Both pairs on one record: counted once.
  await put(2, '2026-10-20T00:00:00.000Z', [{ key: 'cites.node', value: 'a' }, { key: 'cites.entry', value: 'e' }]);
  await put(3, '2026-10-25T00:00:00.000Z', [{ key: 'cites.entry', value: 'e' }]);
  await put(4, '2026-10-26T00:00:00.000Z', [{ key: 'cites.node', value: 'b' }]);
  await put(5, '2026-10-27T00:00:00.000Z', [{ key: 'cites.node', value: 'a' }], 'claim');
  const pairs = [{ key: 'cites.node', value: 'a' }, { key: 'cites.entry', value: 'e' }];
  assert.deepEqual(await store.countIndexed!({ index: pairs, kind: 'submission' }), { count: 3, capped: false });
  assert.deepEqual(await store.countIndexed!({ index: pairs }), { count: 4, capped: false }, 'any kind');
  assert.deepEqual(await store.countIndexed!({ index: pairs, kind: 'submission', since: '2026-10-15T00:00:00.000Z' }), { count: 2, capped: false });
  assert.deepEqual(await store.countIndexed!({ index: pairs, kind: 'submission', cap: 2 }), { count: 2, capped: true });
  assert.deepEqual(await store.countIndexed!({ index: [] }), { count: 0, capped: false });
  assert.deepEqual(await store.countIndexed!({ index: [{ key: 'cites.node', value: 'none' }] }), { count: 0, capped: false });
  await assert.rejects(store.countIndexed!({ index: [{ key: 'Bad Key', value: 'a' }] }), TypeError);
  await assert.rejects(store.countIndexed!({ index: pairs, cap: 0 }), TypeError);
  await assert.rejects(store.countIndexed!({ index: Array.from({ length: 1001 }, (_, i) => ({ key: 'cites.node', value: String(i) })) }), TypeError);
});
