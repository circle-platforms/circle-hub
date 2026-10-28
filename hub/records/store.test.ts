import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { SCHEMA_REGISTRY, SchemaId } from '../../contracts/src/index.ts';
import type { DatabaseConfig } from '../config/index.ts';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { CanonicalizationError } from './canonical.ts';
import { RECORD_SCHEMAS } from './constants.ts';
import { Database, createPool, encodeCursor } from './db.ts';
import { recordDigest } from './digest.ts';
import { IntegrityError, LimitError, MigrationError, RecordsError } from './errors.ts';
import { newId } from './ids.ts';
import { MIGRATIONS, migrate, migrationChecksum } from './migrations.ts';
import { openRecords } from './index.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

async function sql(config: DatabaseConfig, text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ ...config, ssl: false });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

const NOW = '2026-10-21T08:00:00.000Z';

test('a record is stored with the digest of its canonical envelope; an identical put is idempotent', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const input = { kind: 'claim' as const, schema: 'claim@1', provenance: 'observed' as const, body: { b: 2, a: [1, 'x'] }, created_at: NOW };
  const first = await kit.store.put(input);
  assert.equal(first.created, true);
  assert.match(first.id, /^rcd_[0-9a-z]{26}$/);
  assert.equal(first.digest, recordDigest({ kind: 'claim', schema: 'claim@1', provenance: 'observed', created_at: NOW, body: { a: [1, 'x'], b: 2 } }));
  const again = await kit.store.put({ ...input, body: { a: [1, 'x'], b: 2 } });
  assert.equal(again.created, false);
  assert.equal(again.id, first.id);
  assert.equal(again.digest, first.digest);
  const later = await kit.store.put({ ...input, created_at: '2026-10-21T08:00:00.001Z' });
  assert.equal(later.created, true);
  assert.notEqual(later.digest, first.digest);
  assert.equal(Number((await sql(kit.database, 'SELECT count(*) AS n FROM records')).rows[0].n), 2);
  const byDigest = await kit.store.get(first.digest);
  const byId = await kit.store.getById(first.id);
  assert.deepEqual(byDigest, { id: first.id, kind: 'claim', schema: 'claim@1', digest: first.digest, provenance: 'observed', created_at: NOW, body: { a: [1, 'x'], b: 2 } });
  assert.deepEqual(byId, byDigest);
  assert.equal(await kit.store.get('0'.repeat(64)), null);
  assert.equal(await kit.store.get('not a digest'), null);
  assert.equal(await kit.store.getById('rcd_x'), null);
});

