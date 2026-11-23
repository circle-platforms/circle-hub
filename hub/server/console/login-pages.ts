import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_ADMIN_NAME, LimitError, validPassword, type Principal } from '../../records/api.ts';
import { cookiesOf } from '../http.ts';
import { errorLine, postForm } from './components.ts';
import { tooltip, technical } from './presentation.ts';
import { code, html, link, page, pre } from './html.ts';
import { completeSetup } from './manage.ts';
import { NEUTRAL } from './context.ts';
import { circleEntry, trustSteps } from './settings.ts';
import {
  LOGIN_COOKIE, SECURE_LOGIN_COOKIE, SESSION_COOKIE, SECURE_SESSION_COOKIE,
  cookie, safeNext, type ConsoleSession,
} from './session.ts';
import { stepper } from './ui.ts';
import {
  type ConsoleOptions, SETUP_COOKIE, SECURE_SETUP_COOKIE,
  ENDED_COOKIE, SECURE_ENDED_COOKIE, HOME,
  sendHtml, redirect, anonymous, hasAdmin, forbidden, sameOrigin, formOf, fields, mcpOrigin,
} from './console-http.ts';

export async function loginPage(options: ConsoleOptions, response: ServerResponse, status: number, message: string | null, secure: boolean, ended = false, next: string | null = null): Promise<void> {
  const nonce = options.sessions.issueNonce(secure);
  const setup = await hasAdmin(options.deps) ? '' : html`<p class="notice">这个 Hub 还没有管理员：${link('/console/setup', '用初始化码创建首位管理员')}</p>`;
  const scan = await options.deps.records.vault?.has?.('personal-bot.identity')?.catch(() => false)
    ? html`<p class="notice">${link('/console/identity/login', '扫码登录', next ? { next: safeNext(next) } : {})}</p>`
    : '';
  const body = page(
    anonymous('登录'),
    html`${message === null ? '' : errorLine(message)}${ended ? html`<p class="notice">登录已过期或已退出，请重新登录。</p>` : ''}${setup}${scan}
${postForm({
  action: '/console/login',
  csrf: nonce,
  fields: html`<div class="ch-field"><label class="ch-field-label" for="hub-username">用户名</label><div class="ch-input"><input id="hub-username" name="username" autocomplete="username" maxlength="200" required></div></div>
<div class="ch-field"><label class="ch-field-label" for="hub-password" title="所有账户都用用户名和密码登录；访问令牌只用于连接客户端。忘记密码时由管理员在团队页重置，管理员本人可在运行 Hub 的服务器上执行 circle-hub user password-reset">密码</label><div class="ch-input"><input id="hub-password" type="password" name="password" autocomplete="current-password" maxlength="256" required></div></div>
${next === null ? '' : html`<input type="hidden" name="next" value="${safeNext(next)}">`}`,
  submit: '登录',
})}`,
  );
  const cookies = [cookie(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE, nonce, '/console/login', 15 * 60, secure)];
  if (ended) cookies.push(cookie(secure ? SECURE_ENDED_COOKIE : ENDED_COOKIE, '', '/console/login', 0, secure));
  sendHtml(response, status, body, { 'set-cookie': cookies.length === 1 ? cookies[0] : cookies });
}

export async function login(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions): Promise<void> {
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
  const accountKey = 'account:' + name;
  if (!options.sessions.takeLoginAttempt(accountKey) || !options.sessions.takeLoginAttempt(peerKey, 50)) return loginPage(options, response, 429, '登录失败次数过多，请在 15 分钟后重试', secure);
  const principals = options.deps.records.principals;
  let token: string | null = null;
  try {
    const verified = await principals.verifyPassword(name, form.get('password') ?? '');
    if (verified) token = (await principals.openConsoleSession(verified.user.id, verified.revision))?.token ?? null;
  } catch (error) {
    if (error instanceof LimitError) return loginPage(options, response, 429, '密码校验繁忙，请稍后重试', secure);
    throw error;
  }
  if (token === null) return loginPage(options, response, 401, '用户名或密码无效，或账号不可用', secure);
  options.sessions.clearLoginAttempts(accountKey); options.sessions.clearLoginAttempts(peerKey);
  const session = options.sessions.open(token, secure);
  const principal = await (principals.authenticateConsoleSession?.('Bearer ' + token) ?? principals.authenticate('Bearer ' + token));
  const state = principal ? await principals.passwordState?.(principal.id) : null;
  const next = safeNext(form.get('next'));
  const home = principal?.role === 'admin' ? HOME : '/console/me';
  const destination = next === HOME && principal?.role !== 'admin' ? home : next;
  redirect(response, state?.mustChange ? '/console/password?next=' + encodeURIComponent(destination) : destination, [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, session.token, '/console', undefined, secure), cookie(secure ? SECURE_LOGIN_COOKIE : LOGIN_COOKIE, '', '/console/login', 0, secure)]);
}

