// Traces of the requests that enter the server, on a temporary PostgreSQL with the fake services: an MCP call and its call
// log line, W3C Trace Context in the header and in `_meta`, what must never reach the table, a writer that fails, the
// console with its 500 paths, the sync API and a background round.
import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { after, before, test, type TestContext } from 'node:test';
import { Database, createPool, type Row } from '../records/db.ts';
import { TraceReader, startTelemetry, type Telemetry, type TelemetryOptions } from '../telemetry/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { createTestServer, testConsoleCredentials, type TestServer, type TestUser } from './testing.ts';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE}-${PARENT}-01`;

let postgres: TemporaryPostgres;
let server: TestServer;
let db: Database;
let counter = 0;

before(async () => {
  postgres = await startPostgres();
  server = await createTestServer({ postgres, live: { pollMs: 20, heartbeatMs: 250 } });
  db = new Database(createPool(server.records.database, 2));
});
after(async () => {
  await db?.end();
  await server?.close();
  await postgres?.stop();
});

function telemetryFor(t: TestContext, options: Partial<TelemetryOptions> = {}): Telemetry {
  const telemetry = startTelemetry({ database: server.records.database, ...options });
  t.after(() => telemetry.close());
  return telemetry;
}

const member = async (): Promise<TestUser> => {
  counter += 1;
  const user = await server.createUser(`追踪成员${counter}`);
  await server.assign(user.principal, 'review');
  return user;
};

const rowsOf = async (trace: string): Promise<Row[]> => (await db.query('SELECT * FROM trace_spans WHERE trace_id = $1', [trace])).rows;
const rootOf = (rows: readonly Row[]): Row => {
  const roots = rows.filter((row) => row.is_root === true);
  assert.equal(roots.length, 1, 'one root step');
  return roots[0];
};
const named = (rows: readonly Row[], name: string): Row => {
  const row = rows.find((candidate) => candidate.name === name);
  assert.ok(row, `a step named ${name}`);
  return row;
};

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: options.method ?? 'GET', agent: false, setHost: false, headers: { host: `127.0.0.1:${server.port}`, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const valueOf = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const cookieOf = (reply: Reply, name: string): string | undefined => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));

async function signIn(token: string): Promise<string> {
  const page = await send('/console/login');
  const nonce = /name="csrf" value="([^"]+)"/.exec(page.body)![1];
  const reply = await send('/console/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}` },
    body: new URLSearchParams({ ...testConsoleCredentials(token), csrf: nonce }).toString(),
  });
  assert.equal(reply.status, 303, reply.body);
  return `circle_hub_session=${valueOf(cookieOf(reply, 'circle_hub_session'))}`;
}

test('an MCP tool call is a trace: the root shares the call log line, carries who called and what the call read', async (t) => {
  const telemetry = telemetryFor(t, { release: 'abcdef012345', environment: 'test' });
  const user = await member();
  const client = await server.client(user.token, { sessionId: 'synthetic-session' });
  t.after(() => client.close());
  const result = await client.call('list_task_packs');
  await telemetry.flush();
  const trace = String(result.structuredContent.trace);
  const rows = await rowsOf(trace);
  const root = rootOf(rows);
  assert.equal(root.name, 'list_task_packs');
  assert.equal(root.origin, 'mcp');
  assert.equal(root.type, 'span');
  assert.equal(root.level, 'default');
  assert.equal(root.status_message, null);
  assert.equal(root.parent_span_id, null);
  assert.ok((root.usage as Record<string, number>)['db.rows'] > 0, 'the call read rows');
  assert.ok((root.usage as Record<string, number>)['db.queries'] > 0);
  assert.ok((root.usage as Record<string, number>)['answer.bytes'] > 0);
  assert.ok(typeof (root.usage as Record<string, number>)['self.ms'] === 'number');
  for (const row of rows) {
    assert.deepEqual([row.user_id, row.session_id, row.client_name, row.client_version, row.release, row.environment], [user.user.id, 'synthetic-session', 'hub-server-test', '0.0.0', 'abcdef012345', 'test']);
  }
  assert.equal(named(rows, 'authenticate').parent_span_id, root.span_id);
  assert.equal(named(rows, 'authenticate').type, 'guardrail');
  assert.equal(named(rows, 'append-record').parent_span_id, root.span_id);
  const line = (await server.records.callLog.query(user.principal, { traceId: trace })).items;
  assert.equal(line.length, 1);
  assert.equal(line[0].trace_id, root.trace_id);
  assert.equal(line[0].span_id, root.span_id, 'one call, one span');
});

