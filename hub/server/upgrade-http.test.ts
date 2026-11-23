import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_LIMITS } from '../config/index.ts';
import type { CallLogInput, Principal } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { createApp } from './app.ts';

const TOKEN = 'synthetic-upgrade-token';
const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } });

async function bed(t: TestContext, closeGraceMs = 5000, initiallyIdle = false) {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-upgrade-http-'));
  let entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<[]>(), logged = Promise.withResolvers<void>();
  const calls: CallLogInput[] = [], messages: string[] = [];
  const secondRequest = Promise.withResolvers<void>();
  let reads = 0, active = 0, arrivals = 0, blocked = !initiallyIdle;
  const principal = { id: 'usr_' + '0'.repeat(26), name: '合成成员', role: 'user' as const };
  const deps = {
    config: { host: '127.0.0.1', port: 0, environment: 'test', dataDir: root, limits: DEFAULT_LIMITS },
    records: {
      principals: {
        authenticate: async (value: string) => value === `Bearer ${TOKEN}` ? principal : null,
        authenticateConsoleSession: async (value: string) => value === `Bearer ${TOKEN}` ? principal : null,
        revokeTokenValue: async () => true,
        verifyPassword: async (name: string, password: string) => name === principal.name && password === 'synthetic-password' ? { user: principal, revision: 0 } : null,
        openConsoleSession: async () => ({ token: TOKEN }),
      },
      store: {},
      callLog: { append: async (input: CallLogInput) => { calls.push(input); logged.resolve(); } },
    },
    workflows: { summaries: () => { reads++; entered.resolve(); return blocked ? finish.promise : Promise.resolve([]); } },
    memberCapabilities: async (actor: Principal, account?: string, summaries?: readonly unknown[]) => {
      assert.deepEqual(actor, principal);
      assert.equal(account, undefined);
      assert.deepEqual(summaries, [], 'this fixture has an explicitly empty catalog');
      return {
        member: { name: actor.name, enabled: true }, teams: [], workflows: [], skills: [],
        unassigned_workflows_count: 0, connections: [], environments: [],
        environmentAccess: { ready: true, missing: null, nextAction: null }, denials: [],
      };
    },
    runs: {}, knowledge: {},
  } as unknown as ServerDeps;
  const app = createApp(deps, { codeRoot: root, closeTimeoutMs: 0, closeGraceMs, keepalive: { headersAfterMs: 0, keepaliveMs: 5 }, log: line => messages.push(line), health: {
    requests: { get inFlight() { return active; }, begin() {
      active++; if (++arrivals === 2) secondRequest.resolve();
      return Object.assign(() => { active--; }, { identify: () => {} });
    } },
    sessions: { opened() {}, seen() {}, closed() {}, counts: () => ({ total: 0, byClient: {} }) },
  } });
  const info = await app.listen();
  t.after(async () => { finish.resolve([]); await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, info, get entered() { return entered; }, finish, logged, secondRequest, calls, messages, reads: () => reads, active: () => active, block() { blocked = true; entered = Promise.withResolvers<void>(); } };
}

function post(port: number, onChunk?: (chunk: string) => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
      authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => { chunks.push(chunk); onChunk?.(chunk.toString()); });
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      res.on('aborted', () => reject(new Error('response aborted')));
    });
    req.on('error', reject); req.end(BODY);
  });
}

test('an admitted request can finish during the shutdown grace and deliver its complete answer', { timeout: 15_000 }, async t => {
  const w = await bed(t);
  const pending = post(w.info.port).then(value => ({ value }), error => ({ error }));
  await w.entered.promise;
  const closing = w.app.close();
  await nextTurn();
  w.finish.resolve([]);
  const reply = await pending;
  assert.ok('value' in reply, 'the admitted request must not be cut at the first drain deadline');
  assert.equal(reply.value.status, 200);
  assert.equal(JSON.parse(reply.value.body).result.isError, false);
  await closing;
  assert.equal(w.reads(), 1);
  assert.equal(w.calls.length, 1);
  await w.app.close();
});

test('a pipelined call entering shutdown is refused before business with retry guidance', { timeout: 15_000 }, async t => {
  const w = await bed(t);
  const socket = connect(w.info.port, '127.0.0.1');
  t.after(() => socket.destroy());
  let wire = '';
  const ended = Promise.withResolvers<void>();
  socket.on('data', chunk => { wire += chunk.toString(); });
  socket.on('end', () => ended.resolve());
  socket.on('error', error => ended.reject(error));
  const message = `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${w.info.port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${Buffer.byteLength(BODY)}\r\n\r\n${BODY}`;
  socket.write(message);
  await w.entered.promise;
  const closing = w.app.close();
  socket.write(message);
  await w.secondRequest.promise;
  await nextTurn();
  w.finish.resolve([]);
  await ended.promise;
  await closing;
  assert.equal(w.reads(), 1, 'the later call never reached its provider');
  assert.match(wire, /HTTP\/1\.1 503/);
  assert.match(wire, /retry-after: [1-9][0-9]*/i);
  assert.ok(wire.includes('Hub 正在重启，这次调用没有执行，稍后原样重试'));
});

