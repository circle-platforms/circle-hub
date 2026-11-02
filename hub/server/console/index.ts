import {tooltip,technical} from './presentation.ts';
import {personalPublishPage,performPersonalPackAction} from './personal-packs.ts';
import { LimitError, validPassword } from '../../records/api.ts';
// /console: sign-in with username and password (every account; a token only connects a Circle), then the places of the design canvas (总览, 任务, 知识库, 任务包, 连接, 记录,
// 设置) and the four management operations of proposal decision 6 (2026-10-31), which post to the actions of owner
// decision 75; the older paths (/console/results, /console/admin/...) stay. The
// session cookie is HttpOnly, SameSite=Strict and scoped to /console. Every POST form (sign-in, sign-out, first-admin
// setup and the management actions under /console/admin/do/) carries a CSRF token the server issued and must come from
// this server's own origin; a management action also needs an administrator's session. Every request re-authenticates the
// session's token, so revoking it or disabling the account ends the session. Everything that is not one of those forms is
// GET only.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { axisUiLabel, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { RecordsError, type Principal } from '../../records/api.ts';
import { KnowledgeError } from '../../knowledge/api.ts';
import type { ServerDeps } from '../api.ts';
import type { CommandBridge } from '../command-bridge.ts';
import { cookiesOf, mediaTypeOf, readBody, sendJson, setCommonHeaders } from '../http.ts';
import { AUTHORIZE_COOKIE, SECURE_AUTHORIZE_COOKIE, issuerOf, responseUri, type AuthorizationStore } from '../oauth.ts';
import { MAX_INVITATION_FAILURES, authorizeSecurityPolicy, confirmPage, endedPage, expiredPage, identityPage, invitationProblem, refusedPage } from './authorize.ts';
import { connectionsPage } from './connections.ts';
import { handleApi, type ApiResult } from './api.ts';
import { handleApiWrite } from './api-write.ts';
import { CONTENT_SECURITY_POLICY, FAVICON_SVG, code, html, link, logo, page, pre, type Html, type PageChrome } from './html.ts';
import { LIVE_EVENTS, wantedEvents, type LiveEvents } from './live.ts';
import { ACTIONS, completeSetup, isPackStep, jobPage, runAction, type Form, type JobStore } from './manage.ts';
import { operationsPage, systemForgetPage, systemTrialPage } from './operations.ts';
import { overviewPage } from './overview.ts';
import { packPage, packsPage } from './packs.ts';
import { publication } from './pack-display.ts';
import { spacePage, spaceDiffPage, spaceSourcePage, performSpaceAction, spaceActionFailure, shareHistoryPage,batchSharePage } from './spaces.ts';
import {withReadScope} from '../../records/api.ts';
import {performMemoryAction} from './memory.ts';
import { mediaTypeFor } from '../upload.ts';
import { NEUTRAL, diffPage, knowledgePage, neutralPage, productPage, rootPage, runPage, runsPage, treePage, type PageContext, type PageResult } from './pages.ts';
import { recordsPage } from './records.ts';
import { searchPage } from './search.ts';
import { resultPage, resultsPage } from './results.ts';
import { circleEntry, settingsPage, trustSteps, type HubFacts } from './settings.ts';
import { teamPage } from './team.ts';
import { stepper } from './ui.ts';
import { LOGIN_COOKIE, LOGIN_LINK_TTL_MS, SESSION_COOKIE, SECURE_LOGIN_COOKIE, SECURE_SESSION_COOKIE, cookie, safeNext, type ConsoleSession, type LoginLinkStore, type SessionStore } from './session.ts';
import type { PackStaging } from './staging.ts';
import { runForgetTrial, runTrial } from './trial.ts';
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
  /** Task packs that passed the check of 发布任务包 and wait for its 发布 step, in this process. */
  staging: PackStaging;
  /** The event stream of the live updates (/console/api/stream); without it the stream is the neutral answer. */
  live?: LiveEvents;
  /** The process serving the console, for the Hub's state on the settings and overview pages. */
  hub?: HubFacts;
  /** Open requests of the MCP standard authorization (hub/server/oauth.ts); without it /console/authorize is absent. */
  authorizations?: AuthorizationStore;
  /** One-time login links; without it POST /console/api/login-links and /console/login/<code> are absent. */
  loginLinks?: LoginLinkStore;
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

