import { TOOLS } from '../../contracts/src/tools.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ServerDeps } from './api.ts';
import { callTool, errorAnswer, type ToolCall } from './tools.ts';

const run = 'run_0123456789abcdefghjkmnpqrs';
function call(): ToolCall {
  return { principal: { id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0a', name: '合成成员', role: 'user' }, context: { traceId: '1'.repeat(32), sessionId: null, adminNote: () => {} }, state: { method: 'tools/call', tool: 'resolve_reference', args: {}, started: 0, runId: null, callResult: null, acceptance: null, errorCode: null, notes: [] } };
}
function deps(answer: unknown): ServerDeps {
  return { runs: { resolveReference: async () => answer, getRun: async () => null }, knowledge: {} } as unknown as ServerDeps;
}

test('server validation preserves top-level and nested output extensions in structured content and model references', async () => {
  const answer = { call_result: 'ok', errors: [], resolution: 'resolved', references: [{ reference: 'src:' + 'a'.repeat(64), text: '合成原句', extension: { provenance: ['synthetic'] } }], diagnostics: [], extension: { source: 'synthetic' } };
  const result = await callTool(deps(answer), call(), 'resolve_reference', { run, text: '合成原句' });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { ...answer, trace: '1'.repeat(32) });
  const references = JSON.parse(result.content[1].text.slice('供模型引用\n'.length));
  assert.deepEqual(references, result.structuredContent);
});

test('output extensions do not bypass known field validation', async () => {
  const answer = { call_result: 'ok', errors: [], resolution: 'resolved', references: 'invalid', diagnostics: [], extension: true };
  await assert.rejects(callTool(deps(answer), call(), 'resolve_reference', { run, text: '合成原句' }), error => error instanceof McpError && error.code === ErrorCode.InternalError);
});


test('registered handler error envelopes satisfy every published tool output boundary', () => {
  for (const tool of TOOLS) {
    const answer = { ...errorAnswer(tool.name, [{ code: 'SOURCE_UNAVAILABLE', message: '合成资料不可用', fix: '提供合成资料' }]), trace: '1'.repeat(32) };
    assert.ok(tool.output.safeParse(answer).success, tool.name);
  }
});
