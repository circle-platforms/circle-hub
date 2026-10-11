import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { API_VERSION, MAX_BODY_BYTES, ApiError, SubmitRequest, InputRequest, TaskId, requireCondition } from '../../../packages/contracts/src/index.ts';
import { Store } from '../../../packages/storage/src/index.ts';
import { taskMigration } from '../../../packages/tasks/src/migration.ts';
import { Auth } from '../../../packages/tasks/src/auth.ts';
import { Tasks } from '../../../packages/tasks/src/index.ts';

function environment(name: string): string { const value = process.env[name]; if (!value) throw new Error(`Required environment variable: ${name}`); return value; }
const store = new Store(JSON.parse(environment('CIRCLE_SERVER_DATABASE_CONFIG')));
await store.migrate([taskMigration]);
const auth = new Auth(store);
requireCondition(process.env.CIRCLE_SERVER_DEV_AUTH === '1', 'INVALID_PAYLOAD', 'Phase one requires explicitly enabled development authentication');
await auth.initializeDevelopment(environment('CIRCLE_SERVER_DEV_IDENTITIES'));
await mkdir(environment('CIRCLE_SERVER_DATA_DIR'), { recursive: true, mode: 0o700 });
const tasks = new Tasks(store, auth, Number(process.env.CIRCLE_SERVER_INPUT_TTL_MS ?? 300_000));
let closing = false;

async function body(request: IncomingMessage): Promise<unknown> {
  requireCondition(request.headers['content-type']?.split(';')[0] === 'application/json', 'INVALID_PAYLOAD', 'JSON content type required');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; requireCondition(size <= MAX_BODY_BYTES, 'BODY_TOO_LARGE', 'Request body exceeds the limit'); chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('INVALID_PAYLOAD', 'Invalid JSON'); }
}
function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ apiVersion: API_VERSION, status: status >= 400 ? 'failed' : 'succeeded', ...data as object }));
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/v1/auth/token' && request.method === 'POST') {
      const input = z.object({ username: z.string().max(100), password: z.string().max(1000), expiresInMs: z.number().int().positive().optional() }).parse(await body(request));
      send(response, 200, { data: await auth.issue(input.username, input.password, input.expiresInMs) }); return;
    }
    const ctx = await auth.authenticate(request.headers.authorization);
    if (url.pathname === '/v1/status' && request.method === 'GET') { send(response, 200, { data: { apiVersion: API_VERSION, syntheticOnly: true } }); return; }
    if (url.pathname === '/v1/tasks/submit' && request.method === 'POST') {
      send(response, 202, { data: await tasks.submit(ctx, SubmitRequest.parse(await body(request))) }); return;
    }
    const match = /^\/v1\/tasks\/([^/]+)\/(status|result|input|cancel|reconcile|events)$/.exec(url.pathname);
    if (match) {
      const taskId = TaskId.parse(match[1]); const action = match[2];
      if ((action === 'status' || action === 'result') && request.method === 'GET') {
        send(response, 200, { data: await tasks.status(ctx, taskId) }); return;
      }
      if (action === 'input' && request.method === 'POST') { send(response, 200, { data: await tasks.input(ctx, taskId, InputRequest.parse(await body(request))) }); return; }
      if (action === 'cancel' && request.method === 'POST') { await body(request); send(response, 202, { data: await tasks.cancel(ctx, taskId) }); return; }
      if (action === 'events' && request.method === 'GET') {
        const after = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('after') ?? 0);
        const waitMs = z.coerce.number().int().min(0).max(30_000).parse(url.searchParams.get('waitMs') ?? 0);
        const deadline = Date.now() + waitMs; let events;
        do {
          await auth.authenticate(request.headers.authorization);
          events = await tasks.events(ctx, taskId, after);
          if (events.length || Date.now() >= deadline || response.destroyed || closing) break;
          await delay(30);
        } while (true);
        if (!response.destroyed) send(response, 200, { data: { events, after: events.at(-1)?.seq ?? after } }); return;
      }
    }
    if (url.pathname.startsWith('/v1/admin/')) {
      const policy = await auth.check(ctx, 'admin.manage');
      if (url.pathname === '/v1/admin/tasks' && request.method === 'GET') {
        const rows = (await store.pool.query('SELECT task_id FROM tasks WHERE tenant_id=$1 AND scope_id=ANY($2::text[])', [policy.tenantId, policy.scopes])).rows;
        send(response, 200, { data: await Promise.all(rows.map(row => tasks.status(ctx, row.task_id))) }); return;
      }
    }
    throw new ApiError('TARGET_NOT_FOUND', 'API route not found');
  } catch (error) {
    const failure = error instanceof ApiError ? error : error instanceof z.ZodError ? new ApiError('INVALID_PAYLOAD', 'Payload does not satisfy the contract')
      : new ApiError('INTERNAL_ERROR', 'The transaction or server operation failed');
    if (!response.destroyed && !response.headersSent) send(response, failure.httpStatus, { error: { code: failure.code, category: failure.category,
      message: failure.message, details: failure.details, retryable: false } });
  }
});
server.requestTimeout = 10_000; server.headersTimeout = 10_000;
let running: Promise<void> | undefined;
const timer = setInterval(() => {
  if (running || closing) return;
  running = tasks.runOnce().catch(() => { console.error('Durable runner transaction failed; pending work remains in PostgreSQL'); }).finally(() => { running = undefined; });
}, Number(process.env.CIRCLE_SERVER_POLL_MS ?? 100));
await new Promise<void>(resolve => server.listen(Number(process.env.CIRCLE_SERVER_PORT ?? 8080), '127.0.0.1', resolve));
const address = server.address() as { port: number };
console.log(JSON.stringify({ type: 'ready', url: `http://127.0.0.1:${address.port}`, apiVersion: API_VERSION, syntheticOnly: true }));
async function shutdown(): Promise<void> {
  if (closing) return; closing = true; clearInterval(timer);
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
  await running; await store.pool.end();
}
process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
