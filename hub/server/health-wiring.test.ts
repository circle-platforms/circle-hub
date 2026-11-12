// The health package as the running server uses it: the in-flight entry of real HTTP and MCP requests (never an argument or
// a value from a path), open MCP sessions, serve's start and stop events, and the administrator commands that read them.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import pg from 'pg';
import { createHealth, INFLIGHT_FILE, type RequestEnd, type RequestInfo, type RequestLog } from '../health/api.ts';
import { emptyValues, insertSample } from '../health/store.ts';
import { Database, createPool } from '../records/db.ts';
import { FileKeyProvider, openRecords } from '../records/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import type { AssemblyModule, CliIo } from './api.ts';
import { createApp } from './app.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { main } from './cli.ts';
import { loadServerConfig } from './main.ts';
import { beginRequest, identifyRequest } from './request-entry.ts';
import { createTestServer, fakeDeps, testConsoleCredentials, type TestServer } from './testing.ts';

const ARGUMENT = 'synthetic-argument-value';
const RUNTIME = 'hub_health_runtime';
const INITIALIZE = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1.0' } } };

let postgres: TemporaryPostgres;
let scratch: string;

before(async () => {
  postgres = await startPostgres({ socket: true, passwordless: true });
  scratch = await mkdtemp(join(tmpdir(), 'circle-hub-health-wiring-'));
  const client = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: postgres.config.user, database: 'postgres' });
  await client.connect();
  await client.query(`CREATE ROLE ${RUNTIME} LOGIN NOSUPERUSER`);
  await client.end();
});

