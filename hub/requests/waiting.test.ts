// The waiting requests read on their own (issue 200): the same views, in the same order, as the unanswered ones of the full
// listing, whatever closed the others and whenever it was written, while the settled requests and what closed them stay unread.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Database, createPool } from '../records/db.ts';
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
  return { kit, source, body, service: createRequestService(kit, () => NOW) };
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

test('the current answer record carries its settled entry and decides the answer', async (t) => {
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
});

test('current plain requests are skipped while declarations retain their answers', async (t) => {
  const { kit, body, service } = await bed(t);
  const run = newId('run'), other = newId('run');
  const declared = (pointer: number, of = run): RequestBody => ({ ...body(of), kind: 'judgment', declaration: `/criterion_changes/${pointer}` });
  const made: string[] = [];
  for (let i = 0; i < 4; i++) made.push((await service.write(body(run))).digest);
  const first = (await service.write(declared(0))).digest;
  const second = (await service.write(declared(2))).digest;
  await service.write(declared(0, other));
  await service.answer(first, (await kit.store.put({ kind: 'claim', schema: 'synthetic-source@1', provenance: 'declared', body: { label: 'answer' } })).digest);

  const full = await service.all(run), expected = full.filter((request) => request.declaration);
  assert.deepEqual(expected.map((request) => request.record), [first, second]);
  assert.ok(expected[0].answered_by, 'a closed declaration is listed with what closed it');
  /** The requests one listing read. */
  const read = async () => {
    const seen: string[] = [];
    const store = new Proxy(kit.store, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'findLacking') return async (...args: unknown[]) => { const rows = await (value as (...a: unknown[]) => Promise<{ digest: string }[]>).apply(target, args); seen.push(...rows.map((row) => row.digest)); return rows; };
      if (property === 'find' || property === 'list') return (query: { kind?: string }, tx?: unknown) => { assert.notEqual(query.kind, 'request', 'the requests of the run are not listed whole'); return (value as (...a: unknown[]) => unknown).call(target, query, tx); };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    assert.deepEqual(await createRequestService({ store }, () => NOW).declared(run), expected);
    return seen;
  };
  assert.deepEqual(await read(), [first, second], 'the current writer excludes plain requests from declaration reads');

  const owner = new Database(createPool(kit.database, 1)); t.after(() => owner.end());
  const plain = await owner.query<{ digest: string }>(`SELECT digest FROM record_index WHERE key='runs.request.plain' AND value=$1 ORDER BY record_seq`, [run]);
  assert.deepEqual(plain.rows.map((row) => row.digest), made, 'current writes index plain requests, not declarations');
  assert.deepEqual(await read(), [first, second], 'only current declarations require a body read');
  assert.deepEqual(await service.declared(newId('run')), []);
});
