// Following the append log (append-cursor.ts) on a real database, because what it guards against is real: PostgreSQL hands out
// positions before commit, so a transaction can commit below a position that was already read.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { DatabaseConfig } from '../config/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { openAppendCursor, readAppended, type AppendCursor, type RecordStore, type Transaction } from './api.ts';

let postgres: TemporaryPostgres;
// Its own cluster: snapshots span a cluster, so a transaction of any other test file delays `settled` for as long as it is open.
before(async () => { postgres = await startPostgres({ private: true }); });
after(async () => { await postgres?.stop(); });

type Followed = RecordStore & Required<Pick<RecordStore, 'appendHorizon' | 'appended'>>;
const WATCH = { keys: ['test.feed'] };
const put = (store: RecordStore, n: number, tx?: Transaction) => store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', created_at: '2026-11-05T00:00:00.000Z', body: { n }, index: [{ key: 'test.feed', value: String(n) }] }, tx);

async function opened(t: { after: (fn: () => Promise<void>) => void }) {
  const kit: TestRecordsKit = await openTestRecords({ postgres });
  const ends: Array<() => Promise<void>> = [];
  // A failed assertion must not leave a transaction open: closing the kit would wait for it for ever.
  t.after(async () => { for (const end of ends) await end(); await kit.close(); });
  return { kit, store: kit.store as Followed, open: (n: number) => open(kit.store, n, ends) };
}

/**
 * Reads until the cursor is settled at the end of the log. Snapshots span the cluster: a transaction of another database, or
 * of autovacuum, delays `settled` by a read or two, which is what it is for, so a test waits for it instead of counting reads.
 */
async function settle(store: Followed, cursor: AppendCursor): Promise<void> {
  const end = (await store.appendHorizon()).position;
  for (let tries = 0; tries < 2000 && cursor.settled < end; tries++) {
    assert.deepEqual(await readAppended(store, cursor, WATCH), [], 'settling returns nothing new');
    await delay(1);
  }
  assert.equal(cursor.settled, end);
}

/** A transaction that has written record `n`, can write more, and stays open until `end` is called; `ends` rolls it back should a test not get there. */
async function open(store: RecordStore, n: number, ends: Array<() => Promise<void>>): Promise<{ put: (n: number) => Promise<unknown>; end: (outcome: 'commit' | 'rollback') => Promise<void> }> {
  let finish!: (outcome: 'commit' | 'rollback') => void;
  const outcome = new Promise<'commit' | 'rollback'>((resolve) => { finish = resolve; });
  let wrote!: (tx: Transaction) => void;
  const written = new Promise<Transaction>((resolve) => { wrote = resolve; });
  const done = store.withTransaction(async (tx) => {
    await put(store, n, tx);
    wrote(tx);
    if (await outcome === 'rollback') throw new Error('synthetic rollback');
  }).catch((error: unknown) => { if ((error as Error).message !== 'synthetic rollback') throw error; });
  const end = async (value: 'commit' | 'rollback') => { finish(value); await done; };
  ends.push(() => end('rollback'));
  const tx = await written;
  return { put: (more) => put(store, more, tx), end };
}