test('any JSON body round-trips exactly, including NUL and other text PostgreSQL rejects raw', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const body = {
    nul: `a${String.fromCharCode(0)}b`,
    controls: String.fromCharCode(1, 9, 10, 31, 127),
    emoji: String.fromCodePoint(0x1f600),
    chinese: '用例：预期结果',
    numbers: [0, -0.5, 1e21, 5e-324, 9007199254740991],
    nested: { deep: [[[{ x: null }]]] },
  };
  const stored = await kit.store.put({ kind: 'submission', schema: 'submission@1', provenance: 'declared', body });
  const read = await kit.store.get<typeof body>(stored.digest);
  assert.deepEqual(read?.body, body);
  assert.equal(read?.body.nul.length, 3);
  assert.match(read?.created_at ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('inputs that are not records are refused before anything is written', async (t) => {
  const kit = await openTestRecords({ postgres, limits: { maxRecordBytes: 64 * 1024 } });
  t.after(() => kit.close());
  const valid = { kind: 'claim' as const, schema: 'claim@1', provenance: 'observed' as const, body: {} };
  await assert.rejects(kit.store.put({ ...valid, kind: 'note' as never }), TypeError);
  await assert.rejects(kit.store.put({ ...valid, schema: 'Claim' }), TypeError);
  await assert.rejects(kit.store.put({ ...valid, provenance: 'trusted' as never }), TypeError);
  await assert.rejects(kit.store.put({ ...valid, created_at: '2026-10-21T08:00:00Z' }), TypeError);
  await assert.rejects(kit.store.put({ ...valid, body: { when: new Date() } }), TypeError);
  await assert.rejects(kit.store.put({ ...valid, body: { n: Number.NaN } }), TypeError);
  await assert.rejects(kit.store.put({ ...valid, index: [{ key: 'Bad Key', value: 'x' }] }), TypeError);
  await assert.rejects(kit.store.put({ ...valid, index: [{ key: 'ok', value: `x${String.fromCharCode(0)}` }] }), TypeError);
  await assert.rejects(kit.store.put({ ...valid, body: { text: 'x'.repeat(70 * 1024) } }), LimitError);
  assert.equal(Number((await sql(kit.database, 'SELECT count(*) AS n FROM records')).rows[0].n), 0);
});

test('every schema id registered in the contracts can be stored; anything that is not a contracts SchemaId is refused', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const ids = Object.keys(SCHEMA_REGISTRY);
  for (const named of ['check-outcome@1', 'run-summary@1', 'pack-summary@1', 'submission-received@1', 'catalog-entry@1']) assert.ok(ids.includes(named), named);
  for (const schema of [...ids, ...Object.values(RECORD_SCHEMAS), 'tree_node2@1', 'x@0', 'a-b_c9@10']) {
    assert.equal(SchemaId.safeParse(schema).success, true, schema);
    const stored = await kit.store.put({ kind: 'validation_result', schema, provenance: 'projected', body: { schema } });
    assert.equal((await kit.store.get(stored.digest))?.schema, schema);
  }
  // Leading-zero majors, upper case, empty names or majors, other characters and surrounding white space.
  const refused = ['claim@01', 'claim@00', 'Claim@1', 'CLAIM@1', 'check-Outcome@1', '', '@1', 'claim@', 'claim', '-x@1', '1x@1', 'claim@v1', 'a b@1', 'a.b@1', ' claim@1', 'claim@1 ', 'claim@1\n', 'claim@1@2'];
  for (const schema of refused) {
    assert.equal(SchemaId.safeParse(schema).success, false, JSON.stringify(schema));
    await assert.rejects(kit.store.put({ kind: 'claim', schema, provenance: 'observed', body: {} }), TypeError, JSON.stringify(schema));
  }
  await assert.rejects(kit.store.put({ kind: 'claim', schema: 1 as never, provenance: 'observed', body: {} }), TypeError);
  assert.equal(Number((await sql(kit.database, "SELECT count(*) AS n FROM records WHERE kind = 'claim'")).rows[0].n), 0);
});

test('a record whose schema is not a contracts SchemaId is refused on read, although the table lets its shape through', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  // The table only checks the shape (migration 1 accepts a leading-zero major); a row written past put() is refused on read.
  const envelope = { kind: 'claim', schema: 'claim@01', provenance: 'observed', created_at: NOW, body: { x: 1 } };
  const digest = recordDigest(envelope);
  await sql(kit.database, 'INSERT INTO records (id, digest, kind, schema, provenance, created_at, body, size) VALUES ($1, $2, $3, $4, $5, $6, $7, 7)', [
    newId('rcd'),
    digest,
    envelope.kind,
    envelope.schema,
    envelope.provenance,
    NOW,
    '{"x":1}',
  ]);
  await assert.rejects(kit.store.get(digest), (error: unknown) => error instanceof IntegrityError && /模式名/.test(error.message));
  await assert.rejects(kit.store.list({ kind: 'claim' }), IntegrityError);
  // The table still refuses what is not name@major at all.
  await assert.rejects(
    sql(kit.database, 'INSERT INTO records (id, digest, kind, schema, provenance, created_at, body, size) VALUES ($1, $2, $3, $4, $5, $6, $7, 2)', [newId('rcd'), 'b'.repeat(64), 'claim', 'Claim@1', 'observed', NOW, '{}']),
    /records_schema_check/,
  );
});

