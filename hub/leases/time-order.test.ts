// The order of lease actions in time: a change takes its moment only after its key lock, and history answers for a window
// only once every change already timed inside it is committed, saying whether the window ended before its own read
// (round-four review of the lease work, items 1 and 2; round five).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { startPostgres } from '../testing/postgres.ts';
import { createPool, Database } from '../records/db.ts';
import { LeaseService } from './service.ts';

const holder = { user: 'usr_0123456789abcdefghjkmnpqrs', run: 'run_0123456789abcdefghjkmnpqrs' };
const other = { user: 'usr_1123456789abcdefghjkmnpqrs', run: 'run_1123456789abcdefghjkmnpqrs' };
const key = 'bed/synthetic/device0';

async function world(t: import('node:test').TestContext) {
  const postgres = await startPostgres();
  t.after(() => postgres.stop());
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const database = () => {
    const db = new Database(createPool(kit.database, 2));
    t.after(() => db.end());
    return db;
  };
  return { kit, database };
}

/** A clock that stops inside the change's transaction, after its locks, until the gate opens. */
function gatedClock(t: import('node:test').TestContext, at: string) {
  let reached!: () => void;
  let open!: () => void;
  const inside = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { open = resolve; });
  t.after(() => open());
  let opened = false;
  return {
    inside,
    open: () => { opened = true; open(); },
    get opened() { return opened; },
    now: async () => { reached(); await gate; return new Date(at); },
  };
}

