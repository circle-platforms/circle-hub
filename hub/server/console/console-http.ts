import type { IncomingMessage, ServerResponse } from 'node:http';
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { memoReadPort, type Principal, type Principals } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import type { CommandBridge } from '../command-bridge.ts';
import { mediaTypeOf, readBody, setCommonHeaders } from '../http.ts';
import type { AuthorizationStore } from '../oauth.ts';
import { errorLine } from './components.ts';
import { CONTENT_SECURITY_POLICY, secureConsoleResponse, html, page, type Html, type PageChrome } from './html.ts';
import type { HealthPageSources } from './health.ts';
import type { LiveEvents } from './live.ts';
import type { Form, JobStore } from './manage.ts';
import type { PageContext } from './context.ts';
import type { RebuildNeeded } from './reset.ts';
import type { HubFacts } from './settings.ts';
import type { ConsoleSession, SessionStore } from './session.ts';
import type { PackStaging } from './staging.ts';

export interface ConsoleOptions {
  deps: ServerDeps;
  sessions: SessionStore;
  ownOrigins: () => ReadonlySet<string>;
  secureRequest: (request: IncomingMessage) => boolean;
  log: (line: string) => void;
  bridge?: CommandBridge;
  jobs: JobStore;
  staging: PackStaging;
  live?: LiveEvents;
  hub?: HubFacts;
  rebuildNeeded?: RebuildNeeded | null;
  observation?: HealthPageSources;
  authorizations?: AuthorizationStore;
}

export const LOGIN_FORM_LIMIT = 8 * 1024;
export const ACTION_FORM_LIMIT = 64 * 1024;
export const SETUP_COOKIE = 'circle_hub_setup';
export const SECURE_SETUP_COOKIE = '__Secure-circle_hub_setup';
export const ENDED_COOKIE = 'circle_hub_ended';
export const SECURE_ENDED_COOKIE = '__Secure-circle_hub_ended';
export const HOME = '/console/overview';

export function sendHtml(response: ServerResponse, status: number, body: Html, headers: Record<string, string | string[]> = {}): void {
  setCommonHeaders(response);
  const custom = headers['content-security-policy'];
  const secured = secureConsoleResponse(body, typeof custom === 'string' ? custom : CONTENT_SECURITY_POLICY), text = secured.text;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cross-origin-opener-policy': 'same-origin',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
    'content-security-policy': secured.policy,
  });
  response.end(text);
}

export function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  setCommonHeaders(response);
  response.writeHead(303, { location, 'content-length': '0', ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}) });
  response.end();
}

export const anonymous = (title: string): PageChrome => ({ title, user: null, csrf: null });

export async function hasAdmin(deps: ServerDeps): Promise<boolean> {
  try {
    return (await deps.records.principals.list()).some((user) => user.role === 'admin');
  } catch {
    return true;
  }
}

export function forbidden(response: ServerResponse, message: string): void {
  sendHtml(response, 403, page(anonymous('拒绝'), html`${errorLine(message)}<p><a href="/console/login">重新登录</a></p>`));
}

export function sameOrigin(request: IncomingMessage, own: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || !own.has(origin) || typeof request.headers.host !== 'string') return false;
  try { return new URL(origin).host === request.headers.host.toLowerCase(); } catch { return false; }
}

export async function formOf(request: IncomingMessage, limit = LOGIN_FORM_LIMIT): Promise<URLSearchParams | 'too_large' | 'wrong_type' | 'aborted'> {
  if (mediaTypeOf(request) !== 'application/x-www-form-urlencoded') {
    request.resume();
    return 'wrong_type';
  }
  const body = await readBody(request, limit);
  if (!body.ok) return body.reason === 'aborted' ? 'aborted' : 'too_large';
  return new URLSearchParams(body.bytes.toString('utf8'));
}

export function fields(get: (name: string) => string | null | undefined): Form {
  return { get: (name) => (name === 'value' || name === 'password' || name === 'current' || name === 'confirm' || /^value_[0-9]$/.test(name) ? (get(name) ?? '') : (get(name) ?? '').trim()) };
}

export function mcpOrigin(request: IncomingMessage, secure: boolean): string {
  return `${secure ? 'https' : 'http'}://${request.headers.host ?? '127.0.0.1'}`;
}

export const bridgeRun = (options: ConsoleOptions, session: ConsoleSession) => (options.bridge === undefined ? null : (argv: string[]) => options.bridge!.run(argv, { token: session.token }));

export async function principalOfConsoleSession(principals: Principals, token: string): Promise<Principal | null> {
  return principals.authenticateConsoleSession
    ? principals.authenticateConsoleSession(`Bearer ${token}`)
    : principals.authenticate(`Bearer ${token}`);
}

export function pageContext(options: ConsoleOptions, request: IncomingMessage, url: URL, principal: Principal, session: ConsoleSession, secure: boolean): PageContext {
  const notice = request.method === 'GET' && request.headers['circle-hub-refresh'] !== 'live' ? session.notice : undefined;
  if (notice) session.notice = undefined;
  return {
    deps: options.deps,
    principal,
    admin: principal.role === 'admin',
    url,
    csrf: session.csrf,
    secure,
    origin: mcpOrigin(request, secure),
    ...(options.hub === undefined ? {} : { hub: options.hub }),
    ...(options.rebuildNeeded === undefined ? {} : { rebuildNeeded: options.rebuildNeeded }),
    chrome: (title, extra = {}) => ({ title, notice, user: { name: principal.name, role: uiLabelOf('permission_role', principal.role), admin: principal.role === 'admin' }, csrf: session.csrf, ...extra }),
    userName: (userId) => {
      if (userId === null || userId === undefined) return Promise.resolve('未记录');
      return memoReadPort(options.deps.records.principals, ['get', 'list']).get(userId).then((user) => user?.deleted_at ? uiLabelOf('account_display_name', 'deleted_member') : user?.name ?? userId);
    },
  };
}