test('index values are limited in UTF-8 bytes and checked before anything is written', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const randomBmp = (count: number) => Array.from(randomBytes(count * 2).subarray(0, count * 2).reduce<number[]>((out, byte, index, all) => (index % 2 === 0 ? [...out, 0x4e00 + ((byte << 8) | all[index + 1]) % 0x5000] : out), []), (code) => String.fromCharCode(code)).join('');
  // 1000 random BMP characters are 3000 bytes: refused as a TypeError (it used to reach PostgreSQL and fail with 54000).
  await assert.rejects(kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { n: 1 }, index: [{ key: 'claim.title', value: randomBmp(1000) }] }), TypeError);
  await assert.rejects(kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { n: 2 }, index: [{ key: 'claim.title', value: randomBmp(334) }] }), TypeError);
  assert.equal(Number((await sql(kit.database, 'SELECT count(*) AS n FROM records')).rows[0].n), 0);
  const fits = randomBmp(333);
  const stored = await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { n: 3 }, index: [{ key: 'claim.title', value: fits }, { key: 'claim.ascii', value: 'a'.repeat(1000) }] });
  assert.deepEqual((await kit.store.find({ key: 'claim.title', value: fits })).items.map((record) => record.digest), [stored.digest]);
  assert.deepEqual(await kit.store.find({ key: 'claim.title', value: randomBmp(1000) }), { items: [], next: null });
  // The table refuses the same values on its own.
  await assert.rejects(sql(kit.database, 'INSERT INTO record_index (key, value, digest, record_seq) VALUES ($1, $2, $3, 1)', ['claim.raw', '用'.repeat(334), stored.digest]), /record_index_value_check/);
});

test('cursors beyond the bigint range and years outside 0001-9999 are refused before the database sees them', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  for (const seq of ['9999999999999999999', '9223372036854775808']) {
    await assert.rejects(kit.store.list({ kind: 'claim', cursor: encodeCursor(seq) }), (error: unknown) => error instanceof RecordsError && /继续令牌无效/.test((error as Error).message), seq);
    await assert.rejects(kit.store.find({ key: 'test.key', value: 'v', cursor: encodeCursor(seq) }), RecordsError, seq);
  }
  assert.deepEqual(await kit.store.list({ kind: 'claim', cursor: encodeCursor('9223372036854775807') }), { items: [], next: null });
  for (const created_at of ['+010000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z']) {
    await assert.rejects(kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: {}, created_at }), TypeError, created_at);
  }
  await assert.rejects(kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: {}, created_at: new Date(Date.UTC(10000, 0, 1)) as never }), TypeError);
  for (const created_at of ['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
    const stored = await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { created_at }, created_at });
    assert.equal((await kit.store.get(stored.digest))?.created_at, created_at);
  }
});

test('a submission canonicalize refuses (a lone surrogate) is kept verbatim as an object that a record references', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  // Syntactically valid JSON text; JSON.parse turns the escape into a lone surrogate.
  const received = `{"items":[{"statement":"${String.fromCharCode(0x5c)}ud800 broken"}]}`;
  const parsed = JSON.parse(received) as { items: Array<{ statement: string }> };
  await assert.rejects(kit.store.put({ kind: 'submission', schema: 'submission@1', provenance: 'declared', body: parsed }), (error: unknown) => error instanceof CanonicalizationError && error.path === '/items/0/statement');
  // The raw path (README): the received text as an object, and a record that names it and the refused location.
  const object = await kit.objects.put(Buffer.from(JSON.stringify(parsed), 'utf8'), 'application/json');
  const record = await kit.store.put({ kind: 'submission', schema: 'submission@1', provenance: 'declared', body: { verbatim: object.sha256, refused_at: '/items/0/statement' } });
  const kept = JSON.parse(Buffer.from((await kit.objects.get((await kit.store.get<{ verbatim: string }>(record.digest))?.body.verbatim ?? '')) ?? []).toString('utf8'));
  assert.deepEqual(kept, parsed);
  assert.equal(kept.items[0].statement.charCodeAt(0), 0xd800);
});