/** Until a connection of this database is waiting for a transaction to end. */
async function untilWaiting(database: DatabaseConfig): Promise<void> {
  const client = new pg.Client({ ...database, ssl: false });
  await client.connect();
  try {
    for (let tries = 0; tries < 2000; tries++) {
      if ((await client.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'transactionid'")).rows.length > 0) return;
      await delay(1);
    }
    assert.fail('no connection started waiting');
  } finally { await client.end(); }
}

test('appended gives a range of the log by key and kind, without bodies and without what came before', async (t) => {
  const { store } = await opened(t);
  await put(store, 1);
  const mark = (await store.appendHorizon()).position;
  const second = await put(store, 2);
  await store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { other: true }, index: [{ key: 'test.other', value: 'x' }] });
  const artifact = await store.put({ kind: 'source_artifact', schema: 'source_artifact@1', provenance: 'observed', body: { synthetic: true } });
  const end = (await store.appendHorizon()).position;
  const rows = await store.appended({ after: mark, through: end, keys: ['test.feed'], kinds: ['source_artifact'] });
  assert.deepEqual(rows.map(({ digest, kind, key, value }) => ({ digest, kind, key, value })), [
    { digest: second.digest, kind: 'claim', key: 'test.feed', value: '2' },
    { digest: artifact.digest, kind: 'source_artifact', key: null, value: null },
  ]);
  assert.ok(rows[0].position > mark && rows[0].position < rows[1].position && rows[1].position <= end);
  assert.ok(rows.every((row) => !('body' in row)));
  assert.deepEqual(await store.appended({ after: end, through: end, keys: ['test.feed'] }), []);
  assert.deepEqual(await store.appended({ after: mark, through: end, keys: [] }), []);
  await assert.rejects(store.appended({ after: mark, through: end, keys: ['Bad Key'] }), TypeError);
  await assert.rejects(store.appended({ after: -1, through: end, keys: ['test.feed'] }), TypeError);
  await assert.rejects(store.appended({ after: mark, through: end, keys: [], kinds: ['no_such_kind' as 'claim'] }), TypeError);
});

test('a cursor returns each new record once and, when nothing changed, reads only the end of the log', async (t) => {
  const { store } = await opened(t);
  await put(store, 1);
  const cursor = await openAppendCursor(store);
  assert.deepEqual(await readAppended(store, cursor, WATCH), [], 'what came before the cursor is not returned');
  await put(store, 2);
  await put(store, 3);
  assert.deepEqual((await readAppended(store, cursor, WATCH)).map((row) => row.value), ['2', '3']);
  assert.deepEqual(await readAppended(store, cursor, WATCH), [], 'and not twice');
  await settle(store, cursor);
  let ranges = 0;
  const counted = { appendHorizon: () => store.appendHorizon(), appended: (query: Parameters<Followed['appended']>[0]) => { ranges += 1; return store.appended(query); } };
  await readAppended(counted, cursor, WATCH);
  assert.equal(ranges, 0, 'settled at the end of the log, an idle read asks for no range');
  await put(store, 4);
  assert.deepEqual((await readAppended(counted, cursor, WATCH)).map((row) => row.value), ['4']);
});

test('a transaction that commits below a position already read is still returned, exactly once', async (t) => {
  const { store, open } = await opened(t);
  const cursor = await openAppendCursor(store);
  const slow = await open(1);
  await put(store, 2);
  await put(store, 3);
  assert.deepEqual((await readAppended(store, cursor, WATCH)).map((row) => row.value), ['2', '3'], 'the open transaction does not delay what is visible');
  assert.deepEqual(await readAppended(store, cursor, WATCH), [], 'nor is that returned again while it stays open');
  await put(store, 4);
  assert.deepEqual((await readAppended(store, cursor, WATCH)).map((row) => row.value), ['4']);
  await slow.end('commit');
  assert.deepEqual((await readAppended(store, cursor, WATCH)).map((row) => row.value), ['1'], 'its position is below everything already read');
  assert.deepEqual(await readAppended(store, cursor, WATCH), []);
  assert.deepEqual(await readAppended(store, cursor, WATCH), []);
});

test('a transaction younger than any that completed is waited for too, though no snapshot lists it', async (t) => {
  const { store, open } = await opened(t);
  const cursor = await openAppendCursor(store);
  const older = await open(1);
  const younger = await open(2);
  await older.put(3);
  await older.end('commit');
  assert.deepEqual((await readAppended(store, cursor, WATCH)).map((row) => row.value), ['1', '3'], 'the younger transaction holds the lower position');
  assert.deepEqual(await readAppended(store, cursor, WATCH), [], 'and is still open');
  await younger.end('commit');
  assert.deepEqual((await readAppended(store, cursor, WATCH)).map((row) => row.value), ['2'], 'its position is below everything already read');
  assert.deepEqual(await readAppended(store, cursor, WATCH), []);
  assert.deepEqual(await readAppended(store, cursor, WATCH), []);
});

