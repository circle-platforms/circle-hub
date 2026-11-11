// The waiting requests read on their own (issue 200): the same views, in the same order, as the unanswered ones of the full
// listing, whatever closed the others and whenever it was written, while the settled requests and what closed them stay unread.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Database, createPool } from '../records/db.ts';
import { MIGRATIONS } from '../records/migrations.ts';
import { newId } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { closingIndex, createRequestService, type RequestBody } from './api.ts';

let pg: TemporaryPostgres;
before(async () => { pg = await startPostgres(); });
after(async () => { await pg?.stop(); });

const NOW = new Date('2026-11-11T00:00:00.000Z');
const AUDIENCE = 'usr_' + '0'.repeat(26);

async function bed(t: { after(fn: () => unknown): void }) {
  const kit = await openTestRecords({ postgres: pg });
  t.after(() => kit.close());
  const source = async (label: string) => (await kit.store.put({ kind: 'claim', schema: 'synthetic-source@1', provenance: 'declared', body: { label } })).digest;
  const first = await source('first');
  let n = 0;
  const body = (run?: string): RequestBody => ({ kind: 'repair', audience: AUDIENCE, due: '2026-11-13T00:00:00.000Z', missing: `合成缺口 ${++n}`, next_action: '补上后原样重交', source: first, code: 'missing_input', ...(run === undefined ? { pack_digest: 'd'.repeat(64) } : { run }) });
  /** A closing record as code before the settled entry wrote it: found under the answer key alone. */
  const legacyClosing = async (request: string, detail: Record<string, unknown>) => {
    const at = NOW.toISOString();
    await kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', created_at: at, body: { action: 'validate', run: null, item: null, inputs: [`rec:${request}`], component: 'synthetic-legacy@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail: { ...detail, n: ++n } }, index: [{ key: 'runs.request.answer', value: request }] });
  };
  return { kit, source, body, legacyClosing, service: createRequestService(kit, () => NOW) };
}

