// Actual run-export routes and real TCP backpressure: a returned handler is not a finished download.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request, ServerResponse, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { runRecord } from '../../contracts/src/fixtures.ts';
import { DEFAULT_LIMITS } from '../config/index.ts';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { createApp } from './app.ts';

const RUN = 'run_' + '0'.repeat(26);
const TOKEN = 'synthetic-export-token';
// Explicit synthetic service DTO; this HTTP fixture does not construct a records store.
const RUN_REFERENCE = `rec:${'a'.repeat(64)}`;

async function download(t: TestContext, form: 'run' | 'source', grace: number) {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-upgrade-download-'));
  const original = Buffer.alloc(16 * 1024 * 1024, 0xa5), source = sha256Hex(original);
  const instructions = 'synthetic export '.repeat(512 * 1024);
  const run = { ...runRecord, run: RUN, instructions, instructions_digest: sha256Hex(instructions) };
  const expected = form === 'run' ? Buffer.from(canonicalBytes({ schema: 'run-export@1', run_reference: RUN_REFERENCE, run })) : original;
  const path = `/run-export/${RUN}/${form === 'run' ? 'run' : 'sources/' + source}`;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const enqueued = Promise.withResolvers<ServerResponse>();
  const end = ServerResponse.prototype.end;
  t.mock.method(ServerResponse.prototype, 'end', function (this: ServerResponse, ...args: unknown[]) {
    const result = Reflect.apply(end, this, args);
    if (Number(this.getHeader('content-length')) === expected.length) enqueued.resolve(this);
    return result;
  });
  const messages: string[] = [];
  const deps = {
    config: { host: '127.0.0.1', port: 0, environment: 'test', dataDir: root, limits: DEFAULT_LIMITS },
    records: {
      principals: { authenticate: async (header: string) => header === `Bearer ${TOKEN}` ? { id: 'usr_' + '0'.repeat(26), name: '合成下载者', role: 'user' } : null },
      artifacts: { sourceForRun: async (_by: unknown, sha: string, id: string) => sha === source && id === RUN ? { bytes: original } : null },
      callLog: { append: async () => {} },
    },
    runs: { exportRun: async () => { entered.resolve(); await release.promise; return { run_reference: RUN_REFERENCE, accepted_result_reference: null, run, result: null, submission: null }; } },
  } as unknown as ServerDeps;
  const app = createApp(deps, { codeRoot: root, closeTimeoutMs: 0, closeGraceMs: grace, log: line => messages.push(line) });
  const { port } = await app.listen();
  const headers = Promise.withResolvers<IncomingMessage>(), received = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  const req = request({ host: '127.0.0.1', port, path, headers: { authorization: `Bearer ${TOKEN}` } }, res => {
    res.pause();
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => received.resolve(Buffer.concat(chunks)));
    res.on('aborted', () => received.reject(new Error('download aborted')));
    res.on('error', error => received.reject(error));
    headers.resolve(res);
  });
  req.on('error', error => { headers.reject(error); received.reject(error); }); req.end();
  // Attach the failure branch before closing, so an intentional over-budget cutoff is observed rather than unhandled.
  const outcome = received.promise.then(bytes => ({ bytes }), error => ({ error }));
  await entered.promise;
  release.resolve();
  const res = await headers.promise;
  assert.equal(res.statusCode, 200);
  const response = await enqueued.promise;
  await nextTurn();
  assert.equal(response.writableFinished, false, 'the actual response remains backpressured after the route returned');
  assert.ok(response.writableLength > 0, 'bytes remain queued on the real HTTP response');
  t.after(async () => { release.resolve(); res.destroy(); req.destroy(); await app.close(); await rm(root, { recursive: true, force: true }); });
  return { app, res, expected, outcome, messages };
}

for (const form of ['run', 'source'] as const) test(`shutdown preserves the complete ${form} export after route return under TCP backpressure`, { timeout: 20_000 }, async t => {
  const w = await download(t, form, 10_000);
  let closed = false;
  const closing = w.app.close().then(() => { closed = true; });
  try {
    await nextTurn();
    assert.equal(closed, false, 'close still waits for the unfinished export, not only its handler');
  } finally { w.res.resume(); }
  const reply = await w.outcome;
  assert.ok('bytes' in reply, 'the admitted run-export download must not be cut');
  assert.equal(reply.bytes.length, w.expected.length);
  assert.equal(sha256Hex(reply.bytes), sha256Hex(w.expected));
  if (form === 'source') assert.match(String(w.res.headers['content-digest']), /^sha-256=:/);
  await closing;
  assert.ok(!w.messages.some(message => message.includes('结果未知')));
});

test('an export exceeding both shutdown budgets is cut with an unknown outcome rather than blind retry advice', { timeout: 20_000 }, async t => {
  const w = await download(t, 'source', 0);
  await w.app.close();
  w.res.resume();
  assert.ok('error' in await w.outcome);
  assert.match(w.messages.join('\n'), /结果未知/);
  assert.match(w.messages.join('\n'), /不要盲目重发/);
});
