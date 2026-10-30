// POST /mcp: the streamable HTTP transport of the official SDK in stateless JSON mode, one Server and one JSON-RPC request per
// HTTP request. Batches are refused (MCP 2025-06-18 removed them; in a batch, requests sharing an id or a cancellation of a
// sibling would run calls the call log never sees). The bearer token is checked on every request (a revoked token or a
// disabled account stops at once); the body is bounded per request and over all requests. Every request of an authenticated
// caller gets one call-log line (B08), refusals at the transport included, after its answer is ready and before it is sent.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_INSTRUCTIONS } from '../../contracts/src/tools.ts';
import type { CallLogInput, Principal } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { mediaTypeOf, readBody, sendRpcError, setCommonHeaders, type BodyBudget } from './http.ts';
import { clipNote, describeError, describeInternalError } from './notes.ts';
import { newTraceId, sessionIdOf, traceIdFrom } from './trace.ts';
import { callTool, internalError, listTools, type CallState, type ToolCall } from './tools.ts';
import { headersHold, holdsToken, tokenRuns } from './token-echo.ts';

export interface McpOptions {
  deps: ServerDeps;
  serverVersion: string;
  log: (line: string) => void;
  /** Request body bytes held at once over all requests (the app's budget). */
  budget: BodyBudget;
}

/** Same body for missing, unknown, revoked and disabled tokens. */
const UNAUTHENTICATED = '需要有效的 Bearer 令牌';
const TOKEN_IN_REQUEST = 'Invalid params: 请求里含调用方当前的 Hub 令牌或它的片段，整份请求没有处理，也没有保存；删去这段文字后重发';
const TOKEN_IN_HEADERS = 'Invalid Request: 请求头、方法或请求目标里含调用方当前的 Hub 令牌或它的片段，整份请求没有处理，也没有保存；改正后重发';
const BATCH_REFUSED = 'Invalid Request: 不接受 JSON-RPC 批量请求（MCP 2025-06-18 起没有批量）；每个请求单独用一次 POST 发送';
const LOGGED_TOOL = /^[A-Za-z0-9_./:-]{1,100}$/;
const LOGGED_CODE = /^[A-Za-z0-9_.:-]{1,100}$/;
const LOGGED_RUN = /^run_[0-9a-z]{26}$/;
/** Requests of a refused batch that get a line each (the SDK's own batch cap); the rest share one line. */
const LOGGED_BATCH = 100;
/** RFC 8259: JSON exchanged between systems is UTF-8; anything else is refused, never silently replaced with U+FFFD. */
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; error?: unknown; result?: unknown };
type JsonRpcRequest = JsonRpcMessage & { method: string; id: string | number };

const idKey = (id: unknown): string => `${typeof id}:${String(id)}`;
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function isRequest(message: unknown): message is JsonRpcRequest {
  const m = message as JsonRpcMessage | null;
  return typeof m === 'object' && m !== null && typeof m.method === 'string' && (typeof m.id === 'string' || typeof m.id === 'number');
}

/** What one request contributes to its call-log line, from the server's own parse of the body. */
function stateOf(message: JsonRpcRequest, started: number): CallState {
  const params = isPlainObject(message.params) ? message.params : {};
  const isCall = message.method === 'tools/call';
  const args = isCall ? (params.arguments ?? null) : (message.params ?? null);
  const run = isPlainObject(args) ? args.run : undefined;
  return {
    method: message.method,
    tool: isCall && typeof params.name === 'string' ? params.name : message.method,
    args,
    started,
    runId: typeof run === 'string' && LOGGED_RUN.test(run) ? run : null,
    callResult: null,
    acceptance: null,
    errorCode: null,
    notes: [],
  };
}

/** A line for a refusal no request of the body can carry: tool `mcp`, no arguments. */
function transportState(reason: string, started: number): CallState {
  return { method: 'mcp', tool: 'mcp', args: null, started, runId: null, callResult: 'transport_failure', acceptance: null, errorCode: null, notes: [reason] };
}

