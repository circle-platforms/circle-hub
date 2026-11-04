// trace_spans on a temporary PostgreSQL: usage measured at Database.query and at the object store, the batch insert, the
// permission rule of the reader, retention, and the grants of the runtime role.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test, type TestContext } from 'node:test';
import { Database, createPool } from '../records/db.ts';
import type { Principal } from '../records/api.ts';
import { grantRuntime } from '../records/migrations.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { RETENTION_DAYS, TraceReader, installTraceSink, purgeExpired, scheduleRetention, startTelemetry, startTrace, step, updateTrace, withoutTrace, type SpanRow, type StoredSpanRow } from './api.ts';
import { INSERT_SPANS } from './writer.ts';

const PASSWORD = 'synthetic-trace-password';
const DAY_MS = 24 * 3600 * 1000;
const principalOf = (user: { id: string; name: string; role: 'user' | 'admin' }): Principal => ({ id: user.id, name: user.name, role: user.role });

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

interface World {
  kit: TestRecordsKit;
  db: Database;
  reader: TraceReader;
  admin: Principal;
  member(name: string): Promise<Principal>;
  /** A row of trace_spans written as the writer writes it. */
  insert(rows: Partial<StoredSpanRow>[]): Promise<void>;
}

let spans = 0;
const span = (fields: Partial<StoredSpanRow>): StoredSpanRow => ({
  trace_id: randomBytes(16).toString('hex'), span_id: (++spans).toString(16).padStart(16, 'a'), parent_span_id: null, is_root: true, name: 'get_nodes', type: 'span',
  started_at: '2026-11-04T08:00:00.000Z', ended_at: '2026-11-04T08:00:00.010Z', level: 'default', status_message: null, origin: 'mcp',
  user_id: null, session_id: null, run_id: null, client_name: null, client_version: null, usage: {}, release: null, environment: null, ...fields,
});

async function world(t: TestContext): Promise<World> {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const db = new Database(createPool(kit.database, 3));
  t.after(() => db.end());
  const boot = await kit.principals.bootstrapAdmin('synthetic-trace-admin', { password: PASSWORD, mustChange: false });
  const admin = principalOf(boot.user);
  return {
    kit, db, admin,
    reader: new TraceReader(db),
    member: async (name) => principalOf(await kit.principals.createUser(admin, name, 'user', { password: PASSWORD, mustChange: false })),
    insert: async (rows) => { await db.query(INSERT_SPANS, [JSON.stringify(rows.map(span))]); },
  };
}

function collect(t: TestContext): SpanRow[] {
  const rows: SpanRow[] = [];
  t.after(installTraceSink({ push: (row) => rows.push(row) }));
  return rows;
}

test('a query adds what it returned to the step it runs in; outside a trace nothing is measured', async (t) => {
  const w = await world(t);
  const rows = collect(t);
  await startTrace({ name: 'get_nodes', origin: 'mcp' }, async () => {
    await w.db.query('SELECT $1::text AS body, 7 AS size FROM generate_series(1, 3)', ['abcd']);
    await step('read-source', () => w.db.query(`SELECT 'xy' AS body`));
  });
  await w.db.query('SELECT 1');
  const root = rows.find((row) => row.is_root)!, read = rows.find((row) => row.name === 'read-source')!;
  assert.equal(root.usage['db.queries'], 2);
  assert.equal(root.usage['db.rows'], 4);
  assert.equal(root.usage['db.bytes'], 14);
  assert.equal(read.usage['db.rows'], 1);
  assert.equal(read.usage['db.bytes'], 2);
  assert.ok((root.usage['db.ms'] ?? 0) > 0);
  assert.equal(rows.length, 2);
});

test('a transaction counts its statements and its wait for a connection', async (t) => {
  const w = await world(t);
  const rows = collect(t);
  const one = new Database(createPool(w.kit.database, 1));
  t.after(() => one.end());
  const held = await one.pool.connect();
  const waited = startTrace({ name: 'submit_result', origin: 'mcp' }, () => one.transaction(async (tx) => {
    await one.query('SELECT 1 AS n', [], tx);
    await one.query(`SELECT 'abc' AS body`, [], tx);
  }));
  // The pool's one connection is out: the transaction can only be waiting for it.
  while (one.pool.waitingCount === 0) await new Promise((resolve) => setImmediate(resolve));
  held.release();
  await waited;
  const { usage } = rows[0];
  assert.equal(usage['db.queries'], 4, 'BEGIN, two statements, COMMIT');
  assert.equal(usage['db.rows'], 2);
  assert.equal(usage['db.bytes'], 3);
  assert.ok((usage['db.wait_ms'] ?? 0) > 0);
});

