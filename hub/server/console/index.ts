// /console: sign-in with a Hub token, then the pages; administrators also manage the Hub here (owner decision 75). The
// session cookie is HttpOnly, SameSite=Strict and scoped to /console. Every POST form (sign-in, sign-out, first-admin
// setup and the management actions under /console/admin/do/) carries a CSRF token the server issued and must come from
// this server's own origin; a management action also needs an administrator's session. Every request re-authenticates the
// session's token, so revoking it or disabling the account ends the session. Everything that is not one of those forms is
// GET only.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { labelOf } from '../../../contracts/generated/vocabulary.ts';
import { RecordsError, type Principal } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import type { CommandBridge } from '../command-bridge.ts';
import { cookiesOf, mediaTypeOf, readBody, setCommonHeaders } from '../http.ts';
import { CONTENT_SECURITY_POLICY, code, html, link, page, pre, type Html, type PageChrome } from './html.ts';
import { knowledgeAdminPage, packsAdminPage, resourcesAdminPage, secretsAdminPage } from './manage-pages.ts';
import { ACTIONS, completeSetup, jobPage, runAction, type Form, type JobStore } from './manage.ts';
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
import { UploadError, boundaryOf, parseMultipart } from './upload.ts';

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
}

const LOGIN_FORM_LIMIT = 8 * 1024;
/** A management form: the resource form's address, setting and credential lines fit well within it. */
const ACTION_FORM_LIMIT = 64 * 1024;
const SETUP_COOKIE = 'circle_hub_setup';
const SECURE_SETUP_COOKIE = '__Secure-circle_hub_setup';
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

/** Whether an administrator exists; when the records cannot say, the answer is yes (no setup offered, sign-in still works). */
async function hasAdmin(deps: ServerDeps): Promise<boolean> {
  try {
    return (await deps.records.principals.list()).some((user) => user.role === 'admin');
  } catch {
    return true;
  }
}

