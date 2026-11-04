// What the console's 运行状况 page reads of the two tables of migration 28, on a temporary PostgreSQL: curves aggregated in SQL
// to a fixed number of points, unknown kept apart from zero, and every read for administrators only.
import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import type { Principal } from '../records/api.ts';
import { Database, createPool } from '../records/db.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { HealthAccessError, healthReader, type HealthReader } from './api.ts';
import { emptyValues, insertEvent, insertSample, type ProcessEvent, type ResourceSample } from './store.ts';

const START = Date.parse('2026-11-04T00:00:00.000Z');
const MINUTE_MS = 60_000;
const ADMIN: Principal = { id: 'usr_00000000000000000000000000', name: 'synthetic-admin', role: 'admin' };
const MEMBER: Principal = { id: 'usr_00000000000000000000000001', name: 'synthetic-member', role: 'user' };
const at = (ms: number): string => new Date(START + ms).toISOString();

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

async function world(t: TestContext): Promise<{ db: Database; reader: HealthReader }> {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const db = new Database(createPool(kit.database, 2));
  t.after(() => db.end());
  return { db, reader: healthReader(db) };
}

const sample = (ms: number, fields: Partial<ResourceSample> = {}): ResourceSample => ({ ...emptyValues(), sampled_at: at(ms), boot: 'boot-a', interval_ms: 10_000, failed_reads: [], dropped_samples: 0, ...fields });
const event = (ms: number, fields: Partial<ProcessEvent> = {}): ProcessEvent => ({ at: at(ms), kind: 'start', boot: `boot-${ms}`, pid: 4242, release: null, node_version: 'v24.0.0', heap_limit_bytes: null, uptime_ms: null, last_seen_at: null, requests: null, requests_omitted: 0, reports: null, ...fields });

test('a curve has as many points as asked, the most of each interval, and null where nothing was read', async (t) => {
  const { db, reader } = await world(t);
  for (const row of [
    sample(10_000, { heap_used_bytes: 100, event_loop_delay_max_ms: 40 }),
    sample(20_000, { heap_used_bytes: 300, event_loop_delay_max_ms: 5 }),
    sample(30_000, { heap_used_bytes: 200 }),
    // The second interval has samples and no reading of the heap; the third has no sample at all.
    sample(MINUTE_MS + 10_000, { failed_reads: ['memory'], dropped_samples: 2 }),
    sample(3 * MINUTE_MS + 10_000, { heap_used_bytes: 0, sandbox_running: 0 }),
  ]) await insertSample(db, row);
  const points = await reader.curve(ADMIN, { from: new Date(START), to: new Date(START + 4 * MINUTE_MS), points: 4 });
  assert.equal(points.length, 4);
  assert.deepEqual(points.map((point) => point.at), [at(0), at(MINUTE_MS), at(2 * MINUTE_MS), at(3 * MINUTE_MS)]);
  assert.deepEqual(points.map((point) => point.heap_used_bytes), [300, null, null, 0], 'a spike stays; unknown is not 0, and 0 is not unknown');
  assert.equal(points[0]!.event_loop_delay_max_ms, 40);
  assert.deepEqual(points.map((point) => [point.samples, point.failed, point.dropped]), [[3, 0, 0], [1, 1, 2], [0, 0, 0], [1, 0, 0]]);
  assert.deepEqual([points[0]!.last_at, points[2]!.last_at], [at(30_000), null]);
});

test('a curve keeps the least free disk, counts what is out of the pool, and stays inside its window', async (t) => {
  const { db, reader } = await world(t);
  for (const row of [
    sample(-1, { heap_used_bytes: 999 }),
    sample(10_000, { data_free_bytes: 900, pool_total: 7, pool_idle: 4, requests_in_flight: 2 }),
    sample(20_000, { data_free_bytes: 800, pool_total: 3, pool_idle: 3, requests_in_flight: 6 }),
    sample(30_000, { pool_total: 9 }),
    sample(MINUTE_MS, { heap_used_bytes: 999 }),
  ]) await insertSample(db, row);
  const [point] = await reader.curve(ADMIN, { from: new Date(START), to: new Date(START + MINUTE_MS), points: 1 });
  assert.deepEqual([point!.data_free_bytes, point!.pool_in_use, point!.requests_in_flight, point!.heap_used_bytes], [800, 3, 6, null]);
});

