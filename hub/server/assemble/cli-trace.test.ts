// The traces of the CLI, in-process on a temporary socket-only PostgreSQL as the runtime role: a command writes its trace
// before main returns, a clean stop of serve writes what is queued, and `circle-hub trace` lists, shows and ranks them for
// administrators only. Synthetic names and rows.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { layoutAt } from '../../platform/api.ts';
import { newSettingsFile, writeSettingsFile } from '../../platform/settings.ts';
import { osIsolationAvailable } from '../../rules/api.ts';
import type { AssemblyModule, ListenInfo } from '../api.ts';
import { adminCommands } from '../cli-admin.ts';
import { deploymentEnvironment } from '../main.ts';
import { createAssembly } from './hub.ts';
import { memoryOperatorTokens } from './operator-token.ts';
import { openCliHarness, type CliHarness, type Deployment, type RunResult } from './test-cli.ts';

let harness: CliHarness;
let requireOsIsolation: boolean;

before(async () => {
  harness = await openCliHarness();
  requireOsIsolation = await osIsolationAvailable();
});
after(() => harness?.close());

interface Admin {
  deployment: Deployment;
  run(argv: string[], env?: Record<string, string>): Promise<RunResult>;
  sql<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<R[]>;
  token: string;
}

async function setup(): Promise<Admin> {
  const deployment = await harness.deployment();
  const tokens = memoryOperatorTokens(null, '测试令牌存储');
  const assembly = async (): Promise<AssemblyModule> => ({
    assemble: createAssembly({ requireOsIsolation }),
    registerCommands: (register) => { for (const command of adminCommands({ tokens: () => tokens, assembly: { requireOsIsolation } })) register(command); },
  });
  const run = (argv: string[], env: Record<string, string> = {}) => deployment.run(argv, { assembly, operatorTokens: () => tokens }, env);
  const created = await run(['init-admin', 'synthetic-admin']);
  assert.equal(created.code, 0, created.text);
  const sql = async <R extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> => {
    const client = new pg.Client({ host: harness.postgres.socketDir, port: harness.postgres.config.port, user: harness.postgres.config.user, database: deployment.env.CIRCLE_HUB_DATABASE_NAME });
    await client.connect();
    try {
      return (await client.query<R>(text, values)).rows;
    } finally {
      await client.end();
    }
  };
  return { deployment, run, sql, token: tokens.value! };
}

test('a command has written its trace when main returns, with the account it acted as', async () => {
  const admin = await setup();
  const before = (await admin.sql(`SELECT 1 FROM trace_spans WHERE name = 'run-user'`)).length;
  const listed = await admin.run(['user', 'list']);
  assert.equal(listed.code, 0, listed.text);
  const created = await admin.run(['user', 'create', 'synthetic-member']);
  assert.equal(created.code, 0, created.text);
  const rows = await admin.sql<{ origin: string; is_root: boolean; user_id: string | null; usage: Record<string, number>; level: string; status_message: string | null }>(`SELECT * FROM trace_spans WHERE name = 'run-user' ORDER BY started_at`);
  assert.equal(rows.length, before + 2, 'written before main returned: nothing here waited');
  const [list, create] = rows.slice(-2);
  assert.equal(list.origin, 'cli');
  assert.equal(list.is_root, true);
  assert.equal(list.level, 'default');
  assert.ok(list.usage['db.queries'] > 0, 'the command read the database');
  assert.equal(list.user_id, null, 'user list acts as nobody in particular');
  assert.match(String(create.user_id), /^usr_/, 'a state-changing command acts as the operator token');
});

test('a command that fails says so; an unknown one keeps no name of its own', async () => {
  const admin = await setup();
  const failed = await admin.run(['token', 'revoke', 'tok_none']);
  assert.equal(failed.code, 1, failed.text);
  const unknown = await admin.run(['no-such-command']);
  assert.equal(unknown.code, 2, unknown.text);
  const rows = await admin.sql<{ name: string; level: string; status_message: string | null }>(`SELECT name, level, status_message FROM trace_spans WHERE level = 'error' ORDER BY started_at`);
  assert.deepEqual(rows, [{ name: 'run-token', level: 'error', status_message: '退出码 1' }, { name: 'run-command', level: 'error', status_message: '退出码 2' }]);
});

