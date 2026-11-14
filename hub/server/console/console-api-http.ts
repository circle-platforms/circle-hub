// Live updates only (decisions-1600 U5): the JSON read/write management interfaces under /console/api
// are retired — no Circle, Harness, or production caller (login-links included). GET /console/api/stream stays.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import type { Principal } from '../../records/api.ts';
import { sendJson } from '../http.ts';
import { LIVE_EVENTS, wantedEvents } from './live.ts';
import { NEUTRAL } from './context.ts';
import type { ConsoleSession } from './session.ts';
import { type ConsoleOptions, pageContext, principalOfConsoleSession } from './console-http.ts';

/**
 * Console JSON under /console/api: only the live event stream remains. Other paths (including the
 * retired login-links endpoint) answer 404 with SOURCE_UNAVAILABLE (same as a removed page).
 */
export async function api(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions, session: ConsoleSession | null, secure: boolean, rest: string[]): Promise<void> {
  const headers = { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    request.resume();
    return sendJson(response, 405, { code: null, message: '控制台接口只接受 GET', fix: '实时更新用 GET /console/api/stream；管理操作在控制台页面提交' }, { ...headers, allow: 'GET, HEAD' });
  }
  const principal: Principal | null = session === null ? null : await principalOfConsoleSession(options.deps.records.principals, session.token);
  if (principal === null) {
    if (session !== null) options.sessions.close(session.token);
    return sendJson(response, 401, { code: null, message: '登录已过期或已退出', fix: '重新登录控制台后再读取' }, headers);
  }
  if (rest.length === 1 && rest[0] === 'stream') {
    if (options.live === undefined) {
      return sendJson(response, 404, { code: 'SOURCE_UNAVAILABLE', message: NEUTRAL, fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix }, headers);
    }
    const wants = wantedEvents(url.searchParams.get('events'));
    if (wants === null) return sendJson(response, 400, { code: null, message: '请求参数不正确', fix: `events 取以逗号分隔的事件名：${LIVE_EVENTS.join('、')}` }, headers);
    const refused = options.live.refusal(session!.id);
    if (refused !== null) return sendJson(response, refused.status, { code: null, message: refused.message, fix: refused.fix }, headers);
    return options.live.serve(request, response, { session: session!, secure, principal, wants, context: (current) => pageContext(options, request, url, current, session!, secure) });
  }
  request.resume();
  return sendJson(response, 404, { code: 'SOURCE_UNAVAILABLE', message: NEUTRAL, fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix }, headers);
}
