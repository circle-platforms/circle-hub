// /console: sign-in with username and password (every account; a token only connects a Circle), then the places of the design canvas (总览, 任务, 知识库, 工作流, 技能, 连接, 记录,
// 设置, and 运行状况 for administrators) and the four management operations of proposal decision 6 (2026-10-31), which post to the actions of owner
// decision 122. Workflows live at /console/workflows; skills at /console/skills; second admin page entries are gone.
// /console/results and POST /console/admin/do/<action> remain. The session cookie is HttpOnly, SameSite=Strict and scoped to
// /console. Every POST form (sign-in, sign-out, first-admin setup and the management actions under /console/admin/do/)
// carries a CSRF token the server issued and must come from this server's own origin; a management action also needs an
// administrator's session. Every request re-authenticates the session's token, so revoking it or disabling the account
// ends the session. Everything that is not one of those forms is GET only.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type Principal } from '../../records/api.ts';
import { step, updateTrace } from '../../telemetry/api.ts';
import { identifyRequest } from '../request-entry.ts';
import { cookiesOf, sendJson } from '../http.ts';
import { sendConsoleAsset } from './assets.ts';
import { authorizePage, authorizeRefusal, devicePage } from './authorize-page.ts';
import { api } from './console-api-http.ts';
import { type ConsoleOptions, ENDED_COOKIE, SECURE_ENDED_COOKIE, HOME, sendHtml, redirect, anonymous, pageContext } from './console-http.ts';
import { handleAuthenticatedConsole } from './console-posts.ts';
import { FAVICON_SVG, html, page } from './html.ts';
import { login, loginLink, loginLinks, loginPage, logout, passwordPage, setup, setupPage } from './login-pages.ts';
import { SESSION_COOKIE, SECURE_SESSION_COOKIE, cookie, safeNext } from './session.ts';

export type { ConsoleOptions } from './console-http.ts';
export { authorizeRefusal };

/** Handles every path under /console. */
export async function handleConsole(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions): Promise<void> {
  if (url.pathname.startsWith('/console/assets/')) return sendConsoleAsset(request, response, url);
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
      'content-security-policy': `default-src 'none'; style-src 'sha256-${createHash('sha256').update(/<style>([\s\S]*?)<\/style>/.exec(FAVICON_SVG)![1]).digest('base64')}'`,
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
  const signedIn = session === null ? null : await step('authenticate', () => options.deps.records.principals.authenticate('Bearer ' + session.token), { type: 'guardrail' });
  if (signedIn !== null) {
    updateTrace({ userId: signedIn.id });
    identifyRequest(request, { userId: signedIn.id });
  }
  const passwordState = signedIn === null ? null : await options.deps.records.principals.passwordState?.(signedIn.id);
  if (segments[0] === 'password') return passwordPage(request, response, url, options, session, signedIn, secure, segments.slice(1));
  if (passwordState?.mustChange) {
    request.resume();
    if (segments[0] === 'api') return sendJson(response, 403, { code: null, message: '首次登录必须修改密码', fix: '前往 /console/password 修改密码' });
    return redirect(response, '/console/password?next=' + encodeURIComponent(safeNext(url.pathname + url.search)));
  }
  if (segments[0] === 'authorize') return authorizePage(request, response, options, session, secure, segments.slice(1));
  if (segments[0] === 'device' && segments.length === 1) return devicePage(request, response, url, options, secure);
  if (segments[0] === 'api' && segments.length === 2 && segments[1] === 'login-links') return loginLinks(request, response, options, secure);
  if (segments[0] === 'api') return api(request, response, url, options, session, secure, segments.slice(1));
  const isAction = segments.length === 3 && segments[0] === 'admin' && segments[1] === 'do';
  const isKnowledgeAction = segments.length === 3 && (segments[0] === 'knowledge' || segments[0] === 'workflows' || segments[0] === 'skills') && segments[1] === 'do';
  if (isAction || isKnowledgeAction ? request.method !== 'POST' : request.method !== 'GET') {
    request.resume();
    return isAction || isKnowledgeAction
      ? sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>管理操作只接受 POST</p>`), { allow: 'POST' })
      : sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>这个页面只接受 GET</p>`), { allow: 'GET' });
  }
  const principal: Principal | null = session === null ? null : await options.deps.records.principals.authenticate(`Bearer ${session.token}`);
  if (principal === null) {
    if (isAction || isKnowledgeAction) request.resume();
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
  return handleAuthenticatedConsole(request, response, url, options, ctx, session!, principal, segments, isAction, isKnowledgeAction);
}
