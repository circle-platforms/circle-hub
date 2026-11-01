// /console: sign-in with a Hub token, then the seven places of the design canvas (总览, 任务, 知识库, 任务包, 连接, 记录,
// 设置) and the four management operations of proposal decision 6 (2026-10-31), which post to the actions of owner
// decision 75; the older paths (/console/results, /console/admin/...) stay. The
// session cookie is HttpOnly, SameSite=Strict and scoped to /console. Every POST form (sign-in, sign-out, first-admin
// setup and the management actions under /console/admin/do/) carries a CSRF token the server issued and must come from
// this server's own origin; a management action also needs an administrator's session. Every request re-authenticates the
// session's token, so revoking it or disabling the account ends the session. Everything that is not one of those forms is
// GET only.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { RecordsError, type Principal } from '../../records/api.ts';
import type { ServerDeps } from '../api.ts';
import type { CommandBridge } from '../command-bridge.ts';
import { cookiesOf, mediaTypeOf, readBody, sendJson, setCommonHeaders } from '../http.ts';
import { connectionsPage } from './connections.ts';
import { handleApi, type ApiResult } from './api.ts';
import { CONTENT_SECURITY_POLICY, code, html, link, page, pre, type Html, type PageChrome } from './html.ts';
import { ACTIONS, completeSetup, jobPage, runAction, type Form, type JobStore } from './manage.ts';
import { operationsPage } from './operations.ts';
import { overviewPage } from './overview.ts';
import { packPage, packsPage } from './packs.ts';
import { diffPage, knowledgePage, neutralPage, productPage, rootPage, runPage, runsPage, treePage, type PageContext, type PageResult } from './pages.ts';
import { recordsPage } from './records.ts';
import { resultPage, resultsPage } from './results.ts';
import { circleEntry, settingsPage, trustSteps, type HubFacts } from './settings.ts';
import { planned, stepper } from './ui.ts';
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
  /** The process serving the console, for the Hub's state on the settings and overview pages. */
  hub?: HubFacts;
}

const LOGIN_FORM_LIMIT = 8 * 1024;
/** A management form: the resource form's address, setting and credential lines fit well within it. */
const ACTION_FORM_LIMIT = 64 * 1024;
const SETUP_COOKIE = 'circle_hub_setup';
const SECURE_SETUP_COOKIE = '__Secure-circle_hub_setup';
/** Set with the redirect of a session that ended, for the login page to say so once. It carries nothing else. */
const ENDED_COOKIE = 'circle_hub_ended';
const SECURE_ENDED_COOKIE = '__Secure-circle_hub_ended';
const HOME = '/console/overview';
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

