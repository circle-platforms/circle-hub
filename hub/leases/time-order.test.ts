// The order of lease actions in time: a change takes its moment only after its key lock, and history answers for a window
// only once every change already timed inside it is committed (round-four review of the lease work, items 1 and 2).
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
  const during = service.history({ key, from: '2026-10-27T08:00:00.500Z', to: '2026-10-27T08:00:01.000Z' });
  assert.equal(await pending(during), true, 'history waits for the change holding the key');
  clock.open();
  assert.ok((await releasing).ok);
  const actions = await kit.store.find({ key: 'lease.key', value: key, kind: 'action', limit: 10 });
  assert.equal(actions.items.at(-1)?.created_at, '2026-10-27T08:00:02.000Z');
  const answered = await during;
  assert.equal(answered.before?.body.detail.op, 'acquire');
  assert.deepEqual(answered.events, [], 'the release was timed after the window');
});

test('history does not miss a change that was timed inside its window but had not committed yet', { timeout: 30_000 }, async t => {
  const { kit, database } = await world(t);
  const service = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:00:00.000Z') });
  assert.ok((await service.acquire({ keys: [key], holder, prefix: 'bed/' })).ok);
  const clock = gatedClock(t, '2026-10-27T08:00:00.800Z');
  const releasing = new LeaseService(database(), { records: kit.store, now: clock.now }).release({ keys: [key], holder });
  await clock.inside;
  const during = service.history({ key, from: '2026-10-27T08:00:00.500Z', to: '2026-10-27T08:00:01.000Z' });
  assert.equal(await pending(during), true);
  clock.open();
  assert.ok((await releasing).ok);
  const answered = await during;
  assert.deepEqual(answered.events.map(event => event.body.detail.op), ['release'], 'the release inside the window is in the answer, so no continuous lease is claimed');
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
  const reclaiming = new LeaseService(database(), { records: kit.store, now: async () => new Date('2026-10-27T08:01:31.000Z') }).reclaimOrphans();
  assert.equal(await pending(reclaiming), true, 'the reclaim waits for the key');
  clock.open();
  assert.ok((await releasing).ok);
  assert.equal(await reclaiming, 0, 'the row was released while the reclaim waited');
  const log = await service.actionLog('bed/');
  assert.deepEqual(log.map(row => row.op), ['acquire', 'release']);
});
