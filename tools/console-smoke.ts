// Read-only console smoke probe: verifies unauthenticated redirects, admin GET access across all console routes,
// optional member team-isolation and admin-route denial, and login/logout session handling without mutating Hub data.
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { uiLabelOf } from '../contracts/generated/vocabulary.ts';
import {
  connectionsPath,
  faviconPath,
  healthPath,
  knowledgePath,
  knowledgeProductsPath,
  knowledgeSourcesPath,
  knowledgeSpacePath,
  knowledgeSubmissionsPath,
  loginPath,
  logoutPath,
  mePath,
  operationsKnowledgePath,
  operationsMemberPath,
  operationsPackPath,
  operationsPath,
  operationsSystemPath,
  overviewPath,
  passwordPath,
  rebuildPath,
  recordsPath,
  resultsPath,
  roundsPath,
  runsPath,
  searchPath,
  settingsPath,
  skillsPath,
  teamPath,
  teamsPath,
  workflowsPath,
} from '../hub/server/console/routes.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const TITLE_SUFFIX = ' · circle-hub';
const SERVER_ERROR_TITLE = 'Hub 内部错误';
const SERVER_ERROR_BODY = 'Hub 内部错误，原因已记入服务日志';
const NEUTRAL_TEXT = '该内容不存在或无权查看';
const BAD_REQUEST_TITLE = '请求有误';
const FORBIDDEN_TITLE = '拒绝';
const METHOD_NOT_ALLOWED_TITLE = '方法不允许';
const LOGIN_COOKIE_NAMES = ['__Secure-circle_hub_login', 'circle_hub_login'] as const;
const SESSION_COOKIE_NAMES = ['__Secure-circle_hub_session', 'circle_hub_session'] as const;
const WORKFLOW_TITLE = uiLabelOf('pack_kind', 'workflow');
const SKILLS_TITLE = '技能';
/** The member home (/console/me) is titled 我能做的事 for the signed-in account, administrators included. */
const ME_TITLE = '我能做的事';

export type SmokePhase = '未登录' | '管理员' | '普通成员';

export interface RouteProbeSpec {
  readonly path: string;
  readonly expectedTitle: string;
  readonly label?: string;
}

/** Parameterless protected GET routes checked for anonymous 303 redirect and authenticated admin 200 rendering. */
export const ADMIN_GET_ROUTES: readonly RouteProbeSpec[] = [
  { path: overviewPath(), expectedTitle: '总览' },
  { path: mePath(), expectedTitle: ME_TITLE },
  { path: teamPath(), expectedTitle: '团队' },
  { path: `${teamPath()}?tab=members`, expectedTitle: '团队' },
  { path: `${teamPath()}?tab=clients`, expectedTitle: '团队' },
  { path: teamsPath(), expectedTitle: '团队' },
  { path: workflowsPath(), expectedTitle: WORKFLOW_TITLE },
  { path: `${workflowsPath()}/-/publish`, expectedTitle: '发布我的工作流或通用技能' },
  { path: skillsPath(), expectedTitle: SKILLS_TITLE },
  { path: knowledgePath(), expectedTitle: '知识库' },
  { path: `${knowledgePath()}?view=sources`, expectedTitle: '知识库' },
  { path: `${knowledgePath()}?view=memory`, expectedTitle: '知识库' },
  { path: knowledgeProductsPath(), expectedTitle: '知识库' },
  { path: `${knowledgeSpacePath()}?space=team`, expectedTitle: '知识库' },
  { path: knowledgeSubmissionsPath(), expectedTitle: '分享到公共空间记录' },
  { path: knowledgeSourcesPath(), expectedTitle: '知识库' },
  { path: runsPath(), expectedTitle: '任务' },
  { path: roundsPath(), expectedTitle: '一轮编译' },
  { path: resultsPath(), expectedTitle: '生产结果' },
  { path: searchPath(), expectedTitle: '搜索' },
  { path: connectionsPath(), expectedTitle: '连接' },
  { path: recordsPath(), expectedTitle: '记录' },
  { path: settingsPath(), expectedTitle: '设置' },
  { path: `${settingsPath()}?tab=hub`, expectedTitle: '设置' },
  { path: passwordPath(), expectedTitle: '修改密码' },
  { path: healthPath(), expectedTitle: '运行状况' },
  { path: operationsPath(), expectedTitle: '管理操作' },
  { path: operationsMemberPath(), expectedTitle: '添加成员' },
  { path: operationsSystemPath(), expectedTitle: '接入业务系统' },
  { path: operationsPackPath(), expectedTitle: WORKFLOW_TITLE === '工作流' ? '发布工作流' : `发布${WORKFLOW_TITLE}` },
  { path: operationsKnowledgePath(), expectedTitle: '导入公共知识' },
];

/** Protected GET paths that must redirect to login when visited anonymously (`rebuildPath()` is checked separately via rebuild handler rules). */
export const PROTECTED_REDIRECT_PATHS: readonly string[] = [
  ...ADMIN_GET_ROUTES.map((route) => route.path),
  '/console/admin/jobs/smoke-probe',
];

/** Admin-only pages that an ordinary member must not be able to open (404 neutral response). */
export const MEMBER_BLOCKED_ADMIN_PATHS: readonly string[] = [
  healthPath(),
  operationsPath(),
  operationsMemberPath(),
  operationsSystemPath(),
  operationsPackPath(),
  operationsKnowledgePath(),
  '/console/admin/jobs/smoke-probe',
];