/** One line per request of a refused batch (at most LOGGED_BATCH), or one line when it has none. */
function batchStates(messages: readonly unknown[], started: number): CallState[] {
  const requests = messages.filter(isRequest);
  const out = requests.slice(0, LOGGED_BATCH).map((message, index) => {
    const state = stateOf(message, started);
    state.callResult = 'transport_failure';
    state.notes.push(`JSON-RPC batch refused (request ${index + 1} of ${requests.length}, ${messages.length} messages): one request per POST`);
    return state;
  });
  if (out.length === 0) out.push(transportState(`JSON-RPC batch of ${messages.length} messages refused (no request in it)`, started));
  else if (requests.length > LOGGED_BATCH) out.push(transportState(`JSON-RPC batch refused: ${requests.length - LOGGED_BATCH} more requests not logged one by one`, started));
  return out;
}

/**
 * The call-log lines of a request refused for holding the caller's token: what can be logged without it, a line per request
 * of a batch. Arguments are logged only as their digest and size; a method, tool or run id holding the token is not logged.
 */
function refusedStates(runs: RegExp, parsed: unknown, reason: string, started: number): CallState[] {
  const states = Array.isArray(parsed) ? batchStates(parsed, started) : isRequest(parsed) ? [stateOf(parsed, started)] : [transportState(reason, started)];
  return states.map(state => ({
    ...state,
    method: runs.test(state.method) ? 'mcp' : state.method,
    tool: runs.test(state.tool) ? 'mcp' : state.tool,
    runId: state.runId !== null && runs.test(state.runId) ? null : state.runId,
    callResult: 'transport_failure',
    notes: state.notes.includes(reason) ? state.notes : [...state.notes, reason],
  }));
}

/** The id of a single request, answered back unless it holds the token; a batch or an unsafe id gets null. */
function safeId(runs: RegExp, parsed: unknown): string | number | null {
  if (!isRequest(parsed)) return null;
  return typeof parsed.id === 'number' || !runs.test(parsed.id) ? parsed.id : null;
}

/** The message of the transport's JSON-RPC error, for the admin note. */
function transportDetail(text: string): string {
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    return typeof message === 'string' ? `: ${clipNote(message, 300)}` : '';
  } catch {
    return '';
  }
}

/** Credentials stay here: the transport and the handlers never see the token or a cookie. */
const NOT_FORWARDED = new Set(['authorization', 'cookie', 'proxy-authorization']);

