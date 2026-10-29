// /console: sign-in with a Hub token, then read-only pages. The session cookie is HttpOnly, SameSite=Strict and scoped to
// /console; the only POST forms (sign-in, sign-out) carry a CSRF token the server issued and must come from this server's
// own origin. Every page re-authenticates the session's token, so revoking it or disabling the account ends the session.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { labelOf } from '../../../contracts/generated/vocabulary.ts';
import { RecordsError, withRequestPermissions, type Principal } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import { cookiesOf, mediaTypeOf, readBody, setCommonHeaders } from '../http.ts';
import { CONTENT_SECURITY_POLICY, html, page, type Html, type PageChrome } from './html.ts';
import {
  adminPage,
  callsPage,
  diffPage,
  knowledgePage,
  neutralPage,
  packsPage,
  productPage,
  rootPage,
  runPage,
  runsPage,
  treePage,
  type PageContext,
  type PageResult,
} from './pages.ts';
import { resultPage, resultsPage } from './results.ts';
import { LOGIN_COOKIE, SESSION_COOKIE, SECURE_LOGIN_COOKIE, SECURE_SESSION_COOKIE, cookie, type ConsoleSession, type SessionStore } from './session.ts';

export interface ConsoleOptions {
  deps: ServerDeps;
  sessions: SessionStore;
  /** This server's own origins (http://127.0.0.1:<port>, http://localhost:<port>): the only ones its forms may come from. */
  ownOrigins: () => ReadonlySet<string>;
  /** True only after the app has authenticated the configured proxy authority and peer address. */
  secureRequest: (request: IncomingMessage) => boolean;
  log: (line: string) => void;
}

const LOGIN_FORM_LIMIT = 8 * 1024;
const TOKEN = /^(?:Bearer[ \t]+)?([A-Za-z0-9_-]{43})$/i;

function sendHtml(response: ServerResponse, status: number, body: Html, headers: Record<string, string | string[]> = {}): void {
  setCommonHeaders(response);
  const text = body.text;
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'cross-origin-opener-policy': 'same-origin',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
  response.end(text);
}

function redirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  setCommonHeaders(response);
  response.writeHead(303, { location, 'content-length': '0', ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}) });
  response.end();
}

const anonymous = (title: string): PageChrome => ({ title, user: null, csrf: null });

function loginPage(sessions: SessionStore, response: ServerResponse, status: number, message: string | null, secure: boolean): void {
  const nonce = sessions.issueNonce(secure);
  const body = page(
    anonymous('登录'),
    html`${message === null ? '' : html`<p class="error">${message}</p>`}
<form method="post" action="/console/login">
<p><label>Hub 令牌 <input type="password" name="token" autocomplete="off" size="50" required></label></p>
<input type="hidden" name="csrf" value="${nonce}">
<p><button type="submit">登录</button></p>
</form>
<p>令牌由管理员用 circle-hub token issue 签发；控制台只读。</p>`,
  );
  sendHtml(response, status, body, { 'set-cookie': cookie(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE, nonce, '/console/login', 15 * 60, secure) });
}

function forbidden(response: ServerResponse, message: string): void {
  sendHtml(response, 403, page(anonymous('拒绝'), html`<p class="error">${message}</p><p><a href="/console/login">重新登录</a></p>`));
}

/** A console POST must come from this server's own pages: an Origin, when sent, is one of its own origins. */
function sameOrigin(request: IncomingMessage, own: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string' || !own.has(origin) || typeof request.headers.host !== 'string') return false;
  try { return new URL(origin).host === request.headers.host.toLowerCase(); } catch { return false; }
}

async function formOf(request: IncomingMessage): Promise<URLSearchParams | 'too_large' | 'wrong_type' | 'aborted'> {
  if (mediaTypeOf(request) !== 'application/x-www-form-urlencoded') {
    request.resume();
    return 'wrong_type';
  }
  // No body budget here: a console form is at most 8 KiB, so the read is never `busy`.
  const body = await readBody(request, LOGIN_FORM_LIMIT);
  if (!body.ok) return body.reason === 'aborted' ? 'aborted' : 'too_large';
  return new URLSearchParams(body.bytes.toString('utf8'));
}

async function login(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions): Promise<void> {
  const secure = options.secureRequest(request);
  if (!sameOrigin(request, options.ownOrigins())) {
    request.resume();
    forbidden(response, '登录表单只能从本控制台的页面提交');
    return;
  }
  const form = await formOf(request);
  if (form === 'aborted') {
    response.destroy();
    return;
  }
  if (typeof form === 'string') {
    forbidden(response, '登录请求的格式不对');
    return;
  }
  const nonce = form.get('csrf') ?? '';
  const cookieNonce = cookiesOf(request).get(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE);
  if (nonce.length === 0 || cookieNonce !== nonce || !options.sessions.takeNonce(nonce, secure)) {
    forbidden(response, '表单已过期或不是本控制台发出的，请重新打开登录页');
    return;
  }
  const match = TOKEN.exec((form.get('token') ?? '').trim());
  const principal = match === null ? null : await options.deps.records.principals.authenticate(`Bearer ${match[1]}`);
  if (match === null || principal === null) {
    loginPage(options.sessions, response, 401, '令牌无效：不存在、已撤销，或账号已停用', secure);
    return;
  }
  const session = options.sessions.open(match[1], secure);
  redirect(response, '/console/runs', [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, session.id, '/console', undefined, secure), cookie(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE, '', '/console/login', 0, secure)]);
}