async function loginPage(options: ConsoleOptions, response: ServerResponse, status: number, message: string | null, secure: boolean, ended = false, next: string | null = null): Promise<void> {
  const nonce = options.sessions.issueNonce(secure);
  const setup = await hasAdmin(options.deps) ? '' : html`<p class="notice">这个 Hub 还没有管理员：${link('/console/setup', '用初始化码创建首位管理员')}</p>`;
  const body = page(
    anonymous('登录'),
    html`${message === null ? '' : html`<p class="error">${message}</p>`}${ended ? html`<p class="notice">登录已过期或已退出，请重新登录。</p>` : ''}${setup}
<form method="post" action="/console/login">
<div class="ch-field"><label class="ch-field-label" for="hub-username">用户名</label><div class="ch-input"><input id="hub-username" name="username" autocomplete="username" maxlength="200" required></div></div>
<div class="ch-field"><label class="ch-field-label" for="hub-password" title="所有账户都用用户名和密码登录；访问令牌只用于连接 Circle。忘记密码时由管理员在团队页重置，管理员本人可在 Hub 主机上执行 circle-hub user password-reset">密码</label><div class="ch-input"><input id="hub-password" type="password" name="password" autocomplete="current-password" maxlength="256" required></div></div>
<input type="hidden" name="csrf" value="${nonce}">${next === null ? '' : html`<input type="hidden" name="next" value="${safeNext(next)}">`}
<button type="submit" class="ch-btn ch-btn--primary">登录</button></form>`,
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
  return { get: (name) => (name === 'value' || name === 'password' || name === 'current' || name === 'confirm' || /^value_[0-9]$/.test(name) ? (get(name) ?? '') : (get(name) ?? '').trim()) };
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
  const rawName = (form.get('username') ?? '').trim();
  const name = rawName.length <= 200 && [...rawName].length <= 100 ? rawName : '';
  const peerKey = 'peer:' + (request.socket.remoteAddress ?? 'unknown');
  // Every account, administrators included, signs in with its username and password (owner, 2026-11-02); a token only
  // connects a Circle and is never accepted here.
  const accountKey = 'account:' + name;
  if (!options.sessions.takeLoginAttempt(accountKey) || !options.sessions.takeLoginAttempt(peerKey,50)) return loginPage(options,response,429,'登录失败次数过多，请在 15 分钟后重试',secure);
  const principals=options.deps.records.principals;
  let token: string | null = null;
  try {
    const verified=await principals.verifyPassword(name,form.get('password') ?? '');
    if (verified) token=(await principals.openConsoleSession(verified.user.id,verified.revision))?.token ?? null;
  } catch(error) {
    if (error instanceof LimitError) return loginPage(options,response,429,'密码校验繁忙，请稍后重试',secure);
    throw error;
  }
  if (token === null) return loginPage(options,response,401,'用户名或密码无效，或账号不可用',secure);
  options.sessions.clearLoginAttempts(accountKey); options.sessions.clearLoginAttempts(peerKey);
  const session=options.sessions.open(token,secure);
  const principal=await principals.authenticate('Bearer '+token);
  const state=principal ? await principals.passwordState?.(principal.id) : null;
  const next=safeNext(form.get('next'));
  redirect(response,state?.mustChange ? '/console/password?next='+encodeURIComponent(next) : next,[cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE,session.id,'/console',undefined,secure),cookie(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE,'','/console/login',0,secure)]);
}

/** Password forms have no data navigation until the forced first change is complete. */
async function passwordPage(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions, session: ConsoleSession | null, principal: Principal | null, secure: boolean, rest: string[]): Promise<void> {
  if (!session || !principal) { request.resume(); return redirect(response,'/console/login'); }
  const mustChange = (await options.deps.records.principals.passwordState(principal.id)).mustChange;
  if (rest.length > 0) { request.resume(); return sendHtml(response,404,page(anonymous(NEUTRAL),html``)); }
  const show = (status: number, message = '') => sendHtml(response,status,page(anonymous('修改密码'),html`
<p>${principal.name}</p>${mustChange ? html`<p class="notice">首次登录必须修改密码。</p>` : ''}${message ? html`<p class="error">${message}</p>` : ''}
<form method="post" action="/console/password"><input type="hidden" name="csrf" value="${session.csrf}"><input type="hidden" name="next" value="${safeNext(url.searchParams.get('next'))}">
<div class="ch-field"><label class="ch-field-label" for="current-password">当前密码</label><div class="ch-input"><input id="current-password" type="password" name="current" autocomplete="current-password" maxlength="256" required></div></div>
<div class="ch-field"><label class="ch-field-label" for="new-password" title="12 至 256 个字符，不含控制字符">新密码</label><div class="ch-input"><input id="new-password" type="password" name="password" autocomplete="new-password" minlength="12" maxlength="256" required></div></div>
<div class="ch-field"><label class="ch-field-label" for="confirm-password">再次输入新密码</label><div class="ch-input"><input id="confirm-password" type="password" name="confirm" autocomplete="new-password" maxlength="256" required></div></div><button type="submit" class="ch-btn ch-btn--primary">修改密码</button></form>`));
  if (request.method === 'GET') return show(200);
  if (request.method !== 'POST') { request.resume(); return sendHtml(response,405,page(anonymous('方法不允许'),html`<p>只接受 POST</p>`),{allow:'POST'}); }
  if (!sameOrigin(request,options.ownOrigins())) { request.resume(); return forbidden(response,'密码表单只能从本控制台提交'); }
  const form=await formOf(request);
  if (typeof form === 'string' || form.get('csrf') !== session.csrf) return forbidden(response,'表单已过期或不是本控制台发出的');
  const key='password:'+principal.id;
  if (!options.sessions.takeLoginAttempt(key)) return show(429,'密码操作失败次数过多，请在 15 分钟后重试');
  try {
    const password=form.get('password') ?? '';
    if (!validPassword(password) || password !== form.get('confirm')) return show(400,'新密码须为 12 至 256 个字符，不含控制字符，且两次输入一致');
    if (!await options.deps.records.principals.changePassword(principal,form.get('current') ?? '',password)) return show(400,'当前密码无效，或新密码与当前密码相同');
    options.sessions.clearLoginAttempts(key);
    options.sessions.close(session.id);
    sendHtml(response,200,page(anonymous('密码已修改'),html`<p>请用新密码重新登录。</p><p>${link('/console/login','登录',{next:safeNext(form.get('next'))})}</p>`),{'set-cookie':cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE,'','/console',0,secure)});
  } catch(error) {
    if (error instanceof LimitError) return show(429,'密码校验繁忙，请稍后重试');
    if (error instanceof TypeError) return show(400,'密码格式不正确');
    throw error;
  }
}