test('records and the other history tables are append-only: UPDATE, DELETE and TRUNCATE are rejected', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const record = await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { x: 1 }, unique_key:'synthetic-record-key',index: [{ key: 'test.key', value: 'v' }] });
  await kit.objects.put(Buffer.from('bytes'), 'text/plain');
  const admin = await kit.principals.bootstrapAdmin('管理员');
  await kit.callLog.append({ traceId: 'a'.repeat(32), userId: admin.user.id, sessionId: null, tool: 'list_task_packs', runId: null, arguments: {}, callResult: 'ok', durationMs: 1, adminNote: '管理员可见的原因' });
  // call_notes references call_logs, so a plain TRUNCATE of call_logs is refused by that key before the trigger; CASCADE
  // reaches the trigger, like records.
  const attempts: Array<[string, string]> = [
    ['records', `UPDATE records SET body = '{}' WHERE digest = '${record.digest}'`],
    ['records', `DELETE FROM records WHERE digest = '${record.digest}'`],
    ['records', 'TRUNCATE records CASCADE'],
    ['record_index', "UPDATE record_index SET value = 'w'"],
    ['record_index', 'DELETE FROM record_index'],
    ['objects', 'UPDATE objects SET size = 0'],
    ['objects', 'DELETE FROM objects'],
    ['user_history', "UPDATE user_history SET role = 'user'"],
    ['user_history', 'DELETE FROM user_history'],
    ['call_logs', "UPDATE call_logs SET tool = 'x'"],
    ['call_logs', 'DELETE FROM call_logs'],
    ['call_logs', 'TRUNCATE call_logs CASCADE'],
    ['call_notes', "UPDATE call_notes SET note = 'x'"],
    ['call_notes', 'DELETE FROM call_notes'],
    ['call_notes', 'TRUNCATE call_notes'],
    ['record_keys',"UPDATE record_keys SET key='changed'"],
    ['record_keys','DELETE FROM record_keys'],
    ['record_keys','TRUNCATE record_keys'],
  ];
  for (const [table, statement] of attempts) {
    await assert.rejects(sql(kit.database, statement), (error: unknown) => {
      const failure = error as { code?: string; message?: string };
      return failure.code === 'HU001' && (failure.message ?? '').includes(`append-only table ${table}`);
    }, statement);
  }
  assert.deepEqual((await kit.store.get(record.digest))?.body, { x: 1 });
});

test('a stored record whose bytes were altered behind the triggers is refused on read', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const record = await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { verdict: 'refute' }, index: [{ key: 'test.key', value: 'v' }] });
  // Superuser-only bypass of the triggers, to simulate tampering at the storage layer.
  const client = new pg.Client({ ...kit.database, ssl: false });
  await client.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query(`UPDATE records SET body = '{"verdict":"support"}' WHERE digest = $1`, [record.digest]);
  } finally {
    await client.end();
  }
  await assert.rejects(kit.store.get(record.digest), IntegrityError);
  await assert.rejects(kit.store.getById(record.id), IntegrityError);
  await assert.rejects(kit.store.find({ key: 'test.key', value: 'v' }), IntegrityError);
});

test('find pages through an index entry in insertion order, either way, with an optional kind filter', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const digests: string[] = [];
  for (let index = 0; index < 7; index++) {
    const kind = index === 3 ? 'run' : 'claim';
    digests.push((await kit.store.put({ kind, schema: `${kind}@1`, provenance: 'observed', body: { index }, index: [{ key: 'test.group', value: 'g1' }] })).digest);
  }
  await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { other: true }, index: [{ key: 'test.group', value: 'g2' }] });
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page: Awaited<ReturnType<typeof kit.store.find>> = await kit.store.find({ key: 'test.group', value: 'g1', limit: 3, cursor });
    assert.ok(page.items.length <= 3);
    seen.push(...page.items.map((record) => record.digest));
    cursor = page.next;
    pages++;
  } while (cursor !== null);
  assert.equal(pages, 3);
  assert.deepEqual(seen, digests);
  const newest = await kit.store.find({ key: 'test.group', value: 'g1', newestFirst: true, limit: 2 });
  assert.deepEqual(newest.items.map((record) => record.digest), [digests[6], digests[5]]);
  const rest = await kit.store.find({ key: 'test.group', value: 'g1', newestFirst: true, limit: 10, cursor: newest.next });
  assert.deepEqual(rest.items.map((record) => record.digest), [digests[4], digests[3], digests[2], digests[1], digests[0]]);
  assert.equal(rest.next, null);
  const runs = await kit.store.find({ key: 'test.group', value: 'g1', kind: 'run' });
  assert.deepEqual(runs.items.map((record) => record.digest), [digests[3]]);
  const claims = await kit.store.list({ kind: 'claim', limit: 100 });
  assert.equal(claims.items.length, 7);
  assert.equal((await kit.store.find({ key: 'test.group', value: 'none' })).items.length, 0);
  assert.deepEqual(await kit.store.find({ key: 'test.group', value: 'x'.repeat(1001) }), { items: [], next: null });
  assert.deepEqual(await kit.store.find({ key: 'test.group', value: `a${String.fromCharCode(0)}` }), { items: [], next: null });
  await assert.rejects(kit.store.find({ key: 'Not A Key', value: 'g1' }), TypeError);
  await assert.rejects(kit.store.find({ key: 'test.group', value: 'g1', cursor: 'garbage!' }), RecordsError);
  await assert.rejects(kit.store.find({ key: 'test.group', value: 'g1', limit: 0 }), TypeError);
});

