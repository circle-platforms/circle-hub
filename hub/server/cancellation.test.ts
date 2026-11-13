import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ServerDeps } from './api.ts';
import { callTool, type ToolCall } from './tools.ts';

const principal = { id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a', name: '合成成员', role: 'user' as const };
function call(signal: AbortSignal): ToolCall {
  return { principal, context: { traceId: '1'.repeat(32), sessionId: null, signal, adminNote: () => {} }, state: { method: 'tools/call', tool: 'list_task_packs', args: {}, started: 0, runId: null, callResult: null, acceptance: null, errorCode: null, notes: [] } };
}
const cancelled = (error: unknown) => error instanceof McpError && error.code === ErrorCode.ConnectionClosed;

test('an already cancelled pack read never starts its provider', async () => {
  let reads = 0;
  const deps = { workflows: { summaries: async () => { reads++; return []; } } } as unknown as ServerDeps;
  await assert.rejects(callTool(deps, call(AbortSignal.abort()), 'list_task_packs', {}), cancelled);
  assert.equal(reads, 0);
});

test('cancellation during a pending pack read prevents the next context read', async () => {
  const controller = new AbortController();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<[]>();
  let contexts = 0;
  const deps = { workflows: { summaries: () => { started.resolve(); return finish.promise; } }, runs: { packContext: async () => { contexts++; return null; } } } as unknown as ServerDeps;
  const result = callTool(deps, call(controller.signal), 'list_task_packs', {});
  const rejected = assert.rejects(result, cancelled);
  await started.promise;
  controller.abort();
  finish.resolve([]);
  await rejected;
  assert.equal(contexts, 0);
});

test('an already cancelled reference read never starts its provider', async () => {
  let reads = 0;
  const deps = { runs: { resolveReference: async () => { reads++; throw new Error('unused'); } } } as unknown as ServerDeps;
  await assert.rejects(callTool(deps, call(AbortSignal.abort()), 'resolve_reference', { text: '合成原句' }), cancelled);
  assert.equal(reads, 0);
});

test('socket disconnect cancels a pending read before its next stage and still records the call', { timeout: 10_000 }, async t => {
  const { createServer, request } = await import('node:http');
  const { once } = await import('node:events');
  const { handleMcp } = await import('./mcp.ts');
  const { BodyBudget } = await import('./http.ts');
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<[]>();
  const closed = Promise.withResolvers<void>(), completed = Promise.withResolvers<void>();
  let contexts = 0;
  const logs: Array<{ callResult: string }> = [];
  const deps = {
    records: { principals: { authenticate: async () => principal }, callLog: { append: async (line: { callResult: string }) => { logs.push(line); } } },
    workflows: { summaries: () => { started.resolve(); return finish.promise; } },
    runs: { packContext: async () => { contexts++; return null; } },
  } as unknown as ServerDeps;
  const server = createServer((req, res) => {
    res.once('close', () => closed.resolve());
    void handleMcp(req, res, { deps, serverVersion: 'synthetic', budget: new BodyBudget(8192), log: () => {} }, 8192).then(completed.resolve, completed.reject);
  });
  t.after(async () => {
    finish.resolve([]);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const req = request({ hostname: '127.0.0.1', port: address.port, method: 'POST', headers: { authorization: 'Bearer synthetic-transport', 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } }));
  await started.promise;
  req.destroy();
  await closed.promise;
  finish.resolve([]);
  await completed.promise;
  assert.equal(contexts, 0);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].callResult, 'error');
});

test('cancellation notifications reach only the same authenticated token and client session across POSTs', { timeout: 10_000 }, async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { handleMcp } = await import('./mcp.ts');
  const { BodyBudget } = await import('./http.ts');
  for (const scope of [
    { token: 'synthetic-a', session: 'synthetic-session-a', cancels: true },
    { token: 'synthetic-b', session: 'synthetic-session-a', cancels: false },
    { token: 'synthetic-a', session: 'synthetic-session-b', cancels: false },
  ]) await t.test(scope.token + '/' + scope.session, async () => {
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<[]>();
    let contexts = 0;
    const deps = {
      records: { principals: { authenticate: async () => principal }, callLog: { append: async () => {} } },
      workflows: { summaries: () => { started.resolve(); return finish.promise; } },
      runs: { packContext: async () => { contexts++; return null; } },
    } as unknown as ServerDeps;
    const server = createServer((req, res) => { void handleMcp(req, res, { deps, serverVersion: 'synthetic', budget: new BodyBudget(8192), log: () => {} }, 8192).catch(() => res.destroy()); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const post = (body: unknown, token: string, session: string) => fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'circle-session-id': session, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
    try {
      const answer = post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_task_packs', arguments: {} } }, 'synthetic-a', 'synthetic-session-a');
      await started.promise;
      const notice = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }, scope.token, scope.session);
      assert.equal(notice.status, 202);
      await notice.text();
      finish.resolve([]);
      const response = await answer;
      const result = await response.json() as { error?: { code: number } };
      assert.equal(contexts, scope.cancels ? 0 : 1);
      assert.equal(result.error?.code, scope.cancels ? ErrorCode.ConnectionClosed : undefined);
    } finally {
      finish.resolve([]);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
