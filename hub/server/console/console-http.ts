import type { IncomingMessage, ServerResponse } from 'node:http';
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { memoReadPort, type Principal } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import type { CommandBridge } from '../command-bridge.ts';
import { mediaTypeOf, readBody, setCommonHeaders } from '../http.ts';
import type { AuthorizationStore } from '../oauth.ts';
import { CONTENT_SECURITY_POLICY, secureConsoleResponse, html, page, type Html, type PageChrome } from './html.ts';
import type { HealthPageSources } from './health.ts';
import type { LiveEvents } from './live.ts';
import type { Form, JobStore } from './manage.ts';
import type { PageContext } from './context.ts';
import type { HubFacts } from './settings.ts';
import type { ConsoleSession, LoginLinkStore, SessionStore } from './session.ts';
import type { PackStaging } from './staging.ts';

export interface ConsoleOptions {
  deps: ServerDeps;
  sessions: SessionStore;
  /** This server's own origins (http://127.0.0.1:<port>, http://localhost:<port>): the only ones its forms may come from. */
  ownOrigins: () => ReadonlySet<string>;
  /** True only after the app has authenticated the configured proxy authority and peer address. */
  secureRequest: (request: IncomingMessage) => boolean;
  log: (line: string) => void;
  /** Runs the management actions as `circle-hub` commands; without it the management forms say they are unavailable. */
  bridge?: CommandBridge;
  /** Background management runs (knowledge sync) of this process. */
  jobs: JobStore;
  /** Task packs that passed the check of 发布任务包 and wait for its 发布 step, in this process. */
  staging: PackStaging;
  /** The event stream of the live updates (/console/api/stream); without it the stream is the neutral answer. */
  live?: LiveEvents;
  /** The process serving the console, for the Hub's state on the settings and overview pages. */
  hub?: HubFacts;
  /** What the 运行状况 page reads; without it every reading on that page is unknown. */
  observation?: HealthPageSources;
  /** Open requests of the MCP standard authorization (hub/server/oauth.ts); without it /console/authorize is absent. */
  authorizations?: AuthorizationStore;
  /** One-time login links; without it POST /console/api/login-links and /console/login/<code> are absent. */
  loginLinks?: LoginLinkStore;
}

export const LOGIN_FORM_LIMIT = 8 * 1024;
/** A management form: the resource form's address, setting and credential lines fit well within it. */
export const ACTION_FORM_LIMIT = 64 * 1024;
export const SETUP_COOKIE = 'circle_hub_setup';
export const SECURE_SETUP_COOKIE = '__Secure-circle_hub_setup';
/** Set with the redirect of a session that ended, for the login page to say so once. It carries nothing else. */
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

/** Whether an administrator exists; when the records cannot say, the answer is yes (no setup offered, sign-in still works). */
export async function hasAdmin(deps: ServerDeps): Promise<boolean> {
  try {
    return (await deps.records.principals.list()).some((user) => user.role === 'admin');
  } catch {
    return true;
  }
}

export function forbidden(response: ServerResponse, message: string): void {
  sendHtml(response, 403, page(anonymous('拒绝'), html`<p class="error">${message}</p><p><a href="/console/login">重新登录</a></p>`));
}

/** A console POST must come from this server's own pages: an Origin, when sent, is one of its own origins. */
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
  // No body budget here: a console form is small, so the read is never `busy`.
  const body = await readBody(request, limit);
  if (!body.ok) return body.reason === 'aborted' ? 'aborted' : 'too_large';
  return new URLSearchParams(body.bytes.toString('utf8'));
}

/** Trimmed fields; an absent one is the empty string. A secret value (value, value_<n>) is taken as typed. */
export function fields(get: (name: string) => string | null | undefined): Form {
  return { get: (name) => (name === 'value' || name === 'password' || name === 'current' || name === 'confirm' || /^value_[0-9]$/.test(name) ? (get(name) ?? '') : (get(name) ?? '').trim()) };
}

export function mcpOrigin(request: IncomingMessage, secure: boolean): string {
  return `${secure ? 'https' : 'http'}://${request.headers.host ?? '127.0.0.1'}`;
}

export const bridgeRun = (options: ConsoleOptions, session: ConsoleSession) => (options.bridge === undefined ? null : (argv: string[]) => options.bridge!.run(argv, { token: session.token }));

/** What a page or an interface answer of one signed-in request knows; user names are cached for the request. */
export function pageContext(options: ConsoleOptions, request: IncomingMessage, url: URL, principal: Principal, session: ConsoleSession, secure: boolean): PageContext {
  const notice = request.method === 'GET' && request.headers['circle-hub-refresh'] !== 'live' ? session.notice : undefined;
  if (notice) delete session.notice;
  return {
    deps: options.deps,
    principal,
    admin: principal.role === 'admin',
    url,
    csrf: session.csrf,
    secure,
    origin: mcpOrigin(request, secure),
    ...(options.hub === undefined ? {} : { hub: options.hub }),
    chrome: (title, extra = {}) => ({ title, notice, user: { name: principal.name, role: uiLabelOf('permission_role', principal.role), admin: principal.role === 'admin' }, csrf: session.csrf, ...extra }),
    userName: (userId) => {
      if (userId === null || userId === undefined) return Promise.resolve('未记录');
      return memoReadPort(options.deps.records.principals, ['get', 'list']).get(userId).then((user) => user?.deleted_at ? uiLabelOf('account_display_name', 'deleted_member') : user?.name ?? userId);
    },
  };
}