test('a transaction commits all of its records or none', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  await assert.rejects(
    kit.store.withTransaction(async (tx) => {
      await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { n: 1 }, index: [{ key: 'test.tx', value: 'a' }] }, tx);
      throw new Error('abort');
    }),
    /abort/,
  );
  assert.equal((await kit.store.find({ key: 'test.tx', value: 'a' })).items.length, 0);
  const kept = await kit.store.withTransaction(async (tx) => {
    const one = await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { n: 2 } }, tx);
    const visible = await kit.store.get(one.digest, tx);
    assert.equal(visible?.digest, one.digest);
    return one;
  });
  assert.notEqual(await kit.store.get(kept.digest), null);
});

test('migrations apply once, concurrently safe, and later opens apply nothing', async (t) => {
  // Empty on purpose: a shared unit cluster clones an already-migrated template, and this test has to see the versions applied.
  const database = await postgres.createDatabase(undefined, { empty: true });
  t.after(() => postgres.dropDatabase(database.database));
  const pools = [new Database(createPool(database, 2)), new Database(createPool(database, 2)), new Database(createPool(database, 2))];
  t.after(() => Promise.all(pools.map((db) => db.end())));
  const applied = await Promise.all(pools.map((db) => migrate(db)));
  assert.deepEqual(applied.flat(), MIGRATIONS.map(m => m.version));
  assert.deepEqual(await migrate(pools[0]), []);
  const journal = (await sql(database, 'SELECT version, name, sha256 FROM schema_migrations')).rows;
  assert.equal(journal.length, MIGRATIONS.length);
  assert.match(journal[0].sha256, /^[0-9a-f]{64}$/);
});