test('the curve of one process leaves the others out: the five minutes before a crash are that process alone', async (t) => {
  const { db, reader } = await world(t);
  await insertSample(db, sample(10_000, { boot: 'boot-a', heap_used_bytes: 111 }));
  await insertSample(db, sample(10_000, { boot: 'boot-b', heap_used_bytes: 222 }));
  const [point] = await reader.curve(ADMIN, { from: new Date(START), to: new Date(START + MINUTE_MS), points: 1, boot: 'boot-a' });
  assert.equal(point!.heap_used_bytes, 111);
});

test('events are named by their position, and their count stops at its limit', async (t) => {
  const { db, reader } = await world(t);
  for (const ms of [0, 1000, 2000, 3000]) await insertEvent(db, event(ms));
  const events = await reader.events(ADMIN, { limit: 2 });
  assert.deepEqual(events.map((row) => row.at), [at(3000), at(2000)]);
  assert.ok(events[0]!.seq > events[1]!.seq);
  assert.equal(await reader.eventCount(ADMIN, { limit: 3 }), 3, 'a crash loop does not make the count itself long');
  assert.equal(await reader.eventCount(ADMIN, { limit: 100 }), 4);
});

test('releases come newest first with their first start and last event; a process without one is left out', async (t) => {
  const { db, reader } = await world(t);
  await insertEvent(db, event(0, { release: 'aaaaaaaaaaaa', boot: 'boot-1' }));
  await insertEvent(db, event(1000, { release: 'aaaaaaaaaaaa', boot: 'boot-2' }));
  await insertEvent(db, event(2000, { release: 'aaaaaaaaaaaa', boot: 'boot-2', kind: 'stop', uptime_ms: 1000 }));
  await insertEvent(db, event(3000, { release: 'bbbbbbbbbbbb', boot: 'boot-3' }));
  await insertEvent(db, event(4000, { release: null, boot: 'boot-4' }));
  assert.deepEqual(await reader.releases(ADMIN, { limit: 5, events: 100 }), { rows: [{ release: 'bbbbbbbbbbbb', first_start: at(3000), last_event: at(3000) }, { release: 'aaaaaaaaaaaa', first_start: at(0), last_event: at(2000) }], total: 2 });
  const shown = await reader.releases(ADMIN, { limit: 1, events: 100 });
  assert.deepEqual([shown.rows.length, shown.total], [1, 2], 'the page can say how many there are');
  const end = await reader.releases(ADMIN, { limit: 5, events: 1 });
  assert.deepEqual(end.rows.map((row) => row.release), ['bbbbbbbbbbbb'], 'only the latest events are read');
});

test('a release whose start the retention took away still has a beginning: its earliest event', async (t) => {
  const { db, reader } = await world(t);
  await insertEvent(db, event(2000, { release: 'aaaaaaaaaaaa', kind: 'stop', uptime_ms: 1000 }));
  assert.equal((await reader.releases(ADMIN, { limit: 5, events: 100 })).rows[0]!.first_start, at(2000));
});

test('every read is for administrators, in the reader too', async (t) => {
  const { reader } = await world(t);
  const window = { from: new Date(START), to: new Date(START + MINUTE_MS), points: 1 };
  await assert.rejects(reader.curve(MEMBER, window), HealthAccessError);
  await assert.rejects(reader.eventCount(MEMBER, { limit: 1 }), HealthAccessError);
  await assert.rejects(reader.releases(MEMBER, { limit: 1, events: 1 }), HealthAccessError);
  await assert.rejects(reader.events(MEMBER, { limit: 1 }), HealthAccessError);
  await assert.rejects(reader.summary(MEMBER, { since: new Date(START) }), HealthAccessError);
});

test('a read of a pool with a statement timeout is cut off by the server', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const db = new Database(createPool(kit.database, 1, { statementTimeoutMs: 20 }));
  t.after(() => db.end());
  await assert.rejects(db.query('SELECT pg_sleep(30)'), { code: '57014' });
  assert.equal((await db.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one, 1, 'the connection goes on');
});
