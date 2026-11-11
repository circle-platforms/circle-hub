// RecordStore.findDigests: the digests find() would answer, page for page and with the same cursor, without a record body.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { Page, StoredRecord } from './api.ts';
import { Database } from './db.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

test('the digests of an indexed page are those of find, in its order, with cursors either may continue from', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const store = kit.store;
  for (let n = 0; n < 7; n++) await store.put({ kind: n === 3 ? 'claim' : 'submission', schema: 'synthetic-page@1', provenance: 'declared', body: { n }, index: [{ key: 'test.page', value: n === 6 ? 'other' : 'main' }] });
  for (const newestFirst of [false, true]) for (const kind of [undefined, 'submission' as const]) for (const limit of [1, 2, 10]) {
    let cursor: string | null = null, other: string | null = null;
    const seen: string[] = [];
    do {
      const query = { key: 'test.page', value: 'main', limit, newestFirst, ...(kind === undefined ? {} : { kind }) };
      const full: Page<StoredRecord> = await store.find({ ...query, cursor });
      const digests: Page<string> = await store.findDigests!({ ...query, cursor: other });
      assert.deepEqual(digests.items, full.items.map((record) => record.digest));
      assert.equal(digests.next, full.next, 'the same cursor');
      seen.push(...digests.items); cursor = full.next; other = digests.next;
    } while (cursor !== null);
    assert.equal(seen.length, kind === undefined ? 6 : 5);
  }
  assert.deepEqual(await store.findDigests!({ key: 'test.page', value: 'none' }), { items: [], next: null });
  assert.deepEqual(await store.findDigests!({ key: 'test.page', value: 'x'.repeat(2000) }), { items: [], next: null }, 'a value put() would refuse was never indexed');
  await assert.rejects(store.findDigests!({ key: 'Not A Key', value: 'main' }), TypeError);
  await assert.rejects(store.findDigests!({ key: 'test.page', value: 'main', kind: 'no-such-kind' as 'claim' }), TypeError);

  // No body leaves the database for it.
  const original = Database.prototype.query, seen: string[] = [];
  Database.prototype.query = (async function (this: Database, ...args: Parameters<typeof original>) { seen.push(String(args[0])); return original.apply(this, args); }) as typeof original;
  try { await store.findDigests!({ key: 'test.page', value: 'main', limit: 3 }); } finally { Database.prototype.query = original; }
  assert.equal(seen.length, 1);
  assert.ok(!/\bbody\b/.test(seen[0]), seen[0]);
});
