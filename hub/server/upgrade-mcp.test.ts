// SDK transport replies through real loopback HTTP over synthetic ports, without PostgreSQL.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_LIMITS } from '../config/index.ts';
import type { CallLogInput } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { BodyBudget } from './http.ts';
import { handleMcp } from './mcp.ts';

const TOKEN = 'synthetic-protocol-token';
const UNSUPPORTED = '1900-01-01';
const LIST = { jsonrpc: '2.0', id: 'synthetic-call', method: 'tools/list', params: {} };
const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function endpoint(t: TestContext) {
  let reads = 0;
  const calls: CallLogInput[] = [];
  const deps = {
    config: { limits: DEFAULT_LIMITS },
    records: {
      principals: { authenticate: async (credential: string) => credential === `Bearer ${TOKEN}` ? { id: 'usr_' + '0'.repeat(26), name: '合成成员', role: 'user' } : null },
      callLog: { append: async (input: CallLogInput) => { calls.push(input); } },
    },
    workflows: { summaries: async () => { reads++; return []; } },
  } as unknown as ServerDeps;
  const server = createServer((req, res) => { void handleMcp(req, res, {
    deps, serverVersion: 'synthetic', budget: new BodyBudget(1024 * 1024), log: () => {},
  }, DEFAULT_LIMITS.maxRequestBytes).catch(error => { res.destroy(error); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const post = (body: unknown = LIST, headers: Record<string, string> = {}) => fetch(url, {
    method: 'POST', headers: { ...HEADERS, authorization: `Bearer ${TOKEN}`, ...headers }, body: JSON.stringify(body),
  });
  return { url, post, calls, reads: () => reads };
}

async function sdkReply(body: unknown, headers: Record<string, string> = {}) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    const reply = await transport.handleRequest(new Request('http://127.0.0.1/mcp', { method: 'POST', headers: { ...HEADERS, ...headers } }), { parsedBody: body });
    return { status: reply.status, body: await reply.json() };
  } finally { await transport.close(); }
}

test('an SDK-refused protocol header keeps its HTTP status, error code and id with an actionable explanation', async t => {
  const w = await endpoint(t);
  const headers = { 'mcp-protocol-version': UNSUPPORTED };
  const expected = await sdkReply(LIST, headers);
  const reply = await w.post(LIST, headers), body = await reply.json();
  assert.equal(reply.status, expected.status);
  assert.equal(body.error.code, expected.body.error.code);
  assert.equal(body.id, expected.body.id);
  assert.equal(body.jsonrpc, expected.body.jsonrpc);
  assert.match(body.error.message, /协议版本不匹配/);
  assert.match(body.error.message, /这次调用没有执行/);
  assert.match(body.error.message, /重新初始化/);
  assert.ok(body.error.message.includes(UNSUPPORTED));
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) assert.ok(body.error.message.includes(version));
  assert.equal(w.reads(), 0);
  assert.equal(w.calls.length, 1);
});

test('SDK initialization negotiation is unchanged even with an unsupported requested version and header', async t => {
  const w = await endpoint(t);
  const reply = await w.post({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {
    protocolVersion: UNSUPPORTED, capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1' },
  } }, { 'mcp-protocol-version': UNSUPPORTED });
  const body = await reply.json();
  assert.equal(reply.status, 200);
  assert.equal(body.id, 7);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(body.result.protocolVersion));
  assert.equal(body.error, undefined);
});

test('all installed SDK-supported protocol headers and an absent header still list six tools', async t => {
  const w = await endpoint(t);
  for (const version of [undefined, ...SUPPORTED_PROTOCOL_VERSIONS]) {
    const reply = await w.post(LIST, version === undefined ? {} : { 'mcp-protocol-version': version });
    assert.equal(reply.status, 200);
    assert.equal((await reply.json()).result.tools.length, 6);
  }
});

test('another SDK transport refusal is not relabeled as a protocol version error', async t => {
  const w = await endpoint(t);
  for (const [body, headers] of [
    [LIST, { accept: 'application/json', 'mcp-protocol-version': UNSUPPORTED }],
    [{ invalid: true }, { 'mcp-protocol-version': UNSUPPORTED }],
  ] as const) {
    const expected = await sdkReply(body, headers);
    const reply = await w.post(body, headers);
    assert.equal(reply.status, expected.status);
    assert.deepEqual(await reply.json(), expected.body);
  }
  assert.equal(w.reads(), 0);
});

test('bad authorization remains a neutral refusal before version checks', async t => {
  const w = await endpoint(t);
  const reply = await w.post(LIST, { authorization: 'Bearer synthetic-invalid', 'mcp-protocol-version': UNSUPPORTED });
  assert.equal(reply.status, 401);
  assert.doesNotMatch((await reply.json()).error.message, /协议版本不匹配/);
  assert.equal(w.reads(), 0);
});

test('an arbitrary unsupported header is never echoed as a credential or raw diagnostic', async t => {
  const w = await endpoint(t);
  const reply = await w.post(LIST, { 'mcp-protocol-version': TOKEN });
  assert.equal(reply.status, 400);
  const body = await reply.text();
  assert.match(body, /协议版本不匹配/);
  assert.ok(!body.includes(TOKEN));
  assert.ok(!JSON.stringify(w.calls).includes(TOKEN));
});

test('tools/list is HTTP private and non-storable without private result metadata', async t => {
  const w = await endpoint(t);
  const reply = await w.post();
  assert.equal(reply.headers.get('cache-control'), 'private, no-store');
  const body = await reply.json();
  assert.equal(body.result._meta, undefined);
  assert.equal(body.result.tools.length, 6);
});

test('the official SDK client can initialize and read the unchanged tools list', async t => {
  const w = await endpoint(t);
  const client = new Client({ name: 'synthetic-sdk-client', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(w.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  const result = await client.listTools();
  assert.equal(result.tools.length, 6);
  assert.equal(result._meta, undefined);
  assert.equal(client.getServerVersion()?.version, 'synthetic');
});