after(async () => {
  await postgres?.stop();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/** A server whose app reports to a real in-flight log and session tracker; the database of `health` is never used here. */
async function observed(t: TestContext): Promise<{ server: TestServer; url: string; health: ReturnType<typeof createHealth>; lines(): Promise<Record<string, unknown>[]> }> {
  const server = await createTestServer({ postgres });
  t.after(() => server.close());
  const requestLogDir = await mkdtemp(join(scratch, 'logs-'));
  const health = createHealth({ db: { query: async () => { throw new Error('not used'); } }, requestLogDir, reportsDir: join(requestLogDir, 'reports'), log: () => {} });
  t.after(() => health.abandon());
  const app = createApp(server.deps, { codeRoot: server.records.dataDir, log: () => {}, health });
  t.after(() => app.close());
  const { url } = await app.listen();
  return { server, url, health, lines: async () => (await readFile(join(requestLogDir, INFLIGHT_FILE), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>) };
}

const mcp = (url: string, token: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

test('a request is begun before it runs and ended after, at the one HTTP entry', async (t) => {
  const { url, health, lines } = await observed(t);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);
  const logged = await lines();
  assert.deepEqual(logged.filter((line) => line.t === 'begin').map(({ origin, name, user, trace }) => ({ origin, name, user, trace })), [{ origin: 'console', name: 'GET /healthz', user: null, trace: null }]);
  for (let index = 0; index < 100 && health.requests.inFlight > 0; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(health.requests.inFlight, 0);
  assert.deepEqual((await lines()).map((line) => line.t), ['boot', 'begin', 'end']);
});

test('a console request carries its account once the session is known: a crash must say who was on the page', async (t) => {
  const { server, url, lines } = await observed(t);
  const page = await fetch(`${url}/console/login`);
  const nonce = /name="csrf" value="([^"]+)"/.exec(await page.text())![1]!;
  const cookie = (response: Response, name: string): string => response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))!.split(';')[0]!;
  const reply = await fetch(`${url}/console/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie(page, 'circle_hub_login') },
    body: new URLSearchParams({ ...testConsoleCredentials(server.admin.token), csrf: nonce }).toString(),
  });
  assert.equal(reply.status, 303);
  await (await fetch(`${url}/console/overview`, { headers: { cookie: cookie(reply, 'circle_hub_session') } })).text();
  const logged = await lines();
  const begun = logged.findLast((line) => line.t === 'begin' && line.name === 'GET /console/overview');
  assert.ok(begun, 'the page is in the log');
  assert.equal(begun.user, null, 'nobody is known when the request arrives');
  assert.equal(logged.find((line) => line.t === 'note' && line.id === begun.id)?.user, server.admin.user.id);
});

test('an MCP call is named by its tool, caller and trace, and its arguments are nowhere in the log', async (t) => {
  const { server, url, lines } = await observed(t);
  const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
  const response = await mcp(url, server.admin.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_nodes', arguments: { marker: ARGUMENT, nested: { value: ARGUMENT } } } }, { traceparent: `00-${trace}-00f067aa0ba902b7-01` });
  assert.equal(response.status, 200);
  await response.text();
  const logged = await lines();
  const notes = logged.filter((line) => line.t === 'note');
  assert.deepEqual(notes.at(-1), { ...notes.at(-1), name: 'get_nodes', user: server.admin.user.id, trace });
  assert.equal(logged.find((line) => line.t === 'begin')?.origin, 'mcp');
  assert.ok(!JSON.stringify(logged).includes(ARGUMENT), 'no argument, at any depth');
});

test('a tool name that is no name does not reach the log as one', async (t) => {
  const { server, url, lines } = await observed(t);
  await (await mcp(url, server.admin.token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: `get nodes ${ARGUMENT} `, arguments: {} } })).text();
  const logged = await lines();
  assert.equal(logged.filter((line) => line.t === 'note').at(-1)?.name, 'tools/call');
  assert.ok(!JSON.stringify(logged).includes(ARGUMENT));
});

test('a lone surrogate in what a client declares stops no resource sample and costs its initialize no call-log line', async (t) => {
  const { server, url, health } = await observed(t);
  const clientInfo = { name: 'synthetic\ud83d', version: '1.\ud83d', platform: 'os\ud83d' };
  const response = await mcp(url, server.admin.token, { ...INITIALIZE, params: { ...INITIALIZE.params, clientInfo } });
  assert.equal(response.status, 200);
  await response.text();
  assert.ok(response.headers.get('mcp-session-id'), 'the session is issued as for any other name');
  const { total, byClient } = health.sessions.counts();
  assert.deepEqual([total, byClient], [1, { 'synthetic\ufffd': 1 }]);
  const db = new Database(createPool(server.records.database, 1));
  t.after(() => db.end());
  await insertSample(db, { ...emptyValues(), sampled_at: '2026-11-04T08:00:00.000Z', boot: 'boot-surrogate', interval_ms: null, failed_reads: [], dropped_samples: 0, mcp_sessions: total, mcp_sessions_by_client: byClient });
  const stored = (await db.query('SELECT mcp_sessions_by_client FROM resource_samples WHERE boot = $1', ['boot-surrogate'])).rows;
  assert.deepEqual(stored.map((row) => row.mcp_sessions_by_client), [byClient], 'the jsonb column takes the sample');
  const lines = (await server.records.callLog.query(server.admin.principal, { userId: server.admin.user.id, limit: 50 })).items;
  assert.equal(lines.filter((line) => line.tool === 'initialize').length, 1, 'one line per call (B08)');
});

test('a request refused before its body is read keeps its entry, without a caller it never proved', async (t) => {
  const { url, lines } = await observed(t);
  assert.equal((await mcp(url, 'not-a-token', INITIALIZE)).status, 401);
  const logged = await lines();
  assert.deepEqual(logged.filter((line) => line.t === 'begin').map(({ name, user }) => ({ name, user })), [{ name: 'POST /mcp', user: null }]);
  assert.ok(!JSON.stringify(logged).includes('not-a-token'));
});

test('a path keeps its route only: a login link\'s secret, an id and a query never reach the log', async (t) => {
  const { url, lines } = await observed(t);
  const secret = 'Synthetic-Login-Secret_0123456789';
  await (await fetch(`${url}/console/login/${secret}?next=${ARGUMENT}`, { redirect: 'manual' })).text();
  await (await fetch(`${url}/console/runs/run_01jacd5z8q3w7v9h2k4m6n8p0r?q=${ARGUMENT}`, { redirect: 'manual' })).text();
  await (await fetch(`${url}/console/%E5%90%88%E6%88%90/${ARGUMENT}`, { redirect: 'manual' })).text();
  const logged = await lines();
  assert.deepEqual(logged.filter((line) => line.t === 'begin').map(({ name, origin }) => [name, origin]), [['GET /console/login', 'console'], ['GET /console/runs', 'console'], ['GET /console', 'console']]);
  const text = JSON.stringify(logged);
  for (const value of [secret, ARGUMENT, 'run_01jacd5z8q3w7v9h2k4m6n8p0r']) assert.ok(!text.includes(value), value);
});

function fakeLog() {
  const begun: RequestInfo[] = [];
  const noted: Parameters<RequestEnd['identify']>[0][] = [];
  let ended = 0;
  const log: RequestLog = {
    inFlight: 0,
    begin(info) {
      begun.push(info);
      const end = (() => { ended += 1; }) as RequestEnd;
      end.identify = (known) => noted.push(known);
      return end;
    },
  };
  return { log, begun, noted, ended: () => ended };
}

const incoming = (method: string | undefined, headers: Record<string, string> = {}) => ({ method, headers }) as unknown as IncomingMessage;

test('a console event stream is a stream, not a request in flight, and a page\'s other requests are', () => {
  const { log, begun, ended } = fakeLog();
  beginRequest(log, incoming('GET'), '/console/api/stream')();
  assert.equal(begun.length, 0);
  assert.equal(ended(), 0);
  beginRequest(log, incoming('GET'), '/console/api/runs')();
  assert.equal(begun[0]?.name, 'GET /console/api/runs');
});

test('the name and origin of every kind of target', () => {
  const { log, begun, noted } = fakeLog();
  const sync = incoming('POST');
  beginRequest(log, sync, '/api/sync/commit');
  identifyRequest(sync, { userId: 'usr_synthetic' });
  beginRequest(log, incoming('GET'), null);
  beginRequest(log, incoming('BREW\u0000 now'), '/console');
  beginRequest(log, incoming(undefined), '/');
  beginRequest(log, incoming('GET', { traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01` }), '/console/knowledge');
  assert.deepEqual(begun, [
    { traceId: null, origin: 'sync', name: 'POST /api/sync/commit', userId: null },
    { traceId: null, origin: 'console', name: 'GET', userId: null },
    { traceId: null, origin: 'console', name: '? /console', userId: null },
    { traceId: null, origin: 'console', name: '? /', userId: null },
    { traceId: 'a'.repeat(32), origin: 'console', name: 'GET /console/knowledge', userId: null },
  ]);
  assert.deepEqual(noted, [{ userId: 'usr_synthetic' }]);
  identifyRequest(incoming('GET'), { userId: 'usr_nobody' });
  assert.equal(noted.length, 1, 'a request nobody began is not noted');
  assert.doesNotThrow(() => beginRequest(undefined, incoming('GET'), '/mcp')(), 'without a log there is nothing to do');
});