test('the wait for a connection counts for a plain query too, and a query that waited still answers', async (t) => {
  const w = await world(t);
  const rows = collect(t);
  const one = new Database(createPool(w.kit.database, 1));
  t.after(() => one.end());
  const held = await one.pool.connect();
  const waited = startTrace({ name: 'get_nodes', origin: 'mcp' }, () => one.query('SELECT 1 AS n'));
  while (one.pool.waitingCount === 0) await new Promise((resolve) => setImmediate(resolve));
  held.release();
  assert.equal((await waited).rows[0].n, 1);
  assert.ok((rows[0].usage['db.wait_ms'] ?? 0) > 0);
  assert.equal(rows[0].usage['db.queries'], 1);
});

test('a failed query inside a trace fails as outside one: the same error, its connection dropped, the pool still good', async (t) => {
  const w = await world(t);
  const rows = collect(t);
  const one = new Database(createPool(w.kit.database, 1));
  t.after(() => one.end());
  const first = await one.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  await assert.rejects(startTrace({ name: 'get_nodes', origin: 'mcp' }, () => one.query('SELECT 1 FROM no_such_table')), { code: '42P01' });
  assert.equal(rows[0].usage['db.queries'], 1);
  assert.equal(rows[0].usage['db.rows'], undefined);
  assert.equal(rows[0].status_message, '42P01');
  const after = await one.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  assert.notEqual(after.rows[0].pid, first.rows[0].pid, 'pool.query drops a connection whose query failed; so does the measured path');
  assert.equal(one.pool.idleCount, 1);
});

test('traces on the same pool at once do not mix their usage', async (t) => {
  const w = await world(t);
  const rows = collect(t);
  const run = (name: 'get_nodes' | 'start_run', count: number) => startTrace({ name, origin: 'mcp' }, async () => {
    for (let index = 0; index < 20; index++) await w.db.query('SELECT generate_series(1, $1::int) AS n', [count]);
  });
  await Promise.all([run('get_nodes', 1), run('start_run', 5)]);
  assert.equal(rows.find((row) => row.name === 'get_nodes')?.usage['db.rows'], 20);
  assert.equal(rows.find((row) => row.name === 'start_run')?.usage['db.rows'], 100);
});

test('each trace counts the stored bytes it asked for, also when one read served both', async (t) => {
  const w = await world(t);
  const rows = collect(t);
  const object = await w.kit.objects.put(Buffer.from('synthetic source bytes'), 'text/plain');
  const read = (name: 'get_nodes' | 'start_run') => startTrace({ name, origin: 'mcp' }, () => w.kit.objects.get(object.sha256));
  const [first, second] = await Promise.all([read('get_nodes'), read('start_run')]);
  assert.equal(Buffer.from(first!).toString(), 'synthetic source bytes');
  assert.equal(Buffer.from(second!).toString(), 'synthetic source bytes');
  for (const name of ['get_nodes', 'start_run']) {
    const { usage } = rows.find((row) => row.name === name)!;
    assert.equal(usage['source.reads'], 1, name);
    assert.equal(usage['source.bytes'], 22, name);
  }
  assert.equal(await w.kit.objects.get('not a digest'), null);
});

test('a batch insert stores every field; the same span twice is one row', async (t) => {
  const w = await world(t);
  const row = span({ user_id: 'usr_x', session_id: 'session', run_id: 'run_x', client_name: '合成客户端', client_version: '1.0', release: 'abcdef012345', environment: 'test', status_message: 'SOURCE_ABSENT', level: 'error', usage: { 'db.rows': 2 } });
  await w.db.query(INSERT_SPANS, [JSON.stringify([row, row])]);
  const stored = (await w.db.query('SELECT * FROM trace_spans')).rows;
  assert.equal(stored.length, 1);
  assert.deepEqual({ ...stored[0], started_at: undefined, ended_at: undefined }, { ...row, started_at: undefined, ended_at: undefined });
  assert.equal((stored[0].started_at as Date).toISOString(), row.started_at);
});

