// RecordStore.findUnsettled: the records nothing has settled, decided by the index entries of their newest closing record.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

const CLOSING = 'test.closing', SETTLED = 'test.settled';

test('a record is settled when its newest closing record carries the settled entry, and only then', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const store = kit.store;
  let n = 0;
  const open = async (group: string) => (await store.put({ kind: 'request', schema: 'synthetic-open@1', provenance: 'declared', body: { n: ++n }, index: [{ key: 'test.group', value: group }] })).digest;
  const close = async (target: string, settles: boolean, kind: 'action' | 'claim' = 'action') => { await store.put({ kind, schema: 'synthetic-close@1', provenance: 'declared', body: { n: ++n }, index: [{ key: CLOSING, value: target }, ...(settles ? [{ key: SETTLED, value: target }] : [])] }); };
  const untouched = await open('a'), settled = await open('a'), unmarked = await open('a'), reopened = await open('a'), closedAgain = await open('a'), otherGroup = await open('b');
  await close(settled, true);
  await close(unmarked, false);
  await close(reopened, true); await close(reopened, false);
  await close(closedAgain, true); await close(closedAgain, false); await close(closedAgain, true);
  // An entry that belongs to another record's closing settles nothing here.
  await store.put({ kind: 'action', schema: 'synthetic-close@1', provenance: 'declared', body: { n: ++n }, index: [{ key: SETTLED, value: untouched }] });
  // A record of another kind indexed the same way is not asked about.
  await store.put({ kind: 'claim', schema: 'synthetic-open@1', provenance: 'declared', body: { n: ++n }, index: [{ key: 'test.group', value: 'a' }] });

  const ask = async (query: { key?: string; values?: string[]; closingKind?: 'action' | 'claim' }) => (await store.findUnsettled!({ kind: 'request', closing: CLOSING, settled: SETTLED, ...query })).map((record) => record.digest);
  assert.deepEqual(await ask({ key: 'test.group', values: ['a'] }), [untouched, unmarked, reopened], 'in insertion order');
  assert.deepEqual(await ask({ key: 'test.group', values: ['b'] }), [otherGroup]);
  assert.deepEqual(await ask({ key: 'test.group', values: ['a', 'b', 'a'] }), [untouched, unmarked, reopened, otherGroup]);
  assert.deepEqual(await ask({ key: 'test.group', values: ['none'] }), []);
  assert.deepEqual(await ask({ key: 'test.group', values: [] }), []);
  assert.deepEqual(await ask({}), [untouched, unmarked, reopened, otherGroup], 'every record of the kind when no key is given');

  // The newest closing record of the asked kind decides: a newer one of another kind is not a closing record.
  await close(settled, false, 'claim');
  assert.deepEqual(await ask({ key: 'test.group', values: ['a'], closingKind: 'action' }), [untouched, unmarked, reopened]);
  assert.deepEqual(await ask({ key: 'test.group', values: ['a'] }), [untouched, settled, unmarked, reopened], 'with no kind asked, whatever is newest under the key decides');

  // What comes back is the verified record.
  const records = await store.findUnsettled!<{ n: number }>({ kind: 'request', key: 'test.group', values: ['b'], closing: CLOSING, settled: SETTLED });
  assert.deepEqual(records[0], await store.get(otherGroup));

  await assert.rejects(store.findUnsettled!({ kind: 'request', closing: 'Not A Key', settled: SETTLED }), TypeError);
  await assert.rejects(store.findUnsettled!({ kind: 'request', closing: CLOSING, settled: '' }), TypeError);
  await assert.rejects(store.findUnsettled!({ kind: 'no-such-kind' as 'request', closing: CLOSING, settled: SETTLED }), TypeError);
  await assert.rejects(store.findUnsettled!({ kind: 'request', key: 'test.group', closing: CLOSING, settled: SETTLED }), TypeError, 'a key without its values');
  await assert.rejects(store.findUnsettled!({ kind: 'request', values: ['a'], closing: CLOSING, settled: SETTLED }), TypeError);
});