async function loginPage(options: ConsoleOptions, response: ServerResponse, status: number, message: string | null, secure: boolean): Promise<void> {
  const nonce = options.sessions.issueNonce(secure);
  const setup = await hasAdmin(options.deps) ? '' : html`<p class="notice">这个 Hub 还没有管理员：${link('/console/setup', '用设置码建立第一位管理员')}</p>`;
  const body = page(
    anonymous('登录'),
    html`${message === null ? '' : html`<p class="error">${message}</p>`}${setup}
<form method="post" action="/console/login">
<p><label>Hub 令牌 <input type="password" name="token" autocomplete="off" size="50" required></label></p>
<input type="hidden" name="csrf" value="${nonce}">
<p><button type="submit">登录</button></p>
</form>
<p>令牌由管理员在控制台的“管理”页签发，或用 circle-hub token issue 签发。</p>`,
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

async function formOf(request: IncomingMessage, limit = LOGIN_FORM_LIMIT): Promise<URLSearchParams | 'too_large' | 'wrong_type' | 'aborted'> {
  if (mediaTypeOf(request) !== 'application/x-www-form-urlencoded') {
    request.resume();
    return 'wrong_type';
  }
  // No body budget here: a console form is small, so the read is never `busy`.
  const body = await readBody(request, limit);
  if (!body.ok) return body.reason === 'aborted' ? 'aborted' : 'too_large';
  return new URLSearchParams(body.bytes.toString('utf8'));
}

/** Trimmed fields; an absent one is the empty string. A secret value is taken as typed (only its line breaks matter). */
function fields(get: (name: string) => string | null | undefined): Form {
  return { get: (name) => (name === 'value' ? (get(name) ?? '') : (get(name) ?? '').trim()) };
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
    await loginPage(options, response, 401, '令牌无效：不存在、已撤销，或账号已停用', secure);
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

// ---------------------------------------------------------------- first administrator

async function setupPage(options: ConsoleOptions, response: ServerResponse, status: number, message: string | null, secure: boolean): Promise<void> {
  if (await hasAdmin(options.deps)) {
    sendHtml(response, status === 200 ? 409 : status, page(anonymous('初始化'), html`${message === null ? '' : html`<p class="error">${message}</p>`}<p>这个 Hub 已经有管理员；请用令牌${link('/console/login', '登录')}。</p>`));
    return;
  }
  const nonce = options.sessions.issueNonce(secure);
  const body = page(
    anonymous('建立第一位管理员'),
    html`${message === null ? '' : html`<p class="error">${message}</p>`}
<p>输入安装时显示的设置码（也可以在 Hub 所在的机器上运行 circle-hub setup-code 重新生成），给第一位管理员起个名字。</p>
<form method="post" action="/console/setup">
<p><label>设置码 <input name="code" autocomplete="off" size="40" required></label></p>
<p><label>管理员名字 <input name="name" autocomplete="off" size="24" required></label></p>
<input type="hidden" name="csrf" value="${nonce}">
<p><button type="submit">建立管理员</button></p>
</form>`,
  );
  sendHtml(response, status, body, { 'set-cookie': cookie(secure ? SECURE_SETUP_COOKIE : SETUP_COOKIE, nonce, '/console/setup', 15 * 60, secure) });
}

function mcpOrigin(request: IncomingMessage, secure: boolean): string {
  return `${secure ? 'https' : 'http'}://${request.headers.host ?? '127.0.0.1'}`;
}

async function setup(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions): Promise<void> {
  const secure = options.secureRequest(request);
  if (!sameOrigin(request, options.ownOrigins())) {
    request.resume();
    forbidden(response, '初始化表单只能从本控制台的页面提交');
    return;
  }
  const form = await formOf(request);
  if (form === 'aborted') {
    response.destroy();
    return;
  }
  if (typeof form === 'string') {
    forbidden(response, '初始化请求的格式不对');
    return;
  }
  const nonce = form.get('csrf') ?? '';
  const cookieNonce = cookiesOf(request).get(secure ? SECURE_SETUP_COOKIE : SETUP_COOKIE);
  if (nonce.length === 0 || cookieNonce !== nonce || !options.sessions.takeNonce(nonce, secure)) {
    forbidden(response, '表单已过期或不是本控制台发出的，请重新打开初始化页');
    return;
  }
  const outcome = await completeSetup(options.deps.config.dataDir, options.deps.records.principals, fields((name) => form.get(name)));
  if (!outcome.ok) {
    await setupPage(options, response, outcome.status, outcome.message, secure);
    return;
  }
  options.log(`控制台建立了第一位管理员 ${outcome.name}`);
  const session = options.sessions.open(outcome.token, secure);
  const snippet = JSON.stringify({ mcp_servers: [{ name: 'circle-hub', url: `${mcpOrigin(request, secure)}/mcp`, transport: 'streamable_http', headers: { Authorization: 'Bearer ${secret:CIRCLE_HUB_TOKEN}' } }] }, null, 2);
  sendHtml(
    response,
    200,
    page(
      anonymous('管理员已建立'),
      html`<p>已建立管理员 ${outcome.name}，并已登录。</p>
<p class="notice">下面是这位管理员的令牌，只显示这一次：现在复制，保存到只有你能读的地方。离开这页就再也看不到它；丢了只能由管理员重新签发。</p>
${pre(outcome.token)}
<h2>在 Circle 里连接这个 Hub</h2>
<p>在 Circle 里用 /secrets CIRCLE_HUB_TOKEN 保存上面的令牌，再把下面这段加进 Circle 的 settings.json：</p>
${pre(snippet)}
${secure ? html`<p>Hub 用的是自己的证书颁发机构：把 Hub 数据目录里的 ${code('tls/ca.crt')} 复制到这台电脑，在 Circle 设置的 ${code('trust_cert_files')} 里写上它的路径。</p>` : ''}
<p>${link('/console/admin', '去管理页')}：添加用户、签发令牌、上传任务包、接入业务系统。</p>`,
    ),
    { 'set-cookie': [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, session.id, '/console', undefined, secure), cookie(secure ? SECURE_SETUP_COOKIE : SETUP_COOKIE, '', '/console/setup', 0, secure)] },
  );
}

// ---------------------------------------------------------------- pages and actions

type Route = (ctx: PageContext, rest: string[], options: ConsoleOptions, session: ConsoleSession) => Promise<PageResult>;

const ADMIN_PAGES: Record<string, Route> = {
  calls: (ctx) => callsPage(ctx),
  packs: (ctx) => packsAdminPage(ctx),
  resources: (ctx) => resourcesAdminPage(ctx),
  secrets: (ctx, _rest, options, session) => secretsAdminPage(ctx, options.bridge === undefined ? null : (argv) => options.bridge!.run(argv, { token: session.token })),
  knowledge: (ctx, _rest, options) => knowledgeAdminPage(ctx, options.jobs),
};

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
  admin: (ctx, rest, options, session) => {
    if (rest.length === 0) return adminPage(ctx);
    if (!ctx.admin) return Promise.resolve(neutralPage(ctx));
    if (rest.length === 2 && rest[0] === 'jobs') return Promise.resolve(jobPage(ctx, options.jobs.get(rest[1])));
    if (rest.length === 1 && Object.hasOwn(ADMIN_PAGES, rest[0])) return ADMIN_PAGES[rest[0]](ctx, [], options, session);
    return Promise.resolve(neutralPage(ctx));
  },
};

/** One management action: an administrator's session, this console's origin and its CSRF token, then the command. */
async function action(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions, ctx: PageContext, session: ConsoleSession, name: string): Promise<PageResult | null> {
  if (!sameOrigin(request, options.ownOrigins())) {
    request.resume();
    forbidden(response, '管理表单只能从本控制台的页面提交');
    return null;
  }
  if (!ctx.admin) {
    request.resume();
    return neutralPage(ctx);
  }
  if (name !== 'pack-publish' && !Object.hasOwn(ACTIONS, name)) {
    request.resume();
    return neutralPage(ctx);
  }
  let form: Form;
  let upload: Buffer | undefined;
  if (name === 'pack-publish') {
    const boundary = boundaryOf(request.headers['content-type']);
    if (boundary === null) {
      request.resume();
      forbidden(response, '上传请求的格式不对');
      return null;
    }
    const body = await readBody(request, options.deps.config.limits.maxUploadBytes + ACTION_FORM_LIMIT);
    if (!body.ok) {
      if (body.reason === 'aborted') response.destroy();
      else sendHtml(response, 413, page(ctx.chrome('发布任务包'), html`<p class="error">上传的文件太大（上限 ${options.deps.config.limits.maxUploadBytes} 字节）</p>`));
      return null;
    }
    let parsed;
    try {
      parsed = parseMultipart(body.bytes, boundary);
    } catch (error) {
      if (!(error instanceof UploadError)) throw error;
      forbidden(response, error.message);
      return null;
    }
    form = fields((field) => parsed.fields.get(field));
    upload = parsed.files.find((file) => file.field === 'archive')?.bytes;
  } else {
    const parsed = await formOf(request, ACTION_FORM_LIMIT);
    if (parsed === 'aborted') {
      response.destroy();
      return null;
    }
    if (typeof parsed === 'string') {
      forbidden(response, parsed === 'too_large' ? '表单太大' : '管理请求的格式不对');
      return null;
    }
    form = fields((field) => parsed.get(field));
  }
  if (form.get('csrf') !== session.csrf) {
    forbidden(response, '表单已过期或不是本控制台发出的，请刷新页面后重试');
    return null;
  }
  return runAction(ctx, { bridge: options.bridge, jobs: options.jobs, log: options.log }, name, form, session.token, upload);
}

/** Handles every path under /console. */
export async function handleConsole(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions): Promise<void> {
  const segments = url.pathname.split('/').slice(2).filter((s) => s.length > 0);
  const secure = options.secureRequest(request);
  const session = options.sessions.get(cookiesOf(request).get(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE), secure);
  if (segments[0] === 'login') {
    if (segments.length !== 1) return sendHtml(response, 404, page(anonymous('没有这个页面'), html`<p>没有这个页面</p>`));
    if (request.method === 'GET') return loginPage(options, response, 200, null, secure);
    if (request.method === 'POST') return login(request, response, options);
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET 和 POST</p>`), { allow: 'GET, POST' });
  }
  if (segments[0] === 'setup') {
    if (segments.length !== 1) return sendHtml(response, 404, page(anonymous('没有这个页面'), html`<p>没有这个页面</p>`));
    if (request.method === 'GET') return setupPage(options, response, 200, null, secure);
    if (request.method === 'POST') return setup(request, response, options);
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET 和 POST</p>`), { allow: 'GET, POST' });
  }
  if (segments[0] === 'logout' && segments.length === 1) {
    if (request.method === 'POST') return logout(request, response, options, session);
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>退出只接受 POST</p>`), { allow: 'POST' });
  }
  const isAction = segments.length === 3 && segments[0] === 'admin' && segments[1] === 'do';
  if (isAction ? request.method !== 'POST' : request.method !== 'GET') {
    request.resume();
    return isAction
      ? sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>管理操作只接受 POST</p>`), { allow: 'POST' })
      : sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>这个页面只接受 GET</p>`), { allow: 'GET' });
  }
  const principal: Principal | null = session === null ? null : await options.deps.records.principals.authenticate(`Bearer ${session.token}`);
  if (principal === null) {
    if (isAction) request.resume();
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
    csrf: session!.csrf,
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
  let result: PageResult | null;
  try {
    if (isAction) {
      result = await action(request, response, options, ctx, session!, segments[2]);
      if (result === null) return;
    } else {
      const route = Object.hasOwn(ROUTES, segments[0]) ? ROUTES[segments[0]] : undefined;
      result = route === undefined ? neutralPage(ctx) : await route(ctx, segments.slice(1), options, session!);
    }
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