test('an administrator sees every trace, a member only their own, steps and usage included', async (t) => {
  const w = await world(t);
  const ann = await w.member('synthetic-ann'), bob = await w.member('synthetic-bob');
  const annTrace = 'a'.repeat(32), bobTrace = 'b'.repeat(32), root = '1'.repeat(16), child = '2'.repeat(16);
  await w.insert([
    { trace_id: annTrace, span_id: root, user_id: ann.id, usage: { 'db.rows': 9 } },
    { trace_id: annTrace, span_id: child, parent_span_id: root, is_root: false, name: 'read-source', type: 'retriever', user_id: ann.id, usage: { 'db.rows': 9 } },
    { trace_id: bobTrace, span_id: root, user_id: bob.id, usage: { 'db.rows': 5 } },
    { name: 'maintain-runs', origin: 'background' },
  ]);
  assert.equal((await w.reader.list(w.admin)).length, 3);
  assert.deepEqual((await w.reader.list(ann)).map((trace) => trace.trace_id), [annTrace]);
  assert.deepEqual(await w.reader.list(ann, { userId: bob.id }), [], "asking for another member's traces gives what having none gives");
  const own = await w.reader.show(ann, annTrace);
  assert.equal(own?.roots.length, 1);
  assert.equal(own?.roots[0].children[0].name, 'read-source');
  assert.equal(own?.roots[0].children[0].usage['db.rows'], 9);
  assert.equal(await w.reader.show(ann, bobTrace), null, "another member's trace does not exist for a member");
  assert.equal(await w.reader.show(bob, annTrace), null);
  assert.equal(await w.reader.show(ann, 'f'.repeat(32)), null, 'the same answer as a trace that does not exist');
  assert.equal(await w.reader.show(ann, 'not a trace id'), null);
  assert.equal((await w.reader.show(w.admin, bobTrace))?.roots[0].user_id, bob.id);
  const since = '2026-11-01T00:00:00.000Z';
  assert.deepEqual((await w.reader.top(ann, { by: 'db.rows', since })).map((row) => [row.name, row.total]), [['get_nodes', 9], ['read-source', 9]]);
  assert.deepEqual((await w.reader.top(bob, { by: 'db.rows', since })).map((row) => [row.name, row.total]), [['get_nodes', 5]]);
});

test('a trace id two members share shows each only their own rows', async (t) => {
  const w = await world(t);
  const ann = await w.member('synthetic-ann'), bob = await w.member('synthetic-bob');
  const shared = 'c'.repeat(32);
  await w.insert([
    { trace_id: shared, span_id: '1'.repeat(16), user_id: ann.id, name: 'get_nodes' },
    { trace_id: shared, span_id: '2'.repeat(16), user_id: bob.id, name: 'start_run' },
  ]);
  assert.deepEqual((await w.reader.show(ann, shared))?.roots.map((root) => root.name), ['get_nodes']);
  assert.deepEqual((await w.reader.show(bob, shared))?.roots.map((root) => root.name), ['start_run']);
  assert.equal((await w.reader.show(w.admin, shared))?.roots.length, 2);
});

test('the stored account decides, not the principal a caller kept', async (t) => {
  const w = await world(t);
  const member = await w.member('synthetic-demoted');
  await w.insert([{ user_id: w.admin.id, name: 'start_run' }, { user_id: member.id, name: 'get_nodes' }]);
  assert.deepEqual((await w.reader.list({ ...member, role: 'admin' })).map((trace) => trace.name), ['get_nodes'], 'a member who says admin stays a member');
  await w.kit.principals.setDisabled(w.admin, member.id, true);
  assert.deepEqual(await w.reader.list(member), [], 'a disabled account reads nothing');
  assert.deepEqual(await w.reader.list({ id: 'not an id', name: 'x', role: 'admin' }), []);
});

