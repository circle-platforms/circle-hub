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