async function loginPage(options: ConsoleOptions, response: ServerResponse, status: number, message: string | null, secure: boolean, ended = false): Promise<void> {
  const nonce = options.sessions.issueNonce(secure);
  const setup = await hasAdmin(options.deps) ? '' : html`<p class="notice mt12">这个 Hub 还没有管理员：${link('/console/setup', '用初始化码创建首位管理员')}</p>`;
  const body = page(
    anonymous('登录'),
    html`${message === null ? '' : html`<p class="error mt12">${message}</p>`}${ended ? html`<p class="notice mt12">登录已过期或已退出，请重新登录。</p>` : ''}${setup}
<div class="callout info mt16"><span class="logo" aria-hidden="true"></span><span><b>从 Circle 打开</b> ${planned()}<br>在 Circle 中执行“打开 Hub 控制台”，浏览器自动打开并完成登录，无需输入。</span></div>
<div class="divider">访问令牌登录 · 标准授权上线后仅作管理员备用</div>
<form method="post" action="/console/login">
<div class="field"><label for="hub-token">访问令牌</label><input id="hub-token" class="input" type="password" name="token" autocomplete="off" size="50" required placeholder="粘贴管理员签发的令牌"></div>
<input type="hidden" name="csrf" value="${nonce}">
<button type="submit" class="btn primary">登录</button>
</form>
<p class="sub mt12">令牌在添加成员时签发，或由管理员在 Circle 中执行 ${code('circle-hub token issue')} 签发，仅显示一次；遗失后重新签发。</p>`,
  );
  const cookies = [cookie(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE, nonce, '/console/login', 15 * 60, secure)];
  if (ended) cookies.push(cookie(secure ? SECURE_ENDED_COOKIE : ENDED_COOKIE, '', '/console/login', 0, secure));
  sendHtml(response, status, body, { 'set-cookie': cookies.length === 1 ? cookies[0] : cookies });
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

/** Trimmed fields; an absent one is the empty string. A secret value (value, value_<n>) is taken as typed. */
function fields(get: (name: string) => string | null | undefined): Form {
  return { get: (name) => (name === 'value' || /^value_[0-9]$/.test(name) ? (get(name) ?? '') : (get(name) ?? '').trim()) };
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
  redirect(response, HOME, [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, session.id, '/console', undefined, secure), cookie(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE, '', '/console/login', 0, secure)]);
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

const SETUP_STEPS = ['初始化码', '创建管理员', '连接 Circle', '完成'] as const;

async function setupPage(options: ConsoleOptions, response: ServerResponse, status: number, message: string | null, secure: boolean, prefill = ''): Promise<void> {
  if (await hasAdmin(options.deps)) {
    sendHtml(response, status === 200 ? 409 : status, page(anonymous('初始化'), html`${message === null ? '' : html`<p class="error mt12">${message}</p>`}<p class="mt12">这个 Hub 已经有管理员；请用令牌${link('/console/login', '登录')}。</p>`));
    return;
  }
  const nonce = options.sessions.issueNonce(secure);
  const body = page(
    { ...anonymous('创建首位管理员'), wide: true },
    html`${stepper(SETUP_STEPS, 0)}${message === null ? '' : html`<p class="error mt12">${message}</p>`}
<p class="sub mt12">输入安装时显示的初始化码，创建首位管理员。初始化码仅可使用一次，24 小时内有效；也可在 Hub 所在的主机上执行 ${code('circle-hub setup-code')} 重新生成。</p>
<form method="post" action="/console/setup">
<div class="field"><label for="setup-code">初始化码</label><input id="setup-code" class="input" name="code" autocomplete="off" size="40" required value="${prefill}"></div>
<div class="field"><label for="admin-name">管理员姓名</label><input id="admin-name" class="input" name="name" autocomplete="off" size="24" required></div>
<input type="hidden" name="csrf" value="${nonce}">
<button type="submit" class="btn primary">创建管理员</button>
</form>
${secure ? trustSteps() : ''}`,
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
  sendHtml(
    response,
    200,
    page(
      { ...anonymous('管理员已创建'), wide: true },
      html`${stepper(SETUP_STEPS, 2)}
<p class="mt12">已创建管理员 ${outcome.name}，并已登录。</p>
<p class="notice">下面是这位管理员的备用登录令牌，只显示这一次：现在复制，保存到只有本人能读的地方。离开这页后不再显示；遗失后由管理员重新签发。</p>
${pre(outcome.token)}
<h2 class="mt16">在 Circle 中连接这个 Hub</h2>
<p class="sub">在 Circle 中用 ${code('/secrets CIRCLE_HUB_TOKEN')} 保存上面的令牌，再把下面这段写入 Circle 的 settings.json：</p>
<pre class="snippet">${circleEntry(mcpOrigin(request, secure))}</pre>
${secure ? html`<p class="sub">Hub 使用自己的证书颁发机构：把 Hub 数据目录中的 ${code('tls/ca.crt')} 复制到这台电脑，在 Circle 设置的 ${code('trust_cert_files')} 中写入它的路径。</p>${trustSteps()}` : ''}
<h2 class="mt16">接下来</h2>
<ol class="small"><li>${link('/console/operations/member', '添加成员')}</li><li>${link('/console/operations/system', '接入业务系统')}</li><li>${link('/console/operations/pack', '发布任务包')}</li><li>${link('/console/operations/knowledge', '导入知识')}</li></ol>
<p class="mt12">${link(HOME, '进入总览')}</p>`,
    ),
    { 'set-cookie': [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, session.id, '/console', undefined, secure), cookie(secure ? SECURE_SETUP_COOKIE : SETUP_COOKIE, '', '/console/setup', 0, secure)] },
  );
}

// ---------------------------------------------------------------- pages and actions

type Route = (ctx: PageContext, rest: string[], options: ConsoleOptions, session: ConsoleSession) => Promise<PageResult>;

const bridgeRun = (options: ConsoleOptions, session: ConsoleSession) => (options.bridge === undefined ? null : (argv: string[]) => options.bridge!.run(argv, { token: session.token }));

/** The management pages of decision 75, each now part of one of the seven places; administrators only, as before. */
const ADMIN_PAGES: Record<string, Route> = {
  calls: (ctx) => recordsPage(ctx, '/console/admin/calls'),
  packs: (ctx) => packsPage(ctx),
  resources: (ctx) => connectionsPage(ctx),
  secrets: (ctx, _rest, options, session) => settingsPage(ctx, bridgeRun(options, session)),
  knowledge: (ctx, _rest, options) => operationsPage(ctx, 'knowledge', options.jobs),
};

const ROUTES: Record<string, Route> = {
  overview: (ctx, rest) => (rest.length === 0 ? overviewPage(ctx) : Promise.resolve(neutralPage(ctx))),
  results: (ctx, rest) => (rest.length === 0 ? resultsPage(ctx) : rest.length === 1 ? resultPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  runs: (ctx, rest) => (rest.length === 0 ? runsPage(ctx) : rest.length === 1 ? runPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  knowledge: (ctx, rest) => {
    if (rest.length === 0) return knowledgePage(ctx);
    if (rest.length > 1) return Promise.resolve(neutralPage(ctx));
    const pages: Record<string, (c: PageContext) => Promise<PageResult>> = { product: productPage, root: rootPage, tree: treePage, diff: diffPage };
    return Object.hasOwn(pages, rest[0]) ? pages[rest[0]](ctx) : Promise.resolve(neutralPage(ctx));
  },
  packs: (ctx, rest) => (rest.length === 0 ? packsPage(ctx) : rest.length === 1 ? packPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  connections: (ctx, rest) => (rest.length === 0 ? connectionsPage(ctx) : Promise.resolve(neutralPage(ctx))),
  records: (ctx, rest) => (rest.length === 0 ? recordsPage(ctx, '/console/records') : Promise.resolve(neutralPage(ctx))),
  settings: (ctx, rest, options, session) => (rest.length === 0 ? settingsPage(ctx, bridgeRun(options, session)) : Promise.resolve(neutralPage(ctx))),
  operations: (ctx, rest, options) => (rest.length <= 1 ? operationsPage(ctx, rest[0], options.jobs) : Promise.resolve(neutralPage(ctx))),
  admin: (ctx, rest, options, session) => {
    if (!ctx.admin) return Promise.resolve(neutralPage(ctx));
    if (rest.length === 0) return settingsPage(ctx, bridgeRun(options, session));
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

/** What a page or an interface answer of one signed-in request knows; user names are cached for the request. */
function pageContext(options: ConsoleOptions, request: IncomingMessage, url: URL, principal: Principal, session: ConsoleSession, secure: boolean): PageContext {
  const names = new Map<string, Promise<string>>();
  return {
    deps: options.deps,
    principal,
    admin: principal.role === 'admin',
    url,
    csrf: session.csrf,
    secure,
    origin: mcpOrigin(request, secure),
    ...(options.hub === undefined ? {} : { hub: options.hub }),
    chrome: (title, extra = {}) => ({ title, user: { name: principal.name, role: uiLabelOf('permission_role', principal.role), admin: principal.role === 'admin' }, csrf: session.csrf, ...extra }),
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
}

/**
 * The read-only JSON interface (console/api.ts): GET or HEAD only, the session of the pages; without one a 401 answer, not
 * the redirect a page gets, so a client can tell the sign-in ended.
 */
async function api(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions, session: ConsoleSession | null, secure: boolean, rest: string[]): Promise<void> {
  const headers = { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    request.resume();
    return sendJson(response, 405, { code: null, message: '控制台接口只读，只接受 GET', fix: '用 GET 读取；管理操作在控制台页面或 Circle 中执行' }, { ...headers, allow: 'GET, HEAD' });
  }
  const principal: Principal | null = session === null ? null : await options.deps.records.principals.authenticate(`Bearer ${session.token}`);
  if (principal === null) {
    if (session !== null) options.sessions.close(session.id);
    return sendJson(response, 401, { code: null, message: '登录已过期或已退出', fix: '重新登录控制台后再读取' }, headers);
  }
  const ctx = pageContext(options, request, url, principal, session!, secure);
  let result: ApiResult;
  try {
    result = await handleApi(ctx, rest, { jobs: options.jobs, run: bridgeRun(options, session!) });
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

/** Handles every path under /console. */
export async function handleConsole(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions): Promise<void> {
  const segments = url.pathname.split('/').slice(2).filter((s) => s.length > 0);
  const secure = options.secureRequest(request);
  const session = options.sessions.get(cookiesOf(request).get(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE), secure);
  if (segments[0] === 'login') {
    if (segments.length !== 1) return sendHtml(response, 404, page(anonymous('没有这个页面'), html`<p>没有这个页面</p>`));
    if (request.method === 'GET') return loginPage(options, response, 200, null, secure, cookiesOf(request).get(secure ? SECURE_ENDED_COOKIE : ENDED_COOKIE) === '1');
    if (request.method === 'POST') return login(request, response, options);
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET 和 POST</p>`), { allow: 'GET, POST' });
  }
  if (segments[0] === 'setup') {
    if (segments.length !== 1) return sendHtml(response, 404, page(anonymous('没有这个页面'), html`<p>没有这个页面</p>`));
    if (request.method === 'GET') return setupPage(options, response, 200, null, secure, (url.searchParams.get('code') ?? '').slice(0, 64));
    if (request.method === 'POST') return setup(request, response, options);
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET 和 POST</p>`), { allow: 'GET, POST' });
  }
  if (segments[0] === 'logout' && segments.length === 1) {
    if (request.method === 'POST') return logout(request, response, options, session);
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>退出只接受 POST</p>`), { allow: 'POST' });
  }
  if (segments[0] === 'api') return api(request, response, url, options, session, secure, segments.slice(1));
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
    // A session cookie the store no longer knows, or one whose token stopped working: the login page says the sign-in ended.
    const sent = cookiesOf(request).get(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE) !== undefined;
    const cookies = sent ? [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, '', '/console', 0, secure), cookie(secure ? SECURE_ENDED_COOKIE : ENDED_COOKIE, '1', '/console/login', 120, secure)] : [];
    return redirect(response, '/console/login', cookies);
  }
  if (segments.length === 0) return redirect(response, HOME);
  const ctx = pageContext(options, request, url, principal, session!, secure);
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