test('the list filters by entry, name, user, time and duration, roots only, newest first', async (t) => {
  const w = await world(t);
  const ann = await w.member('synthetic-ann');
  await w.insert([
    { name: 'get_nodes', started_at: '2026-11-04T08:00:00.000Z', ended_at: '2026-11-04T08:00:00.100Z', user_id: ann.id },
    { name: 'read-source', is_root: false, parent_span_id: '1'.repeat(16) },
    { name: 'serve-runs', origin: 'console', started_at: '2026-11-04T09:00:00.000Z', ended_at: '2026-11-04T09:00:02.000Z' },
    { name: 'maintain-runs', origin: 'background', started_at: '2026-11-04T10:00:00.000Z', ended_at: '2026-11-04T10:00:05.000Z' },
  ]);
  const names = async (query: Parameters<TraceReader['list']>[1]) => (await w.reader.list(w.admin, query)).map((trace) => trace.name);
  assert.deepEqual(await names({}), ['maintain-runs', 'serve-runs', 'get_nodes']);
  assert.deepEqual(await names({ origin: 'console' }), ['serve-runs']);
  assert.deepEqual(await names({ name: 'get_nodes' }), ['get_nodes']);
  assert.deepEqual(await names({ userId: ann.id }), ['get_nodes']);
  assert.deepEqual(await names({ since: '2026-11-04T09:00:00.000Z' }), ['maintain-runs', 'serve-runs']);
  assert.deepEqual(await names({ minMs: 2000 }), ['maintain-runs', 'serve-runs']);
  assert.deepEqual(await names({ minMs: 2001 }), ['maintain-runs']);
  assert.deepEqual(await names({ limit: 1 }), ['maintain-runs']);
  assert.equal((await w.reader.list(w.admin, { name: 'serve-runs' }))[0].duration_ms, 2000);
});

test('the totals rank what a name cost since a time, the idle loop first; event rows are not steps', async (t) => {
  const w = await world(t);
  await w.insert([
    { name: 'maintain-runs', origin: 'background', usage: { 'db.rows': 1000, 'db.bytes': 50000 } },
    { name: 'maintain-runs', origin: 'background', usage: { 'db.rows': 1000, 'db.bytes': 50000 } },
    { name: 'get_nodes', usage: { 'db.rows': 10, 'db.bytes': 100, 'answer.bytes': 700 } },
    { name: 'slow-query', type: 'event', is_root: false, parent_span_id: '1'.repeat(16) },
    { name: 'get_nodes', started_at: '2026-10-01T08:00:00.000Z', ended_at: '2026-10-01T08:00:00.001Z', usage: { 'db.rows': 1000000 } },
  ]);
  const since = '2026-11-01T00:00:00.000Z';
  const top = await w.reader.top(w.admin, { by: 'db.rows', since });
  assert.deepEqual(top.map((row) => [row.origin, row.name, row.count, row.total, row.db_bytes]), [['background', 'maintain-runs', 2, 2000, 100000], ['mcp', 'get_nodes', 1, 10, 100]]);
  assert.equal(top[0].total_ms, 20);
  assert.deepEqual((await w.reader.top(w.admin, { by: 'answer.bytes', since })).map((row) => row.name), ['get_nodes', 'maintain-runs']);
  assert.deepEqual((await w.reader.top(w.admin, { by: 'db.rows', since, limit: 1 })).map((row) => row.name), ['maintain-runs']);
});

test('more steps than a read shows: the tree is cut and says so', async (t) => {
  const w = await world(t);
  const shared = 'd'.repeat(32);
  await w.db.query(`INSERT INTO trace_spans (trace_id, span_id, is_root, name, type, started_at, ended_at, level, origin, usage)
    SELECT $1, lpad(to_hex(n), 16, '0'), true, 'get_nodes', 'span', now(), now(), 'default', 'mcp', '{}' FROM generate_series(1, 5001) AS n`, [shared]);
  const shown = await w.reader.show(w.admin, shared);
  assert.equal(shown?.roots.length, 5000);
  assert.equal(shown?.truncated, true);
});