test('a writer held up inside its insert already has its transaction id, so it is waited for like any other', async (t) => {
  const { kit, store, open } = await opened(t);
  const cursor = await openAppendCursor(store);
  const first = await open(1);
  // The same record: this writer has its position and waits to see whether the first one commits.
  const second = open(1);
  await untilWaiting(kit.database);
  await put(store, 2);
  assert.deepEqual((await readAppended(store, cursor, WATCH)).map((row) => row.value), ['2']);
  await first.end('rollback');
  const held = await second;
  assert.deepEqual(await readAppended(store, cursor, WATCH), [], 'it has written below what was read, and is still open');
  await held.end('commit');
  assert.deepEqual((await readAppended(store, cursor, WATCH)).map((row) => row.value), ['1'], 'its position is below everything already read');
  assert.deepEqual(await readAppended(store, cursor, WATCH), []);
  assert.deepEqual(await readAppended(store, cursor, WATCH), []);
});

test('a position stays open while a transaction may still hold one below it, and a rollback frees it', async (t) => {
  const { store, open } = await opened(t);
  const cursor = await openAppendCursor(store);
  const slow = await open(1);
  await put(store, 2);
  await readAppended(store, cursor, WATCH);
  await readAppended(store, cursor, WATCH);
  const held = cursor.settled;
  assert.ok(held < (await store.appendHorizon()).position, 'not settled past the open transaction');
  assert.equal(cursor.seen.size, 1, 'what was returned is remembered until then');
  await slow.end('rollback');
  assert.deepEqual(await readAppended(store, cursor, WATCH), [], 'a rollback adds nothing');
  await settle(store, cursor);
  assert.equal(cursor.seen.size, 0, 'and no longer holds the cursor back');
});

test('every record of many concurrent writers is returned exactly once, whatever order they commit in', async (t) => {
  const { store, open } = await opened(t);
  const cursor = await openAppendCursor(store);
  const returned: string[] = [];
  const read = async () => { for (const row of await readAppended(store, cursor, WATCH)) returned.push(row.value!); };
  const open1 = await open(1), open2 = await open(2);
  await Promise.all([put(store, 3), put(store, 4)]);
  await read();
  const open5 = await open(5);
  await open2.end('commit');
  await put(store, 6);
  await read();
  await open1.end('rollback');
  await open5.end('commit');
  await read();
  await read();
  assert.deepEqual(returned.sort(), ['2', '3', '4', '5', '6']);
});

test('a new cursor waits for the transactions open now, so that one whole read after it misses none of them', async (t) => {
  const { store, open } = await opened(t);
  const slow = await open(1);
  await put(store, 2);
  let ready = false;
  const opening = openAppendCursor(store, { tries: 100_000, waitMs: 5 }).then((cursor) => { ready = true; return cursor; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ready, false, 'still waiting for the open transaction');
  await slow.end('commit');
  const cursor = await opening;
  assert.ok((await store.find({ key: 'test.feed', value: '1' })).items.length === 1, 'the whole read that follows sees it');
  assert.deepEqual(await readAppended(store, cursor, WATCH), [], 'so the cursor rightly starts after it');
  const stuck = await open(3);
  await openAppendCursor(store, { tries: 2, waitMs: 1 });
  await stuck.end('commit');
});

test('a new cursor waits for a transaction younger than any that completed too', async (t) => {
  const { store, open } = await opened(t);
  const older = await open(1), younger = await open(2);
  await older.end('commit');
  let ready = false;
  const opening = openAppendCursor(store, { tries: 100_000, waitMs: 5 }).then(() => { ready = true; });
  await delay(40);
  assert.equal(ready, false);
  await younger.end('commit');
  await opening;
});
