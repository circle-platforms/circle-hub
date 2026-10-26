// Integration: table summaries and platform sessions on a real PostgreSQL from the pinned binaries (synthetic data).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { ensureLayout, layoutAt } from './layout.ts';
import { createPostgres, ensureDatabaseRunning, type PostgresControl } from './postgres.ts';
import { DIGEST_BUCKET_DIGITS, summarizeTables, withSession, type SqlSession } from './sql.ts';
import { ownerTables, removeDir, socketPort, tempDir } from './test-support.ts';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The documented digest, computed in Node from the row texts the server renders. */
function expectedDigest(rowTexts: readonly string[]): string {
  const buckets = new Map<string, string[]>();
  for (const text of rowTexts) {
    const h = sha(text);
    const key = h.slice(0, DIGEST_BUCKET_DIGITS);
    buckets.set(key, [...(buckets.get(key) ?? []), h]);
  }
  const lines = [...buckets.keys()].sort().map((key) => {
    const hashes = buckets.get(key)!.sort();
    return `${key} ${hashes.length} ${sha(hashes.join(''))}\n`;
  });
  return sha(lines.join(''));
}

describe('table summaries and platform sessions on a real cluster', () => {
  let root: string;
  let control: PostgresControl;
  const summaries = () => withSession(control.connector, control.target.database, summarizeTables);
  // The tables belong to the superuser role, as the Hub's do; the application role may only read and append.
  const owner = <T>(fn: (session: SqlSession) => Promise<T>) => withSession(control.connector, control.target.database, fn);
  const app = <T>(fn: (session: SqlSession) => Promise<T>) => withSession(control.applicationConnector, control.target.database, fn);
  const digestOf = async (table: string) => (await summaries()).find((summary) => summary.table === table);

  before(async () => {
    root = await tempDir();
    const layout = layoutAt(root);
    await ensureLayout(layout);
    control = createPostgres({ layout, port: socketPort() });
    await control.initialise();
    await ensureDatabaseRunning(control, { create: true });
  });

  after(async () => {
    await control?.stop().catch(() => {});
    if (root) await removeDir(root);
  });

  test('a column named like the row alias does not hide the other columns from the digest', async () => {
    await ownerTables(control, ['CREATE TABLE shadowed (t int, payload text)'], ['shadowed']);
    await app((s) => s.query("INSERT INTO shadowed SELECT n, 'p' || n FROM generate_series(1, 30) AS n"));
    const before = await digestOf('shadowed');
    await owner((s) => s.query("UPDATE shadowed SET payload = payload || '-changed'"));
    const after = await digestOf('shadowed');
    assert.equal(after?.rows, 30);
    assert.notEqual(after?.digest, before?.digest);
  });

  test('the digest is the documented bucketed one: independent of row order, counts duplicates, many buckets', async () => {
    await ownerTables(
      control,
      [
        'CREATE TABLE ascending AS SELECT n, md5(n::text) AS label, (n % 7)::float8 / 3 AS ratio FROM generate_series(1, 20000) AS n ORDER BY n',
        'CREATE TABLE descending AS SELECT * FROM ascending ORDER BY n DESC',
        'CREATE TABLE doubled AS SELECT * FROM ascending UNION ALL SELECT * FROM ascending',
      ],
      ['ascending', 'descending', 'doubled'],
    );
    const texts = await withSession(control.connector, control.target.database, async (s) => {
      for (const statement of ["SET TimeZone TO 'UTC'", "SET DateStyle TO 'ISO, YMD'", "SET IntervalStyle TO 'postgres'", 'SET extra_float_digits TO 1', "SET bytea_output TO 'hex'"]) {
        await s.query(statement);
      }
      return (await s.query('SELECT ROW(t.*)::text AS text FROM ascending AS t')).map((row) => String(row.text));
    });
    const ascending = await digestOf('ascending');
    assert.equal(ascending?.rows, 20000);
    assert.equal(ascending?.digest, expectedDigest(texts), 'matches the definition computed independently');
    assert.ok(new Set(texts.map((text) => sha(text).slice(0, DIGEST_BUCKET_DIGITS))).size > 4000, 'the rows span nearly all 4096 buckets');
    assert.equal((await digestOf('descending'))?.digest, ascending?.digest, 'physical order does not matter');
    const doubled = await digestOf('doubled');
    assert.equal(doubled?.rows, 40000);
    assert.equal(doubled?.digest, expectedDigest([...texts, ...texts]));
    assert.notEqual(doubled?.digest, ascending?.digest);
    await owner((s) => s.query("UPDATE descending SET label = 'x' WHERE n = 12345"));
    assert.notEqual((await digestOf('descending'))?.digest, ascending?.digest, 'one changed row changes the digest');
    await ownerTables(control, ['CREATE TABLE empty_table (n int)'], ['empty_table']);
    assert.deepEqual(await digestOf('empty_table'), { schema: 'public', table: 'empty_table', rows: 0, digest: sha('') });
  });

  test("PG* variables of the operator's shell do not reach the platform's sessions", async () => {
    const leaked = {
      PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=50',
      PGSSLNEGOTIATION: 'direct',
      PGREPLICATION: 'database',
      PGCLIENTENCODING: 'LATIN1',
      PGDATABASE: 'postgres',
      PGUSER: 'nobody',
    };
    const saved = Object.fromEntries(Object.keys(leaked).map((key) => [key, process.env[key]]));
    Object.assign(process.env, leaked);
    try {
      // A read-only or 50 ms PGOPTIONS would break the owner's DDL and the application role's insert and sleep.
      await ownerTables(control, ['CREATE TABLE env_probe (n int)', 'SELECT pg_sleep(0.2)'], ['env_probe']);
      const [row] = await app(async (s) => {
        await s.query('INSERT INTO env_probe VALUES (1)');
        await s.query('SELECT pg_sleep(0.2)');
        return s.query('SELECT $1::text AS echo, current_database() AS db, current_user AS role', ['合成']);
      });
      assert.deepEqual(row, { echo: '合成', db: control.target.database, role: control.application.user });
      assert.equal(await control.databaseExists(), true, 'the admin connection too');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