test('retention deletes only what is older than 14 days, in batches, and the job is traced', async (t) => {
  const w = await world(t);
  const now = new Date('2026-11-04T12:00:00.000Z');
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  await w.insert([
    { started_at: at(RETENTION_DAYS + 30), ended_at: at(RETENTION_DAYS + 30), name: 'get_nodes' },
    { started_at: at(RETENTION_DAYS + 1), ended_at: at(RETENTION_DAYS + 1), name: 'start_run' },
    { started_at: new Date(now.getTime() - RETENTION_DAYS * DAY_MS - 1).toISOString(), ended_at: at(RETENTION_DAYS), name: 'submit_result' },
    { started_at: at(RETENTION_DAYS), ended_at: at(RETENTION_DAYS), name: 'upload_file' },
    { started_at: at(1), ended_at: at(1), name: 'list_task_packs' },
  ]);
  assert.equal(await purgeExpired(w.db, now, { batchRows: 2 }), 3);
  assert.deepEqual((await w.db.query('SELECT name FROM trace_spans ORDER BY started_at')).rows.map((row) => row.name), ['upload_file', 'list_task_packs']);
  assert.equal(await purgeExpired(w.db, now), 0);

  await w.insert([{ started_at: at(RETENTION_DAYS + 2), ended_at: at(RETENTION_DAYS + 2), name: 'get_nodes' }]);
  const rows = collect(t);
  const schedule = scheduleRetention(w.db, { now: () => now });
  t.after(() => schedule.stop());
  assert.equal(await schedule.runNow(), 1);
  const pass = rows.find((row) => row.name === 'purge-traces');
  assert.equal(pass?.origin, 'background');
  assert.equal(pass?.is_root, true);
  assert.equal(pass?.usage['db.queries'], 1);
});

test('a pass asked to stop ends at its next batch and the next pass finishes the job', async (t) => {
  const w = await world(t);
  const now = new Date('2026-11-04T12:00:00.000Z');
  const old = new Date(now.getTime() - (RETENTION_DAYS + 1) * DAY_MS).toISOString();
  await w.insert(Array.from({ length: 4 }, () => ({ started_at: old, ended_at: old })));
  let stop = false;
  assert.equal(await purgeExpired(w.db, now, { batchRows: 2, stop: () => { stop = true; return stop; } }), 2);
  assert.equal(await purgeExpired(w.db, now, { batchRows: 2 }), 2);
});

test('the runtime role writes, reads and deletes its rows, and may do nothing else with them', async (t) => {
  const w = await world(t);
  const role = `synthetic_trace_${randomBytes(4).toString('hex')}`, password = randomBytes(20).toString('hex');
  await w.db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await w.db.query(`REVOKE TEMPORARY ON DATABASE "${w.kit.database.database}" FROM PUBLIC`);
  await grantRuntime(w.db, role);
  t.after(() => withoutTrace(() => w.db.query(`DROP OWNED BY ${role}`).then(() => w.db.query(`DROP ROLE ${role}`)).catch(() => {})));
  const database = { ...w.kit.database, user: role, password };
  const runtime = new Database(createPool(database, 2));
  t.after(() => runtime.end());

  const telemetry = startTelemetry({ database, release: 'abcdef012345', environment: 'test' });
  t.after(() => telemetry.close());
  await startTrace({ name: 'get_nodes', origin: 'mcp' }, async () => {
    updateTrace({ userId: w.admin.id });
    await runtime.query('SELECT 1');
  });
  await telemetry.flush();
  assert.deepEqual(telemetry.stats(), { queued: 0, written: 1, dropped: 0, failed: 0 });

  const traces = await new TraceReader(runtime).list(w.admin);
  assert.deepEqual(traces.map((trace) => [trace.name, trace.release, trace.environment, trace.usage['db.queries']]), [['get_nodes', 'abcdef012345', 'test', 1]]);

  await assert.rejects(runtime.query(`UPDATE trace_spans SET name = 'x'`), { code: '42501' });
  await assert.rejects(runtime.query('TRUNCATE trace_spans'), { code: '42501' });
  assert.equal(await purgeExpired(runtime, new Date(Date.now() + 365 * DAY_MS)), 1);
  assert.equal((await w.db.query('SELECT count(*)::int AS n FROM trace_spans')).rows[0].n, 0);
});

test('close writes what is left and a connection that cannot be reached costs only the rows', async (t) => {
  const w = await world(t);
  const telemetry = startTelemetry({ database: w.kit.database });
  await startTrace({ name: 'get_nodes', origin: 'mcp' }, async () => {});
  await telemetry.close();
  assert.equal((await w.db.query('SELECT count(*)::int AS n FROM trace_spans')).rows[0].n, 1);

  const lost = startTelemetry({ database: { ...w.kit.database, database: 'no_such_database' } });
  assert.equal(await startTrace({ name: 'get_nodes', origin: 'mcp' }, async () => 'answer'), 'answer');
  await lost.close();
  assert.deepEqual(lost.stats(), { queued: 0, written: 0, dropped: 0, failed: 1 });
});