test('MCP sessions count by the client name declared at initialize, until the client ends them', async (t) => {
  const { server, url, health } = await observed(t);
  const response = await mcp(url, server.admin.token, INITIALIZE);
  assert.equal(response.status, 200);
  await response.text();
  const session = response.headers.get('mcp-session-id');
  assert.ok(session);
  assert.deepEqual(health.sessions.counts(), { total: 1, byClient: { 'synthetic-client': 1 } });
  await (await mcp(url, server.admin.token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': session })).text();
  assert.deepEqual(health.sessions.counts(), { total: 1, byClient: { 'synthetic-client': 1 } }, 'seen again, the same session with its name');
  const ended = await fetch(`${url}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${server.admin.token}`, 'mcp-session-id': session } });
  assert.equal(ended.status, 405, 'the Hub stays stateless');
  assert.deepEqual(health.sessions.counts(), { total: 0, byClient: {} });
});

function capture(env: NodeJS.ProcessEnv): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line), env, cwd: scratch }, out, err };
}

const keyProvider = () => new FileKeyProvider(join(scratch, 'vault.key'));

async function cli(argv: string[], env: NodeJS.ProcessEnv, extra: Record<string, unknown> = {}) {
  const c = capture(env);
  const code = await main(argv, { io: c.io, keyProvider, ownerRole: postgres.config.user, operatorTokens: () => memoryOperatorTokens(null, '测试的空令牌存储'), ...extra });
  return { code, out: c.out, text: [...c.out, ...c.err].join('\n') };
}