export async function passwordPage(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions, session: ConsoleSession | null, principal: Principal | null, secure: boolean, rest: string[]): Promise<void> {
  if (!session || !principal) { request.resume(); return redirect(response, '/console/login'); }
  const mustChange = (await options.deps.records.principals.passwordState(principal.id)).mustChange;
  if (rest.length > 0) { request.resume(); return sendHtml(response, 404, page(anonymous(NEUTRAL), html``)); }
  const show = (status: number, message = '') => sendHtml(response, status, page(anonymous('修改密码'), html`
<p>${principal.name}</p>${mustChange ? html`<p class="notice">首次登录必须修改密码。</p>` : ''}${message ? errorLine(message) : ''}
${postForm({
  action: '/console/password',
  csrf: session.csrf,
  fields: html`<input type="hidden" name="next" value="${safeNext(url.searchParams.get('next'))}">
<input type="text" name="username" value="${principal.name}" autocomplete="username" hidden readonly>
<div class="ch-field"><label class="ch-field-label" for="current-password">当前密码</label><div class="ch-input"><input id="current-password" type="password" name="current" autocomplete="current-password" maxlength="256" required></div></div>
<div class="ch-field"><label class="ch-field-label" for="new-password" title="12 至 256 个字符，不含控制字符">新密码</label><div class="ch-input"><input id="new-password" type="password" name="password" autocomplete="new-password" minlength="12" maxlength="256" required></div></div>
<div class="ch-field"><label class="ch-field-label" for="confirm-password">再次输入新密码</label><div class="ch-input"><input id="confirm-password" type="password" name="confirm" autocomplete="new-password" maxlength="256" required></div></div>`,
  submit: '修改密码',
})}`));
  if (request.method === 'GET') return show(200);
  if (request.method !== 'POST') { request.resume(); return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 POST</p>`), { allow: 'POST' }); }
  if (!sameOrigin(request, options.ownOrigins())) { request.resume(); return forbidden(response, '密码表单只能从本控制台提交'); }
  const form = await formOf(request);
  if (typeof form === 'string' || form.get('csrf') !== session.csrf) return forbidden(response, '表单已过期或不是本控制台发出的');
  const key = 'password:' + principal.id;
  if (!options.sessions.takeLoginAttempt(key)) return show(429, '密码操作失败次数过多，请在 15 分钟后重试');
  try {
    const password = form.get('password') ?? '';
    if (!validPassword(password) || password !== form.get('confirm')) return show(400, '新密码须为 12 至 256 个字符，不含控制字符，且两次输入一致');
    const principals = options.deps.records.principals;
    if (!await principals.changePassword(principal, form.get('current') ?? '', password)) return show(400, '当前密码无效，或新密码与当前密码相同');
    options.sessions.clearLoginAttempts(key);
    options.sessions.close(session.token);
    const next = safeNext(form.get('next')), state = await principals.passwordState(principal.id);
    const token = state.mustChange ? null : (await principals.openConsoleSession(principal.id, state.revision))?.token ?? null;
    if (token !== null) {
      const fresh = options.sessions.open(token, secure);
      return sendHtml(response, 200, page(anonymous('密码已修改'), html`<p>密码已修改；该账户其他的控制台会话已失效。</p><p>${link(next, '继续')}</p>`), { 'set-cookie': cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, fresh.token, '/console', undefined, secure) });
    }
    sendHtml(response, 200, page(anonymous('密码已修改'), html`<p>请用新密码重新登录。</p><p>${link('/console/login', '登录', { next })}</p>`), { 'set-cookie': cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, '', '/console', 0, secure) });
  } catch (error) {
    if (error instanceof LimitError) return show(429, '密码校验繁忙，请稍后重试');
    if (error instanceof TypeError) return show(400, '密码格式不正确');
    throw error;
  }
}

export async function logout(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions, session: ConsoleSession | null): Promise<void> {
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
  await options.deps.records.principals.revokeTokenValue(session.token);
  options.sessions.close(session.token);
  redirect(response, '/console/login', [cookie(secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, '', '/console', 0, secure)]);
}

const SETUP_STEPS = ['初始化码', '创建管理员', '连接客户端', '完成'] as const;

export async function setupPage(options: ConsoleOptions, response: ServerResponse, status: number, message: string | null, secure: boolean, prefill = ''): Promise<void> {
  if (await hasAdmin(options.deps)) {
    sendHtml(response, status === 200 ? 409 : status, page(anonymous('初始化'), html`${message === null ? '' : errorLine(message)}<p>这个 Hub 已经有管理员；请用用户名和密码${link('/console/login', '登录')}。</p>`));
    return;
  }
  const nonce = options.sessions.issueNonce(secure);
  const body = page(
    { ...anonymous('创建首位管理员'), wide: true, hint: `使用初始化码创建首位管理员；管理员用户名默认为 ${DEFAULT_ADMIN_NAME}，可以修改，密码可留空。` },
    html`${stepper(SETUP_STEPS, 0)}${message === null ? '' : errorLine(message)}
<p class="ch-meta">初始化码 24 小时内有效，仅可使用一次</p>${technical(code('circle-hub setup-code'), '查看重新生成命令')}
${postForm({
  action: '/console/setup',
  csrf: nonce,
  fields: html`<div class="ch-field"><label class="ch-field-label" for="setup-code">初始化码</label><div class="ch-input"><input id="setup-code" name="code" autocomplete="off" size="40" required value="${prefill}"></div></div>
<div class="ch-field"><label class="ch-field-label" for="admin-name">管理员用户名</label><div class="ch-input"><input id="admin-name" name="name" autocomplete="off" size="24" required value="${DEFAULT_ADMIN_NAME}"></div></div>
<div class="ch-field"><label class="ch-field-label" for="admin-password" title="可留空；留空则生成初始密码，仅显示一次，首次登录必须修改">管理员密码（可选）</label><div class="ch-input"><input id="admin-password" type="password" name="password" autocomplete="new-password" maxlength="256"></div></div>`,
  submit: '创建管理员',
})}
${secure ? trustSteps() : ''}`,
  );
  sendHtml(response, status, body, { 'set-cookie': cookie(secure ? SECURE_SETUP_COOKIE : SETUP_COOKIE, nonce, '/console/setup', 15 * 60, secure) });
}

export async function setup(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions): Promise<void> {
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
  sendHtml(
    response,
    200,
    page(
      { ...anonymous('管理员已创建'), wide: true },
      html`${stepper(SETUP_STEPS, 2)}
<p>已创建管理员 ${outcome.name}。</p>${outcome.password === null ? '' : html`<p class="notice">初始密码仅显示一次；首次登录必须修改。</p>${pre(outcome.password)}`}
<p class="notice">下面是这位管理员的访问令牌，只用于连接客户端，不能登录控制台；只显示这一次：现在复制，保存到只有本人能读的地方。离开这页后不再显示；遗失后由管理员重新签发。</p>
${pre(outcome.token)}
<h2>在客户端中连接这个 Hub</h2>
<h2 class="ch-section-label">${tooltip('MCP 标准连接确认', '下面是 mcpServers 格式的条目；其他客户端按各自的格式填写同一 MCP 地址。首次连接时登录控制台并确认身份。')}</h2>
<pre class="ch-quote"><code>${circleEntry(mcpOrigin(request, secure), false)}</code></pre>
<h2 class="ch-section-label">${tooltip('兼容连接方式', '客户端不支持 MCP 标准连接确认时，把令牌保存为客户端的密钥 CIRCLE_HUB_TOKEN，再采用下方配置。')}</h2>
<pre class="ch-quote"><code>${circleEntry(mcpOrigin(request, secure))}</code></pre>
${secure ? html`${trustSteps()}` : ''}
<h2>接下来</h2>
<ol class="ch-meta"><li>${link('/console/operations/member', '添加成员')}</li><li>${link('/console/operations/system', '接入业务系统')}</li><li>${link('/console/operations/pack', '发布工作流')}</li><li>${link('/console/operations/knowledge', '导入知识')}</li></ol>
<p>${link('/console/login', '前往登录')}</p>`,
    ),
    { 'set-cookie': cookie(secure ? SECURE_SETUP_COOKIE : SETUP_COOKIE, '', '/console/setup', 0, secure) },
  );
}