test('an altered applied migration, an unknown applied version or a gap refuses to start', async (t) => {
  const database = await postgres.createDatabase();
  t.after(() => postgres.dropDatabase(database.database));
  const db = new Database(createPool(database, 2));
  t.after(() => db.end());
  await migrate(db);
  const changed = MIGRATIONS.map((migration) => ({ ...migration, sql: `${migration.sql}\n-- edited` }));
  await assert.rejects(migrate(db, changed), (error: unknown) => error instanceof MigrationError && /校验和/.test((error as Error).message));
  const renamed = MIGRATIONS.map((migration) => ({ ...migration, name: 'renamed' }));
  await assert.rejects(migrate(db, renamed), MigrationError);
  await assert.rejects(migrate(db, [...MIGRATIONS, { version: MIGRATIONS.length + 2, name: 'skips_next', sql: 'SELECT 1' }]), TypeError);
  // The journal itself was tampered with: the program refuses to open the database.
  await sql(database, "UPDATE schema_migrations SET sha256 = repeat('0', 64) WHERE version = 1");
  const dataDir = postgres.root;
  const config = { dataDir: `${dataDir}/kit`, logDir: `${dataDir}/kit/logs`, database, limits: { maxUploadBytes: 1 << 20, maxRecordBytes: 1 << 20, maxRequestBytes: 2 << 20 } };
  await assert.rejects(openRecords(config), MigrationError);
  await sql(database, `UPDATE schema_migrations SET sha256 = $1 WHERE version = 1`, [migrationChecksum(MIGRATIONS[0])]);
  await sql(database, "INSERT INTO schema_migrations (version, name, sha256) VALUES (99, 'from_the_future', repeat('a', 64))");
  await assert.rejects(openRecords(config), (error: unknown) => error instanceof MigrationError && /不认识的迁移/.test((error as Error).message));
  await sql(database, 'DELETE FROM schema_migrations WHERE version = 99');
  // Version 4 is applied but version 3 is not: migrations only move forward (versions past this program's list).
  const third = { version: MIGRATIONS.length + 1, name: 'third', sql: 'CREATE TABLE gap_three (x int)' };
  const fourth = { version: MIGRATIONS.length + 2, name: 'fourth', sql: 'CREATE TABLE gap_four (x int)' };
  await sql(database, 'INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [fourth.version, fourth.name, migrationChecksum(fourth)]);
  await assert.rejects(migrate(db, [...MIGRATIONS, third, fourth]), (error: unknown) => error instanceof MigrationError && /只能向前迁移/.test((error as Error).message));
  assert.equal((await sql(database, "SELECT to_regclass('gap_three') AS t")).rows[0].t, null);
  await sql(database, 'DELETE FROM schema_migrations WHERE version = $1', [fourth.version]);
  const kit = await openRecords(config);
  await kit.close();
});

test('batched record reads retain integrity checks, insertion order and complete index matches', async t => {
  const kit=await openTestRecords({postgres}); t.after(()=>kit.close());
  const a=await kit.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{synthetic:1},index:[{key:'batch.test',value:'one'},{key:'batch.test',value:'both'}]});
  const b=await kit.store.put({kind:'action',schema:'action@1',provenance:'observed',body:{synthetic:2},index:[{key:'batch.test',value:'two'},{key:'batch.test',value:'both'}]});
  const records=await kit.store.getMany([b.digest,a.digest,a.digest,'bad']);
  assert.equal(records.size,2); assert.deepEqual(records.get(a.digest)?.body,{synthetic:1});
  const found=await kit.store.findMany({key:'batch.test',values:['two','one','both'],kind:'action'});
  assert.deepEqual(found.map(r=>r.digest),[a.digest,b.digest]);
  const client=new pg.Client({...kit.database,ssl:false});await client.connect();
  try { await client.query("SET session_replication_role = 'replica'"); await client.query('UPDATE records SET body=$1 WHERE digest=$2',['{"synthetic":3}',a.digest]); } finally {await client.end();}
  await assert.rejects(kit.store.getMany([a.digest]),IntegrityError);
  await assert.rejects(kit.store.findMany({key:'batch.test',values:['one']}),IntegrityError);
});

test('batch first matches equal oldest per-value reads, including duplicates, missing values and damaged records', async t => {
  const kit = await openTestRecords({ postgres }); t.after(() => kit.close());
  const first = await kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', body: { n: 1 }, index: [{ key: 'first.batch', value: 'x' }, { key: 'first.batch', value: 'y' }] });
  await kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'observed', body: { n: 2 }, index: [{ key: 'first.batch', value: 'x' }] });
  const original = pg.Client.prototype.query; let queries = 0;
  t.mock.method(pg.Client.prototype, 'query', function (this: pg.Client, ...args: unknown[]) { queries++; return Reflect.apply(original, this, args); });
  const found = await kit.store.findFirstMany({ key: 'first.batch', values: ['x', 'y', 'missing', 'x'], kind: 'action' });
  assert.equal(queries, 1); assert.deepEqual([...found].map(([key, row]) => [key, row.digest]), [['x', first.digest], ['y', first.digest]]);
  assert.equal((await kit.store.findFirstMany({ key: 'first.batch', values: [] })).size, 0);
  await sql(kit.database, "SET session_replication_role = 'replica'; UPDATE records SET body='{\"n\":3}' WHERE digest='" + first.digest + "'");
  await assert.rejects(kit.store.findFirstMany({ key: 'first.batch', values: ['x'] }), IntegrityError);
});

test('the pool never falls back to a password file or PG* variables when the server asks for a password', async () => {
  const { password: _password, ...withoutPassword } = postgres.config;
  const db = new Database(createPool(withoutPassword, 1));
  try {
    await assert.rejects(db.query('SELECT 1'), /口令只经密钥库提供/);
  } finally {
    await db.end();
  }
});