let deployments = 0;
async function deployment(): Promise<NodeJS.ProcessEnv> {
  deployments += 1;
  const database = await postgres.createDatabase();
  const owner = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: postgres.config.user, database: 'postgres' });
  await owner.connect();
  await owner.query(`REVOKE TEMPORARY ON DATABASE "${database.database}" FROM PUBLIC`);
  await owner.end();
  const env = {
    CIRCLE_HUB_DATA_DIR: join(scratch, `data-${deployments}`),
    CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
    CIRCLE_HUB_DATABASE_PORT: String(postgres.config.port),
    CIRCLE_HUB_DATABASE_NAME: database.database,
    CIRCLE_HUB_DATABASE_USER: RUNTIME,
  };
  const migrated = await cli(['serve', '--migrate-only'], env);
  assert.equal(migrated.code, 0, migrated.text);
  return env;
}

async function serveOnce(env: NodeJS.ProcessEnv, whileUp: (url: string) => Promise<void> = async () => {}): Promise<void> {
  const assembly: AssemblyModule = { assemble: (config, records) => fakeDeps(config, records).deps };
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  let url = '';
  const c = capture(env);
  const serving = main(['serve'], { io: c.io, keyProvider, assembly: async () => assembly, stopSignal: () => stopped, onListening: (info) => { url = info.url; } });
  try {
    for (let index = 0; index < 400 && url === ''; index += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.notEqual(url, '', c.err.join('\n'));
    await whileUp(url);
  } finally {
    stop();
  }
  assert.equal(await serving, 0, c.err.join('\n'));
}

test('under a runtime directory the in-flight log is there and not on the data disk', async () => {
  const env = await deployment();
  const runtime = await mkdtemp(join(scratch, 'runtime-'));
  await serveOnce({ ...env, RUNTIME_DIRECTORY: runtime }, async (url) => {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  });
  const inflight = (await Promise.all([join(runtime, 'inflight.1.jsonl'), join(runtime, INFLIGHT_FILE)].map((path) => readFile(path, 'utf8').catch(() => '')))).join('');
  assert.match(inflight, /GET \/healthz/);
  await assert.rejects(readFile(join(String(env.CIRCLE_HUB_DATA_DIR), 'logs', INFLIGHT_FILE)), { code: 'ENOENT' });
});

test('serve records its start and stop as the runtime role, and logs requests; the next start sees a clean stop', async () => {
  const env = await deployment();
  await serveOnce(env, async (url) => {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  });
  // The process's own start may rotate the file around this request, so it is in one of the two; the next start replaces the older.
  const logs = join(String(env.CIRCLE_HUB_DATA_DIR), 'logs');
  const inflight = (await Promise.all([join(logs, 'inflight.1.jsonl'), join(logs, INFLIGHT_FILE)].map((path) => readFile(path, 'utf8').catch(() => '')))).join('');
  assert.match(inflight, /GET \/healthz/);
  assert.match(inflight, /"t":"stop"/);
  await serveOnce(env);
  const kit = await openRecords(loadServerConfig(env), { migrate: false, keyProvider: keyProvider() });
  const { token, user } = await kit.principals.bootstrapAdmin('synthetic-admin', { password: 'synthetic-password-2026', mustChange: false });
  const member = await kit.principals.createUser({ id: user.id, name: user.name, role: user.role }, 'synthetic-member');
  const memberToken = await kit.principals.issueToken({ id: user.id, name: user.name, role: user.role }, member.id, 'synthetic');
  await kit.close();
  const admin = { ...env, CIRCLE_HUB_TOKEN: token.token };

  const text = await cli(['crashes'], admin);
  assert.equal(text.code, 0, text.text);
  assert.deepEqual(text.out.map((line) => line.split(' ')[1]), ['正常停止', '启动', '正常停止', '启动'], 'newest first, and no abnormal exit');
  const events = JSON.parse((await cli(['crashes', '--json', '--limit', '2'], admin)).out.join('\n')) as { kind: string; pid: number; node_version: string }[];
  assert.deepEqual(events.map((event) => event.kind), ['stop', 'start']);
  assert.equal(events[0]?.pid, process.pid);
  assert.equal(events[0]?.node_version, process.version);

  const health = await cli(['health'], admin);
  assert.equal(health.code, 0, health.text);
  assert.match(health.text, /以来没有资源样本/, 'a process shorter than one interval takes no sample');

  for (const argv of [['health'], ['crashes']]) {
    const refused = await cli(argv, { ...env, CIRCLE_HUB_TOKEN: memberToken.token });
    assert.equal(refused.code, 1);
    assert.match(refused.text, /只有管理员可以读运行状况/);
  }
  assert.equal((await cli(['health', '--since', 'yesterday'], admin)).code, 2);
  for (const limit of ['0', '-1', '501', 'many']) assert.equal((await cli(['crashes', `--limit=${limit}`], admin)).code, 2, limit);
});

test('serve gives the 运行状况 page its readers, and the runtime role may read everything they read', async () => {
  const env = await deployment();
  const kit = await openRecords(loadServerConfig(env), { migrate: false, keyProvider: keyProvider() });
  await kit.principals.bootstrapAdmin('synthetic-admin', { password: 'synthetic-password-2026', mustChange: false });
  await kit.close();
  const cookie = (response: Response, name: string): string => response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`))!.split(';')[0]!;
  await serveOnce(env, async (url) => {
    const form = await fetch(`${url}/console/login`);
    const nonce = /name="csrf" value="([^"]+)"/.exec(await form.text())![1]!;
    const signedIn = await fetch(`${url}/console/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie(form, 'circle_hub_login') }, body: new URLSearchParams({ username: 'synthetic-admin', password: 'synthetic-password-2026', csrf: nonce }).toString() });
    assert.equal(signedIn.status, 303);
    // Each tab of the page makes its own reads (decision 151): every one of them must be allowed.
    const pages = new Map<string, string>();
    for (const tab of ['', 'tasks', 'events', 'clients', 'releases', 'self']) {
      const reply = await fetch(`${url}/console/health${tab === '' ? '' : `?tab=${tab}`}`, { headers: { cookie: cookie(signedIn, 'circle_hub_session') } });
      assert.equal(reply.status, 200, tab);
      pages.set(tab, await reply.text());
      assert.doesNotMatch(pages.get(tab)!, /这次没有读出/, `no read of the tab ${tab || 'resources'} was refused`);
    }
    assert.match(pages.get('self')!, /队列<\/span><span class="ch-stat-value">\d/, 'the trace writer of this process answers');
  });
});

