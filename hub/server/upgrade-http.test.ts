// Real loopback HTTP and SDK handling over synthetic in-memory ports; no database or credential files.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { DEFAULT_LIMITS } from '../config/index.ts';
import type { CallLogInput } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { createApp } from './app.ts';

const TOKEN = 'synthetic-upgrade-token';
const BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } });

async function bed(t: TestContext, closeGraceMs = 5000) {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-upgrade-http-'));
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<[]>(), logged = Promise.withResolvers<void>();
  const calls: CallLogInput[] = [], messages: string[] = [];
  const secondRequest = Promise.withResolvers<void>();
  let reads = 0, active = 0, arrivals = 0;
  const deps = {
    config: { host: '127.0.0.1', port: 0, environment: 'test', dataDir: root, limits: DEFAULT_LIMITS },
    records: {
      principals: { authenticate: async (value: string) => value === `Bearer ${TOKEN}` ? { id: 'usr_' + '0'.repeat(26), name: '合成成员', role: 'user' } : null },
      callLog: { append: async (input: CallLogInput) => { calls.push(input); logged.resolve(); } },
    },
    workflows: { summaries: () => { reads++; entered.resolve(); return finish.promise; } },
    runs: {}, knowledge: {},
  } as unknown as ServerDeps;
  const app = createApp(deps, { codeRoot: root, closeTimeoutMs: 0, closeGraceMs, log: line => messages.push(line), health: {
    requests: { get inFlight() { return active; }, begin() {
      active++; if (++arrivals === 2) secondRequest.resolve();
      return Object.assign(() => { active--; }, { identify: () => {} });
    } },
    sessions: { opened() {}, seen() {}, closed() {}, counts: () => ({ total: 0, byClient: {} }) },
  } });
  const info = await app.listen();
  t.after(async () => { finish.resolve([]); await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, info, entered, finish, logged, secondRequest, calls, messages, reads: () => reads };
}

function post(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: {
      authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
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