/** The records store, with every put held at a gate: a change that reaches it has its time and has not committed. */
function gatedRecords(t: import('node:test').TestContext, store: Awaited<ReturnType<typeof openTestRecords>>['store']) {
  let reached!: () => void;
  let open!: () => void;
  const inside = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { open = resolve; });
  t.after(() => open());
  const records = new Proxy(store, {
    get(target, property) {
      if (property === 'put') return async (...args: Parameters<typeof store.put>) => { reached(); await gate; return target.put(...args); };
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { records, inside, open: () => open() };
}

/** Whether a promise is still pending after a short wait (a lock it should be waiting for). */
async function pending(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  const marker = Symbol('pending');
  return (await Promise.race([promise.then(() => null, () => null), new Promise(resolve => setTimeout(() => resolve(marker), ms))])) === marker;
}

test('a blocked release takes its timestamp after the row lock, and history waits for it instead of answering without it', { timeout: 30_000 }, async t => {
  const { kit, database } = await world(t);
  const db = database();
  const service = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:00.000Z') });
  assert.ok((await service.acquire({ keys: [key], holder, prefix: 'bed/' })).ok);
  const events: string[] = [];
  const original = db.query.bind(db);
  db.query = new Proxy(original, {
    apply(target, _this, args) {
      if (String(args[0]).includes('FOR UPDATE')) events.push('lock');
      return Reflect.apply(target, _this, args);
    },
  });
  const clock = gatedClock(t, '2026-10-27T08:00:02.000Z');
  const blocked = new LeaseService(db, { records: kit.store, now: async () => { events.push('now'); return clock.now(); } });
  const releasing = blocked.release({ keys: [key], holder });
  await clock.inside;
  assert.deepEqual(events, ['lock', 'now']);
  const reader = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:05.000Z') });
  const during = reader.history({ key, from: '2026-10-27T08:00:00.500Z', to: '2026-10-27T08:00:01.000Z' });
  assert.equal(await pending(during), true, 'history waits for the change holding the key');
  clock.open();
  assert.ok((await releasing).ok);
  const actions = await kit.store.find({ key: 'lease.key', value: key, kind: 'action', limit: 10 });
  assert.equal(actions.items.at(-1)?.created_at, '2026-10-27T08:00:02.000Z');
  const answered = await during;
  assert.equal(answered.before?.body.detail.op, 'acquire');
  assert.deepEqual(answered.events, [], 'the release was timed after the window');
  assert.equal(answered.settled, true);
});

test('history does not miss a change that was timed inside its window but had not committed yet', { timeout: 30_000 }, async t => {
  const { kit, database } = await world(t);
  const service = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:00.000Z') });
  assert.ok((await service.acquire({ keys: [key], holder, prefix: 'bed/' })).ok);
  // The release has read its clock (inside the window) and holds its action record at the gate, uncommitted (round five, item 1).
  const held = gatedRecords(t, kit.store);
  const releasing = new LeaseService(database(), { records: held.records, now: async () => new Date('2026-10-27T08:00:00.800Z') }).release({ keys: [key], holder });
  await held.inside;
  const reader = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:05.000Z') });
  const during = reader.history({ key, from: '2026-10-27T08:00:00.500Z', to: '2026-10-27T08:00:01.000Z' });
  assert.equal(await pending(during), true, 'history waits for the timed change to commit');
  held.open();
  assert.ok((await releasing).ok);
  const answered = await during;
  assert.deepEqual(answered.events.map(event => event.body.detail.op), ['release'], 'the release inside the window is in the answer, so no continuous lease is claimed');
  assert.equal(answered.settled, true);
});

test('a history read is settled only for a window that ended before its own moment on the lease clock (round five, item 1)', { timeout: 30_000 }, async t => {
  const { kit, database } = await world(t);
  const service = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:00.000Z') });
  assert.ok((await service.acquire({ keys: [key], holder, prefix: 'bed/' })).ok);
  const reader = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:10.000Z') });
  const settled = async (to: string) => (await reader.history({ key, from: '2026-10-27T08:00:01.000Z', to })).settled;
  assert.equal(await settled('2026-10-27T08:00:09.999Z'), true, 'ended a millisecond before the read');
  assert.equal(await settled('2026-10-27T08:00:10.000Z'), false, 'a later change may be timed in the same millisecond');
  assert.equal(await settled('2026-10-27T08:00:11.000Z'), false, 'a window that ends after the read');
});

test('an acquire that waits for a release is timed after it, never before', { timeout: 30_000 }, async t => {
  const { kit, database } = await world(t);
  const service = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:00.000Z') });
  assert.ok((await service.acquire({ keys: [key], holder, prefix: 'bed/' })).ok);
  const clock = gatedClock(t, '2026-10-27T08:00:02.000Z');
  const releasing = new LeaseService(database(), { records: kit.store, now: clock.now }).release({ keys: [key], holder });
  await clock.inside;
  let timedAfterRelease: boolean | undefined;
  const acquiring = new LeaseService(database(), {
    records: kit.store,
    now: async () => { timedAfterRelease ??= clock.opened; return new Date('2026-10-27T08:00:03.000Z'); },
  }).acquire({ keys: [key], holder: other, prefix: 'bed/' });
  assert.equal(await pending(acquiring), true, 'the acquire waits for the key');
  clock.open();
  assert.ok((await releasing).ok);
  assert.ok((await acquiring).ok);
  assert.equal(timedAfterRelease, true, 'the acquire read its clock only after the release it waited for');
});

test('an orphan reclaim that meets a release in flight re-reads the row instead of releasing it twice', { timeout: 30_000 }, async t => {
  const { kit, database } = await world(t);
  // The holder's run has no run record: an orphan once the row is older than a minute.
  const service = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:00.000Z') });
  assert.ok((await service.acquire({ keys: [key], holder, prefix: 'bed/' })).ok);
  const clock = gatedClock(t, '2026-10-27T08:01:30.000Z');
  const releasing = new LeaseService(database(), { records: kit.store, now: clock.now }).release({ keys: [key], holder });
  await clock.inside;
  let timedAfterRelease: boolean | undefined;
  const reclaiming = new LeaseService(database(), {
    records: kit.store,
    now: async () => { timedAfterRelease ??= clock.opened; return new Date('2026-10-27T08:01:31.000Z'); },
  }).reclaimOrphans();
  assert.equal(await pending(reclaiming), true, 'the reclaim waits for the key');
  clock.open();
  assert.ok((await releasing).ok);
  assert.equal(await reclaiming, 0, 'the row was released while the reclaim waited');
  assert.equal(timedAfterRelease, true, 'the reclaim read its clock only after the release it waited for (round five, item 2)');
  const log = await service.actionLog('bed/');
  assert.deepEqual(log.map(row => row.op), ['acquire', 'release']);
});

test('a history read on a one-connection pool shared with its records does not wait for its own connection (round five, item 1)', { timeout: 30_000 }, async t => {
  const { kit } = await world(t);
  const db = new Database(createPool(kit.database, 1));
  t.after(() => db.end());
  // No records option: the service's record store shares this single connection.
  const service = new LeaseService(db, { now: async () => new Date('2026-10-27T08:00:00.000Z') });
  assert.ok((await service.acquire({ keys: [key], holder, prefix: 'bed/' })).ok);
  const read = service.history({ key, from: '2026-10-27T07:59:00.000Z', to: '2026-10-27T08:01:00.000Z' });
  assert.equal(await pending(read, 5_000), false, 'the read finished instead of waiting for the connection it held');
  assert.deepEqual((await read).events.map(event => event.body.detail.op), ['acquire']);
});