/** Common GET pages also checked under the optional ordinary member session (besides team isolation & settings/rebuild checks). */
export const MEMBER_COMMON_GET_ROUTES: readonly RouteProbeSpec[] = [
  { path: overviewPath(), expectedTitle: '总览' },
  { path: mePath(), expectedTitle: ME_TITLE },
  { path: workflowsPath(), expectedTitle: WORKFLOW_TITLE },
  { path: skillsPath(), expectedTitle: SKILLS_TITLE },
  { path: knowledgePath(), expectedTitle: '知识库' },
  { path: `${knowledgePath()}?view=sources`, expectedTitle: '知识库' },
  { path: `${knowledgePath()}?view=memory`, expectedTitle: '知识库' },
  { path: knowledgeProductsPath(), expectedTitle: '知识库' },
  { path: `${knowledgeSpacePath()}?space=team`, expectedTitle: '知识库' },
  { path: knowledgeSubmissionsPath(), expectedTitle: '分享到公共空间记录' },
  { path: knowledgeSourcesPath(), expectedTitle: '知识库' },
  { path: runsPath(), expectedTitle: '任务' },
  { path: roundsPath(), expectedTitle: '一轮编译' },
  { path: resultsPath(), expectedTitle: '生产结果' },
  { path: searchPath(), expectedTitle: '搜索' },
  { path: connectionsPath(), expectedTitle: '连接' },
  { path: recordsPath(), expectedTitle: '记录' },
  { path: settingsPath(), expectedTitle: '设置' },
  { path: passwordPath(), expectedTitle: '修改密码' },
];

export interface HttpResponseData {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
}

export type HttpRequester = (input: {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  ca?: string;
  timeoutMs: number;
}) => Promise<HttpResponseData>;

export interface SmokeAccountCredentials {
  readonly username: string;
  readonly password: string;
}

export interface ConsoleSmokeOptions {
  readonly baseUrl: string;
  readonly admin: SmokeAccountCredentials;
  readonly member?: SmokeAccountCredentials & {
    readonly memberTeams?: readonly string[];
    readonly excludedTeams?: readonly string[];
  };
  readonly ca?: string;
  readonly timeoutMs?: number;
  readonly requester?: HttpRequester;
}

export interface SmokeCheckResult {
  readonly phase: SmokePhase;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly status: number;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ConsoleSmokeReport {
  readonly ok: boolean;
  readonly checks: readonly SmokeCheckResult[];
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

const REQUEST_METHOD_GUARD_MSG = '只读冒烟脚本禁止除登录与登出之外的非 GET 请求';

/** Executes a single HTTP/HTTPS request without following redirects; refuses any non-GET except login/logout POST. */
export const defaultHttpRequester: HttpRequester = ({ url, method, headers, body, ca, timeoutMs }) => {
  if (method !== 'GET' && url.pathname !== loginPath() && url.pathname !== logoutPath()) {
    return Promise.reject(new Error(`${REQUEST_METHOD_GUARD_MSG}: ${method} ${url.pathname}`));
  }
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<HttpResponseData>((resolvePromise, rejectPromise) => {
    const request = client.request(
      url,
      {
        method,
        headers,
        ...(url.protocol === 'https:' && ca !== undefined ? { ca, rejectUnauthorized: true } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
          size += buf.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error(`响应超过 ${MAX_RESPONSE_BYTES} 字节`));
            return;
          }
          chunks.push(buf);
        });
        response.on('end', () => {
          const outHeaders: Record<string, string | string[]> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) outHeaders[key.toLowerCase()] = value;
          }
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: outHeaders,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', rejectPromise);
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`请求超时（${timeoutMs} ms）: ${method} ${url.pathname}`)));
    request.on('error', rejectPromise);
    if (body !== undefined) request.write(body, 'utf8');
    request.end();
  });
};

function normalizeBaseUrl(raw: string): URL {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`基础地址仅支持 http 或 https：${raw}`);
  }
  return new URL(parsed.origin);
}

