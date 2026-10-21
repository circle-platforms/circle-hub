import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { checkHealth, HEALTH_PATH, portAnswers, waitForHealth } from './health.ts';
import { freePort } from './test-support.ts';

let server: Server;
let port: number;
const state: { status: number; body: string; seen: string[] } = { status: 200, body: '{"status":"ok","release":"aaaaaaaaaaaa"}', seen: [] };

before(async () => {
  server = createServer((request, response) => {
    state.seen.push(`${request.method} ${request.url} ${request.headers.host}`);
    if (request.url !== HEALTH_PATH) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(state.status, { 'content-type': 'application/json' }).end(state.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('GET /healthz on loopback with status 200 is healthy and reports the release', async () => {
  state.status = 200;
  state.body = '{"status":"ok","release":"aaaaaaaaaaaa"}';
  assert.deepEqual(await checkHealth(port), { ok: true, status: 200, release: 'aaaaaaaaaaaa' });
  assert.deepEqual(await checkHealth(port, { release: 'aaaaaaaaaaaa' }), { ok: true, status: 200, release: 'aaaaaaaaaaaa' });
  assert.match(state.seen.at(-1) ?? '', new RegExp(`^GET /healthz 127\\.0\\.0\\.1:${port}$`));
  state.body = 'ok';
  assert.deepEqual(await checkHealth(port, { release: 'aaaaaaaaaaaa' }), { ok: true, status: 200 }, 'a body without a release is accepted');
});

test('another release answering, a non-200 status or nothing listening is not healthy', async () => {
  state.status = 200;
  state.body = '{"status":"ok","release":"bbbbbbbbbbbb"}';
  const other = await checkHealth(port, { release: 'aaaaaaaaaaaa' });
  assert.equal(other.ok, false);
  assert.match(other.error ?? '', /应答来自发布 bbbbbbbbbbbb/);
  state.status = 503;
  assert.deepEqual(await checkHealth(port), { ok: false, status: 503, release: 'bbbbbbbbbbbb' });
  const closed = await freePort();
  const none = await checkHealth(closed, { timeoutMs: 500 });
  assert.equal(none.ok, false);
  assert.ok(none.error);
});

test('waitForHealth polls until healthy and times out with the last observation', async () => {
  state.status = 503;
  state.body = '{}';
  setTimeout(() => {
    state.status = 200;
  }, 150);
  assert.equal((await waitForHealth(port, { totalMs: 5000, intervalMs: 50 })).ok, true);
  state.status = 500;
  await assert.rejects(waitForHealth(port, { totalMs: 300, intervalMs: 50 }), /健康检查超时.*HTTP 500/);
});

test('portAnswers sees a listener and a free port', async () => {
  assert.equal(await portAnswers(port), true);
  assert.equal(await portAnswers(await freePort()), false);
});