test('initialize and tools/list are named; the client name comes from what initialize declared', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const client = await server.client(user.token);
  t.after(() => client.close());
  await telemetry.flush();
  const rows = (await db.query(`SELECT * FROM trace_spans WHERE user_id = $1 AND is_root ORDER BY started_at`, [user.user.id])).rows;
  assert.ok(rows.some((row) => row.name === 'initialize' && row.client_name === 'hub-server-test'));
  assert.ok(rows.some((row) => row.name === 'list-tools' && row.client_name === 'hub-server-test'));
});

/** A raw initialize, with the clientInfo a test wants; the SDK's client sends only a name and a version. */
async function initialize(token: string, clientInfo: unknown): Promise<string | null> {
  const response = await fetch(server.mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo } }) });
  assert.equal(response.status, 200);
  await response.text();
  return response.headers.get('mcp-session-id');
}

const listTools = async (token: string, session: string | null): Promise<void> => {
  const response = await fetch(server.mcpUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session === null ? {} : { 'mcp-session-id': session }) }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.equal(response.status, 200);
  await response.text();
};

test('the platform a client declares at initialize reaches the rows of that connection, cleaned and bounded, as a declaration', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const session = await initialize(user.token, { name: 'synthetic-client', version: '1.0', platform: ` synthetic\u0000-os\u200b${'x'.repeat(200)} ` });
  await listTools(user.token, session);
  await telemetry.flush();
  const rows = (await db.query(`SELECT name, client_name, client_version, client_platform FROM trace_spans WHERE user_id = $1 AND is_root ORDER BY started_at`, [user.user.id])).rows;
  const platform = `synthetic-os${'x'.repeat(88)}`;
  assert.equal([...platform].length, 100);
  assert.deepEqual(rows, [
    { name: 'initialize', client_name: 'synthetic-client', client_version: '1.0', client_platform: platform },
    { name: 'list-tools', client_name: 'synthetic-client', client_version: '1.0', client_platform: platform },
  ]);
});

test('a root on /mcp is a call exactly when the call log has its line, whatever its name', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const headers = { authorization: `Bearer ${user.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = (body: unknown, extra: Record<string, string> = {}): Promise<Reply> => send('/mcp', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const session = await initialize(user.token, { name: 'synthetic-client', version: '1.0' });
  assert.ok(session);
  const inSession = { 'mcp-session-id': session };
  // No line: the client's probe for a stream, and a notification.
  assert.equal((await send('/mcp', { headers: { ...headers, ...inSession } })).status, 405);
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, inSession)).status, 202);
  // A line each: a ping, a tool no one has, and a request or a notification refused at the transport.
  assert.equal((await post({ jsonrpc: '2.0', id: 2, method: 'ping' }, inSession)).status, 200);
  assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } }, inSession)).status, 200);
  assert.equal((await post({ jsonrpc: '2.0', id: 4, method: 'ping' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { accept: 'text/plain' })).status, 406);
  assert.equal((await send('/mcp', { method: 'DELETE', headers: { ...headers, ...inSession } })).status, 405);
  await telemetry.flush();
  const roots = (await db.query(`SELECT name, count(*)::int AS n FROM trace_spans WHERE user_id = $1 AND is_root AND origin = 'mcp' GROUP BY name ORDER BY name`, [user.user.id])).rows;
  assert.deepEqual(roots, [{ name: 'handle-mcp', n: 5 }, { name: 'initialize', n: 1 }, { name: 'serve-http', n: 2 }]);
  const lines = (await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 50 })).items;
  assert.equal(lines.length, 6, 'the calls the page counts are the lines of the call log');
});

/** A POST that goes away before its body is complete, and the line the call log writes for it. */
async function abandon(user: TestUser, session: string): Promise<void> {
  const before = (await server.records.callLog.query(user.principal, { limit: 50 })).items.length;
  const socket = connect(server.port, '127.0.0.1');
  socket.write(`POST /mcp HTTP/1.1\r\nhost: 127.0.0.1:${server.port}\r\nauthorization: Bearer ${user.token}\r\ncontent-type: application/json\r\nmcp-session-id: ${session}\r\ncontent-length: 100\r\n\r\n{`, () => socket.destroy());
  for (let index = 0; index < 500; index += 1) {
    if ((await server.records.callLog.query(user.principal, { limit: 50 })).items.length > before) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the abandoned request got no line');
}

test('a request refused on the way in is still the call of the client that declared itself: no client without a name appears', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const since = new Date().toISOString();
  const session = await initialize(user.token, { name: 'synthetic-client', version: '1.0', platform: 'synthetic-os' });
  assert.ok(session);
  const headers = { authorization: `Bearer ${user.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session };
  const post = (body: string, extra: Record<string, string> = {}): Promise<Reply> => send('/mcp', { method: 'POST', headers: { ...headers, ...extra }, body });
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.equal((await post(ping, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(ping, { 'content-length': String(2 ** 40) })).status, 413);
  assert.equal((await post(JSON.stringify({ token: user.token }))).status, 400);
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post(`[${ping}]`)).status, 400);
  await abandon(user, session);
  assert.equal((await send('/mcp', { method: 'DELETE', headers })).status, 405);
  await telemetry.flush();
  const client = { client_name: 'synthetic-client', client_version: '1.0', client_platform: 'synthetic-os' };
  const roots = (await db.query(`SELECT name, client_name, client_version, client_platform, count(*)::int AS n FROM trace_spans WHERE user_id = $1 AND is_root GROUP BY 1, 2, 3, 4 ORDER BY 1`, [user.user.id])).rows;
  assert.deepEqual(roots, [{ name: 'handle-mcp', ...client, n: 7 }, { name: 'initialize', ...client, n: 1 }]);
  const { rows } = await new TraceReader(db).clients(server.admin.principal, { since, limit: 50 });
  assert.deepEqual(rows.map((row) => [row.origin, row.client_name, row.client_platform, row.calls]), [['mcp', 'synthetic-client', 'synthetic-os', 8]]);
});