test('shutdown beyond both budgets reports unknown and never recommends blind resubmission', { timeout: 15_000 }, async t => {
  const w = await bed(t, 0);
  const pending = post(w.info.port).then(value => ({ value }), error => ({ error }));
  await w.entered.promise;
  await w.app.close();
  assert.ok('error' in await pending);
  assert.match(w.messages.join('\n'), /结果未知/);
  assert.match(w.messages.join('\n'), /不要盲目重发/);
  w.finish.resolve([]);
  await w.logged.promise;
});

async function sdkClient(t: TestContext, url: string) {
  const client = new Client({ name: 'synthetic-idle-client', version: '1' });
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {});
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  assert.equal((await client.listTools()).tools.length, 6);
  return client;
}

async function listener(t: TestContext, url: string) {
  const login = await fetch(url + '/console/login');
  assert.equal(login.status, 200);
  const nonce = /name="csrf" value="([^"]+)"/.exec(await login.text())![1];
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('circle_hub_login='))!.split(';')[0];
  const signed = await fetch(url + '/console/login', { method: 'POST', redirect: 'manual', headers: {
    origin: url, cookie, 'content-type': 'application/x-www-form-urlencoded',
  }, body: new URLSearchParams({ username: '合成成员', password: 'synthetic-password', csrf: nonce }) });
  assert.equal(signed.status, 303);
  const session = signed.headers.getSetCookie().find(value => value.startsWith('circle_hub_session='))!.split(';')[0];
  return new Promise<{ ended: Promise<void>; isEnded(): boolean }>((resolve, reject) => {
    const ended = Promise.withResolvers<void>();
    let complete = false;
    const req = request(url + '/console/api/stream?events=import.progress', { headers: { cookie: session } }, response => {
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-type']), /text\/event-stream/);
      response.once('data', () => resolve({ ended: ended.promise, isEnded: () => complete }));
      response.on('data', () => {});
      response.on('end', () => { complete = true; ended.resolve(); });
      response.on('aborted', () => ended.reject(new Error('idle listener was cut instead of ended')));
      t.after(() => response.destroy());
    });
    req.on('error', reject); req.end();
    t.after(() => req.destroy());
  });
}

test('two initialized idle SDK clients and unsupported notification probes do not create a shutdown business wait', { timeout: 15_000 }, async t => {
  const w = await bed(t, 5000, true);
  await sdkClient(t, w.info.url);
  await sdkClient(t, w.info.url);
  for (let client = 0; client < 2; client++) {
    const probe = await fetch(w.info.url + '/mcp', { headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' } });
    assert.equal(probe.status, 405, 'this Hub does not open an MCP server notification stream');
    await probe.text();
  }
  await nextTurn();
  assert.equal(w.active(), 0, 'idle SDK connections are not pending business requests');
  await w.app.close();
  assert.ok(!w.messages.some(message => message.includes('结果未知')));
});

test('idle console listeners end before a busy MCP keepalive reply and close still waits for its business barrier', { timeout: 15_000 }, async t => {
  const w = await bed(t, 5000, true);
  await sdkClient(t, w.info.url);
  await sdkClient(t, w.info.url);
  const streams = [await listener(t, w.info.url), await listener(t, w.info.url)];
  assert.equal(w.app.consoleStreams(), 2);
  assert.ok(streams.every(stream => !stream.isEnded()));
  w.block();
  const pulse = Promise.withResolvers<void>();
  let businessEnded = false, closeEnded = false;
  const pending = post(w.info.port, chunk => { if (chunk.trim() === '') pulse.resolve(); }).then(
    value => { businessEnded = true; return { value }; }, error => { businessEnded = true; return { error }; },
  );
  await w.entered.promise;
  await pulse.promise;
  const closing = w.app.close().then(() => { closeEnded = true; });
  try {
    await Promise.all(streams.map(stream => stream.ended));
    assert.equal(w.app.consoleStreams(), 0);
    assert.equal(businessEnded, false, 'the keepalive response still contains an unfinished business operation');
    assert.equal(closeEnded, false, 'closing idle listeners must not stop waiting for business');
  } finally { w.finish.resolve([]); }
  const reply = await pending;
  assert.ok('value' in reply);
  assert.equal(reply.value.status, 200);
  assert.equal(JSON.parse(reply.value.body).result.isError, false);
  await closing;
});
