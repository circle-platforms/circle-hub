// Unconnected request/response streams only: no listener, database, HTTP server or service is constructed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { once } from 'node:events';
import { HttpCallErrorData, HttpErrorEnvelope } from '../../contracts/api.ts';
import { callErrorCategory } from '../../contracts/generated/protocol.ts';
import { BodyBudget, httpCallErrorData, sendHttpError, sendRpcError } from './http.ts';
import { parseTarget, sendMachineCallError } from './app.ts';
import { handleMcp, sdkCallErrorData } from './mcp.ts';
import { handleRunExport } from './run-export.ts';
import type { ServerDeps } from './api.ts';

class CaptureSocket extends Socket {
  readonly chunks: Buffer[] = [];
  override _write(chunk: Uint8Array, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
  override _writev(chunks: Array<{chunk: Uint8Array; encoding: BufferEncoding}>, done: (error?: Error | null) => void): void {
    for (const {chunk, encoding} of chunks) this._write(chunk, encoding, () => {});
    done();
  }
}

function exchange(method: string, url: string, body = '', headers: Record<string, string> = {}) {
  const request = new IncomingMessage(new Socket());
  request.method = method; request.url = url; request.headers = { host: 'localhost', ...headers };
  const response = new ServerResponse(request);
  const wire = new CaptureSocket();
  response.assignSocket(wire);
  const finished = once(response, 'finish');
  request.push(Buffer.from(body)); request.push(null);
  return { request, response, async read() {
    await finished;
    const serialized = Buffer.concat(wire.chunks);
    const boundary = serialized.indexOf('\r\n\r\n');
    const payload = serialized.subarray(boundary + 4);
    request.destroy(); wire.destroy();
    return { status: response.statusCode, headers: response.getHeaders(), bytes: payload, json: () => JSON.parse(payload.toString('utf8')) };
  } };
}
const TOKEN = 's'.repeat(43);
const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const sourceBytes = Buffer.from('synthetic exact bytes\n');
import { createHash } from 'node:crypto';
const SHA = createHash('sha256').update(sourceBytes).digest('hex');
function deps(mode: 'absent' | 'ready' | 'not_ready' | 'withheld' | 'broken' = 'absent', authenticated = true): ServerDeps {
  return {
    records: {
      principals: { authenticate: async () => authenticated ? { id: 'synthetic-user', role: 'user' } : null },
      artifacts: { sourceForRun: async () => ({ bytes: mode === 'withheld' ? null : sourceBytes }) },
      callLog: { append: async () => {} },
    },
    runs: { exportRun: async () => {
      if (mode === 'broken') throw new Error('PRIVATE storage error');
      return mode === 'absent' ? null : { run: { run: RUN }, run_reference: `rec:${'a'.repeat(64)}`, accepted_result_reference: `rec:${'b'.repeat(64)}`, result: mode === 'not_ready' ? null : { acceptance: 'accepted' }, submission: {} };
    } },
  } as unknown as ServerDeps;
}

test('RPC error keeps numeric code, fifth headers and exact optional sixth data without guessing non-execution', async () => {
  const x = exchange('POST', '/mcp');
  const data = httpCallErrorData('CALL_BUSY', true);
  sendRpcError(x.response, 503, -32000, 'synthetic', { 'retry-after': '5' }, data);
  const reply = await x.read();
  assert.equal(reply.headers['retry-after'], '5');
  assert.equal(reply.json().error.code, -32000);
  assert.deepEqual(HttpCallErrorData.parse(reply.json().error.data), data);
  assert.equal(reply.json().error.data.call_error_category, callErrorCategory('CALL_BUSY'));
  const original = exchange('POST', '/mcp');
  sendRpcError(original.response, 503, -32000, '没有执行', { 'retry-after': '5' });
  assert.equal(Object.hasOwn((await original.read()).json().error, 'data'), false);
  const unknown = exchange('GET', '/run-export/unknown');
  sendHttpError(unknown.response, 500, '没有执行', httpCallErrorData('CALL_INTERNAL_UNAVAILABLE'));
  assert.equal(Object.hasOwn(HttpErrorEnvelope.parse((await unknown.read()).json()).error, 'call_not_executed'), false);
});

test('app boundary routing covers raw encoded and absolute export targets and leaves ordinary endpoints untouched', async () => {
  for (const url of ['/run-export/%broken', 'http://localhost/run-export/%broken', '/run-export\\bad']) {
    for (const [status, code] of [[403, 'CALL_ORIGIN_REFUSED'], [400, 'CALL_REQUEST_INVALID'], [503, 'CALL_BUSY']] as const) {
      const x = exchange('GET', url);
      assert.equal(sendMachineCallError(x.request, x.response, parseTarget(url), status, -32000, 'synthetic refusal', httpCallErrorData(code, true), { 'retry-after': '5' }), true);
      const reply = await x.read(), error = HttpErrorEnvelope.parse(reply.json()).error;
      assert.equal(reply.status, status); assert.equal(error.code, code); assert.equal(error.call_not_executed, true);
      if (status === 503) assert.equal(reply.headers['retry-after'], '5');
    }
  }
  const ordinary = exchange('GET', '/healthz');
  assert.equal(sendMachineCallError(ordinary.request, ordinary.response, parseTarget('/healthz'), 503, -32000, 'synthetic', httpCallErrorData('CALL_BUSY', true)), false);
  assert.equal(ordinary.response.headersSent, false);
  ordinary.request.destroy(); ordinary.response.destroy();
});

test('MCP source refusals carry registered codes and proven non-entry with no listener or business dependency', async () => {
  const cases = [
    { method: 'POST', auth: false, code: 'CALL_AUTHENTICATION_REQUIRED', numeric: -32001, body: '{}' },
    { method: 'GET', code: 'CALL_METHOD_UNSUPPORTED', numeric: -32000, body: '' },
    { method: 'POST', contentType: 'text/plain', code: 'CALL_MEDIA_TYPE_UNSUPPORTED', numeric: -32000, body: '{}' },
    { method: 'POST', code: 'CALL_REQUEST_INVALID', numeric: -32700, body: '{' },
    { method: 'POST', code: 'CALL_REQUEST_INVALID', numeric: -32600, body: '[]' },
    { method: 'POST', code: 'CALL_REQUEST_INVALID', numeric: -32602, body: JSON.stringify({secret: TOKEN}) },
    { method: 'POST', code: 'CALL_BUSY', numeric: -32000, body: '{}', capacity: 1, length: '2' },
    { method: 'POST', code: 'CALL_REQUEST_INVALID', numeric: -32000, body: '{}', length: '9999' },
  ];
  for (const c of cases) {
    const x = exchange(c.method, '/mcp', c.body, { 'content-type': c.contentType ?? 'application/json', authorization: `Bearer ${TOKEN}`, ...(c.length ? { 'content-length': c.length } : {}) });
    await handleMcp(x.request, x.response, { deps: deps('absent', c.auth !== false), serverVersion: 'synthetic', log() {}, budget: new BodyBudget(c.capacity ?? 1024) }, 128);
    const reply = await x.read(), error = reply.json().error;
    assert.equal(error.code, c.numeric);
    assert.equal(HttpCallErrorData.parse(error.data).code, c.code);
    assert.equal(error.data.call_not_executed, true);
    if (c.code === 'CALL_BUSY') assert.equal(reply.headers['retry-after'], '5');
    assert.equal(JSON.stringify(error).includes(TOKEN), false);
  }
});

test('run-export errors keep absence private and distinguish known withheld, unmet prerequisite and unknown internal failure', async () => {
  for (const [mode, status, code] of [
    ['absent', 404, 'SOURCE_UNAVAILABLE'], ['withheld', 403, 'SOURCE_NOT_PERMITTED'],
    ['not_ready', 409, 'RUN_EXPORT_NOT_READY'], ['broken', 500, 'CALL_INTERNAL_UNAVAILABLE'],
  ] as const) {
    const path = `/run-export/${RUN}${mode === 'withheld' ? `/sources/${SHA}` : ''}`;
    const x = exchange('GET', path);
    await handleRunExport(x.request, x.response, deps(mode), () => {});
    const reply = await x.read(), error = HttpErrorEnvelope.parse(reply.json()).error;
    assert.equal(reply.status, status); assert.equal(error.code, code);
    assert.equal(Object.hasOwn(error, 'call_not_executed'), false);
    if (mode === 'absent') assert.equal(error.call_error_category, null);
    assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
  }
});

test('run-export authentication and method refusals are structured while successful source bytes and HEAD stay unchanged', async () => {
  for (const [method, auth, code] of [['GET', false, 'CALL_AUTHENTICATION_REQUIRED'], ['POST', true, 'CALL_METHOD_UNSUPPORTED']] as const) {
    const x = exchange(method, `/run-export/${RUN}`);
    await handleRunExport(x.request, x.response, deps('ready', auth), () => {});
    assert.equal(HttpErrorEnvelope.parse((await x.read()).json()).error.code, code);
  }
  for (const method of ['GET', 'HEAD']) {
    const x = exchange(method, `/run-export/${RUN}/sources/${SHA}`);
    await handleRunExport(x.request, x.response, deps('ready'), () => {});
    const reply = await x.read(); assert.equal(reply.status, 200);
    assert.deepEqual(reply.bytes, method === 'HEAD' ? Buffer.alloc(0) : sourceBytes);
    assert.equal(Number(reply.headers['content-length']), sourceBytes.length);
  }
});

test('SDK pre-handler refusal and a thrown business dependency have distinct effect evidence without status guessing', async () => {
  const body = JSON.stringify({jsonrpc: '2.0', id: 7, method: 'tools/list'});
  const refused = exchange('POST', '/mcp', body, { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '1900-01-01' });
  await handleMcp(refused.request, refused.response, { deps: deps(), serverVersion: 'synthetic', log() {}, budget: new BodyBudget(1024) }, 1024);
  const refusal = (await refused.read()).json().error;
  assert.equal(refusal.code, -32000);
  assert.equal(HttpCallErrorData.parse(refusal.data).code, 'CALL_REQUEST_INVALID');
  assert.equal(refusal.data.call_not_executed, true);

  let entered = 0;
  const enteredDeps = { ...deps(), workflows: { summaries: async () => { entered++; throw new Error('PRIVATE business failure'); } } } as unknown as ServerDeps;
  const failed = exchange('POST', '/mcp', body, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
  await handleMcp(failed.request, failed.response, { deps: enteredDeps, serverVersion: 'synthetic', log() {}, budget: new BodyBudget(1024) }, 1024);
  const error = (await failed.read()).json().error;
  assert.equal(entered, 1);
  assert.equal(error.code, -32603);
  assert.equal(HttpCallErrorData.parse(error.data).code, 'CALL_INTERNAL_UNAVAILABLE');
  assert.equal(Object.hasOwn(error.data, 'call_not_executed'), false);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE business failure/);
  assert.match(error.data.trace,/^[a-f0-9]{32}$/,'retain the existing machine-readable trace instead of moving it only into prose');
  assert.ok(error.message.includes(error.data.trace));
});

import { McpError } from '@modelcontextprotocol/sdk/types.js';

test('actual SDK malformed tool parameters stay unknown when its schema layer returns internal error; entered invalid-params never implies non-entry', async () => {
  let businessCalls = 0;
  const counted = { ...deps(), runs: { submitResult: async () => { businessCalls++; throw new Error('must not run'); } } } as unknown as ServerDeps;
  const body = JSON.stringify({jsonrpc: '2.0', id: 8, method: 'tools/call', params: {name: 42, arguments: {}}});
  const refused = exchange('POST', '/mcp', body, { 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
  await handleMcp(refused.request, refused.response, { deps: counted, serverVersion: 'synthetic', log() {}, budget: new BodyBudget(1024) }, 1024);
  const refusal = (await refused.read()).json().error;
  assert.equal(refusal.code, -32603, 'this installed SDK converts its earlier schema parse failure to internal error');
  assert.equal(businessCalls, 0);
  assert.equal(HttpCallErrorData.parse(refusal.data).code, 'CALL_INTERNAL_UNAVAILABLE');
  assert.equal(Object.hasOwn(refusal.data, 'call_not_executed'), false);

  const entered = { ...deps(), workflows: { summaries: async () => { businessCalls++; throw new McpError(-32602, 'synthetic parameter failure after entry'); } } } as unknown as ServerDeps;
  const failed = exchange('POST', '/mcp', JSON.stringify({jsonrpc: '2.0', id: 9, method: 'tools/list'}), { 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
  await handleMcp(failed.request, failed.response, { deps: entered, serverVersion: 'synthetic', log() {}, budget: new BodyBudget(1024) }, 1024);
  const error = (await failed.read()).json().error;
  assert.equal(error.code, -32602);
  assert.equal(businessCalls, 1);
  assert.equal(Object.hasOwn(HttpCallErrorData.parse(error.data), 'call_not_executed'), false);
});


test('exact SDK invalid-params code proves a refused call only with a source witness that no business guard entered', () => {
  const sdkError = new McpError(-32602, 'arbitrary prose is not a classification source');
  assert.deepEqual(sdkCallErrorData(sdkError.code, false), httpCallErrorData('CALL_REQUEST_INVALID', true));
  assert.deepEqual(sdkCallErrorData(sdkError.code, true), httpCallErrorData('CALL_INTERNAL_UNAVAILABLE'));
  assert.deepEqual(sdkCallErrorData(-32603, false), httpCallErrorData('CALL_INTERNAL_UNAVAILABLE'));
});

test('the locked SDK malformed RPC envelope is a confirmed pre-handler parse refusal', async () => {
  let entered = 0;
  const guardedDeps = { ...deps(), workflows: { summaries: async () => { entered++; return []; } } } as unknown as ServerDeps;
  const x = exchange('POST', '/mcp', '{}', {
    'content-type':'application/json',accept:'application/json, text/event-stream',
  });
  await handleMcp(x.request,x.response,{deps:guardedDeps,serverVersion:'synthetic',log() {},budget:new BodyBudget(1024)},1024);
  const reply=await x.read(), error=reply.json().error;
  assert.equal(entered,0);
  assert.equal(reply.status,400);
  assert.equal(error.code,-32700,'retain the locked SDK numeric parse-error code');
  assert.equal(HttpCallErrorData.parse(error.data).code,'CALL_REQUEST_INVALID');
  assert.equal(error.data.call_error_category,'invalid_parameters');
  assert.equal(error.data.call_not_executed,true);
});