test('a refused request of a connection that declared nothing keeps no name: nothing is guessed from another connection', async (t) => {
  const telemetry = telemetryFor(t);
  const [declared, silent] = [await member(), await member()];
  await initialize(declared.token, { name: 'synthetic-client', version: '1.0' });
  assert.equal((await send('/mcp', { method: 'DELETE', headers: { authorization: `Bearer ${silent.token}` } })).status, 405);
  await telemetry.flush();
  assert.deepEqual((await db.query(`SELECT name, client_name FROM trace_spans WHERE user_id = $1 AND is_root`, [silent.user.id])).rows, [{ name: 'handle-mcp', client_name: null }]);
});

test('a request on /mcp refused before it could be a call is an exchange, traced like any other', async (t) => {
  const telemetry = telemetryFor(t);
  const refused = [
    ['4bf92f3577b34da6a3ce929d0e0e4737', await send('/mcp', { method: 'POST', headers: { traceparent: `00-4bf92f3577b34da6a3ce929d0e0e4737-${PARENT}-01`, 'content-type': 'application/json' }, body: '{}' }), 401],
    ['4bf92f3577b34da6a3ce929d0e0e4738', await send('/mcp', { method: 'POST', headers: { traceparent: `00-4bf92f3577b34da6a3ce929d0e0e4738-${PARENT}-01`, host: 'other.example', 'content-type': 'application/json' }, body: '{}' }), 403],
  ] as const;
  await telemetry.flush();
  for (const [trace, reply, status] of refused) {
    assert.equal(reply.status, status);
    const root = rootOf(await rowsOf(trace));
    assert.deepEqual([root.name, root.origin, root.user_id], ['serve-http', 'mcp', null]);
    await db.query('DELETE FROM trace_spans WHERE trace_id = $1', [trace]);
  }
});

test('a refused batch is one root of the MCP entry, whatever its requests asked for', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const reply = await send('/mcp', { method: 'POST', headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]) });
  assert.equal(reply.status, 400);
  await telemetry.flush();
  const roots = (await db.query(`SELECT name FROM trace_spans WHERE user_id = $1 AND is_root`, [user.user.id])).rows;
  assert.deepEqual(roots.map((row) => row.name), ['handle-mcp']);
  assert.equal((await server.records.callLog.query(server.admin.principal, { userId: user.user.id, limit: 50 })).items.length, 2, 'a line per request of it');
});