async function logout(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions, session: ConsoleSession | null): Promise<void> {
  const secure = options.secureRequest(request);
  if (!sameOrigin(request, options.ownOrigins())) {
    request.resume();
    forbidden(response, '退出表单只能从本控制台的页面提交');
    return;
  }
  const form = await formOf(request);
  if (form === 'aborted') {
    response.destroy();
    return;
  }
  if (typeof form === 'string' || session === null || form.get('csrf') !== session.csrf) {
    forbidden(response, '表单已过期或不是本控制台发出的');
    return;
  }
  options.sessions.close(session.id);
  redirect(response, '/console/login', [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, '', '/console', 0, secure)]);
}

type Route = (ctx: PageContext, rest: string[]) => Promise<PageResult>;

const ROUTES: Record<string, Route> = {
  results: (ctx, rest) => (rest.length === 0 ? resultsPage(ctx) : rest.length === 1 ? resultPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  runs: (ctx, rest) => (rest.length === 0 ? runsPage(ctx) : rest.length === 1 ? runPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  knowledge: (ctx, rest) => {
    if (rest.length === 0) return knowledgePage(ctx);
    if (rest.length > 1) return Promise.resolve(neutralPage(ctx));
    const pages: Record<string, (c: PageContext) => Promise<PageResult>> = { product: productPage, root: rootPage, tree: treePage, diff: diffPage };
    return Object.hasOwn(pages, rest[0]) ? pages[rest[0]](ctx) : Promise.resolve(neutralPage(ctx));
  },
  packs: (ctx, rest) => (rest.length === 0 ? packsPage(ctx) : Promise.resolve(neutralPage(ctx))),
  admin: (ctx, rest) => (rest.length === 0 ? adminPage(ctx) : rest.length === 1 && rest[0] === 'calls' ? callsPage(ctx) : Promise.resolve(neutralPage(ctx))),
};

/** Handles every path under /console. */
export async function handleConsole(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions): Promise<void> {
  const segments = url.pathname.split('/').slice(2).filter((s) => s.length > 0);
  const secure = options.secureRequest(request);
  const session = options.sessions.get(cookiesOf(request).get(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE), secure);
  if (segments[0] === 'login') {
    if (segments.length !== 1) return sendHtml(response, 404, page(anonymous('没有这个页面'), html`<p>没有这个页面</p>`));
    if (request.method === 'GET') return loginPage(options.sessions, response, 200, null, secure);
    if (request.method === 'POST') return login(request, response, options);
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET 和 POST</p>`), { allow: 'GET, POST' });
  }
  if (segments[0] === 'logout' && segments.length === 1) {
    if (request.method === 'POST') return logout(request, response, options, session);
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>退出只接受 POST</p>`), { allow: 'POST' });
  }
  if (request.method !== 'GET') {
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>控制台只读，只接受 GET</p>`), { allow: 'GET' });
  }
  const principal: Principal | null = session === null ? null : await options.deps.records.principals.authenticate(`Bearer ${session.token}`);
  if (principal === null) {
    if (session !== null) options.sessions.close(session.id);
    return redirect(response, '/console/login', session === null ? [] : [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, '', '/console', 0, secure)]);
  }
  if (segments.length === 0) return redirect(response, '/console/runs');
  const names = new Map<string, Promise<string>>();
  const ctx: PageContext = {
    deps: options.deps,
    principal,
    admin: principal.role === 'admin',
    url,
    chrome: (title) => ({ title, user: { name: principal.name, role: labelOf('permission_role', principal.role), admin: principal.role === 'admin' }, csrf: session!.csrf }),
    userName: (userId) => {
      if (userId === null || userId === undefined) return Promise.resolve('—');
      let pending = names.get(userId);
      if (pending === undefined) {
        pending = options.deps.records.principals.get(userId).then((user) => user?.name ?? userId);
        names.set(userId, pending);
      }
      return pending;
    },
  };
  const route = Object.hasOwn(ROUTES, segments[0]) ? ROUTES[segments[0]] : undefined;
  let result: PageResult;
  try {
    result = await withRequestPermissions(options.deps.records.artifacts,principal,async()=>route === undefined ? neutralPage(ctx) : route(ctx, segments.slice(1)));
  } catch (error) {
    if (error instanceof RecordsError && error.code === null && !(error.name === 'IntegrityError')) {
      result = { status: 400, body: page(ctx.chrome('请求有误'), html`<p class="error">${error.message}</p>`) };
    } else if (error instanceof TypeError) {
      options.log(`控制台请求参数不对（${url.pathname}）：${error.message}`);
      result = { status: 400, body: page(ctx.chrome('请求有误'), html`<p class="error">请求参数不对</p>`) };
    } else {
      options.log(`控制台页面出错（${url.pathname}）：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      result = { status: 500, body: page(ctx.chrome('Hub 内部错误'), html`<p class="error">Hub 内部错误，原因已记入服务日志</p>`) };
    }
  }
  sendHtml(response, result.status, result.body);
}