function headersOf(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || NOT_FORWARDED.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/**
 * Writes one call-log line; a failure to write is reported to the operator and never changes the answer. A note records
 * refuses never costs the line: it is written once more without the note, and the operator's log says so.
 */
async function logCall(options: McpOptions, principal: Principal, traceId: string, sessionId: string | null, state: CallState): Promise<void> {
  const tool = LOGGED_TOOL.test(state.tool) ? state.tool : state.method === 'tools/call' ? 'tools/call' : 'mcp';
  const errorCode = state.errorCode !== null && LOGGED_CODE.test(state.errorCode) ? state.errorCode : null;
  const note=state.notes.length===0?null:`管理员理由 ${state.notes.length} 条；详见管理员调用日志详情`;
  const input: CallLogInput = {
    ...(options.deps.now ? { at: options.deps.now() } : {}),
    traceId,
    userId: principal.id,
    sessionId,
    tool,
    runId: state.runId !== null && LOGGED_RUN.test(state.runId) ? state.runId : null,
    arguments: state.args,
    callResult: state.callResult ?? 'error',
    acceptance: state.acceptance,
    errorCode,
    durationMs: Math.max(0, performance.now() - state.started),
    adminNote: note,
    adminReasons:[...state.notes],
  };
  try {
    await options.deps.records.callLog.append(input);
    return;
  } catch (error) {
    if (!(error instanceof TypeError) || input.adminNote === null) {
      options.log(`调用日志写入失败（追踪 ${traceId}，工具 ${tool}）：${describeError(error)}`);
      return;
    }
    try {
      await options.deps.records.callLog.append({ ...input, adminNote: null });
      options.log(`调用日志的管理员备注没有被接受（追踪 ${traceId}，工具 ${tool}）：${describeError(error)}；这一行已不带备注写入`);
    } catch (second) {
      options.log(`调用日志写入失败（追踪 ${traceId}，工具 ${tool}）：${describeError(second)}`);
    }
  }
}

export async function handleMcp(request: IncomingMessage, response: ServerResponse, options: McpOptions, limit: number): Promise<void> {
  const started = performance.now();
  const { deps } = options;
  const authorization = request.headers.authorization;
  const principal = await deps.records.principals.authenticate(typeof authorization === 'string' ? authorization : null);
  if (principal === null) {
    request.resume();
    sendRpcError(response, 401, -32001, UNAUTHENTICATED, { 'www-authenticate': 'Bearer realm="circle-hub"', connection: 'close' });
    return;
  }
  // The caller's own token anywhere in the request refuses all of it before it is handled or stored (issue #105). A header,
  // the method or the target that holds it is refused before any of them reaches a log: that line keeps no session id and
  // a trace id of the Hub's own.
  const runs = tokenRuns(authorization);
  const headerHolds = runs !== null && headersHold(runs, request);
  const traceId = (headerHolds ? null : traceIdFrom(request.headers.traceparent)) ?? newTraceId();
  const sessionId = headerHolds ? null : sessionIdOf(request.headers['circle-session-id']);
  /** A refusal before any handler ran: its call-log lines (one transport_failure line by default), then the JSON-RPC error. */
  const refuse = async (status: number, code: number, message: string, reason: string, headers: Record<string, string> = {}, states?: CallState[], id: string | number | null = null): Promise<void> => {
    for (const state of states ?? [transportState(reason, started)]) await logCall(options, principal, traceId, sessionId, state);
    sendRpcError(response, status, code, message, headers, id);
  };
  if (headerHolds) {
    request.resume();
    return refuse(400, -32600, TOKEN_IN_HEADERS, "a request header, the method or the target held the caller's own Hub token or a 12-character run of it; nothing in the request was handled or stored", { connection: 'close' });
  }

  if (request.method !== 'POST') {
    request.resume();
    const message = '只接受 POST：这个服务器是无状态的 JSON 模式，没有 SSE 流';
    // A GET is the streamable HTTP client's probe for the optional server stream; the specification prescribes 405 for a
    // server without one, so it is the expected answer to every session, not a failed call, and gets no line.
    if (request.method === 'GET') return sendRpcError(response, 405, -32000, message, { allow: 'POST' });
    return refuse(405, -32000, message, `HTTP method ${clipNote(request.method, 20)} is not served (stateless JSON mode, no SSE stream)`, { allow: 'POST' });
  }
  if (mediaTypeOf(request) !== 'application/json') {
    request.resume();
    return refuse(415, -32000, 'Content-Type 必须是 application/json', `media type ${clipNote(mediaTypeOf(request) || '(none)', 100)} is not application/json`);
  }
  const hold = options.budget.hold();
  try {
    const body = await readBody(request, limit, hold);
    if (!body.ok) {
      if (body.reason === 'too_large') return await refuse(413, -32000, `请求体超过上限 ${limit} 字节，没有读取`, `request body over ${limit} bytes`, { connection: 'close' });
      if (body.reason === 'busy') {
        return await refuse(503, -32000, 'Hub 正忙：同时在处理的请求体已到上限，请稍后重试', `request bodies in flight reached the budget of ${options.budget.capacity} bytes`, { 'retry-after': '5', connection: 'close' });
      }
      // The client went away before its body was complete: nobody is left to answer.
      await logCall(options, principal, traceId, sessionId, transportState('the request body was not received completely (aborted)', started));
      response.destroy();
      return;
    }
    let text: string;
    try {
      text = UTF8.decode(body.bytes);
    } catch {
      return await refuse(400, -32700, 'Parse error: 请求体不是 UTF-8 编码的 JSON', 'request body is not UTF-8');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return await refuse(400, -32700, 'Parse error: 请求体不是 JSON', 'request body is not JSON');
    }
    if (runs !== null && holdsToken(runs, text, parsed)) {
      const reason = "the request held the caller's own Hub token or a 12-character run of it; nothing in it was handled or stored";
      return await refuse(400, -32602, TOKEN_IN_REQUEST, reason, {}, refusedStates(runs, parsed, reason, started), safeId(runs, parsed));
    }
    if (Array.isArray(parsed)) return await refuse(400, -32600, BATCH_REFUSED, 'JSON-RPC batch refused', {}, batchStates(parsed, started));
    await answer(request, response, options, principal, traceId, sessionId, parsed, started);
  } finally {
    hold.release();
  }
}

/** Hands the one JSON-RPC message to the SDK transport, logs its line and sends the transport's answer. */
async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  options: McpOptions,
  principal: Principal,
  traceId: string,
  sessionId: string | null,
  parsed: unknown,
  started: number,
): Promise<void> {
  const { deps } = options;
  const own = isRequest(parsed) ? { key: idKey(parsed.id), state: stateOf(parsed, started) } : null;
  const states: CallState[] = own === null ? [] : [own.state];
  const stateFor = (requestId: string | number): CallState => {
    if (own !== null && own.key === idKey(requestId)) return own.state;
    // A request the body scan did not see (cannot happen with one message per body): logged under `mcp`.
    const created: CallState = { method: 'mcp', tool: 'mcp', args: null, started, runId: null, callResult: null, acceptance: null, errorCode: null, notes: [] };
    states.push(created);
    return created;
  };

  const server = new Server(
    { name: 'circle-hub', version: options.serverVersion },
    { capabilities: { tools: { listChanged: false } }, instructions: SERVER_INSTRUCTIONS },
  );
  const noteOn = (state: CallState) => (reason: string) => {
    if (typeof reason !== 'string' || reason.length === 0) return;
    const clean=reason.replaceAll('\0','').toWellFormed();
    if(clean.length>0)state.notes.push(clean);
  };
  /** Anything but an McpError becomes an internal error: its message is for the admin note, never for the caller. */
  const guarded = async <T>(state: CallState, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      state.callResult = 'error';
      if (error instanceof McpError) throw error;
      state.notes.push(describeInternalError(error));
      throw internalError(traceId);
    }
  };
  server.setRequestHandler(ListToolsRequestSchema, async (_message, extra) => {
    const state = stateFor(extra.requestId);
    return guarded(state, async () => ({ tools: await listTools(deps, principal, noteOn(state)) }));
  });
  server.setRequestHandler(CallToolRequestSchema, async (message, extra) => {
    const state = stateFor(extra.requestId);
    const call: ToolCall = { principal, state, context: { traceId, sessionId, adminNote: noteOn(state) } };
    // The arguments as received (the server's own parse), not the SDK's validated copy: its record schema drops members
    // such as `__proto__`, and submit_result must reach the runs service exactly as sent (W07).
    const args = isPlainObject(state.args) ? state.args : message.params.arguments;
    return guarded(state, () => callTool(deps, call, message.params.name, args));
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    // The Host header passed the allow-list already; the path is always /mcp (an absolute-form target is not reused).
    const host = typeof request.headers.host === 'string' ? request.headers.host : '127.0.0.1';
    const webRequest = new Request(`http://${host}/mcp`, { method: 'POST', headers: headersOf(request) });
    const reply = await transport.handleRequest(webRequest, { parsedBody: parsed });
    const text = await reply.text();
    if (reply.status >= 400) {
      // The transport refused the message before any handler ran (a missing Accept, a malformed message, a protocol version).
      const reason = `the transport answered HTTP ${reply.status}${transportDetail(text)}`;
      if (states.length === 0) states.push(transportState(reason, started));
      for (const state of states) {
        state.callResult ??= 'transport_failure';
        state.notes.push(reason);
      }
    } else if (states.length > 0) {
      try {
        const replies = text.length === 0 ? [] : (JSON.parse(text) as unknown);
        for (const item of Array.isArray(replies) ? replies : [replies]) {
          const r = item as JsonRpcMessage;
          if (own === null || idKey(r?.id) !== own.key) continue;
          if (r.error !== undefined) own.state.callResult = 'error';
          else own.state.callResult ??= 'ok';
        }
      } catch {
        // An answer that is not JSON leaves the call without a result: counted as an error below.
      }
      for (const state of states) state.callResult ??= 'error';
    }
    for (const state of states) await logCall(options, principal, traceId, sessionId, state);
    setCommonHeaders(response);
    const headers: Record<string, string> = {};
    reply.headers.forEach((value, name) => {
      headers[name] = value;
    });
    headers['content-length'] = String(Buffer.byteLength(text));
    response.writeHead(reply.status, headers);
    response.end(text);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