test('a client that declares no platform has none: absent, not guessed, and not taken from another connection', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  await initialize(user.token, { name: 'synthetic-client', version: '1.0', platform: 'synthetic-os' });
  const silent = await initialize(user.token, { name: 'synthetic-client', version: '1.0' });
  await listTools(user.token, silent);
  const blank = await initialize(user.token, { name: 'synthetic-client', version: '1.0', platform: ' \u0000 ' });
  const wrong = await initialize(user.token, { name: 'synthetic-client', version: '1.0', platform: 42 });
  await telemetry.flush();
  const rows = (await db.query(`SELECT client_platform FROM trace_spans WHERE user_id = $1 AND is_root ORDER BY started_at`, [user.user.id])).rows;
  assert.deepEqual(rows.map((row) => row.client_platform), ['synthetic-os', null, null, null, null]);
  assert.ok(blank && wrong);
});

test('a platform with no name says nothing, and the records that bind a client to its writes do not hold the platform', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  await initialize(user.token, { platform: 'synthetic-os' });
  const session = await initialize(user.token, { name: 'synthetic-client', version: '1.0', platform: 'synthetic-os' });
  await telemetry.flush();
  const rows = (await db.query(`SELECT client_name, client_platform FROM trace_spans WHERE user_id = $1 AND is_root ORDER BY started_at`, [user.user.id])).rows;
  assert.deepEqual(rows[0], { client_name: null, client_platform: null });
  const tokenId = (await server.records.principals.tokens(user.user.id))[0]!.id;
  assert.deepEqual(await server.records.callLog.declaredClient!(user.user.id, session, tokenId), { name: 'synthetic-client', version: '1.0' });
  const declarations = (await db.query(`SELECT body FROM records WHERE schema = 'mcp-client-declaration@1' AND body LIKE $1`, [`%${user.user.id}%`])).rows;
  assert.equal(declarations.length, 1);
  assert.deepEqual((JSON.parse(String(declarations[0]!.body)) as { client: unknown }).client, { name: 'synthetic-client', version: '1.0' }, 'the declaration bound to writes is the name and version');
});

test('the traceparent header joins the client trace: the client span is the parent of the root', async (t) => {
  const telemetry = telemetryFor(t);
  const client = await server.client((await member()).token, { traceparent: TRACEPARENT });
  t.after(() => client.close());
  const result = await client.call('list_task_packs');
  assert.equal(result.structuredContent.trace, TRACE);
  await telemetry.flush();
  const roots = (await rowsOf(TRACE)).filter((row) => row.is_root === true);
  assert.ok(roots.length >= 2, 'every request of this client shares its trace id');
  assert.ok(roots.every((row) => row.parent_span_id === PARENT));
  assert.ok(roots.some((row) => row.name === 'list_task_packs'));
  await db.query('DELETE FROM trace_spans WHERE trace_id = $1', [TRACE]);
});

test('_meta.traceparent of a tool call does the same, and a valid header stays first', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const meta = '7'.repeat(32), metaParent = '8'.repeat(16);
  const plain = await server.client(user.token);
  t.after(() => plain.close());
  const declared = (await plain.client.callTool({ name: 'list_task_packs', arguments: {}, _meta: { traceparent: `00-${meta}-${metaParent}-01` } })) as { structuredContent: Record<string, unknown> };
  assert.equal(declared.structuredContent.trace, meta);
  const invalid = (await plain.client.callTool({ name: 'list_task_packs', arguments: {}, _meta: { traceparent: 'not a traceparent' } })) as { structuredContent: Record<string, unknown> };
  assert.match(String(invalid.structuredContent.trace), /^[0-9a-f]{32}$/);
  assert.notEqual(invalid.structuredContent.trace, meta);
  const headed = await server.client(user.token, { traceparent: TRACEPARENT });
  t.after(() => headed.close());
  const both = (await headed.client.callTool({ name: 'list_task_packs', arguments: {}, _meta: { traceparent: `00-${meta}-${metaParent}-01` } })) as { structuredContent: Record<string, unknown> };
  assert.equal(both.structuredContent.trace, TRACE);
  await telemetry.flush();
  const root = rootOf(await rowsOf(meta));
  assert.equal(root.parent_span_id, metaParent);
  assert.equal(root.name, 'list_task_packs');
  assert.equal((await server.records.callLog.query(user.principal, { traceId: meta })).items.length, 1, 'the call log line has the same trace id');
  await db.query('DELETE FROM trace_spans WHERE trace_id = $1', [TRACE]);
});