test('the environment on the rows is the class in the deployment settings; a root without settings has none', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-trace-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await deploymentEnvironment(root), null);
  await writeSettingsFile(layoutAt(root), newSettingsFile({ environment: 'shared' }));
  assert.equal(await deploymentEnvironment(root), 'shared');
});

test('observation never changes a command: a broken database name costs only the row', async () => {
  const admin = await setup();
  const run = await admin.deployment.run(['local-tools', 'help'], {}, { CIRCLE_HUB_DATABASE_NAME: 'no_such_database' });
  const plain = await admin.deployment.run(['local-tools', 'help']);
  assert.equal(run.code, plain.code);
  assert.deepEqual(run.out, plain.out);
  assert.deepEqual(run.err, plain.err);
});

test('a clean stop of serve writes what is queued, background rounds included', async () => {
  const admin = await setup();
  let listening: ListenInfo | undefined;
  let stop = (): void => {};
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  const serving = admin.deployment.run(['serve'], { assembly: async () => ({ assemble: createAssembly({ requireOsIsolation }) }), keyProvider: () => admin.deployment.key, stopSignal: () => stopped, onListening: (info) => { listening = info; } });
  for (let i = 0; i < 400 && !listening; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(listening, serving.toString());
  const health = await fetch(`${listening.url}/healthz`, { headers: { traceparent: `00-${'9'.repeat(32)}-${'1'.repeat(16)}-01` } });
  assert.equal(health.status, 200);
  stop();
  const result = await serving;
  assert.equal(result.code, 0, result.text);
  const rows = await admin.sql<{ origin: string; name: string }>(`SELECT origin, name FROM trace_spans WHERE is_root`);
  assert.ok(rows.some((row) => row.origin === 'console' && row.name === 'serve-http'), 'the request of a moment ago was written on the way out, not by a timer');
  assert.ok(rows.some((row) => row.origin === 'background' && row.name === 'maintain-runs'), 'the first maintenance pass is a trace');
});

test('trace list, show and top read the rows, in Chinese and as JSON', async () => {
  const admin = await setup();
  const [{ id }] = await admin.sql<{ id: string }>(`SELECT id FROM users WHERE name = 'synthetic-admin'`);
  const trace = 'e'.repeat(32), root = '1'.repeat(16), child = '2'.repeat(16);
  await admin.sql(`INSERT INTO trace_spans (trace_id, span_id, parent_span_id, is_root, name, type, started_at, ended_at, level, status_message, origin, user_id, session_id, run_id, client_name, client_version, release, environment, usage) VALUES
    ($1, $2, NULL, true, 'get_nodes', 'span', now(), now() + interval '30 milliseconds', 'default', NULL, 'mcp', $4, 'synthetic-session', NULL, '合成客户端', '1.0', 'abcdef012345', 'test', '{"db.rows": 40, "db.bytes": 900, "answer.bytes": 700, "self.ms": 5}'),
    ($1, $3, $2, false, 'read-source', 'retriever', now(), now() + interval '20 milliseconds', 'error', 'SOURCE_ABSENT', 'mcp', $4, 'synthetic-session', NULL, '合成客户端', '1.0', 'abcdef012345', 'test', '{"db.rows": 30}')`, [trace, root, child, id]);
  await admin.sql(`INSERT INTO trace_spans (trace_id, span_id, is_root, name, type, started_at, ended_at, level, origin, usage)
    SELECT lpad(to_hex(n), 32, 'f'), $1, true, 'maintain-runs', 'span', now(), now() + interval '2 seconds', 'default', 'background', '{"db.rows": 5000, "db.bytes": 700000}' FROM generate_series(1, 3) AS n`, [root]);

  const listed = await admin.run(['trace', 'list', '--origin', 'mcp', '--name', 'get_nodes', '--user', 'synthetic-admin', '--limit', '5']);
  assert.equal(listed.code, 0, listed.text);
  assert.equal(listed.out.length, 1);
  assert.match(listed.out[0], new RegExp(`^\\S+\\t${trace}\\tMCP\\tget_nodes\\t30 毫秒\\tsynthetic-admin\\t—\\tdb\\.rows=40 db\\.bytes=900 answer\\.bytes=700 self\\.ms=5$`));
  const slow = await admin.run(['trace', 'list', '--min-ms', '1000', '--json']);
  assert.deepEqual((JSON.parse(slow.out.join('\n')) as { traces: { name: string }[] }).traces.map((row) => row.name), ['maintain-runs', 'maintain-runs', 'maintain-runs']);
  assert.match((await admin.run(['trace', 'list', '--since', '2099-01-01T00:00:00Z'])).out[0], /没有符合条件的追踪/);

  const shown = await admin.run(['trace', 'show', trace]);
  assert.equal(shown.code, 0, shown.text);
  assert.equal(shown.out[0], `追踪 ${trace}`);
  assert.match(shown.out[1], /入口 MCP.*用户 synthetic-admin，会话 synthetic-session，客户端声明 合成客户端 1\.0，发布 abcdef012345，环境 测试/);
  assert.equal(shown.out[2], 'get_nodes（步骤）30 毫秒；db.rows=40 db.bytes=900 answer.bytes=700 self.ms=5');
  assert.equal(shown.out[3], '  read-source（读取）20 毫秒；错误 SOURCE_ABSENT；db.rows=30');
  const tree = JSON.parse((await admin.run(['trace', 'show', trace, '--json'])).out.join('\n')) as { roots: { children: { name: string }[] }[] };
  assert.equal(tree.roots[0].children[0].name, 'read-source');
  const missing = await admin.run(['trace', 'show', '0'.repeat(32)]);
  assert.equal(missing.code, 1);
  assert.match(missing.text, /没有追踪/);

  const top = await admin.run(['trace', 'top', '--since', '2026-01-01T00:00:00Z']);
  assert.equal(top.code, 0, top.text);
  assert.match(top.out[0], /^后台\tmaintain-runs\t3 次\t耗时 6000 毫秒\tdb\.rows=15000\tdb\.bytes=2100000$/, 'the loop that reads the most ranks itself first');
  const asked = await admin.run(['trace', 'top', '--by', 'answer.bytes', '--since', '2026-01-01T00:00:00Z']);
  assert.match(asked.out[0], /^MCP\tget_nodes\t1 次\t耗时 30 毫秒\tdb\.rows=40\tdb\.bytes=900\tanswer\.bytes=700$/);
  const byName = JSON.parse((await admin.run(['trace', 'top', '--by', 'answer.bytes', '--since', '2026-01-01T00:00:00Z', '--limit', '1', '--json'])).out.join('\n')) as { totals: { name: string }[] };
  assert.deepEqual(byName.totals.map((row) => row.name), ['get_nodes']);
});

test('the usage of the trace command is checked before anything is read', async () => {
  const admin = await setup();
  for (const argv of [['trace'], ['trace', 'none'], ['trace', 'list', '--origin', 'nowhere'], ['trace', 'list', '--since', 'yesterday'], ['trace', 'list', '--limit', '0'], ['trace', 'list', '--min-ms', 'x'], ['trace', 'show'], ['trace', 'top', '--by', 'db.nothing']]) {
    const result = await admin.run(argv);
    assert.equal(result.code, 2, `${argv.join(' ')}: ${result.text}`);
  }
});

test('trace is for administrators: a member token is refused, whatever the rows hold', async () => {
  const admin = await setup();
  await admin.run(['user', 'create', 'synthetic-member']);
  const issued = await admin.run(['token', 'issue', 'synthetic-member', '--raw']);
  assert.equal(issued.code, 0, issued.text);
  const refused = await admin.run(['trace', 'list'], { CIRCLE_HUB_TOKEN: issued.out[0] });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /只有管理员能读运行观测/);
});
