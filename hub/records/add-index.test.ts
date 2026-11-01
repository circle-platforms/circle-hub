// Index entries added to a stored record (RecordStore.addIndex): appended to the derived index, the record and its digest
// unchanged; entries already held are kept, a record holds at most 200, and a record that is not stored takes none.
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

test('entries are added to a stored record without changing it, once each and at most 200 in all', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const store = kit.store;
  const record = await store.put({ kind: 'submission', schema: 'submission@1', provenance: 'declared', body: { n: 1 }, index: [{ key: 'test.run', value: 'a' }] });
  assert.equal(await store.addIndex!(record.digest, [{ key: 'test.cites', value: 'x' }, { key: 'test.run', value: 'a' }]), 1, 'an entry it holds is not added again');
  assert.equal(await store.addIndex!(record.digest, [{ key: 'test.cites', value: 'x' }]), 0);
  const found = await store.find({ key: 'test.cites', value: 'x', kind: 'submission' });
  assert.deepEqual(found.items.map((item) => item.digest), [record.digest]);
  const stored = (await store.get(record.digest))!;
  assert.equal(stored.digest, record.digest);
  assert.deepEqual(stored.body, { n: 1 });
  assert.equal(stored.created_at, record.created_at);

  assert.equal(await store.addIndex!('f'.repeat(64), [{ key: 'test.cites', value: 'x' }]), 0, 'a record that is not stored takes none');
  await assert.rejects(store.addIndex!('not-a-digest', [{ key: 'test.cites', value: 'x' }]), TypeError);
  await assert.rejects(store.addIndex!(record.digest, [{ key: 'Not A Key', value: 'x' }]), TypeError);
  assert.equal(await store.addIndex!(record.digest, []), 0);
  assert.equal(await store.addIndex!(record.digest, Array.from({ length: 198 }, (_, i) => ({ key: 'test.many', value: String(i) }))), 198);
  await assert.rejects(store.addIndex!(record.digest, [{ key: 'test.many', value: 'one more' }]), TypeError, 'a record holds at most 200 entries');
  assert.equal((await store.find({ key: 'test.many', value: '197', kind: 'submission' })).items.length, 1);
});