test('no argument value, name or message of a caller reaches the table', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const client = await server.client(user.token, { sessionId: 'synthetic-session' });
  t.after(() => client.close());
  const secret = 'SYNTHETICARGUMENTVALUE7741';
  await client.call('upload_file', { file_path: Buffer.from(`${secret} 正文`).toString('base64'), media_type: 'text/plain', name: `${secret}.txt` });
  await client.call('get_nodes', { search: secret });
  await client.call('get_nodes', { reference: `src:${secret}` });
  await client.call('start_run', { pack: secret, inputs: { [secret]: { reference: secret } } });
  await client.client.callTool({ name: secret, arguments: { value: secret } }).catch(() => {});
  await telemetry.flush();
  const rows = (await db.query('SELECT * FROM trace_spans WHERE user_id = $1', [user.user.id])).rows;
  assert.ok(rows.length > 5);
  assert.ok(!JSON.stringify(rows).includes(secret), 'the rows hold no argument');
  assert.ok(rows.some((row) => row.name === 'handle-mcp' && row.is_root === true), 'a tool name a client made up is not a step name');
  assert.ok(rows.some((row) => row.name === 'upload_file' && row.is_root === true));
});

test('a call that fails marks its root with the error code', async (t) => {
  const telemetry = telemetryFor(t);
  const client = await server.client((await member()).token);
  t.after(() => client.close());
  const result = await client.call('get_nodes', { reference: 'nonsense' });
  assert.equal(result.isError, true);
  await telemetry.flush();
  const root = rootOf(await rowsOf(String(result.structuredContent.trace)));
  assert.equal(root.level, 'error');
  assert.equal(root.status_message, (result.structuredContent.errors as { code: string }[])[0].code);
});

test('a writer that fails, or a queue that is full, changes no answer', async (t) => {
  const lines: string[] = [];
  const telemetry = telemetryFor(t, { insert: async () => { throw Object.assign(new Error('the database refused this'), { code: '53100' }); }, log: (line) => lines.push(line) });
  const user = await member();
  const client = await server.client(user.token);
  t.after(() => client.close());
  const result = await client.call('list_task_packs');
  assert.equal(result.isError, false);
  await telemetry.flush();
  assert.equal(telemetry.stats().written, 0);
  assert.ok(telemetry.stats().failed > 0, 'the rows are counted as lost');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /53100/);
  assert.equal((await rowsOf(String(result.structuredContent.trace))).length, 0);
  assert.equal((await server.records.callLog.query(user.principal, { traceId: String(result.structuredContent.trace) })).items.length, 1, 'the call log is not diagnostic data: it was written');

  await telemetry.close();
  const full = telemetryFor(t, { queueRows: 1 });
  const again = await client.call('list_task_packs');
  assert.equal(again.isError, false);
  assert.ok(full.stats().dropped > 0, 'what the queue had no room for is counted');
});

test('without telemetry a call leaves no row and answers as before', async () => {
  const user = await member();
  const client = await server.client(user.token);
  const result = await client.call('list_task_packs');
  await client.close();
  assert.equal(result.isError, false);
  assert.equal((await rowsOf(String(result.structuredContent.trace))).length, 0);
});

test('a console request is a trace with its signed-in account; the page area names it', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const cookie = await signIn(user.token);
  const reply = await send('/console/runs', { headers: { cookie } });
  assert.equal(reply.status, 200);
  await telemetry.flush();
  const rows = (await db.query(`SELECT * FROM trace_spans WHERE origin = 'console' AND user_id = $1 AND name = 'serve-runs'`, [user.user.id])).rows;
  assert.equal(rows.filter((row) => row.is_root === true).length, 1);
  const root = rows.find((row) => row.is_root === true)!;
  assert.equal(root.level, 'default');
  assert.equal((root.usage as Record<string, number>)['answer.bytes'], Buffer.byteLength(reply.body));
  assert.ok((root.usage as Record<string, number>)['db.queries'] > 0);
});

test('a page that fails with HTTP 500 is a trace that says so', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const cookie = await signIn(user.token);
  const { runs } = server.deps;
  const listRuns = runs.listRuns;
  runs.listRuns = async () => { throw new Error('synthetic page failure SECRETPAGETEXT'); };
  t.after(() => { runs.listRuns = listRuns; });
  const reply = await send('/console/runs', { headers: { cookie } });
  assert.equal(reply.status, 500);
  await telemetry.flush();
  const rows = (await db.query(`SELECT * FROM trace_spans WHERE name = 'serve-runs' AND level = 'error' AND user_id = $1`, [user.user.id])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status_message, 'HTTP 500');
  assert.ok(!JSON.stringify(rows).includes('SECRETPAGETEXT'));
});

