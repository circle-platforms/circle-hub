// Process events on a temporary PostgreSQL: how a process's ending is established at the next start, what reaches the
// abnormal-exit event, retention, and what the runtime role may do with the two tables.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Principal } from '../records/api.ts';
import { Database, createPool } from '../records/db.ts';
import { grantRuntime } from '../records/migrations.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { createHealth, HealthAccessError, healthReader, INFLIGHT_FILE, NUMERIC_FIELDS, pruneExpired, RETENTION_MS, type Health, type ProcessEvent, type ResourceSample } from './api.ts';
import { createRequestLog } from './inflight.ts';
import { emptyValues, insertEvent, insertSample } from './store.ts';

const FIXTURE = readFileSync(new URL('./fixtures/report.synthetic.json', import.meta.url), 'utf8');
const ADMIN: Principal = { id: 'usr_synthetic_admin', name: 'synthetic-admin', role: 'admin' };
const MEMBER: Principal = { id: 'usr_synthetic_member', name: 'synthetic-member', role: 'user' };

let kit: TestRecordsKit;
let db: Database;

before(async () => {
  kit = await openTestRecords();
  db = new Database(createPool(kit.database, 4));
});

after(async () => {
  await db.end();
  await kit.close();
});

/** A clean slate and a scratch data root for one test. */
async function world(t: TestContext) {
  await db.query('DELETE FROM public.process_events');
  await db.query('DELETE FROM public.resource_samples');
  const root = mkdtempSync(join(tmpdir(), 'circle-hub-health-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requestLogDir = join(root, 'logs');
  const reportsDir = join(requestLogDir, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const state = { at: Date.parse('2026-01-02T03:00:00.000Z') };
  const logs: string[] = [];
  const now = () => new Date((state.at += 1000));
  const open = (database: Database | { query: Database['query'] } = db, timing: { sampleIntervalMs?: number; retentionDelayMs?: number; stopWaitMs?: number } = {}): Health => createHealth({ db: database, requestLogDir, reportsDir, log: (line) => logs.push(line), now, ...timing });
  const sources = { release: 'synthetic-release', dataDir: root, pool: () => ({ limit: 10, total: 3, idle: 2, waiting: 0, connectionFailures: 0 }), sandbox: () => ({ running: 0, limit: 8, waiting: 0, timeouts: 0, queueFull: 0 }), consoleStreams: () => 0 };
  return { root, requestLogDir, reportsDir, logs, open, sources, state };
}

const events = () => healthReader(db).events(ADMIN, { limit: 50 });
const kinds = async () => (await events()).map((event) => event.kind).reverse();
const exit = async (): Promise<ProcessEvent> => {
  const found = (await events()).filter((event) => event.kind === 'abnormal_exit');
  assert.equal(found.length, 1);
  return found[0]!;
};

test('a process with no clean stop is an abnormal exit at the next start, and what it was running reaches the event', async (t) => {
  const w = await world(t);
  const crashed = w.open();
  await crashed.start(w.sources);
  crashed.requests.begin({ traceId: null, origin: 'console', name: 'GET /console/runs', userId: null })();
  const running = crashed.requests.begin({ traceId: 'a'.repeat(32), origin: 'mcp', name: 'POST /mcp', userId: null });
  running.identify({ userId: 'usr_synthetic', name: 'get_nodes' });
  crashed.abandon();

  const next = w.open();
  await next.start({ ...w.sources, release: 'synthetic-next' });
  const event = await exit();
  assert.equal(event.boot, crashed.boot);
  assert.equal(event.release, 'synthetic-release', 'the crashed process\'s release, not the one that found it');
  assert.equal(event.pid, process.pid);
  assert.equal(event.node_version, process.version);
  assert.ok(Number(event.heap_limit_bytes) > 0);
  assert.deepEqual(event.requests?.map(({ origin, name, user, trace }) => ({ origin, name, user, trace })), [{ origin: 'mcp', name: 'get_nodes', user: 'usr_synthetic', trace: 'a'.repeat(32) }], 'the finished request is not listed');
  assert.deepEqual(event.reports, [], 'no report: it was not a fatal error');
  assert.ok(event.uptime_ms !== null && event.uptime_ms > 0);
  assert.ok(event.last_seen_at !== null);
  assert.deepEqual(await kinds(), ['start', 'abnormal_exit', 'start']);
  assert.match(w.logs.join('\n'), /没有正常停止/);

  await next.stop();
  const third = w.open();
  await third.start(w.sources);
  assert.deepEqual(await kinds(), ['start', 'abnormal_exit', 'start', 'stop', 'start'], 'reported once');
  await third.stop();
});

test('a clean stop is not an abnormal exit, and says how long the process ran', async (t) => {
  const w = await world(t);
  const first = w.open();
  await first.start(w.sources);
  w.state.at += 3_600_000;
  await first.stop();
  const second = w.open();
  await second.start(w.sources);
  await second.stop();
  assert.deepEqual(await kinds(), ['start', 'stop', 'start', 'stop']);
  const stop = (await events()).findLast((event) => event.kind === 'stop')!;
  assert.equal(stop.boot, first.boot);
  assert.ok(Number(stop.uptime_ms) >= 3_600_000);
  assert.equal(stop.requests, null);
  assert.deepEqual(w.logs, []);
});

test('a stop the database refused is still a clean stop: the log\'s marker says so, and the event is written late', async (t) => {
  const w = await world(t);
  let down = false;
  const flaky = { query: ((text: string, values?: unknown[]) => (down ? Promise.reject(new Error('synthetic database failure')) : db.query(text, values))) as Database['query'] };
  const first = w.open(flaky as unknown as Database);
  await first.start(w.sources);
  down = true;
  await first.stop();
  assert.match(w.logs.join('\n'), /写入进程停止事件失败/);
  assert.deepEqual(await kinds(), ['start']);
  const second = w.open();
  await second.start(w.sources);
  await second.stop();
  assert.deepEqual(await kinds(), ['start', 'stop', 'start', 'stop']);
  assert.equal((await events()).filter((event) => event.kind === 'abnormal_exit').length, 0);
});

test('a stop during the start waits for it, starts no sampling afterwards and ends clean', async (t) => {
  const w = await world(t);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const slow = { query: (async (text: string, values?: unknown[]) => { await held; return db.query(text, values); }) as Database['query'] };
  const health = w.open(slow as unknown as Database, { sampleIntervalMs: 1, retentionDelayMs: 1 });
  const started = health.start(w.sources);
  const stopping = health.stop();
  release();
  await Promise.all([started, stopping]);
  assert.deepEqual(await kinds(), ['start', 'stop']);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.resource_samples')).rows[0]!.n, 0, 'no sampling after a stop');
  assert.deepEqual(w.logs, []);
});

test('a stop is bounded when the database hangs, and the marker still tells the next start it was clean', async (t) => {
  const w = await world(t);
  const first = w.open();
  await first.start(w.sources);
  const hanging = { query: (() => new Promise(() => {})) as unknown as Database['query'] };
  const stuck = w.open(hanging as unknown as Database, { stopWaitMs: 5 });
  void stuck.start(w.sources);
  await stuck.stop();
  first.abandon();
  const next = w.open();
  await next.start(w.sources);
  await next.stop();
  const ends = (await events()).filter((event) => event.kind !== 'start');
  assert.deepEqual(ends.map((event) => [event.kind, event.boot]).sort(), [['abnormal_exit', first.boot], ['stop', next.boot]].sort(), 'only the one that really went away is abnormal');
  assert.match(w.logs.join('\n'), /写入进程停止事件失败/);
});

test('with no line of that process in the log, what it was running is unknown, not nothing', async (t) => {
  const w = await world(t);
  const crashed = w.open();
  await crashed.start(w.sources);
  crashed.abandon();
  rmSync(join(w.requestLogDir, INFLIGHT_FILE));
  const next = w.open();
  await next.start(w.sources);
  assert.equal((await exit()).requests, null);
  await next.stop();
});

test('a process that crashed with nothing running says so: an empty list', async (t) => {
  const w = await world(t);
  const crashed = w.open();
  await crashed.start(w.sources);
  crashed.abandon();
  const next = w.open();
  await next.start(w.sources);
  assert.deepEqual((await exit()).requests, []);
  await next.stop();
});

test('a process that never held the port judges nobody: the running one is not called crashed and keeps its log', async (t) => {
  const w = await world(t);
  const running = w.open();
  await running.start(w.sources);
  const held = running.requests.begin({ traceId: null, origin: 'mcp', name: 'POST /mcp', userId: null });
  // A second `serve` on the same data root: it fails to bind, so it never calls start().
  w.open().abandon();
  assert.deepEqual(await kinds(), ['start']);
  held();
  await running.stop();
  const next = w.open();
  await next.start(w.sources);
  await next.stop();
  assert.deepEqual(await kinds(), ['start', 'stop', 'start', 'stop']);
});

test('the crash report of the process reaches its abnormal-exit event, and is not read twice', async (t) => {
  const w = await world(t);
  const crashed = w.open();
  await crashed.start(w.sources);
  crashed.abandon();
  const report = JSON.parse(FIXTURE) as { header: { processId: number; dumpEventTimeStamp: string } };
  report.header.processId = process.pid;
  report.header.dumpEventTimeStamp = String(Date.parse('2026-01-02T03:30:00.000Z'));
  const file = `report.20260102.033000.${process.pid}.0.001.json`;
  writeFileSync(join(w.reportsDir, file), JSON.stringify(report));
  const next = w.open();
  await next.start(w.sources);
  const event = await exit();
  assert.deepEqual(event.reports?.map(({ file: name, event: reason, trigger, heap }) => ({ name, reason, trigger, used: heap?.used_bytes })), [{ name: file, reason: 'Allocation failed - JavaScript heap out of memory', trigger: 'OOMError', used: 2197815296 }]);
  assert.equal(event.last_seen_at, '2026-01-02T03:30:00.000Z', 'the report is its last sign of life');
  assert.deepEqual(readdirSync(w.reportsDir), [`${file}.ingested`]);
  await next.stop();
  const third = w.open();
  await third.start(w.sources);
  await third.stop();
  assert.equal((await events()).filter((item) => item.kind === 'abnormal_exit').length, 1);
});

test('a report no start matches is a process that crashed before it listened: its own event, not pinned on another process', async (t) => {
  const w = await world(t);
  const crashed = w.open();
  await crashed.start(w.sources);
  await crashed.stop();
  writeFileSync(join(w.reportsDir, 'report.20260102.033000.4242.0.001.json'), FIXTURE);
  const next = w.open();
  await next.start(w.sources);
  const event = await exit();
  assert.equal(event.boot, null);
  assert.equal(event.pid, 4242);
  assert.equal(event.requests, null, 'nothing is known of what it was doing');
  assert.equal(event.reports?.[0]?.event, 'Allocation failed - JavaScript heap out of memory');
  await next.stop();
});

test('a real heap exhaustion: the running request and the report are at the next start, and the finished request is not', async (t) => {
  const w = await world(t);
  const boot = `real-${randomBytes(4).toString('hex')}`;
  const child = spawnSync(process.execPath, ['--max-old-space-size=32', '--report-on-fatalerror', `--report-directory=${w.reportsDir}`, '--report-exclude-env', '--report-compact', fileURLToPath(new URL('./fixtures/crash-child.ts', import.meta.url)), w.requestLogDir, boot], { encoding: 'utf8', env: { PATH: process.env.PATH, SYNTHETIC_MARKER: 'synthetic-environment-value' } });
  assert.equal(child.status, null, 'it did not exit by itself');
  assert.equal(child.signal, 'SIGABRT');
  const [file] = readdirSync(w.reportsDir);
  assert.match(file!, /^report\./);
  assert.ok(!readFileSync(join(w.reportsDir, file!), 'utf8').includes('synthetic-environment-value'), 'no environment in the report');
  const pid = Number(file!.split('.')[3]);
  await insertEvent(db, { at: '2026-01-02T00:00:00.000Z', kind: 'start', boot, pid, release: 'synthetic-release', node_version: process.version, heap_limit_bytes: 1, uptime_ms: null, last_seen_at: null, requests: null, requests_omitted: 0, reports: null });
  const next = w.open();
  await next.start(w.sources);
  const event = await exit();
  assert.deepEqual(event.requests?.map(({ origin, name, user, trace }) => ({ origin, name, user, trace })), [{ origin: 'mcp', name: 'get_nodes', user: 'usr_synthetic', trace: 'e'.repeat(32) }]);
  assert.equal(event.reports?.length, 1);
  const report = event.reports![0]!;
  assert.equal(report.readable, true);
  assert.equal(report.pid, pid);
  assert.match(report.event!, /heap out of memory/);
  assert.ok(typeof report.trigger === 'string' && report.trigger.length > 0);
  assert.ok(Number(report.heap?.used_bytes) > 0 && Number(report.heap?.limit_bytes) > 0);
  assert.ok(Number(report.resource_usage?.rss_bytes) > 0);
  await next.stop();
});

test('one ending per process: two starts cannot both report the same crash', async (t) => {
  await world(t);
  const event: ProcessEvent = { at: '2026-01-02T00:00:00.000Z', kind: 'abnormal_exit', boot: 'boot-a', pid: 1, release: null, node_version: null, heap_limit_bytes: null, uptime_ms: null, last_seen_at: null, requests: [], requests_omitted: 0, reports: [] };
  assert.equal(await insertEvent(db, event), true);
  assert.equal(await insertEvent(db, event), false);
  assert.equal(await insertEvent(db, { ...event, kind: 'stop' }), false);
  assert.equal(await insertEvent(db, { ...event, boot: null }), true, 'an exit no start matches');
  assert.equal(await insertEvent(db, { ...event, boot: null }), true);
});

test('requests on one event are bounded, and the rest are counted', async (t) => {
  const w = await world(t);
  const crashed = w.open();
  await crashed.start(w.sources);
  for (let index = 0; index < 205; index += 1) crashed.requests.begin({ traceId: null, origin: 'mcp', name: `POST /request-${index}`, userId: null });
  crashed.abandon();
  const next = w.open();
  await next.start(w.sources);
  const event = await exit();
  assert.equal(event.requests?.length, 200);
  assert.equal(event.requests_omitted, 5);
  assert.equal(event.requests?.[0]?.name, 'POST /request-0', 'the oldest are kept');
  await next.stop();
});

test('health never stops the process: with the database gone every step is logged and the requests go on', async (t) => {
  const w = await world(t);
  const broken = { query: (async () => { throw new Error('synthetic database failure'); }) as unknown as Database['query'] };
  const health = w.open(broken as unknown as Database);
  await health.start(w.sources);
  const end = health.requests.begin({ traceId: null, origin: 'mcp', name: 'POST /mcp', userId: null });
  end();
  await health.stop();
  assert.match(w.logs.join('\n'), /读取上一个进程的结局失败/);
  assert.match(w.logs.join('\n'), /写入进程启动事件失败/);
});

function sample(at: string, boot = 'boot-a', values: Partial<ResourceSample> = {}): ResourceSample {
  return { ...emptyValues(), sampled_at: at, boot, interval_ms: 10_000, failed_reads: [], dropped_samples: 0, ...values };
}

test('a sample row keeps every field, with null for what was unavailable', async (t) => {
  await world(t);
  await insertSample(db, sample('2026-01-02T00:00:00.000Z', 'boot-a', { heap_used_bytes: 1024, event_loop_utilization: 0.5, mcp_sessions: 2, mcp_sessions_by_client: { 'client-a': 2 }, failed_reads: ['disk'], data_free_bytes: Number.NaN }));
  const row = (await db.query('SELECT * FROM public.resource_samples')).rows[0]!;
  const columns = Object.keys(row).sort();
  assert.deepEqual(columns, [...NUMERIC_FIELDS, 'seq', 'sampled_at', 'boot', 'interval_ms', 'mcp_sessions_by_client', 'failed_reads', 'dropped_samples'].sort());
  assert.equal(row.heap_used_bytes, '1024');
  assert.equal(row.event_loop_utilization, 0.5);
  assert.deepEqual(row.mcp_sessions_by_client, { 'client-a': 2 });
  assert.deepEqual(row.failed_reads, ['disk']);
  assert.equal(row.io_wait_ratio, null);
  assert.equal(row.data_free_bytes, null, 'not a number is not a reading');
});

test('the running process samples into the table with its real readings, and stops sampling when it stops', async (t) => {
  const w = await world(t);
  const health = w.open(db, { sampleIntervalMs: 1 });
  await health.start({ ...w.sources, consoleStreams: () => 4 });
  health.sessions.opened('s1', 'client-a');
  const held = health.requests.begin({ traceId: null, origin: 'mcp', name: 'POST /mcp', userId: null });
  const rows = async () => (await db.query('SELECT * FROM public.resource_samples ORDER BY seq')).rows;
  while (!(await rows()).some((row) => row.mcp_sessions === 1 && row.requests_in_flight === 1)) await new Promise((resolve) => setTimeout(resolve, 1));
  held();
  await health.stop();
  const taken = await rows();
  const row = taken.find((candidate) => candidate.mcp_sessions === 1)!;
  assert.equal(row.boot, health.boot);
  assert.ok(Number(row.heap_used_bytes) > 0 && Number(row.heap_limit_bytes) > Number(row.heap_used_bytes) && Number(row.rss_bytes) > 0);
  assert.ok(Number(row.data_free_bytes) > 0);
  assert.equal(row.pool_total, 3);
  assert.equal(row.sandbox_limit, 8);
  assert.equal(row.console_streams, 4);
  assert.deepEqual(row.mcp_sessions_by_client, { 'client-a': 1 });
  assert.equal(taken.find((candidate) => candidate.pg_active_connections !== null) !== undefined, true, 'PostgreSQL was read at the first tick');
  assert.equal(row.io_wait_ratio, process.platform === 'linux' ? row.io_wait_ratio : null, 'unknown on macOS, never 0');
  assert.ok(taken.every((candidate) => candidate.failed_reads !== null && (candidate.failed_reads as string[]).length === 0), JSON.stringify(taken.map((candidate) => candidate.failed_reads)));
  assert.deepEqual(w.logs, []);
  const count = taken.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await rows()).length, count, 'nothing is written after the stop');
});

test('what the database refused at a start is not lost: the log and the reports wait for the next start', async (t) => {
  const w = await world(t);
  const crashed = w.open();
  await crashed.start(w.sources);
  crashed.requests.begin({ traceId: null, origin: 'mcp', name: 'POST /mcp', userId: 'usr_synthetic' });
  crashed.abandon();
  const report = JSON.parse(FIXTURE) as { header: { processId: number } };
  report.header.processId = process.pid;
  const file = `report.20260102.033000.${process.pid}.0.001.json`;
  writeFileSync(join(w.reportsDir, file), JSON.stringify(report));
  const refusing = { query: ((text: string, values?: unknown[]) => (/INSERT/.test(text) ? Promise.reject(new Error('synthetic database failure')) : db.query(text, values))) as Database['query'] };
  const unlucky = w.open(refusing as unknown as Database);
  await unlucky.start(w.sources);
  unlucky.abandon();
  assert.deepEqual(await kinds(), ['start'], 'nothing was written');
  assert.deepEqual(readdirSync(w.reportsDir), [file], 'the report is not marked as read');
  const next = w.open();
  await next.start(w.sources);
  const event = await exit();
  assert.equal(event.requests?.[0]?.user, 'usr_synthetic');
  assert.equal(event.reports?.[0]?.file, file);
  await next.stop();
});

test('retention deletes only what is expired, in batches, and never the running process\'s own start', async (t) => {
  await world(t);
  const now = Date.parse('2026-02-01T00:00:00.000Z');
  const cutoff = new Date(now - RETENTION_MS);
  const old = new Date(cutoff.getTime() - 60_000).toISOString();
  const fresh = new Date(cutoff.getTime() + 60_000).toISOString();
  const edge = cutoff.toISOString();
  for (let index = 0; index < 25; index += 1) await insertSample(db, sample(old));
  await insertSample(db, sample(fresh));
  await insertSample(db, sample(edge));
  const start: ProcessEvent = { at: old, kind: 'start', boot: 'boot-running', pid: 1, release: null, node_version: null, heap_limit_bytes: null, uptime_ms: null, last_seen_at: null, requests: null, requests_omitted: 0, reports: null };
  await insertEvent(db, start);
  await insertEvent(db, { ...start, boot: 'boot-old' });
  await insertEvent(db, { ...start, boot: null, kind: 'abnormal_exit' });
  await insertEvent(db, { ...start, boot: 'boot-fresh', at: fresh });
  const removed = await pruneExpired(db, cutoff, 'boot-running', { batch: 10 });
  assert.deepEqual(removed, { samples: 25, events: 2 });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.resource_samples')).rows[0]!.n, 2);
  const left = (await db.query('SELECT boot FROM public.process_events ORDER BY seq')).rows.map((row) => row.boot);
  assert.deepEqual(left, ['boot-running', 'boot-fresh'], 'a crash after 14 days of uptime must still find its start');
});

test('the running process runs retention by itself, at the 14 days of the design', async (t) => {
  const w = await world(t);
  const at = (offset: number) => new Date(w.state.at + offset).toISOString();
  await insertSample(db, sample(at(-RETENTION_MS - 3_600_000)));
  await insertSample(db, sample(at(-RETENTION_MS + 3_600_000)));
  const health = w.open(db, { retentionDelayMs: 1 });
  await health.start(w.sources);
  const count = async () => Number((await db.query('SELECT count(*)::int AS n FROM public.resource_samples')).rows[0]!.n);
  while ((await count()) > 1) await new Promise((resolve) => setTimeout(resolve, 1));
  await health.stop();
  assert.equal(await count(), 1);
  assert.equal(RETENTION_MS, 14 * 24 * 3600 * 1000);
  assert.deepEqual(w.logs, []);
});

test('one pass of retention is bounded; the next pass goes on', async (t) => {
  await world(t);
  for (let index = 0; index < 5; index += 1) await insertSample(db, sample('2026-01-01T00:00:00.000Z'));
  assert.equal((await pruneExpired(db, new Date('2026-01-02T00:00:00.000Z'), 'x', { batch: 2, maxBatches: 1 })).samples, 2);
  assert.equal((await pruneExpired(db, new Date('2026-01-02T00:00:00.000Z'), 'x', { batch: 2, maxBatches: 10 })).samples, 3);
});

test('the runtime role writes, reads and expires these rows, and can do nothing else to them', async (t) => {
  await world(t);
  const role = `synthetic_health_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(20).toString('hex');
  await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await db.query(`REVOKE TEMPORARY ON DATABASE "${kit.database.database}" FROM PUBLIC`);
  await grantRuntime(db, role);
  const runtime = new Database(createPool({ ...kit.database, user: role, password }, 1));
  t.after(() => runtime.end());
  await insertSample(runtime, sample('2026-01-01T00:00:00.000Z'));
  await insertEvent(runtime, { at: '2026-01-01T00:00:00.000Z', kind: 'start', boot: 'boot-a', pid: 1, release: null, node_version: null, heap_limit_bytes: null, uptime_ms: null, last_seen_at: null, requests: null, requests_omitted: 0, reports: null });
  assert.equal((await healthReader(runtime).summary(ADMIN, { since: new Date('2026-01-01T00:00:00.000Z') })).samples, 1);
  assert.equal((await healthReader(runtime).events(ADMIN, { limit: 5 })).length, 1);
  const forbidden = (statement: string) => assert.rejects(runtime.query(statement), (error: unknown) => (error as { code?: string }).code === '42501', statement);
  for (const table of ['resource_samples', 'process_events']) {
    await forbidden(`TRUNCATE public.${table}`);
    await forbidden(`DROP TABLE public.${table}`);
    await forbidden(`ALTER TABLE public.${table} ADD COLUMN probe integer`);
  }
  await forbidden('UPDATE public.resource_samples SET boot=boot');
  await forbidden('UPDATE public.process_events SET kind=kind');
  assert.deepEqual(await pruneExpired(runtime, new Date('2026-01-02T00:00:00.000Z'), 'other'), { samples: 1, events: 1 });
  // The catalog reads of the sampler need no grant of their own.
  const { postgresReading } = await import('./readings.ts');
  const reading = await postgresReading(runtime).read();
  assert.ok(Number.isInteger(reading.pg_active_connections) && Number.isInteger(reading.pg_waiting_locks) && Number.isInteger(reading.pg_deadlocks));
});

test('administrators read the current value and the range of the window; unknown stays unknown', async (t) => {
  await world(t);
  const at = (minute: number) => `2026-01-02T03:0${minute}:00.000Z`;
  await insertSample(db, sample('2026-01-02T02:00:00.000Z', 'boot-a', { heap_used_bytes: 9000 }));
  await insertSample(db, sample(at(1), 'boot-a', { heap_used_bytes: 100, pg_waiting_locks: 7, failed_reads: ['disk'], mcp_sessions: 1 }));
  await insertSample(db, sample(at(2), 'boot-a', { heap_used_bytes: 300, pg_waiting_locks: null, failed_reads: ['disk', 'postgres'], dropped_samples: 2 }));
  await insertSample(db, sample(at(3), 'boot-a', { heap_used_bytes: 200, pg_waiting_locks: null, mcp_sessions: 3, mcp_sessions_by_client: { 'client-a': 3 } }));
  const summary = await healthReader(db).summary(ADMIN, { since: new Date(at(0)) });
  assert.equal(summary.samples, 3);
  assert.equal(summary.latest, at(3));
  assert.deepEqual(summary.fields.heap_used_bytes, { current: 200, min: 100, max: 300 }, 'the sample before the window is outside it');
  assert.deepEqual(summary.fields.pg_waiting_locks, { current: 7, min: 7, max: 7 }, 'a reading taken once a minute is current until the next');
  assert.deepEqual(summary.fields.io_wait_ratio, { current: null, min: null, max: null }, 'never read');
  assert.deepEqual(summary.mcp_sessions_by_client, { 'client-a': 3 });
  assert.deepEqual(summary.failed_reads, { disk: 2, postgres: 1 });
  assert.equal(summary.dropped_samples, 2);
});

test('a value older than a couple of minutes is not current', async (t) => {
  await world(t);
  await insertSample(db, sample('2026-01-02T03:00:00.000Z', 'boot-a', { pg_waiting_locks: 7 }));
  for (let index = 1; index <= 12; index += 1) await insertSample(db, sample(`2026-01-02T03:${String(index).padStart(2, '0')}:00.000Z`));
  assert.deepEqual((await healthReader(db).summary(ADMIN, { since: new Date('2026-01-02T00:00:00.000Z') })).fields.pg_waiting_locks, { current: null, min: 7, max: 7 });
});

test('a window with no samples reads as empty, without inventing values', async (t) => {
  await world(t);
  const summary = await healthReader(db).summary(ADMIN, { since: new Date('2026-01-02T00:00:00.000Z') });
  assert.equal(summary.samples, 0);
  assert.equal(summary.latest, null);
  assert.ok(NUMERIC_FIELDS.every((field) => summary.fields[field].current === null));
  assert.equal(summary.mcp_sessions_by_client, null);
});

test('only administrators read this', async (t) => {
  await world(t);
  const reader = healthReader(db);
  await assert.rejects(reader.summary(MEMBER, { since: new Date(0) }), HealthAccessError);
  await assert.rejects(reader.events(MEMBER, { limit: 5 }), HealthAccessError);
});

test('events are newest first and bounded by the limit', async (t) => {
  await world(t);
  const start: ProcessEvent = { at: '2026-01-02T00:00:00.000Z', kind: 'start', boot: 'boot-a', pid: 1, release: 'synthetic', node_version: 'v24.0.0', heap_limit_bytes: 1, uptime_ms: null, last_seen_at: null, requests: null, requests_omitted: 0, reports: null };
  await insertEvent(db, start);
  await insertEvent(db, { ...start, kind: 'stop', uptime_ms: 5 });
  await insertEvent(db, { ...start, boot: 'boot-b' });
  const listed = await healthReader(db).events(ADMIN, { limit: 2 });
  assert.deepEqual(listed.map((event) => [event.kind, event.boot]), [['start', 'boot-b'], ['stop', 'boot-a']]);
});

test('nothing here keeps a request\'s arguments: the log has only the fields it is given', async (t) => {
  const w = await world(t);
  const log = createRequestLog({ directory: w.requestLogDir, boot: 'boot-a', now: () => new Date(0) });
  const end = log.begin({ traceId: null, origin: 'mcp', name: 'POST /mcp', userId: null, arguments: { secret: 'synthetic-argument-value' } } as never);
  end.identify({ name: 'get_nodes', arguments: 'synthetic-argument-value' } as never);
  end();
  log.close();
  assert.ok(existsSync(join(w.requestLogDir, INFLIGHT_FILE)));
  assert.ok(!readFileSync(join(w.requestLogDir, INFLIGHT_FILE), 'utf8').includes('synthetic-argument-value'));
});
