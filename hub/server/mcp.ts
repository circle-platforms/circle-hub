// POST /mcp: the streamable HTTP transport of the official SDK in stateless JSON mode, one Server and one JSON-RPC request per
// HTTP request. Batches are refused (MCP 2025-06-18 removed them; in a batch, requests sharing an id or a cancellation of a
// sibling would run calls the call log never sees). The bearer token is checked on every request (a revoked token or a
// disabled account stops at once); the body is bounded per request and over all requests. Every request of an authenticated
// caller gets one call-log line (B08), refusals at the transport included, after its answer is ready and before it is sent.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { SERVER_INSTRUCTIONS } from '../../contracts/src/tools.ts';
import type { SessionTracker } from '../health/api.ts';
import type { CallLogInput, Principal } from '../records/api.ts';
import { addUsage, currentTrace, mcpStep, setTraceStatus, step, tracing, updateTrace } from '../telemetry/api.ts';
import type { ServerDeps } from './api.ts';
import type { DeclaredClients } from './declared-clients.ts';
import { mediaTypeOf, readBody, sendRpcError, setCommonHeaders, type BodyBudget } from './http.ts';
import { clipNote, describeError, describeInternalError } from './notes.ts';
import { newTraceId, sessionIdOf, traceContextFrom, traceIdFrom } from './trace.ts';
import type { ClientDeclaration } from '../../contracts/src/spaces.ts';
import { callTool, internalError, listTools, type CallState, type ToolCall } from './tools.ts';
import { beginObservedCall } from './inflight-calls.ts';
import { retainReadReply } from './read-replies.ts';
import { identifyRequest } from './request-entry.ts';
import { bearerToken } from './token-echo.ts';

export interface McpOptions {
  deps: ServerDeps;
  serverVersion: string;
  log: (line: string) => void;
  /** Request body bytes held at once over all requests (the app's budget). */
  budget: BodyBudget;
  /** What connections declared at initialize, for their traces. */
  clients?: DeclaredClients;
  /** The resource metadata URL an unauthenticated answer names (RFC 9728 5.1), for the MCP standard authorization. */
  resourceMetadata?: (request: IncomingMessage) => string;
  /**
   * A tool call that is still working after `headersAfterMs` gets its response head sent, then one space every `keepaliveMs`
   * (insignificant whitespace before the JSON body), so a client that gives up on a silent connection (Node's fetch waits
   * 300 s for headers and between body chunks) keeps waiting for a call that needs minutes.
   */
  keepalive?: { headersAfterMs: number; keepaliveMs: number };
  /** Counts open MCP sessions (hub/health); the Hub itself stays stateless. */
  sessions?: SessionTracker;
}

const KEEPALIVE = { headersAfterMs: 20_000, keepaliveMs: 30_000 } as const;

/** Same body for missing, unknown, revoked and disabled tokens. */
const UNAUTHENTICATED = '需要有效的 Bearer 令牌';
const TOKEN_IN_REQUEST = 'Invalid params: 请求正文里含调用方当前的 Hub 令牌，整份请求没有处理，也没有保存；删去令牌后重发';
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
    ...(message.method === 'initialize' ? clientInfoOf(params.clientInfo) : {}),
  };
}

/** The W3C Trace Context a request carries in `params._meta.traceparent` (the MCP way to join a client's trace). */
function metaTraceContext(message: unknown): ReturnType<typeof traceContextFrom> {
  const params = (message as JsonRpcMessage | null)?.params;
  const meta = isPlainObject(params) ? params._meta : undefined;
  const value = isPlainObject(meta) ? meta.traceparent : undefined;
  return typeof value === 'string' ? traceContextFrom(value) : null;
}

/** A session id this Hub issued (a UUID); anything else binds nothing. */
function mcpSessionOf(header: string | string[] | undefined): string | null {
  return typeof header === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(header) ? header : null;
}

