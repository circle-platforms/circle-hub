// `db top`: read from the maintenance database, what it says when it cannot, and a real cluster's statistics.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PlatformError } from './errors.ts';
import { ensureLayout, layoutAt } from './layout.ts';
import { createPostgres, ensureDatabaseRunning, resolveBinaries, statementStatisticsLibrary } from './postgres.ts';
import type { SqlSession } from './sql.ts';
import { withSession } from './sql.ts';
import { statementLines, STATEMENT_ORDERS, topStatements, type StatementOrder } from './statements.ts';
import { removeDir, socketPort, tempDir } from './test-support.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

function control(answer: (text: string, values?: unknown[]) => Record<string, unknown>[], running = true) {
  const asked: { database: string; text: string; values?: unknown[] }[] = [];
  return {
    asked,
    subject: {
      target: { socketDir: '/synthetic/run', port: 5432, user: 'synthetic-owner', database: 'circle_hub' },
      status: async () => ({ running }) as Awaited<ReturnType<Parameters<typeof topStatements>[0]['status']>>,
      connector: async (database: string): Promise<SqlSession> => ({
        query: async (text, values) => {
          asked.push({ database, text, values });
          return answer(text, values);
        },
        close: async () => {},
      }),
    },
  };
}

const installed = (text: string): boolean => text.includes('to_regclass');

test('without the extension it says so and asks nothing more', async () => {
  const { subject, asked } = control(() => [{ installed: false }]);
  const top = await topStatements(subject, 'total_ms', 5);
  assert.equal(top.available, false);
  assert.ok(!top.available && /没有 pg_stat_statements 扩展/.test(top.reason) && /circle-hub db stop/.test(top.hint));
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.database, 'postgres', 'the extension lives in the maintenance database');
});

test('an extension PostgreSQL did not preload says that instead of failing', async () => {
  const { subject } = control((text) => {
    if (installed(text)) return [{ installed: true }];
    throw Object.assign(new Error('pg_stat_statements must be loaded via "shared_preload_libraries"'), { code: '55000' });
  });
  const top = await topStatements(subject, 'rows', 5);
  assert.ok(!top.available && /没有预加载/.test(top.reason));
});

test('any other failure is a failure', async () => {
  const { subject } = control((text) => {
    if (installed(text)) return [{ installed: true }];
    throw Object.assign(new Error('synthetic failure'), { code: '42P01' });
  });
  await assert.rejects(topStatements(subject, 'rows', 5), /synthetic failure/);
});

test('a database that is not running is refused before connecting', async () => {
  const { subject, asked } = control(() => [], false);
  await assert.rejects(topStatements(subject, 'rows', 5), (error: unknown) => error instanceof PlatformError && /没在运行/.test(error.message) && /circle-hub db start/.test(String(error.hint)));
  assert.equal(asked.length, 0);
});

test('each order sorts by its own column, the Hub database only, with the limit as a parameter', async () => {
  for (const by of Object.keys(STATEMENT_ORDERS) as StatementOrder[]) {
    const { subject, asked } = control((text) => (installed(text) ? [{ installed: true }] : [{ calls: '7', rows: '21', total_ms: 12.5, mean_ms: 1.75, blocks_hit: '99', blocks_read: '1', query: 'SELECT $1' }]));
    const top = await topStatements(subject, by, 3);
    assert.deepEqual(top, { available: true, statements: [{ calls: 7, rows: 21, total_ms: 12.5, mean_ms: 1.75, blocks_hit: 99, blocks_read: 1, query: 'SELECT $1' }] });
    assert.match(asked[1]!.text, new RegExp(`ORDER BY s\\.${STATEMENT_ORDERS[by]} DESC`));
    assert.deepEqual(asked[1]!.values, ['circle_hub', 3]);
  }
});

test('the text says what it is sorted by; an empty list says so', () => {
  const lines = statementLines('circle_hub', 'rows', [{ calls: 7, rows: 21, total_ms: 12.5, mean_ms: 1.75, blocks_hit: 99, blocks_read: 1, query: 'SELECT $1' }, { calls: 1, rows: 0, total_ms: 0.5, mean_ms: 0.5, blocks_hit: 0, blocks_read: 0, query: 'BEGIN' }]);
  assert.match(lines[0]!, /按读出行数排序的前 2 条/);
  assert.match(lines[1]!, /累计 12\.5 毫秒，调用 7 次，平均 1\.75 毫秒，读出 21 行，缓存命中 99\.0%/);
  assert.equal(lines[2], '   SELECT $1');
  assert.match(lines[3]!, /未读块/);
  assert.deepEqual(statementLines('circle_hub', 'rows', []), ['数据库 circle_hub 还没有语句统计']);
});

const binaries = await resolveBinaries();
test('a real cluster: its statements, constants replaced, this database only; dropping the extension is said', { skip: existsSync(statementStatisticsLibrary(binaries)) ? false : 'skipped: these binaries do not ship pg_stat_statements' }, async () => {
  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(join(root, 'r'));
  await ensureLayout(layout);
  const cluster = createPostgres({ layout, port: socketPort(), tuning: { memoryBytes: 1024 ** 3, statementStatistics: true } });
  await cluster.initialise();
  await ensureDatabaseRunning(cluster, { create: true });
  try {
    await withSession(cluster.connector, cluster.target.database, async (session) => {
      await session.query('CREATE TABLE synthetic_top (n integer, secret text)');
      for (let index = 0; index < 5; index += 1) await session.query(`INSERT INTO synthetic_top VALUES (${index}, 'synthetic-literal-value')`);
      await session.query('SELECT n FROM synthetic_top');
    });
    await withSession(cluster.connector, 'postgres', (session) => session.query('SELECT 42 AS only_in_the_maintenance_database'));
    const top = await topStatements(cluster, 'calls', 50);
    assert.ok(top.available);
    const texts = top.statements.map((statement) => statement.query);
    const insert = top.statements.find((statement) => statement.query.startsWith('INSERT INTO synthetic_top'));
    assert.equal(insert?.calls, 5);
    assert.equal(top.statements[0], insert, 'sorted by calls');
    assert.ok(!texts.join('\n').includes('synthetic-literal-value'), 'constants are replaced');
    assert.ok(!texts.some((text) => text.includes('only_in_the_maintenance_database')), 'other databases are left out');
    assert.ok((await topStatements(cluster, 'rows', 1)).available);
    await withSession(cluster.connector, 'postgres', (session) => session.query('DROP EXTENSION pg_stat_statements'));
    const gone = await topStatements(cluster, 'total_ms', 5);
    assert.ok(!gone.available && /没有 pg_stat_statements 扩展/.test(gone.reason));
  } finally {
    await cluster.stop();
  }
});