// ---------------------------------------------------------------- one-time login links

const LINK_INVALID = '登录链接已失效：该链接已使用或已过期。请在 Circle 中重新获取。';

/**
 * A link from Circle leads to the password sign-in at its page (owner, 2026-11-02: every account signs in with username and
 * password). It signs nobody in, so a prefetch or a planted link cannot either; POST still consumes it.
 */
async function loginLink(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions, secure: boolean, code: string): Promise<void> {
  const links = options.loginLinks;
  if (links === undefined) {
    request.resume();
    return sendHtml(response, 404, page(anonymous('没有这个页面'), html`<p>没有这个页面</p>`));
  }
  if (request.method === 'GET') {
    const found = links.peek(code);
    const principal = found === null ? null : await options.deps.records.principals.authenticate(`Bearer ${found.token}`);
    if (found === null || principal === null) return sendHtml(response, 410, page(anonymous('登录链接已失效'), html`<p>${LINK_INVALID}</p><p>${link('/console/login', '前往登录页')}</p>`));
    // A link from Circle leads every account to the password sign-in at the requested page; it never opens a session.
    return redirect(response,'/console/login?next='+encodeURIComponent(found.next));
  }
  if (request.method !== 'POST') {
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET 和 POST</p>`), { allow: 'GET, POST' });
  }
  if (!sameOrigin(request, options.ownOrigins())) {
    request.resume();
    return forbidden(response, '登录表单只能从本控制台的页面提交');
  }
  const form = await formOf(request);
  if (form === 'aborted') return void response.destroy();
  const nonce = typeof form === 'string' ? '' : (form.get('csrf') ?? '');
  if (nonce.length === 0 || cookiesOf(request).get(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE) !== nonce || !options.sessions.takeNonce(nonce, secure)) {
    return forbidden(response, '表单已过期或不是本控制台发出的，请重新打开登录链接');
  }
  const taken = links.take(code);
  const principal = taken === null ? null : await options.deps.records.principals.authenticate(`Bearer ${taken.token}`);
  if (taken === null || principal === null) return sendHtml(response, 410, page(anonymous('登录链接已失效'), html`<p>${LINK_INVALID}</p>`));
  redirect(response,'/console/login?next='+encodeURIComponent(taken.next));
}

/**
 * POST /console/api/login-links: a client asks with its Bearer token for a one-time link to the console, optionally at
 * `next` (a console path). The link only leads to the password sign-in there; it never opens a session (owner, 2026-11-02).
 */
async function loginLinks(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions, secure: boolean): Promise<void> {
  const headers = { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' };
  if (options.loginLinks === undefined) {
    request.resume();
    return sendJson(response, 404, { code: 'SOURCE_UNAVAILABLE', message: NEUTRAL, fix: PROTOCOL_CODES.SOURCE_UNAVAILABLE.fix }, headers);
  }
  if (request.method !== 'POST') {
    request.resume();
    return sendJson(response, 405, { code: null, message: '登录链接只接受 POST', fix: '以 Bearer 令牌 POST 本地址' }, { ...headers, allow: 'POST' });
  }
  const authorization = request.headers.authorization;
  const principal = await options.deps.records.principals.authenticate(typeof authorization === 'string' ? authorization : null);
  const match = typeof authorization === 'string' ? /^Bearer[ \t]+([A-Za-z0-9_-]{43})[ \t]*$/i.exec(authorization) : null;
  if (principal === null || match === null) {
    request.resume();
    return sendJson(response, 401, { code: null, message: '需要有效的 Bearer 令牌', fix: '以已连接的 Circle 的令牌请求登录链接' }, { ...headers, 'www-authenticate': 'Bearer realm="circle-hub"' });
  }
  let next: string | null = null;
  if (mediaTypeOf(request) === 'application/json') {
    const body = await readBody(request, LOGIN_FORM_LIMIT);
    if (!body.ok) return body.reason === 'aborted' ? void response.destroy() : sendJson(response, 413, { code: null, message: '请求正文太大', fix: '正文只写 {"next": "/console/…"}' }, headers);
    try {
      const parsed: unknown = body.bytes.length === 0 ? {} : JSON.parse(body.bytes.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('not an object');
      const value = (parsed as Record<string, unknown>).next;
      if (value !== undefined && typeof value !== 'string') throw new TypeError('next is a string');
      next = value ?? null;
    } catch {
      return sendJson(response, 400, { code: null, message: '请求正文不正确', fix: '正文写成 {"next": "/console/…"}，或不带正文' }, headers);
    }
  } else {
    request.resume();
  }
  const issued = options.loginLinks.issue(match[1], next ?? HOME);
  options.log(`${principal.name} 获取了一次性登录链接`);
  sendJson(response, 201, { url: `${issuerOf(request, secure)}/console/login/${issued.code}`, expires_at: new Date(issued.expires).toISOString() }, headers);
}

// ---------------------------------------------------------------- the authorization page

/** The error page of an authorization request the endpoint cannot redirect (hub/server/oauth.ts). */
export function authorizeRefusal(response: ServerResponse, status: number, message: string): void {
  sendHtml(response, status, refusedPage(message));
}

async function authorizePage(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions, session: ConsoleSession | null, secure: boolean, rest: string[]): Promise<void> {
  const store = options.authorizations;
  const open = rest.length === 1 && store !== undefined ? store.get(rest[0]) : null;
  // Only the browser that opened the request (it holds the cookie the authorization endpoint set) sees or answers it; to any
  // other the request does not exist.
  const bound = open !== null && cookiesOf(request).get(secure ? SECURE_AUTHORIZE_COOKIE : AUTHORIZE_COOKIE) === open.browser;
  if (open === null || open.secure !== secure || !bound) {
    request.resume();
    return sendHtml(response, 410, expiredPage());
  }
  const principals = options.deps.records.principals;
  const signedIn = session === null ? null : await principals.authenticate(`Bearer ${session.token}`);
  // The account the page names: the invitation's, else the session's. The approval must name the same one.
  const named = open.invitation !== null ? { id: open.invitation.user, name: open.invitation.name, role: open.invitation.role, via: 'invitation' as const } : signedIn !== null ? { ...signedIn, via: 'session' as const } : null;
  const show = (status: number, error: string | null): void => {
    if (named === null) return sendHtml(response, status, identityPage(open, error));
    sendHtml(response, status, confirmPage(open, { id: named.id, name: named.name, role: uiLabelOf('permission_role', named.role) }, named.via, open.csrf, error), { 'content-security-policy': authorizeSecurityPolicy(open.redirectUri) });
  };
  const go = (location: string): void => {
    setCommonHeaders(response);
    response.writeHead(303, { location, 'content-length': '0', 'cache-control': 'no-store' });
    response.end();
  };
  if (request.method === 'GET') {
    if (open.ended !== null) return sendHtml(response, 200, endedPage(open));
    return show(200, null);
  }
  if (request.method !== 'POST') {
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET 和 POST</p>`), { allow: 'GET, POST' });
  }
  if (!sameOrigin(request, options.ownOrigins())) {
    request.resume();
    return forbidden(response, '连接确认表单只能从本控制台的页面提交');
  }
  const form = await formOf(request);
  if (form === 'aborted') return void response.destroy();
  if (typeof form === 'string' || form.get('csrf') !== open.csrf) return forbidden(response, '表单已过期或不是本控制台发出的，请在 Circle 中重新连接 Hub');
  const step = form.get('step');
  // A request is decided once: a second submit (a double click) waits for the first and gets the same answer.
  if (step === 'decide' && open.decision !== null) {
    const decided = await open.decision;
    return 'location' in decided ? go(decided.location) : show(decided.status, decided.error);
  }
  if (open.ended !== null) return sendHtml(response, 200, endedPage(open));
  if (step === 'identity') {
    const check = await principals.checkInvitation(form.get('code') ?? '');
    if (!check.ok) {
      open.failures += 1;
      if (open.failures >= MAX_INVITATION_FAILURES) {
        store!.end(open.id);
        return sendHtml(response, 410, expiredPage(`邀请码连续 ${MAX_INVITATION_FAILURES} 次未通过验证，该连接请求已结束。`));
      }
      return show(400, invitationProblem(check.reason));
    }
    open.invitation = { id: check.invitation, user: check.user.id, name: check.user.name, role: check.user.role };
    return redirect(response, `/console/authorize/${open.id}`);
  }
  if (step !== 'decide') return show(400, '请求不正确，请重新选择');
  const decision = form.get('decision');
  if (decision !== 'approve' && decision !== 'deny') return show(400, '请求不正确，请重新选择');
  const to = (params: Record<string, string>): { location: string } => ({ location: responseUri(open.redirectUri, { ...params, state: open.state, iss: open.issuer }) });
  const decide = async (): Promise<{ location: string } | { status: number; error: string }> => {
    if (decision === 'deny') {
      open.ended = 'denied';
      options.log(`标准授权：客户端 ${open.client.id}（${open.client.name}）的授权请求被拒绝`);
      return to({ error: 'access_denied', error_description: 'the request was refused' });
    }
    if (named === null) return { status: 401, error: '请先输入邀请码' };
    // The account must still be the one the page named: signing in as someone else in another tab changes nothing here.
    if (form.get('account') !== named.id) return { status: 409, error: '页面显示的账号已变化：请核对下面的账号后重新确认连接' };
    if (named.via === 'invitation' && (await principals.takeInvitation(open.invitation!.id, open.client.id)) === null) {
      open.invitation = null;
      return { status: 409, error: `邀请码已失效（已使用、已过期，或账号${uiLabelOf('account_status','disabled')}）：请管理员重新签发` };
    }
    const code = store!.grant(open, named.id);
    if (code === null) return { status: 409, error: '该连接请求已处理' };
    options.log(`标准授权：客户端 ${open.client.id}（${open.client.name}）获授权，账号 ${named.id}`);
    return to({ code });
  };
  open.decision = decide();
  const decided = await open.decision;
  // A refusal of the page (not of the request) lets the person try again.
  if (!('location' in decided)) open.decision = null;
  if ('location' in decided) return go(decided.location);
  return decided.status === 409 && open.invitation === null && named?.via === 'invitation' ? sendHtml(response, 409, identityPage(open, decided.error)) : show(decided.status, decided.error);
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
    sendHtml(response, status === 200 ? 409 : status, page(anonymous('初始化'), html`${message === null ? '' : html`<p class="error">${message}</p>`}<p>这个 Hub 已经有管理员；请用用户名和密码${link('/console/login', '登录')}。</p>`));
    return;
  }
  const nonce = options.sessions.issueNonce(secure);
  const body = page(
    { ...anonymous('创建首位管理员'), wide: true, hint: '使用初始化码创建首位管理员；管理员用户名必填，密码可留空。' },
    html`${stepper(SETUP_STEPS, 0)}${message === null ? '' : html`<p class="error">${message}</p>`}
<p class="ch-meta">初始化码 24 小时内有效，仅可使用一次</p>${technical(code('circle-hub setup-code'),'查看重新生成命令')}
<form method="post" action="/console/setup">
<div class="ch-field"><label class="ch-field-label" for="setup-code">初始化码</label><div class="ch-input"><input id="setup-code" name="code" autocomplete="off" size="40" required value="${prefill}"></div></div>
<div class="ch-field"><label class="ch-field-label" for="admin-name">管理员用户名</label><div class="ch-input"><input id="admin-name" name="name" autocomplete="off" size="24" required></div></div>
<div class="ch-field"><label class="ch-field-label" for="admin-password" title="可留空；留空则生成初始密码，仅显示一次，首次登录必须修改">管理员密码（可选）</label><div class="ch-input"><input id="admin-password" type="password" name="password" autocomplete="new-password" maxlength="256"></div></div>
<input type="hidden" name="csrf" value="${nonce}">
<button type="submit" class="ch-btn ch-btn--primary">创建管理员</button>
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
  // No session is opened here: like every account, the new administrator signs in with username and password.
  sendHtml(
    response,
    200,
    page(
      { ...anonymous('管理员已创建'), wide: true },
      html`${stepper(SETUP_STEPS, 2)}
<p>已创建管理员 ${outcome.name}。</p>${outcome.password === null ? '' : html`<p class="notice">初始密码仅显示一次；首次登录必须修改。</p>${pre(outcome.password)}`}
<p class="notice">下面是这位管理员的访问令牌，只用于连接 Circle，不能登录控制台；只显示这一次：现在复制，保存到只有本人能读的地方。离开这页后不再显示；遗失后由管理员重新签发。</p>
${pre(outcome.token)}
<h2>在 Circle 中连接这个 Hub</h2>
<h2 class="ch-section-label">${tooltip('连接 Circle','把配置写入 Circle 的 settings.json，首次连接时登录控制台并确认身份。')}</h2>
<pre class="ch-quote">${circleEntry(mcpOrigin(request, secure), false)}</pre>
<h2 class="ch-section-label">${tooltip('兼容连接方式','客户端不支持 MCP 标准连接确认时，在 Circle 中用 /secrets CIRCLE_HUB_TOKEN 保存令牌后采用下方配置。')}</h2>
<pre class="ch-quote">${circleEntry(mcpOrigin(request, secure))}</pre>
${secure ? html`${trustSteps()}` : ''}
<h2>接下来</h2>
<ol class="ch-meta"><li>${link('/console/operations/member', '添加成员')}</li><li>${link('/console/operations/system', '接入业务系统')}</li><li>${link('/console/operations/pack', '发布工作流')}</li><li>${link('/console/operations/knowledge', '导入知识')}</li></ol>
<p>${link('/console/login', '前往登录')}</p>`,
    ),
    { 'set-cookie': cookie(secure ? SECURE_SETUP_COOKIE : SETUP_COOKIE, '', '/console/setup', 0, secure) },
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
  knowledge: (ctx, _rest, options) => operationsPage(ctx, 'knowledge', options.jobs, options.staging),
};

const ROUTES: Record<string, Route> = {
  overview: (ctx, rest) => (rest.length === 0 ? overviewPage(ctx) : Promise.resolve(neutralPage(ctx))),
  results: (ctx, rest) => (rest.length === 0 ? resultsPage(ctx) : rest.length === 1 ? resultPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  runs: (ctx, rest) => (rest.length === 0 ? runsPage(ctx) : rest.length === 1 ? runPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx))),
  knowledge: (ctx, rest) => {
    if (rest.length === 0) return knowledgePage(ctx);
    if (rest.length > 1) return Promise.resolve(neutralPage(ctx));
    const pages: Record<string, (c: PageContext) => Promise<PageResult>> = { product: productPage, root: rootPage, tree: treePage, diff: diffPage, space:spacePage, submissions:shareHistoryPage, 'space-diff':spaceDiffPage, source:spaceSourcePage,'share-batch':batchSharePage };
    return Object.hasOwn(pages, rest[0]) ? pages[rest[0]](ctx) : Promise.resolve(neutralPage(ctx));
  },
  packs: (ctx, rest, options) => (rest.length === 0 ? packsPage(ctx) : rest.join('/')==='-/publish'?personalPublishPage(ctx,options.staging):rest.length===1?packPage(ctx,rest[0]):Promise.resolve(neutralPage(ctx))),
  connections: (ctx, rest) => (rest.length === 0 ? connectionsPage(ctx) : Promise.resolve(neutralPage(ctx))),
  records: (ctx, rest) => (rest.length === 0 ? recordsPage(ctx, '/console/records') : Promise.resolve(neutralPage(ctx))),
  search: (ctx, rest) => (rest.length === 0 ? searchPage(ctx) : Promise.resolve(neutralPage(ctx))),
  settings: (ctx, rest, options, session) => (rest.length === 0 ? settingsPage(ctx, bridgeRun(options, session)) : Promise.resolve(neutralPage(ctx))),
  team: (ctx, rest) => rest.length <= 1 ? teamPage(ctx, rest[0]) : Promise.resolve(neutralPage(ctx)),
  operations: (ctx, rest, options) => (rest.length <= 1 ? operationsPage(ctx, rest[0], options.jobs, options.staging) : Promise.resolve(neutralPage(ctx))),
  admin: (ctx, rest, options, session) => {
    if (!ctx.admin) return Promise.resolve(neutralPage(ctx));
    if (rest.length === 0) return teamPage(ctx);
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
  // The connection trial and its targeted stop reset run in this process, without a command or a saved configuration.
  if (!isPackStep(name) && !Object.hasOwn(ACTIONS, name) && name !== 'system-test' && name !== 'system-test-forget') {
    request.resume();
    return neutralPage(ctx);
  }
  let form: Form;
  let upload: Buffer | undefined;
  // The check of 发布任务包 takes the uploaded zip; every other action, the 发布 of a stage included, is a plain form.
  if (name === 'pack-stage') {
    const boundary = boundaryOf(request.headers['content-type']);
    if (boundary === null) {
      request.resume();
      forbidden(response, '上传请求的格式不对');
      return null;
    }
    const body = await readBody(request, options.deps.config.limits.maxUploadBytes + ACTION_FORM_LIMIT);
    if (!body.ok) {
      if (body.reason === 'aborted') response.destroy();
      else sendHtml(response, 413, page(ctx.chrome(publication(ctx).title,{active:publication(ctx).active}), html`<p class="error">上传的文件太大（上限 ${options.deps.config.limits.maxUploadBytes} 字节）</p>`));
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
  if (name === 'system-test') return systemTrialPage(ctx, form, await runTrial(ctx, form));
  if (name === 'system-test-forget') return systemForgetPage(ctx, form, await runForgetTrial(ctx, form));
  const result = await runAction(ctx, { bridge: options.bridge, jobs: options.jobs, staging: options.staging, log: options.log }, name, form, session.token, upload);
  if (name === 'password-reset' && result.status === 200) {
    const principals = options.deps.records.principals;
    const user = await principals.get(form.get('user')) ?? await principals.findByName(form.get('user'));
    if (user !== null) options.sessions.clearLoginAttempts(`account:${user.name}`);
  }
  return result;
}

/** What a page or an interface answer of one signed-in request knows; user names are cached for the request. */
function pageContext(options: ConsoleOptions, request: IncomingMessage, url: URL, principal: Principal, session: ConsoleSession, secure: boolean): PageContext {
  const names = new Map<string, Promise<string>>();
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
 * The read-only JSON interface (console/api.ts) and the event stream of the live updates (console/live.ts): GET or HEAD
 * only, the session of the pages; without one a 401 answer, not the redirect a page gets, so a client can tell the sign-in
 * ended.
 */
async function api(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions, session: ConsoleSession | null, secure: boolean, rest: string[]): Promise<void> {
  const headers = { 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
  if (request.method === 'POST' && writePath(rest.join('/'))) return apiWrite(request, response, url, options, session, secure, rest, headers);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    request.resume();
    return sendJson(response, 405, { code: null, message: '控制台接口只读，只接受 GET', fix: '用 GET 读取；管理操作在控制台页面或 Circle 中执行' }, { ...headers, allow: 'GET, HEAD' });
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

/** Handles every path under /console. */
export async function handleConsole(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions): Promise<void> {
  const segments = url.pathname.split('/').slice(2).filter((s) => s.length > 0);
  const secure = options.secureRequest(request);
  const cookieValue = cookiesOf(request).get(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE);
  // The live updates' own requests (the stream and the page fetches of script.ts) are not activity: an unattended page
  // still reaches the idle limit of its session.
  const automatic = request.headers['circle-hub-refresh'] === 'live' || (segments.length === 2 && segments[0] === 'api' && segments[1] === 'stream');
  const session = automatic ? options.sessions.peek(cookieValue, secure) : options.sessions.get(cookieValue, secure);
  // The console's icon: static, the same for everyone, signed in or not.
  if (segments.length === 1 && segments[0] === 'favicon.svg') {
    request.resume();
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET</p>`), { allow: 'GET, HEAD' });
    response.writeHead(200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : FAVICON_SVG);
    return;
  }
  if (segments[0] === 'login') {
    if (segments.length === 2) return loginLink(request, response, options, secure, segments[1]);
    if (segments.length !== 1) return sendHtml(response, 404, page(anonymous('没有这个页面'), html`<p>没有这个页面</p>`));
    if (request.method === 'GET') return loginPage(options, response, 200, null, secure, cookiesOf(request).get(secure ? SECURE_ENDED_COOKIE : ENDED_COOKIE) === '1', url.searchParams.get('next'));
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
  const signedIn = session === null ? null : await options.deps.records.principals.authenticate('Bearer '+session.token);
  const passwordState = signedIn === null ? null : await options.deps.records.principals.passwordState?.(signedIn.id);
  if (segments[0] === 'password') return passwordPage(request,response,url,options,session,signedIn,secure,segments.slice(1));
  if (passwordState?.mustChange) {
    request.resume();
    if (segments[0] === 'api') return sendJson(response,403,{code:null,message:'首次登录必须修改密码',fix:'前往 /console/password 修改密码'});
    return redirect(response,'/console/password?next='+encodeURIComponent(safeNext(url.pathname+url.search)));
  }
  if (segments[0] === 'authorize') return authorizePage(request, response, options, session, secure, segments.slice(1));
  if (segments[0] === 'api' && segments.length === 2 && segments[1] === 'login-links') return loginLinks(request, response, options, secure);
  if (segments[0] === 'api') return api(request, response, url, options, session, secure, segments.slice(1));
  const isAction = segments.length === 3 && segments[0] === 'admin' && segments[1] === 'do';
  const isKnowledgeAction=segments.length===3&&(segments[0]==='knowledge'||segments[0]==='packs')&&segments[1]==='do';
  if (isAction||isKnowledgeAction ? request.method !== 'POST' : request.method !== 'GET') {
    request.resume();
    return isAction||isKnowledgeAction
      ? sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>管理操作只接受 POST</p>`), { allow: 'POST' })
      : sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>这个页面只接受 GET</p>`), { allow: 'GET' });
  }
  const principal: Principal | null = session === null ? null : await options.deps.records.principals.authenticate(`Bearer ${session.token}`);
  if (principal === null) {
    if (isAction||isKnowledgeAction) request.resume();
    if (session !== null) options.sessions.close(session.id);
    // A session cookie the store no longer knows, or one whose token stopped working: the login page says the sign-in ended.
    const sent = cookiesOf(request).get(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE) !== undefined;
    const cookies = sent ? [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, '', '/console', 0, secure), cookie(secure ? SECURE_ENDED_COOKIE : ENDED_COOKIE, '1', '/console/login', 120, secure)] : [];
    // After signing in, a page leads back to itself (an action to its page, not to the form's target).
    const back = isAction || isKnowledgeAction || segments.length === 0 ? null : safeNext(`${url.pathname}${url.search}`);
    return redirect(response, back === null || back === HOME ? '/console/login' : `/console/login?next=${encodeURIComponent(back)}`, cookies);
  }
  if (segments.length === 0) return redirect(response, HOME);
  const ctx = pageContext(options, request, url, principal, session!, secure);
  let result: PageResult | null;
  try {
    if(isKnowledgeAction){
      if(!sameOrigin(request,options.ownOrigins())){request.resume();return forbidden(response,'表单只能从本控制台提交');}
      let values:URLSearchParams|Map<string,string>;
      let upload:{bytes:Buffer;name:string;mediaType:string}|undefined;
      if(mediaTypeOf(request)==='multipart/form-data'){
        const boundary=boundaryOf(request.headers['content-type']);if(!boundary){request.resume();return forbidden(response,'上传请求的格式不正确');}
        const read=await readBody(request,options.deps.config.limits.maxUploadBytes+ACTION_FORM_LIMIT);if(!read.ok){if(read.reason==='aborted')return void response.destroy();return sendHtml(response,413,page(ctx.chrome('原文超出大小上限'),html`<p>原文超出上传大小上限</p>`));}
        const multipart=parseMultipart(read.bytes,boundary);values=multipart.fields;const file=multipart.files.find(file=>file.field==='archive');
        if(file&&file.bytes.length>options.deps.config.limits.maxUploadBytes)return sendHtml(response,413,page(ctx.chrome('原文超出大小上限'),html`<p>原文超出上传大小上限</p>`));
        if(file)upload={bytes:file.bytes,name:file.filename,mediaType:mediaTypeFor(file.bytes,undefined,file.filename)};
      }else{const parsed=await formOf(request,ACTION_FORM_LIMIT);if(parsed==='aborted')return void response.destroy();if(parsed==='too_large')return sendHtml(response,413,page(ctx.chrome('表单超出大小上限'),html`<p>表单超出 ${ACTION_FORM_LIMIT} 字节上限</p>`));if(typeof parsed==='string')return forbidden(response,'表单格式不正确');values=parsed;}
      if(values.get('csrf')!==session!.csrf)return forbidden(response,'表单已过期或不是本控制台发出的');
      try{
        const target=segments[0]==='packs'?await performPersonalPackAction(ctx,segments[2],values,options.staging,upload):segments[2].startsWith('memory-')?await performMemoryAction(ctx,segments[2].slice(7),values):await performSpaceAction(ctx,segments[2],values,upload);
        if(values.get('preview_grant')!=='1'&&segments[2]!=='share-batch'&&segments[2]!=='memory-share'){
          // A replay may return an earlier mode receipt; feedback reports the current state, never a new purge.
          const state=segments[2]==='sync-mode'||segments[2]==='sync-resume'?await ctx.deps.records.personalSync?.state(ctx.principal):undefined;
          session!.notice=state?axisUiLabel('sync_mode')+'：'+uiLabelOf('sync_mode',state.mode):'操作已完成';
        }
        return request.headers['circle-hub-form']==='enhanced'?sendJson(response,200,{location:target},{'content-security-policy':"default-src 'none'; frame-ancestors 'none'"}):redirect(response,target);
      }catch(error){result=spaceActionFailure(ctx,error);}
    }else if (isAction) {
      result = await action(request, response, options, ctx, session!, segments[2]);
      if (result === null) return;
    } else {
      const route = Object.hasOwn(ROUTES, segments[0]) ? ROUTES[segments[0]] : undefined;
      result = route === undefined ? neutralPage(ctx) : await withReadScope(()=>route(ctx, segments.slice(1), options, session!));
    }
  } catch (error) {
    if(error instanceof KnowledgeError&&error.code){result=spaceActionFailure(ctx,error);}
    else if(error instanceof UploadError&&isKnowledgeAction){result={status:400,body:page(ctx.chrome('原文上传未完成'),html`<p class="error">${error.message}</p>`)};}
    else if (error instanceof RecordsError && (error.code === null||isKnowledgeAction&&error.code==='CREDENTIAL_IN_UPLOAD') && !(error.name === 'IntegrityError')) {
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