/** The store with the values each batched read of closing records asked for. */
function watched(kit: TestRecordsKit): { store: TestRecordsKit['store']; closingsAsked: string[][]; requestsListed: number } {
  const seen = { closingsAsked: [] as string[][], requestsListed: 0 };
  const store = new Proxy(kit.store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'findMany') return (query: { key: string; values: readonly string[] }, tx?: unknown) => { if (query.key === 'runs.request.answer') seen.closingsAsked.push([...query.values]); return (value as (...args: unknown[]) => unknown).call(target, query, tx); };
      if (property === 'find' || property === 'list') return (query: { kind?: string }, tx?: unknown) => { if (query.kind === 'request') seen.requestsListed++; return (value as (...args: unknown[]) => unknown).call(target, query, tx); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.assign(seen, { store });
}

test('the waiting requests are the unanswered ones of the full listing, and only they and their closings are read', async (t) => {
  const { kit, source, body, service } = await bed(t);
  const run = newId('run'), other = newId('run');
  const made = [];
  for (let i = 0; i < 8; i++) made.push((await service.write(body(run))).digest);
  const elsewhere = (await service.write(body(other))).digest, unbound = (await service.write(body())).digest;
  const later = await source('later'), again = await source('again');
  await service.answer(made[0], later);                       // answered
  assert.equal(await service.supersede([made[1], made[2], made[3]], later), 3);   // voided by a later result
  assert.equal(await service.reinstate([made[2]], again), 1);  // waits again
  assert.equal(await service.supersede([made[3]], again), 0, 'a voided request keeps what voided it');
  assert.equal(await service.reinstate([made[3]], again), 1);
  assert.equal(await service.supersede([made[3]], again), 1, 'and one that waits again can be voided again');

  const full = await service.all(run), waiting = await service.waiting(run);
  assert.deepEqual(waiting, full.filter((request) => request.answered_by === null));
  assert.deepEqual(waiting.map((request) => request.record), [made[2], made[4], made[5], made[6], made[7]]);
  assert.deepEqual((await service.waiting(other)).map((request) => request.record), [elsewhere]);
  assert.deepEqual(await service.waiting(), (await service.all()).filter((request) => request.answered_by === null));
  assert.ok((await service.waiting()).some((request) => request.record === unbound), 'a request bound to a published pack and no run is listed among all');
  assert.deepEqual(await service.waiting(newId('run')), []);

  // What is read: no listing of every request, and closing records for the waiting candidates alone.
  const seen = watched(kit), narrow = createRequestService({ store: seen.store }, () => NOW);
  await narrow.waiting(run);
  assert.equal(seen.requestsListed, 0, 'the requests of the run are not listed whole');
  assert.deepEqual(seen.closingsAsked, [[made[2], made[4], made[5], made[6], made[7]]], 'the answered and the voided requests are not asked about');
});

test('closing records stored before the settled entry answer the same, and migration 32 spares their reads', async (t) => {
  const { kit, source, body, legacyClosing, service } = await bed(t);
  const run = newId('run');
  const made = [];
  for (let i = 0; i < 6; i++) made.push((await service.write(body(run))).digest);
  const later = await source('later');
  await legacyClosing(made[0], { request: made[0], answer: later });
  await legacyClosing(made[1], { request: made[1], answer: later, superseded: true });
  await legacyClosing(made[2], { request: made[2], answer: later, superseded: true });
  await legacyClosing(made[2], { request: made[2], reinstated_by: later });   // waits again
  await legacyClosing(made[3], { answer: later });                             // an answer that does not name its request
  await legacyClosing(made[4], { request: made[4], answer: 7 });               // no answer: a source is a digest
  const expected = [made[2], made[4], made[5]];
  const full = await service.all(run);
  assert.deepEqual(full.filter((request) => request.answered_by === null).map((request) => request.record), expected);

  const before = watched(kit);
  assert.deepEqual(await createRequestService({ store: before.store }, () => NOW).waiting(run), full.filter((request) => request.answered_by === null));
  assert.deepEqual(new Set(before.closingsAsked.flat()), new Set(made), 'without the entry every request is a candidate, read as before');

  const owner = new Database(createPool(kit.database, 1)); t.after(() => owner.end());
  const migration = MIGRATIONS.find((m) => m.version === 32)!;
  await owner.query(migration.sql);
  await owner.query(migration.sql);
  const settled = await owner.query<{ value: string }>(`SELECT value FROM record_index WHERE key='runs.request.settled' ORDER BY value`);
  assert.deepEqual(settled.rows.map((row) => row.value), [made[0], made[1], made[2], made[3]].sort(), 'one entry for each closing record that carries a source, added once');

  const after = watched(kit);
  assert.deepEqual(await createRequestService({ store: after.store }, () => NOW).waiting(run), full.filter((request) => request.answered_by === null));
  assert.deepEqual(after.closingsAsked, [expected], 'the settled ones are no longer read; the one that waits again still is');
  assert.deepEqual(await service.all(run), full, 'the full listing is untouched');
});

test('what the index says is never the answer: a closing record decides, and a store without the index reads them all', async (t) => {
  const { kit, source, body, service } = await bed(t);
  const run = newId('run');
  const one = (await service.write(body(run))).digest, two = (await service.write(body(run))).digest;
  const later = await source('later');
  // A settled entry on a record that does not answer: the request is left out of the candidates, as the entry says. The
  // entry is written by the request service alone, with the closing record, in the same statement as its answer entry.
  assert.deepEqual(closingIndex(one, true), [{ key: 'runs.request.answer', value: one }, { key: 'runs.request.settled', value: one }]);
  assert.deepEqual(closingIndex(one, false), [{ key: 'runs.request.answer', value: one }]);
  await service.answer(one, later);
  const entries = await kit.store.findMany<{ detail: { answer?: string } }>({ kind: 'action', key: 'runs.request.settled', values: [one, two] });
  assert.deepEqual(entries.map((record) => record.body.detail.answer), [later], 'the answer carries the entry; nothing else does');
  assert.deepEqual((await service.waiting(run)).map((request) => request.record), [two]);

  const plain = new Proxy(kit.store, { get(target, property) { if (property === 'findUnsettled') return undefined; const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value; } });
  assert.deepEqual(await createRequestService({ store: plain }, () => NOW).waiting(run), await service.waiting(run));
});