test('the last-resort 500 outside any page handler is a trace too', async (t) => {
  const telemetry = telemetryFor(t);
  const { principals } = server.records;
  const user = await member();
  const cookie = await signIn(user.token);
  const authenticate = principals.authenticate;
  principals.authenticate = async () => { throw new Error('synthetic failure SECRETFAILTEXT'); };
  t.after(() => { principals.authenticate = authenticate; });
  const reply = await send('/console/overview', { headers: { cookie } });
  principals.authenticate = authenticate;
  assert.equal(reply.status, 500);
  await telemetry.flush();
  const rows = (await db.query(`SELECT * FROM trace_spans WHERE name = 'serve-overview' AND is_root AND level = 'error'`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status_message, 'Hub 内部错误');
  assert.ok(!JSON.stringify(rows).includes('SECRETFAILTEXT'));
});

test('requests outside MCP, the console and sync are traced as well, a refusal included', async (t) => {
  const telemetry = telemetryFor(t);
  assert.equal((await send('/healthz')).status, 200);
  assert.equal((await send('/no-such-path', { headers: { traceparent: TRACEPARENT } })).status, 404);
  await telemetry.flush();
  const root = rootOf(await rowsOf(TRACE));
  assert.equal(root.name, 'serve-http');
  assert.equal(root.level, 'warning');
  assert.equal(root.status_message, 'HTTP 404');
  assert.equal(root.parent_span_id, PARENT);
  await db.query('DELETE FROM trace_spans WHERE trace_id = $1', [TRACE]);
});

test('a sync request takes the platform its token declared, as it takes the name and version', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  await initialize(user.token, { name: 'synthetic-client', version: '1.0', platform: 'synthetic-os' });
  await send('/api/sync/v1/state', { headers: { authorization: `Bearer ${user.token}` } });
  await telemetry.flush();
  const rows = (await db.query(`SELECT client_name, client_version, client_platform FROM trace_spans WHERE origin = 'sync' AND is_root AND user_id = $1`, [user.user.id])).rows;
  assert.deepEqual(rows, [{ client_name: 'synthetic-client', client_version: '1.0', client_platform: 'synthetic-os' }]);
});

test('a sync request is a trace named by its route, with its account', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const reply = await send('/api/sync/v1/state', { headers: { authorization: `Bearer ${user.token}` } });
  const refused = await send('/api/sync/v1/state');
  assert.equal(refused.status, 401);
  await telemetry.flush();
  const rows = (await db.query(`SELECT * FROM trace_spans WHERE origin = 'sync' AND is_root`)).rows;
  const own = rows.find((row) => row.user_id === user.user.id);
  assert.equal(own?.name, 'sync-state');
  assert.equal(own?.level, reply.status >= 500 ? 'error' : 'default');
  const anonymous = rows.find((row) => row.user_id === null);
  assert.equal(anonymous?.name, 'serve-sync');
  assert.equal(anonymous?.status_message, 'HTTP 401');
});

test('a background round of the console live updates is its own trace, apart from the stream that started it', async (t) => {
  const telemetry = telemetryFor(t);
  const user = await member();
  const cookie = await signIn(user.token);
  const controller = new AbortController();
  const stream = await fetch(`${server.url}/console/api/stream`, { headers: { cookie, accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(stream.status, 200);
  t.after(() => controller.abort());
  let polls: Row[] = [];
  for (let attempt = 0; attempt < 500 && polls.length === 0; attempt += 1) {
    await telemetry.flush();
    polls = (await db.query(`SELECT * FROM trace_spans WHERE name = 'poll-console'`)).rows;
    if (polls.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(polls.length > 0, 'a poll round was written');
  assert.equal(polls[0].origin, 'background');
  assert.equal(polls[0].is_root, true);
  assert.equal(polls[0].user_id, null, 'the round belongs to no call');
  assert.ok((polls[0].usage as Record<string, number>)['db.queries'] > 0, 'it read the database');
  controller.abort();
  await stream.body?.cancel().catch(() => {});
  let streams: Row[] = [];
  for (let attempt = 0; attempt < 500 && streams.length === 0; attempt += 1) {
    await telemetry.flush();
    streams = (await db.query(`SELECT * FROM trace_spans WHERE name = 'stream-console' AND user_id = $1`, [user.user.id])).rows;
    if (streams.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(streams.length, 1, 'the stream is one request, named apart: its duration is the time the page stayed open');
  assert.notEqual(streams[0].trace_id, polls[0].trace_id);
});
