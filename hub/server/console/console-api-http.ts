import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { RecordsError, withReadScope, type Principal } from '../../records/api.ts';
import { mediaTypeOf, readBody, sendJson } from '../http.ts';
import { handleApi, type ApiResult } from './api.ts';
import { handleApiWrite } from './api-write.ts';
import { LIVE_EVENTS, wantedEvents } from './live.ts';
import { NEUTRAL } from './context.ts';
import type { ConsoleSession } from './session.ts';
import { UploadError, boundaryOf, parseMultipart } from './upload.ts';
import {
  type ConsoleOptions, ACTION_FORM_LIMIT, sameOrigin, pageContext, bridgeRun,
} from './console-http.ts';

/**
 * The read-only JSON interface (console/api.ts) and the event stream of the live updates (console/live.ts): GET or HEAD
 * only, the session of the pages; without one a 401 answer, not the redirect a page gets, so a client can tell the sign-in
 * ended.
 */
export async function api(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions, session: ConsoleSession | null, secure: boolean, rest: string[]): Promise<void> {
  const headers = { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
  if (request.method === 'POST' && writePath(rest.join('/'))) return apiWrite(request, response, url, options, session, secure, rest, headers);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    request.resume();
    return sendJson(response, 405, { code: null, message: '控制台接口只读，只接受 GET', fix: '用 GET 读取；管理操作在控制台页面或运行 Hub 的服务器上执行' }, { ...headers, allow: 'GET, HEAD' });
  }
  const principal: Principal | null = session === null ? null : await options.deps.records.principals.authenticate(`Bearer ${session.token}`);
  if (principal === null) {
    if (session !== null) options.sessions.close(session.id);
    return sendJson(response, 401, { code: null, message: '登录已过期或已退出', fix: '重新登录控制台后再读取' }, headers);
  }
  if (rest.length === 1 && rest[0] === 'stream' && options.live !== undefined) {
    const wants = wantedEvents(url.searchParams.get('events'));
    if (wants === null) return sendJson(response, 400, { code: null, message: '请求参数不正确', fix: `events 取以逗号分隔的事件名：${LIVE_EVENTS.join('、')}` }, headers);
    const refused = options.live.refusal(session!.id);
    if (refused !== null) return sendJson(response, refused.status, { code: null, message: refused.message, fix: refused.fix }, headers);
    return options.live.serve(request, response, { session: session!, secure, principal, wants, context: (current) => pageContext(options, request, url, current, session!, secure) });
  }
  const ctx = pageContext(options, request, url, principal, session!, secure);
  let result: ApiResult;
  try {
    result = await withReadScope(() => handleApi(ctx, rest, { jobs: options.jobs, run: bridgeRun(options, session!) }));
  } catch (error) {
    if ((error instanceof RecordsError && error.code === null && error.name !== 'IntegrityError') || error instanceof TypeError) {
      options.log(`控制台接口参数不对（${url.pathname}）：${error instanceof Error ? error.message : String(error)}`);
      result = { status: 400, body: { code: null, message: '请求参数不正确', fix: '核对查询参数；分页游标只能取自上一页的 next' } };
    } else {
      options.log(`控制台接口出错（${url.pathname}）：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      result = { status: 500, body: { code: null, message: 'Hub 内部错误，原因已记入服务日志', fix: '稍后重试；仍出错时由管理员查看服务日志' } };
    }
  }
  sendJson(response, result.status, result.body, headers);
}

/** The write interfaces of console/api-write.ts. */
const WRITE_PATHS = new Set(['members', 'systems', 'systems/test', 'systems/test/forget', 'knowledge/imports', 'commands', 'packs/stage']);
const writePath = (path: string): boolean => WRITE_PATHS.has(path) || /^packs\/stage\/[A-Za-z0-9_-]{1,64}\/(?:publish|discard)$/.test(path);

/**
 * A write interface: an administrator's session, this console's Origin (required, as every browser sends it on a POST),
 * the session's CSRF token in X-CSRF-Token and a JSON object body; then the operation of console/api-write.ts.
 */
async function apiWrite(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions, session: ConsoleSession | null, secure: boolean, rest: string[], headers: Record<string, string>): Promise<void> {
  if (typeof request.headers.origin !== 'string' || !sameOrigin(request, options.ownOrigins())) {
    request.resume();
    return sendJson(response, 403, { code: null, message: '写接口只接受本控制台页面发出的请求', fix: '从控制台的页面发起请求' }, headers);
  }
  const principal: Principal | null = session === null ? null : await options.deps.records.principals.authenticate(`Bearer ${session.token}`);
  if (principal === null) {
    request.resume();
    if (session !== null) options.sessions.close(session.id);
    return sendJson(response, 401, { code: null, message: '登录已过期或已退出', fix: '重新登录控制台后再操作' }, headers);
  }
  if (request.headers['x-csrf-token'] !== session!.csrf) {
    request.resume();
    return sendJson(response, 403, { code: null, message: 'CSRF 令牌不正确', fix: '在请求头 X-CSRF-Token 中带上 GET /console/api/me 返回的 csrf' }, headers);
  }
  // Before any body is read: a member's write, an upload included, is the neutral answer and holds no memory.
  if (principal.role !== 'admin') {
    request.resume();
    return sendJson(response, 404, { code: 'SOURCE_UNAVAILABLE', message: NEUTRAL, fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix }, headers);
  }
  // The pack check takes the zip as multipart/form-data (field archive); every other write a JSON object.
  let upload: Buffer | undefined;
  if (rest.join('/') === 'packs/stage') {
    const boundary = boundaryOf(request.headers['content-type']);
    if (boundary === null) {
      request.resume();
      return sendJson(response, 400, { code: null, message: '上传请求的格式不对', fix: '以 multipart/form-data 上传，发布内容的 zip 放在字段 archive' }, headers);
    }
    const sent = await readBody(request, options.deps.config.limits.maxUploadBytes + ACTION_FORM_LIMIT);
    if (!sent.ok) return sent.reason === 'aborted' ? void response.destroy() : sendJson(response, 413, { code: null, message: '上传的文件太大', fix: `zip 不超过 ${options.deps.config.limits.maxUploadBytes} 字节` }, headers);
    try {
      upload = parseMultipart(sent.bytes, boundary).files.find((file) => file.field === 'archive')?.bytes;
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      return sendJson(response, 400, { code: null, message: error.message, fix: '以 multipart/form-data 上传，发布内容的 zip 放在字段 archive' }, headers);
    }
  }
  if (upload === undefined && rest.join('/') !== 'packs/stage' && mediaTypeOf(request) !== 'application/json') {
    request.resume();
    return sendJson(response, 400, { code: null, message: '请求正文须为 JSON', fix: 'Content-Type 写 application/json，正文为一个对象' }, headers);
  }
  const body = rest.join('/') === 'packs/stage' ? { ok: true as const, bytes: Buffer.from('{}') } : await readBody(request, ACTION_FORM_LIMIT);
  if (!body.ok) return body.reason === 'aborted' ? void response.destroy() : sendJson(response, 413, { code: null, message: '请求正文太大', fix: `正文不超过 ${ACTION_FORM_LIMIT} 字节` }, headers);
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.bytes.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('not an object');
    fields = parsed as Record<string, unknown>;
  } catch {
    return sendJson(response, 400, { code: null, message: '请求正文不是 JSON 对象', fix: '正文写成一个 JSON 对象' }, headers);
  }
  const ctx = pageContext(options, request, url, principal, session!, secure);
  let result: ApiResult;
  try {
    result = await handleApiWrite(ctx, rest, fields, { bridge: options.bridge, jobs: options.jobs, staging: options.staging, log: options.log, token: session!.token, ...(upload === undefined ? {} : { upload }) });
  } catch (error) {
    options.log(`控制台写接口出错（${url.pathname}）：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    result = { status: 500, body: { code: null, message: 'Hub 内部错误，原因已记入服务日志', fix: '稍后重试；仍出错时由管理员查看服务日志' } };
  }
  sendJson(response, result.status, result.body, headers);
}