test('a crash reads back through the command: what was running, and what the report said', async () => {
  const env = await deployment();
  const logs = join(String(env.CIRCLE_HUB_DATA_DIR), 'logs');
  const kit = await openRecords(loadServerConfig(env), { migrate: false, keyProvider: keyProvider() });
  const { token } = await kit.principals.bootstrapAdmin('synthetic-admin', { password: 'synthetic-password-2026', mustChange: false });
  await kit.close();
  const owner = new pg.Client({ host: postgres.socketDir, port: postgres.config.port, user: postgres.config.user, database: String(env.CIRCLE_HUB_DATABASE_NAME) });
  await owner.connect();
  await owner.query("INSERT INTO public.process_events(at,kind,boot,pid,release,node_version,heap_limit_bytes) VALUES('2026-01-02T00:00:00.000Z','start','boot-crashed',4242,'synthetic-release','v24.22.0',2147483648)");
  await owner.end();
  await writeFile(join(logs, INFLIGHT_FILE), [
    { t: 'boot', boot: 'boot-crashed', at: '2026-01-02T00:00:00.000Z' },
    { t: 'begin', boot: 'boot-crashed', id: 1, at: '2026-01-02T01:00:00.000Z', trace: 'f'.repeat(32), origin: 'mcp', name: 'get_nodes', user: 'usr_synthetic' },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');
  const report = JSON.parse(await readFile(new URL('../health/fixtures/report.synthetic.json', import.meta.url), 'utf8')) as object;
  await mkdir(join(logs, 'reports'), { recursive: true });
  await writeFile(join(logs, 'reports', 'report.20260102.030405.4242.0.001.json'), JSON.stringify(report));
  await serveOnce(env);
  const text = (await cli(['crashes'], { ...env, CIRCLE_HUB_TOKEN: token.token })).text;
  assert.match(text, /异常退出 PID 4242 发布 synthetic-release v24\.22\.0/);
  assert.match(text, /Allocation failed - JavaScript heap out of memory（OOMError）/);
  assert.match(text, /堆 2\.05 GB \/ 上限 2\.09 GB/);
  assert.match(text, /当时在处理 1 个请求/);
  assert.match(text, /mcp get_nodes（用户 usr_synthetic，追踪 f{32}）/);
});
