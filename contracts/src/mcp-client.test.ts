// (i) What a standard MCP client does with the published tools: a low-level SDK server lists exactly tools.json and answers
// with the error shapes the Hub sends; the SDK Client checks each structuredContent against the listed outputSchema, also
// when isError is true. Before the fix the neutral submit_result answer made callTool throw.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { accepted, acceptedCounts, notAccepted, TRACE, unavailable } from './fixtures.ts';

const tools = JSON.parse(readFileSync(new URL('../generated/tools.json', import.meta.url), 'utf8')) as { name: string }[];
const malformedRun = { code: 'SUBMISSION_SCHEMA_VIOLATION', message: '提交结构或条目投影违规', fix: '按槽位模式改正后重交', path: '/run' };
const failed = (error: object) => ({ call_result: 'error', errors: [error], trace: TRACE });

/** The answers the fake Hub gives, by tool name and a case argument. */
const ANSWERS: Record<string, Record<string, { isError: boolean; structuredContent: Record<string, unknown> }>> = {
  submit_result: {
    unavailable: { isError: true, structuredContent: { ...failed(unavailable), acceptance: 'not_accepted' } },
    malformed: { isError: true, structuredContent: { ...failed(malformedRun), acceptance: 'not_accepted' } },
    refused: { isError: true, structuredContent: { ...failed(notAccepted.errors[0]), acceptance: 'not_accepted', result: notAccepted } },
    accepted: { isError: false, structuredContent: { call_result: 'ok', errors: [], trace: TRACE, acceptance: 'accepted', result: accepted, counts: acceptedCounts() } },
    invented: { isError: true, structuredContent: { ...failed(unavailable), acceptance: 'not_accepted', result: { ...notAccepted, run: 'run_123' } } },
  },
  resolve_reference: { unavailable: { isError: true, structuredContent: { ...failed(unavailable), references: [], diagnostics: [] } } },
  start_run: { unavailable: { isError: true, structuredContent: failed(unavailable) } },
  get_nodes: { unavailable: { isError: true, structuredContent: failed(unavailable) } },
  upload_file: { unavailable: { isError: true, structuredContent: { ...failed(unavailable), acceptance: 'not_accepted' } } },
  list_task_packs: { unavailable: { isError: true, structuredContent: { ...failed(unavailable), packs: [] } } },
};

let client: Client;
let server: Server;

before(async () => {
  server = new Server({ name: 'contracts-fake-hub', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as never }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const answer = ANSWERS[request.params.name][String(request.params.arguments?.case)];
    return { content: [{ type: 'text', text: JSON.stringify(answer.structuredContent) }], ...answer };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'contracts-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 6);
});
after(async () => {
  await client.close();
  await server.close();
});

test('the neutral answer of every tool passes the client check (D05 R[3])', async () => {
  for (const name of Object.keys(ANSWERS)) {
    const result = await client.callTool({ name, arguments: { case: 'unavailable' } });
    assert.equal(result.isError, true, name);
  }
});

test('submit_result: a malformed run id, a refused and an accepted submission reach the model', async () => {
  for (const which of ['malformed', 'refused', 'accepted']) {
    const result = await client.callTool({ name: 'submit_result', arguments: { case: which } });
    assert.equal(result.isError, which !== 'accepted', which);
  }
});

test('an answer that invents a run id still fails the client check, as it should', async () => {
  await assert.rejects(client.callTool({ name: 'submit_result', arguments: { case: 'invented' } }), /Structured content does not match the tool's output schema/);
});