/** MCP initialize clientInfo (name, version) as the client reported it; bounded, kept only as a declaration. */
function clientInfoOf(value: unknown): { client?: ClientDeclaration } {
  if (!isPlainObject(value)) return {};
  const clean = (text: unknown): string | null => typeof text === 'string' ? ([...text.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 100).join('').trim() || null) : null;
  const name = clean(value.name);
  return name === null ? {} : { client: { name, version: clean(value.version) } };
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
async function logCall(options: McpOptions, principal: Principal, traceId: string, sessionId: string | null, state: CallState, tokenId: string | null = null, mcpSessionId: string | null = null, spanId?: string): Promise<void> {
  const tool = LOGGED_TOOL.test(state.tool) ? state.tool : state.method === 'tools/call' ? 'tools/call' : 'mcp';
  const errorCode = state.errorCode !== null && LOGGED_CODE.test(state.errorCode) ? state.errorCode : null;
  const note=state.notes.length===0?null:`管理员理由 ${state.notes.length} 条；详见管理员调用日志详情`;
  const input: CallLogInput = {
    ...(options.deps.now ? { at: options.deps.now() } : {}),
    traceId,
    ...(spanId === undefined ? {} : { spanId }),
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
    ...(state.client ? { client: state.client, tokenId, mcpSessionId } : {}),
  };
  try {
    await step('append-record', () => options.deps.records.callLog.append(input));
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
  const credential = typeof authorization === 'string' ? authorization : null;
  const identity = deps.records.principals.identify ? await step('authenticate', () => deps.records.principals.identify!(credential), { type: 'guardrail' }) : null;
  const principal = identity?.principal ?? (deps.records.principals.identify ? null : await step('authenticate', () => deps.records.principals.authenticate(credential), { type: 'guardrail' }));
  const tokenId = identity?.token_id ?? null;
  if (principal === null) {
    request.resume();
    // RFC 6750 3.1: a request without credentials gets no error code; one with a token that does not work gets invalid_token.
    const challenge = ['Bearer realm="circle-hub"'];
    if (options.resourceMetadata !== undefined) challenge.push(`resource_metadata="${options.resourceMetadata(request)}"`);
    if (typeof authorization === 'string') challenge.push('error="invalid_token"');
    sendRpcError(response, 401, -32001, UNAUTHENTICATED, { 'www-authenticate': challenge.join(', '), connection: 'close' });
    return;
  }
  const headerTrace = traceIdFrom(request.headers.traceparent);
  const traceId = headerTrace ?? currentTrace()?.traceId ?? newTraceId();
  const sessionId = sessionIdOf(request.headers['circle-session-id']);
  updateTrace({ userId: principal.id, sessionId });
  identifyRequest(request, { traceId, userId: principal.id });
  options.sessions?.seen(mcpSessionOf(request.headers['mcp-session-id']));
  /** A refusal before any handler ran: its call-log lines (one transport_failure line by default), then the JSON-RPC error. */
  const refuse = async (status: number, code: number, message: string, reason: string, headers: Record<string, string> = {}, states?: CallState[]): Promise<void> => {
    setTraceStatus('warning', labelOf('call_result', 'transport_failure'));
    for (const state of states ?? [transportState(reason, started)]) await logCall(options, principal, traceId, sessionId, state);
    sendRpcError(response, status, code, message, headers);
  };

  if (request.method !== 'POST') {
    request.resume();
    const message = '只接受 POST：这个服务器是无状态的 JSON 模式，没有 SSE 流';
    // The specification lets a client end its session with DELETE, even where the answer is 405: it is done with it.
    if (request.method === 'DELETE') options.sessions?.closed(mcpSessionOf(request.headers['mcp-session-id']));
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
    // The caller's own token in the body refuses all of it, before anything in it is handled or stored (issue #105).
    const token = bearerToken(authorization);
    if (token !== null && text.includes(token)) return await refuse(400, -32602, TOKEN_IN_REQUEST, "the request body held the caller's own Hub token; nothing in it was handled or stored");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return await refuse(400, -32700, 'Parse error: 请求体不是 JSON', 'request body is not JSON');
    }
    if (Array.isArray(parsed)) return await refuse(400, -32600, BATCH_REFUSED, 'JSON-RPC batch refused', {}, batchStates(parsed, started));
    // A tool call may name the client's trace in `_meta` too; a valid header stays first.
    const declared = headerTrace === null ? metaTraceContext(parsed) : null;
    if (declared !== null) updateTrace({ traceId: declared.traceId, parentSpanId: declared.parentSpanId });
    await answer(request, response, options, principal, declared?.traceId ?? traceId, sessionId, parsed, started, tokenId);
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
  tokenId: string | null = null,
): Promise<void> {
  const { deps } = options;
  const own = isRequest(parsed) ? { key: idKey(parsed.id), state: stateOf(parsed, started) } : null;
  if (own !== null) updateTrace({ name: mcpStep(own.state.method, own.state.tool) });
  const session = mcpSessionOf(request.headers['mcp-session-id']);
  if (tracing()) {
    const client = own?.state.client ?? (await options.clients?.of(principal.id, tokenId, session)) ?? null;
    if (client !== null) updateTrace({ clientName: client.name, clientVersion: client.version });
  }
  if (own !== null) identifyRequest(request, { traceId, name: LOGGED_TOOL.test(own.state.tool) ? own.state.tool : own.state.method === 'tools/call' ? 'tools/call' : 'mcp' });
  let finishObserved:(()=>void)|undefined;
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
    const declared = deps.records.callLog.declaredClient;
    const client = declared ? () => declared.call(deps.records.callLog, principal.id, session, tokenId) : undefined;
    const call: ToolCall = { principal, state, context: { traceId, sessionId, adminNote: noteOn(state), ...(client ? { client } : {}) } };
    // The arguments as received (the server's own parse), not the SDK's validated copy: its record schema drops members
    // such as `__proto__`, and submit_result must reach the runs service exactly as sent (W07).
    const args = isPlainObject(state.args) ? state.args : message.params.arguments;
    if ((message.params.name==='start_run'||message.params.name==='get_nodes') && !(message.params.name==='get_nodes' && isPlainObject(args) && Object.hasOwn(args,'call_query'))) {
      finishObserved=beginObservedCall(deps,principal.id,message.params.name,state.args,traceId);
    }
    const result=await guarded(state, () => callTool(deps, call, message.params.name, args));
    if(message.params.name==='get_nodes' && !(isPlainObject(args)&&Object.hasOwn(args,'call_query')) && !result.isError){
      retainReadReply(deps,principal.id,state.args,traceId,result.structuredContent);
    }
    return result;
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const keepalive = options.keepalive ?? KEEPALIVE;
  let early = false;
  let ticker: NodeJS.Timeout | undefined;
  const opening = isRequest(parsed) && parsed.method === 'tools/call'
    ? setTimeout(() => {
        if (response.headersSent || response.destroyed || response.writableEnded) return;
        early = true;
        setCommonHeaders(response);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.flushHeaders();
        ticker = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) response.write(' ');
        }, keepalive.keepaliveMs);
        ticker.unref();
      }, keepalive.headersAfterMs)
    : undefined;
  opening?.unref();
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
    // Streamable HTTP sessions: the Hub stays stateless but issues an Mcp-Session-Id at a successful initialize, so a
    // client's declared clientInfo is bound to the writes it makes in that session and to no other client's. A head that
    // already went out early (keepalive) cannot carry one.
    const issued = !early && own?.state.method === 'initialize' && reply.status < 400 && own.state.callResult === 'ok' ? randomUUID() : null;
    if (issued !== null) options.sessions?.opened(issued, own?.state.client?.name ?? null);
    if (own !== null) {
      updateTrace({ runId: own.state.runId });
      if (own.state.callResult !== 'ok') setTraceStatus('error', own.state.errorCode !== null && LOGGED_CODE.test(own.state.errorCode) ? own.state.errorCode : labelOf('call_result', own.state.callResult ?? 'error'));
      if (own.state.client !== undefined) options.clients?.remember(principal.id, tokenId, issued, own.state.client);
    }
    for (const state of states) await logCall(options, principal, traceId, sessionId, state, tokenId, state === own?.state ? issued : null, state === own?.state ? currentTrace()?.rootSpanId : undefined);
    if (early) {
      // The head (HTTP 200, JSON) went out while the call worked; the body follows the keepalive spaces.
      addUsage('answer.bytes', Buffer.byteLength(text));
      response.end(text);
    } else {
      setCommonHeaders(response);
      const headers: Record<string, string> = {};
      reply.headers.forEach((value, name) => {
        headers[name] = value;
      });
      if (issued !== null) headers['mcp-session-id'] = issued;
      headers['content-length'] = String(Buffer.byteLength(text));
      response.writeHead(reply.status, headers);
      response.end(text);
    }
  } finally {
    if (opening !== undefined) clearTimeout(opening);
    if (ticker !== undefined) clearInterval(ticker);
    finishObserved?.();
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