function headerFirst(headers: Record<string, string | string[]>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function setCookiesOf(headers: Record<string, string | string[]>): string[] {
  const value = headers['set-cookie'];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function updateCookieJar(jar: Map<string, string>, headers: Record<string, string | string[]>): void {
  for (const raw of setCookiesOf(headers)) {
    const pair = raw.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (val === '' || /;\s*Max-Age=0\b/i.test(raw)) jar.delete(name);
    else jar.set(name, val);
  }
}

function cookieHeader(jar: Map<string, string>): string | undefined {
  if (jar.size === 0) return undefined;
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function pickCookie(jar: Map<string, string>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = jar.get(name);
    if (value !== undefined && value !== '') return `${name}=${value}`;
  }
  return undefined;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitle(body: string): string | null {
  const match = /<title>([^<]*)<\/title>/i.exec(body);
  if (!match) return null;
  const full = decodeHtmlEntities(match[1].trim());
  return full.endsWith(TITLE_SUFFIX) ? full.slice(0, -TITLE_SUFFIX.length) : full;
}

function extractCsrf(body: string): string | null {
  const match = /name="csrf"\s+value="([^"]+)"/i.exec(body) ?? /value="([^"]+)"\s+name="csrf"/i.exec(body);
  return match ? decodeHtmlEntities(match[1]) : null;
}

function redirectPathname(base: URL, location: string | undefined): string | null {
  if (!location) return null;
  try {
    return new URL(location, base).pathname;
  } catch {
    return null;
  }
}

/** Extracts visible team names from `/console/team` / `/console/teams` table links (`/console/team/tm_...`). */
export function extractTeamNames(body: string): string[] {
  const seen = new Set<string>();
  const pattern = /href="\/console\/team(?:s)?\/(tm_[^"?#"]+)"[^>]*>([^<]+)<\/a>/gi;
  for (const match of body.matchAll(pattern)) {
    const name = decodeHtmlEntities(match[2].trim());
    if (name !== '') seen.add(name);
  }
  return [...seen];
}

function htmlErrorReasons(body: string, title: string | null, expectNeutral = false): string[] {
  const reasons: string[] = [];
  if (title === SERVER_ERROR_TITLE || body.includes(SERVER_ERROR_BODY)) reasons.push(`出现服务器错误页面（${SERVER_ERROR_TITLE}）`);
  if (!expectNeutral && (title === NEUTRAL_TEXT || body.includes(NEUTRAL_TEXT))) reasons.push(`出现无权/不存在页面（${NEUTRAL_TEXT}）`);
  if (title === BAD_REQUEST_TITLE) reasons.push(`页面标题为「${BAD_REQUEST_TITLE}」`);
  if (title === FORBIDDEN_TITLE) reasons.push(`页面标题为「${FORBIDDEN_TITLE}」`);
  if (title === METHOD_NOT_ALLOWED_TITLE) reasons.push(`页面标题为「${METHOD_NOT_ALLOWED_TITLE}」`);
  return reasons;
}

function validateRenderedHtml(
  response: HttpResponseData,
  expectedTitle: string,
): { ok: true; title: string } | { ok: false; reason: string } {
  if (response.status !== 200) {
    const title = extractTitle(response.body);
    return {
      ok: false,
      reason: `期望 HTTP 200，实际 HTTP ${response.status}${title ? `（标题：${title}）` : ''}`,
    };
  }
  const contentType = headerFirst(response.headers, 'content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    return { ok: false, reason: `期望 text/html，实际 Content-Type: ${contentType || '缺失'}` };
  }
  const title = extractTitle(response.body);
  const errors = htmlErrorReasons(response.body, title);
  if (errors.length > 0) return { ok: false, reason: errors.join('；') };
  if (title !== expectedTitle) {
    return { ok: false, reason: `期望标题「${expectedTitle}」，实际「${title ?? '缺失'}」` };
  }
  if (!response.body.includes('</html>')) return { ok: false, reason: 'HTML 响应不完整（缺少 </html>）' };
  return { ok: true, title };
}

class ConsoleSessionClient {
  readonly #base: URL;
  readonly #requester: HttpRequester;
  readonly #ca: string | undefined;
  readonly #timeoutMs: number;
  readonly #jar = new Map<string, string>();
  lastCsrf: string | null = null;

  constructor(base: URL, requester: HttpRequester, timeoutMs: number, ca?: string) {
    this.#base = base;
    this.#requester = requester;
    this.#timeoutMs = timeoutMs;
    this.#ca = ca;
  }

  async send(method: 'GET' | 'POST', path: string, formBody?: URLSearchParams, refererPath?: string): Promise<HttpResponseData> {
    if (method !== 'GET' && path !== loginPath() && path !== logoutPath()) {
      throw new Error(`${REQUEST_METHOD_GUARD_MSG}: ${method} ${path}`);
    }
    const url = new URL(path, this.#base);
    const headers: Record<string, string> = {};
    const cookie = cookieHeader(this.#jar);
    if (cookie !== undefined) headers.cookie = cookie;
    let body: string | undefined;
    if (method === 'POST') {
      headers.origin = this.#base.origin;
      headers.referer = new URL(refererPath ?? path, this.#base).href;
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = (formBody ?? new URLSearchParams()).toString();
    }
    const response = await this.#requester({
      url,
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(this.#ca === undefined ? {} : { ca: this.#ca }),
      timeoutMs: this.#timeoutMs,
    });
    updateCookieJar(this.#jar, response.headers);
    const csrf = extractCsrf(response.body);
    if (csrf !== null) this.lastCsrf = csrf;
    return response;
  }

  hasSessionCookie(): boolean {
    return pickCookie(this.#jar, SESSION_COOKIE_NAMES) !== undefined;
  }

  hasLoginCookie(): boolean {
    return pickCookie(this.#jar, LOGIN_COOKIE_NAMES) !== undefined;
  }

  cookieSnapshot(): Map<string, string> {
    return new Map(this.#jar);
  }
}

async function runUnauthenticatedChecks(
  base: URL,
  requester: HttpRequester,
  timeoutMs: number,
  ca: string | undefined,
  checks: SmokeCheckResult[],
): Promise<void> {
  const anon = new ConsoleSessionClient(base, requester, timeoutMs, ca);
  const loginRes = await anon.send('GET', loginPath());
  const loginHtml = validateRenderedHtml(loginRes, '登录');
  if (!loginHtml.ok) {
    checks.push({ phase: '未登录', method: 'GET', path: loginPath(), status: loginRes.status, ok: false, detail: loginHtml.reason });
  } else if (!loginRes.body.includes('name="username"') || !loginRes.body.includes('name="password"') || !anon.hasLoginCookie() || !extractCsrf(loginRes.body)) {
    checks.push({ phase: '未登录', method: 'GET', path: loginPath(), status: loginRes.status, ok: false, detail: '登录页缺少表单字段、CSRF 或登录 Cookie' });
  } else {
    checks.push({ phase: '未登录', method: 'GET', path: loginPath(), status: loginRes.status, ok: true, detail: '登录页可打开（登录）' });
  }

  const favRes = await anon.send('GET', faviconPath());
  const favType = (headerFirst(favRes.headers, 'content-type') ?? '').toLowerCase();
  const favOk = favRes.status === 200 && favType.includes('image/svg+xml') && favRes.body.includes('<svg');
  checks.push({
    phase: '未登录',
    method: 'GET',
    path: faviconPath(),
    status: favRes.status,
    ok: favOk,
    detail: favOk ? '控制台图标可访问' : `期望 200 image/svg+xml，实际 HTTP ${favRes.status}（${favType || '无 Content-Type'}）`,
  });

  const rootRes = await anon.send('GET', '/console');
  const rootTarget = redirectPathname(base, headerFirst(rootRes.headers, 'location'));
  const rootOk = rootRes.status === 303 && rootTarget === loginPath();
  checks.push({
    phase: '未登录',
    method: 'GET',
    path: '/console',
    status: rootRes.status,
    ok: rootOk,
    detail: rootOk ? '跳回登录页' : `期望 303 跳转至 ${loginPath()}，实际 HTTP ${rootRes.status} -> ${headerFirst(rootRes.headers, 'location') ?? '无'}`,
  });

  for (const path of PROTECTED_REDIRECT_PATHS) {
    const client = new ConsoleSessionClient(base, requester, timeoutMs, ca);
    const response = await client.send('GET', path);
    const location = headerFirst(response.headers, 'location');
    const targetPath = redirectPathname(base, location);
    const ok = response.status === 303 && targetPath === loginPath();
    checks.push({
      phase: '未登录',
      method: 'GET',
      path,
      status: response.status,
      ok,
      detail: ok ? '跳回登录页' : `期望 303 跳转至 ${loginPath()}，实际 HTTP ${response.status} -> ${location ?? '无'}`,
    });
  }

  const rebuildAnonClient = new ConsoleSessionClient(base, requester, timeoutMs, ca);
  const rebuildAnonRes = await rebuildAnonClient.send('GET', rebuildPath());
  const rebuildRedirectTarget = redirectPathname(base, headerFirst(rebuildAnonRes.headers, 'location'));
  const rebuildAnonOk =
    (rebuildAnonRes.status === 403 && rebuildAnonRes.body.includes('需要当前有效且已完成密码设置的管理员会话')) ||
    (rebuildAnonRes.status === 303 && rebuildRedirectTarget === loginPath());
  checks.push({
    phase: '未登录',
    method: 'GET',
    path: rebuildPath(),
    status: rebuildAnonRes.status,
    ok: rebuildAnonOk,
    detail: rebuildAnonOk
      ? rebuildAnonRes.status === 403
        ? '重建入口已拦截未登录访问（403）'
        : '跳回登录页'
      : `期望 403 或 303 跳转至 ${loginPath()}，实际 HTTP ${rebuildAnonRes.status}${rebuildAnonRes.body ? `（${rebuildAnonRes.body.slice(0, 60)}）` : ''}`,
  });
}

async function signIn(
  phase: Exclude<SmokePhase, '未登录'>,
  base: URL,
  requester: HttpRequester,
  timeoutMs: number,
  ca: string | undefined,
  account: SmokeAccountCredentials,
  checks: SmokeCheckResult[],
): Promise<ConsoleSessionClient | null> {
  const client = new ConsoleSessionClient(base, requester, timeoutMs, ca);
  const pageRes = await client.send('GET', loginPath());
  const csrf = extractCsrf(pageRes.body);
  if (pageRes.status !== 200 || csrf === null || !client.hasLoginCookie()) {
    checks.push({ phase, method: 'POST', path: loginPath(), status: pageRes.status, ok: false, detail: '无法获取登录页 CSRF 或登录 Cookie' });
    return null;
  }
  const loginRes = await client.send(
    'POST',
    loginPath(),
    new URLSearchParams({ username: account.username, password: account.password, csrf }),
    loginPath(),
  );
  const location = headerFirst(loginRes.headers, 'location');
  const targetPath = redirectPathname(base, location);
  if (loginRes.status === 303 && targetPath === passwordPath()) {
    checks.push({ phase, method: 'POST', path: loginPath(), status: loginRes.status, ok: false, detail: '账户处于必须首次修改密码状态，无法直接进入控制台' });
    return null;
  }
  if (loginRes.status !== 303 || !client.hasSessionCookie()) {
    const title = extractTitle(loginRes.body);
    checks.push({
      phase,
      method: 'POST',
      path: loginPath(),
      status: loginRes.status,
      ok: false,
      detail: `登录失败（HTTP ${loginRes.status}${title ? `，${title}` : ''}；检查用户名或密码）`,
    });
    return null;
  }
  checks.push({ phase, method: 'POST', path: loginPath(), status: loginRes.status, ok: true, detail: `登录成功 -> ${targetPath ?? location ?? ''}` });
  return client;
}

async function signOutAndVerify(
  phase: Exclude<SmokePhase, '未登录'>,
  base: URL,
  requester: HttpRequester,
  timeoutMs: number,
  ca: string | undefined,
  client: ConsoleSessionClient,
  checks: SmokeCheckResult[],
): Promise<void> {
  if (client.lastCsrf === null) {
    const overviewRes = await client.send('GET', overviewPath());
    if (overviewRes.status !== 200 || client.lastCsrf === null) {
      checks.push({ phase, method: 'POST', path: logoutPath(), status: overviewRes.status, ok: false, detail: '未能拿到登出所需的 CSRF 令牌' });
      return;
    }
  }
  const staleCookies = client.cookieSnapshot();
  const logoutRes = await client.send('POST', logoutPath(), new URLSearchParams({ csrf: client.lastCsrf }), overviewPath());
  const logoutTarget = redirectPathname(base, headerFirst(logoutRes.headers, 'location'));
  const logoutOk = logoutRes.status === 303 && logoutTarget === loginPath() && !client.hasSessionCookie();
  checks.push({
    phase,
    method: 'POST',
    path: logoutPath(),
    status: logoutRes.status,
    ok: logoutOk,
    detail: logoutOk ? '已登出并清除会话 Cookie' : `期望 303 跳转至 ${loginPath()} 且清除 Cookie，实际 HTTP ${logoutRes.status} -> ${logoutTarget ?? '无'}`,
  });

  // Verify old session id is revoked server-side as well.
  const staleJar = cookieHeader(staleCookies);
  const probeRes = await requester({
    url: new URL(overviewPath(), base),
    method: 'GET',
    headers: staleJar ? { cookie: staleJar } : {},
    ...(ca === undefined ? {} : { ca }),
    timeoutMs,
  });
  const probeTarget = redirectPathname(base, headerFirst(probeRes.headers, 'location'));
  const revokedOk = probeRes.status === 303 && probeTarget === loginPath();
  checks.push({
    phase,
    method: 'GET',
    path: `${overviewPath()}（登出后验证）`,
    status: probeRes.status,
    ok: revokedOk,
    detail: revokedOk ? '旧会话已失效并跳回登录页' : `期望 303 跳转至 ${loginPath()}，实际 HTTP ${probeRes.status}`,
  });
}

async function runAdminChecks(
  base: URL,
  requester: HttpRequester,
  timeoutMs: number,
  ca: string | undefined,
  account: SmokeAccountCredentials,
  checks: SmokeCheckResult[],
): Promise<string[]> {
  const client = await signIn('管理员', base, requester, timeoutMs, ca, account, checks);
  if (client === null) return [];

  let discoveredTeams: string[] = [];
  const rootRes = await client.send('GET', '/console');
  const rootTarget = redirectPathname(base, headerFirst(rootRes.headers, 'location'));
  const rootOk = rootRes.status === 303 && rootTarget === overviewPath();
  checks.push({
    phase: '管理员',
    method: 'GET',
    path: '/console',
    status: rootRes.status,
    ok: rootOk,
    detail: rootOk ? `跳转到 ${overviewPath()}` : `期望 303 -> ${overviewPath()}，实际 HTTP ${rootRes.status}`,
  });

  for (const route of ADMIN_GET_ROUTES) {
    const res = await client.send('GET', route.path);
    const rendered = validateRenderedHtml(res, route.expectedTitle);
    if (!rendered.ok) {
      checks.push({ phase: '管理员', method: 'GET', path: route.path, status: res.status, ok: false, detail: rendered.reason });
      continue;
    }
    if (route.path === teamPath()) discoveredTeams = extractTeamNames(res.body);
    if (route.path === `${settingsPath()}?tab=hub` && !res.body.includes('id="reset-rebuild"')) {
      checks.push({ phase: '管理员', method: 'GET', path: route.path, status: res.status, ok: false, detail: '设置页缺少「重置和重建」区块（#reset-rebuild）' });
      continue;
    }
    checks.push({ phase: '管理员', method: 'GET', path: route.path, status: res.status, ok: true, detail: `标题「${rendered.title}」` });
  }

  const adminRebuildRes = await client.send('GET', rebuildPath());
  if (adminRebuildRes.status === 409 && adminRebuildRes.body.includes('服务数据库与本机平台数据库目标不一致')) {
    checks.push({ phase: '管理员', method: 'GET', path: rebuildPath(), status: adminRebuildRes.status, ok: true, detail: '外置数据库提示（409 目标不一致，未报错）' });
  } else {
    const rendered = validateRenderedHtml(adminRebuildRes, '需要重建');
    if (!rendered.ok) {
      checks.push({ phase: '管理员', method: 'GET', path: rebuildPath(), status: adminRebuildRes.status, ok: false, detail: rendered.reason });
    } else if (!adminRebuildRes.body.includes('归档并初始化')) {
      checks.push({ phase: '管理员', method: 'GET', path: rebuildPath(), status: adminRebuildRes.status, ok: false, detail: '重建页未显示管理员操作区「归档并初始化」' });
    } else {
      checks.push({ phase: '管理员', method: 'GET', path: rebuildPath(), status: adminRebuildRes.status, ok: true, detail: `标题「${rendered.title}」` });
    }
  }

  await signOutAndVerify('管理员', base, requester, timeoutMs, ca, client, checks);
  return discoveredTeams;
}

async function runMemberChecks(
  base: URL,
  requester: HttpRequester,
  timeoutMs: number,
  ca: string | undefined,
  member: NonNullable<ConsoleSmokeOptions['member']>,
  adminTeams: readonly string[],
  checks: SmokeCheckResult[],
): Promise<void> {
  const client = await signIn('普通成员', base, requester, timeoutMs, ca, member, checks);
  if (client === null) return;

  const excluded = new Set(member.excludedTeams ?? []);
  if (member.memberTeams !== undefined) {
    const allowed = new Set(member.memberTeams);
    for (const teamName of adminTeams) {
      if (!allowed.has(teamName)) excluded.add(teamName);
    }
  }

  for (const route of MEMBER_COMMON_GET_ROUTES) {
    const res = await client.send('GET', route.path);
    const rendered = validateRenderedHtml(res, route.expectedTitle);
    checks.push({
      phase: '普通成员',
      method: 'GET',
      path: route.path,
      status: res.status,
      ok: rendered.ok,
      detail: rendered.ok ? `标题「${rendered.title}」` : rendered.reason,
    });
  }

  for (const teamRoute of [teamPath(), teamsPath()]) {
    const res = await client.send('GET', teamRoute);
    const rendered = validateRenderedHtml(res, '团队');
    if (!rendered.ok) {
      checks.push({ phase: '普通成员', method: 'GET', path: teamRoute, status: res.status, ok: false, detail: rendered.reason });
      continue;
    }
    const visible = extractTeamNames(res.body);
    const problems: string[] = [];
    if (!res.body.includes('只显示当前账户所属团队的名字')) problems.push('缺少普通成员团队隔离提示');
    for (const marker of ['新建团队', '删除团队', '/console/admin/do/team-create', '调整容量']) {
      if (res.body.includes(marker)) problems.push(`普通成员团队页泄露管理员元素「${marker}」`);
    }
    if (member.memberTeams !== undefined) {
      for (const expected of member.memberTeams) {
        if (!visible.includes(expected)) problems.push(`未看到所属团队「${expected}」`);
      }
      if (member.memberTeams.length === 0 && visible.length > 0) {
        problems.push(`未分配任何团队却看到：${visible.join('、')}`);
      }
    }
    for (const forbiddenTeam of excluded) {
      if (visible.includes(forbiddenTeam) || res.body.includes(forbiddenTeam)) {
        problems.push(`越权看到非所属团队「${forbiddenTeam}」`);
      }
    }
    checks.push({
      phase: '普通成员',
      method: 'GET',
      path: teamRoute,
      status: res.status,
      ok: problems.length === 0,
      detail: problems.length === 0 ? `仅见所属团队（${visible.length === 0 ? '无团队' : visible.join('、')}）` : problems.join('；'),
    });
  }

  const hubTabPath = `${settingsPath()}?tab=hub`;
  const hubRes = await client.send('GET', hubTabPath);
  const hubRendered = validateRenderedHtml(hubRes, '设置');
  if (!hubRendered.ok) {
    checks.push({ phase: '普通成员', method: 'GET', path: hubTabPath, status: hubRes.status, ok: false, detail: hubRendered.reason });
  } else if (!hubRes.body.includes('data-hub-state')) {
    checks.push({ phase: '普通成员', method: 'GET', path: hubTabPath, status: hubRes.status, ok: false, detail: '普通成员设置页未渲染 Hub 状态（缺少 data-hub-state）' });
  } else if (hubRes.body.includes('id="reset-rebuild"') || hubRes.body.includes('重置和重建')) {
    checks.push({ phase: '普通成员', method: 'GET', path: hubTabPath, status: hubRes.status, ok: false, detail: '普通成员设置页暴露了管理员「重置和重建」区块' });
  } else {
    checks.push({ phase: '普通成员', method: 'GET', path: hubTabPath, status: hubRes.status, ok: true, detail: '仅显示 Hub 状态，已隐藏重置重建' });
  }

  const rebuildRes = await client.send('GET', rebuildPath());
  const rebuildHasServerErr = extractTitle(rebuildRes.body) === SERVER_ERROR_TITLE || rebuildRes.body.includes(SERVER_ERROR_BODY);
  const rebuildBlockedOk =
    !rebuildHasServerErr &&
    ((rebuildRes.status === 403 && rebuildRes.body.includes('需要当前有效且已完成密码设置的管理员会话')) ||
      (rebuildRes.status === 404 && rebuildRes.body.includes(NEUTRAL_TEXT)));
  checks.push({
    phase: '普通成员',
    method: 'GET',
    path: rebuildPath(),
    status: rebuildRes.status,
    ok: rebuildBlockedOk,
    detail: rebuildBlockedOk
      ? `管理员重建入口已拦截（${rebuildRes.status}）`
      : `期望 HTTP 403/404 拒绝访问，实际 HTTP ${rebuildRes.status}`,
  });

  for (const adminPath of MEMBER_BLOCKED_ADMIN_PATHS) {
    const res = await client.send('GET', adminPath);
    const title = extractTitle(res.body);
    const hasServerErr = title === SERVER_ERROR_TITLE || res.body.includes(SERVER_ERROR_BODY);
    const ok = res.status === 404 && !hasServerErr && res.body.includes(NEUTRAL_TEXT);
    checks.push({
      phase: '普通成员',
      method: 'GET',
      path: adminPath,
      status: res.status,
      ok,
      detail: ok ? '管理员页面已拦截（404）' : `期望 HTTP 404 无权页，实际 HTTP ${res.status}${title ? `（${title}）` : ''}`,
    });
  }

  await signOutAndVerify('普通成员', base, requester, timeoutMs, ca, client, checks);
}

/** Runs the full read-only console smoke suite and returns per-route results and summary counts. */
export async function runConsoleSmoke(options: ConsoleSmokeOptions): Promise<ConsoleSmokeReport> {
  const base = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error(`timeout-ms 必须是不小于 100 的整数：${timeoutMs}`);
  }
  const requester = options.requester ?? defaultHttpRequester;
  const checks: SmokeCheckResult[] = [];

  await runUnauthenticatedChecks(base, requester, timeoutMs, options.ca, checks);
  const adminTeams = await runAdminChecks(base, requester, timeoutMs, options.ca, options.admin, checks);
  if (options.member !== undefined) {
    await runMemberChecks(base, requester, timeoutMs, options.ca, options.member, adminTeams, checks);
  }

  const passed = checks.filter((row) => row.ok).length;
  const failed = checks.length - passed;
  return { ok: failed === 0, checks, total: checks.length, passed, failed };
}

/** Formats one check line and the final summary for operator output. */
export function formatSmokeLine(check: SmokeCheckResult): string {
  return `[${check.phase}] ${check.method} ${check.path} -> HTTP ${check.status} ${check.ok ? '符合预期' : '不符合预期'}（${check.detail}）`;
}

export function formatSmokeSummary(report: ConsoleSmokeReport): string {
  return `汇总：共检查 ${report.total} 项，通过 ${report.passed} 项，失败 ${report.failed} 项`;
}

function splitLinesPreservePasswords(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

async function readPipedPasswords(input: Readable, count: number): Promise<string[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new Error(`标准输入超过 ${MAX_STDIN_BYTES} 字节`);
    chunks.push(buf);
  }
  const combined = Buffer.concat(chunks);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } catch {
    throw new Error('标准输入不是有效的 UTF-8 文本');
  } finally {
    combined.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
  const lines = splitLinesPreservePasswords(decoded);
  if (lines.length < count) {
    throw new Error(count === 1 ? '未从标准输入读到管理员密码' : '未从标准输入读到全部密码（第 1 行管理员，第 2 行普通成员）');
  }
  return lines.slice(0, count);
}

type SecretStream = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

function readTerminalSecret(input: SecretStream, prompt: (text: string) => void, label: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    let value = '';
    let escape: 'none' | 'escape' | 'csi' | 'ss3' = 'none';
    let done = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    prompt(`输入${label}（不回显），回车结束：`);
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('close', onEnd);
      input.off('error', onError);
      input.setRawMode?.(false);
      input.pause();
      if (err !== null) {
        value = '';
        rejectPromise(err);
      } else {
        resolvePromise(value);
      }
    };
    const onEnd = () => finish(new Error(`标准输入在回车前关闭，未读到${label}`));
    const onError = () => finish(new Error(`读取${label}失败`));
    const onData = (chunk: Buffer | string) => {
      let text: string;
      try {
        text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      } catch {
        return finish(new Error('输入不是有效的 UTF-8 文本'));
      }
      for (const ch of text) {
        if (escape === 'escape') {
          escape = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none';
          if (escape !== 'none') continue;
        } else if (escape === 'csi') {
          if (ch >= ' ' && ch <= '?') continue;
          escape = 'none';
          if (ch >= '@' && ch <= '~') continue;
        } else if (escape === 'ss3') {
          escape = 'none';
          continue;
        } else if (ch === '\u001b') {
          escape = 'escape';
          continue;
        }
        if (ch === '\u0003') return finish(new Error('已取消输入'));
        if (ch === '\u0004') return value === '' ? finish(new Error(`未输入${label}`)) : finish(null);
        if (ch === '\r' || ch === '\n') {
          try {
            decoder.decode();
          } catch {
            return finish(new Error('输入不是有效的 UTF-8 文本'));
          }
          prompt('\n');
          return finish(null);
        }
        if (ch === '\u007f' || ch === '\b') {
          const chars = [...value];
          chars.pop();
          value = chars.join('');
        } else if (ch === '\u0015') {
          value = '';
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };
    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.once('error', onError);
  });
}

/** Reads 1 (admin) or 2 (admin, member) passwords from stdin (pipe lines or non-echoing TTY). */
export async function readPasswordsFromStdin(
  needMember: boolean,
  stream: SecretStream = process.stdin as SecretStream,
  prompt: (text: string) => void = (text) => process.stderr.write(text),
): Promise<{ adminPassword: string; memberPassword?: string }> {
  if (stream.isTTY === true) {
    const adminPassword = await readTerminalSecret(stream, prompt, '管理员密码');
    if (adminPassword === '') throw new Error('管理员密码不能为空');
    if (!needMember) return { adminPassword };
    const memberPassword = await readTerminalSecret(stream, prompt, '普通成员密码');
    if (memberPassword === '') throw new Error('普通成员密码不能为空');
    return { adminPassword, memberPassword };
  }
  const [adminPassword, memberPassword] = await readPipedPasswords(stream, needMember ? 2 : 1);
  if (adminPassword === '') throw new Error('管理员密码不能为空');
  if (needMember && (!memberPassword || memberPassword === '')) throw new Error('普通成员密码不能为空');
  return needMember ? { adminPassword, memberPassword } : { adminPassword };
}

function parseTeamCsv(raw: string): string[] {
  return raw === ''
    ? []
    : raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
}

const USAGE = `用法：
  node tools/console-smoke.ts --base-url <url> --admin <用户名> [选项]

选项：
  --base-url <url>          控制台地址（例如 https://192.0.2.10:8443 或 http://127.0.0.1:3000）
  --admin <用户名>           管理员用户名（密码从标准输入第 1 行读取，命令行不接受密码）
  --member <用户名>          可选，普通成员用户名（密码从标准输入第 2 行读取）
  --member-teams <列表>      可选，普通成员应看到的团队名，逗号分隔（传空串表示不应看到任何团队）
  --excluded-teams <列表>    可选，普通成员不应看到的团队名，逗号分隔
  --ca <证书路径>            可选，HTTPS 自签/内网 CA 证书（PEM）
  --timeout-ms <毫秒>        可选，单次请求超时时间（默认 15000）
  -h, --help                 显示此帮助

示例（密码通过标准输入传入）：
  printf '%s\\n%s\\n' "<管理员密码>" "<成员密码>" | \\
    node tools/console-smoke.ts --base-url https://192.0.2.10:8443 --admin 管理员 --member 成员甲 --member-teams 团队甲 --excluded-teams 团队乙
`;

export interface ParsedCliArgs {
  readonly help: boolean;
  readonly baseUrl: string;
  readonly adminUser: string;
  readonly memberUser?: string;
  readonly memberTeams?: readonly string[];
  readonly excludedTeams?: readonly string[];
  readonly ca?: string;
  readonly timeoutMs: number;
}

/** Validates CLI flags; explicitly forbids password options on the command line. */
export function parseSmokeCliArgs(argv: readonly string[]): ParsedCliArgs {
  for (const arg of argv) {
    if (arg === '--password' || arg.startsWith('--password=') || arg === '--admin-password' || arg.startsWith('--admin-password=') || arg === '--member-password' || arg.startsWith('--member-password=')) {
      throw new Error('命令行参数禁止传递密码；请通过标准输入传入');
    }
  }
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      'base-url': { type: 'string' },
      admin: { type: 'string' },
      member: { type: 'string' },
      'member-teams': { type: 'string' },
      'excluded-teams': { type: 'string' },
      ca: { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });
  if (positionals.length > 0) throw new Error(`不识别的位置参数：${positionals.join(' ')}`);
  if (values.help === true) {
    return { help: true, baseUrl: '', adminUser: '', timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  const baseUrl = values['base-url'];
  const adminUser = values.admin;
  if (!baseUrl) throw new Error('缺少必需参数 --base-url');
  if (!adminUser) throw new Error('缺少必需参数 --admin');
  normalizeBaseUrl(baseUrl);
  if ((values['member-teams'] !== undefined || values['excluded-teams'] !== undefined) && values.member === undefined) {
    throw new Error('--member-teams / --excluded-teams 必须配合 --member 使用');
  }
  const timeoutRaw = values['timeout-ms'];
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new Error(`--timeout-ms 必须是不小于 100 的整数：${timeoutRaw}`);
  }
  return {
    help: false,
    baseUrl,
    adminUser,
    ...(values.member === undefined ? {} : { memberUser: values.member }),
    ...(values['member-teams'] === undefined ? {} : { memberTeams: parseTeamCsv(values['member-teams']) }),
    ...(values['excluded-teams'] === undefined ? {} : { excludedTeams: parseTeamCsv(values['excluded-teams']) }),
    ...(values.ca === undefined ? {} : { ca: values.ca }),
    timeoutMs,
  };
}

async function main(): Promise<number> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseSmokeCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const ca = parsed.ca === undefined ? undefined : readFileSync(resolve(parsed.ca), 'utf8');
  const secrets = await readPasswordsFromStdin(parsed.memberUser !== undefined);
  const report = await runConsoleSmoke({
    baseUrl: parsed.baseUrl,
    admin: { username: parsed.adminUser, password: secrets.adminPassword },
    ...(parsed.memberUser === undefined
      ? {}
      : {
          member: {
            username: parsed.memberUser,
            password: secrets.memberPassword!,
            ...(parsed.memberTeams === undefined ? {} : { memberTeams: parsed.memberTeams }),
            ...(parsed.excludedTeams === undefined ? {} : { excludedTeams: parsed.excludedTeams }),
          },
        }),
    ...(ca === undefined ? {} : { ca }),
    timeoutMs: parsed.timeoutMs,
  });
  for (const check of report.checks) {
    process.stdout.write(`${formatSmokeLine(check)}\n`);
  }
  process.stdout.write(`${formatSmokeSummary(report)}\n`);
  return report.ok ? 0 : 1;
}

const isMain = resolve(dirname(fileURLToPath(import.meta.url)), 'console-smoke.ts') === resolve(process.argv[1] ?? '');
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
