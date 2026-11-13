import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResetRequest, ResetInspection, ResetPlan, ResetWorkerStatus } from '../platform/api.ts';
import { checkRebuildCode, normalizeSetupCode, removeRebuildCode } from './setup-code.ts';
import { SessionStore, cookie, type ConsoleSession } from './console/session.ts';
import { cookiesOf, readBody, sendJson, sendText } from './http.ts';
import type { RebuildNeeded } from './rebuild-state.ts';

export interface RebuildResetBridge {
  validate(input: unknown): ResetRequest | null | Promise<ResetRequest | null>;
  inspect(): Promise<ResetInspection>;
  preview(request: ResetRequest): Promise<ResetPlan>;
  launch(request: ResetRequest, authorizationContext: string): Promise<{ operationId: string }>;
  acknowledge(operationId: string, authorizationContext: string): Promise<void>;
  status(operationId: string, authorizationContext: string): Promise<ResetWorkerStatus>;
}
export interface RebuildConsoleContext {
  authorized: boolean;
  rebuildNeeded?: RebuildNeeded | null;
  csrf: string;
  loginNonce?: string;
  actionId?: string;
  inspection?: ResetInspection;
  plan?: ResetPlan;
  operation?: ResetWorkerStatus;
}
export type RebuildPageRenderer = (context: RebuildConsoleContext) => string | Promise<string>;
export interface RebuildHttpOptions {
  dataDir: string;
  rebuildNeeded: RebuildNeeded;
  bridge: RebuildResetBridge;
  originAllowed(request: IncomingMessage): boolean;
  render?: RebuildPageRenderer;
  now?: () => Date;
  log(line: string): void;
}
interface Action {
  id: string;
  plan?: ResetPlan;
  launching?: Promise<{ operationId: string }>;
  operationId?: string;
}
const ROOT = '/console/rebuild', STATUS = '/console/reset/status/';
const SESSION = 'circle_hub_rebuild_session', NONCE = 'circle_hub_rebuild_nonce';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secureRequest = (request: IncomingMessage) => 'encrypted' in request.socket && request.socket.encrypted === true;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Restricted reset-only authorization. No database account, administrator token or ordinary console session is created. */
export function createRebuildHandler(options: RebuildHttpOptions) {
  const sessions = new SessionStore(() => (options.now?.() ?? new Date()).getTime());
  const actions = new WeakMap<ConsoleSession, Action>();
  let redemption = Promise.resolve();
  const authContext = (session: ConsoleSession, action: Action) => `setup:${hash(session.id)}:${action.id}`;
  const page = async (response: ServerResponse, context: RebuildConsoleContext) => {
    if (!options.render) return sendText(response, context.authorized ? 200 : 401, context.authorized ? '记录库需要重建；请在本机执行 circle-hub reset，或使用控制台重建表单' : '需要本机 setup-code 维护授权');
    const body = await options.render(context);
    response.writeHead(context.authorized ? 200 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(body)) });
    response.end(body);
  };
  const redeem = async (code: string) => {
    const previous = redemption, ready = Promise.withResolvers<void>();
    redemption = ready.promise;
    await previous;
    try {
      if (await checkRebuildCode(options.dataDir, code, options.now?.()) !== 'ok') return false;
      await removeRebuildCode(options.dataDir);
      return true;
    } finally { ready.resolve(); }
  };
  return async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    const secure = secureRequest(request), cookies = cookiesOf(request);
    const session = sessions.get(cookies.get(SESSION), secure);
    const action = session ? actions.get(session) : undefined;
    if (request.method === 'GET' && url.pathname === ROOT) {
      if (!session || !action) {
        const nonce = sessions.issueNonce(secure);
        response.setHeader('set-cookie', cookie(NONCE, nonce, ROOT, 900, secure));
        return page(response, { authorized: false, csrf: '', loginNonce: nonce });
      }
      const operation = action.operationId ? await options.bridge.status(action.operationId, authContext(session, action)) : undefined;
      return page(response, { authorized: true, rebuildNeeded: options.rebuildNeeded, csrf: session.csrf, actionId: action.id,
        ...(operation ? { operation } : { inspection: await options.bridge.inspect() }), ...(action.plan ? { plan: action.plan } : {}) });
    }
    if (request.method === 'GET' && url.pathname.startsWith(STATUS)) {
      const operationId = url.pathname.slice(STATUS.length);
      if (!session || !action) return sendText(response, 401, '需要当前有效的维护授权；重启后请本机查询 reset 状态');
      if (!UUID.test(operationId) || action.operationId !== operationId) return sendText(response, 404, '操作不可用');
      return sendJson(response, 200, await options.bridge.status(operationId, authContext(session, action)));
    }
    if (request.method !== 'POST' || ![ROOT + '/authorize', ROOT + '/preview', ROOT + '/execute', ROOT + '/new-action'].includes(url.pathname)) return sendText(response, 503, '记录库需要重建；业务入口未开放，请由本机操作账户授权后重建');
    if (!options.originAllowed(request)) return sendText(response, 403, '请求来源不允许');
    if (request.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') return sendText(response, 415, '请提交控制台表单');
    const read = await readBody(request, 16 * 1024);
    if (!read.ok) return sendText(response, read.reason === 'too_large' ? 413 : 400, '表单未完整接收');
    const form = new URLSearchParams(read.bytes.toString('utf8'));
    const allowedFields = new Set(url.pathname === ROOT + '/authorize' ? ['setup_code', 'nonce'] : url.pathname === ROOT + '/preview' ? ['csrf', 'actionId', 'scope', 'keep-config', 'definition'] : ['csrf', 'actionId']);
    if ([...form.keys()].some(name => !allowedFields.has(name))) return sendText(response, 400, '表单字段不符合重建动作；请重新打开控制台');
    if (url.pathname === ROOT + '/authorize') {
      const nonce = form.get('nonce');
      if (!sessions.takeLoginAttempt(request.socket.remoteAddress ?? 'unknown')) return sendText(response, 429, '尝试过多，请稍后重试');
      if (!nonce || nonce !== cookies.get(NONCE) || !sessions.takeNonce(nonce, secure)) return sendText(response, 403, '授权表单已失效，请重新打开');
      const code = form.get('setup_code');
      if (!code || !await redeem(code)) return sendText(response, 401, '维护授权无效或已过期，请由本机操作账户重新签发');
      const opened = sessions.open(hash(normalizeSetupCode(code)), secure);
      actions.set(opened, { id: randomUUID() });
      response.setHeader('set-cookie', [cookie(SESSION, opened.id, '/console', undefined, secure), cookie(NONCE, '', ROOT, 0, secure)]);
      response.writeHead(303, { location: ROOT }); response.end(); return;
    }
    if (!session || !action) return sendText(response, 401, '需要当前有效的维护授权');
    if (form.get('csrf') !== session.csrf || form.get('actionId') !== action.id) return sendText(response, 403, '动作或 CSRF 验证失败');
    const context = authContext(session, action);
    if (url.pathname === ROOT + '/new-action') {
      if (action.launching && !action.operationId) return sendText(response, 409, '当前动作正在接受中');
      if (action.operationId && !(await options.bridge.status(action.operationId, context)).completed) return sendText(response, 409, '当前重建尚未结束');
      actions.set(session, { id: randomUUID() }); response.writeHead(303, { location: ROOT }); response.end(); return;
    }
    if (url.pathname === ROOT + '/preview') {
      if (action.operationId || action.launching) return sendText(response, 409, '当前动作已启动，请查询其状态');
      const scopes = form.getAll('scope'), definitionFile = form.get('definition');
      const canonical = await options.bridge.validate({ scopes: scopes.length === 1 && scopes[0] === 'all' ? 'all' : scopes,
        keepConfig: form.has('keep-config'), ...(definitionFile ? { definitionFile } : {}) });
      if (!canonical || canonical.scopes !== 'all' || canonical.keepConfig) return sendText(response, 400, '不兼容记录库只允许明确选择 all 归档初始化，不可保留无法核对的配置');
      const plan = await options.bridge.preview(canonical);
      if (action.operationId || action.launching) return sendText(response, 409, '当前动作已启动，请查询其状态');
      action.plan = plan;
      return page(response, { authorized: true, rebuildNeeded: options.rebuildNeeded, csrf: session.csrf, actionId: action.id, plan: action.plan });
    }
    if (!action.plan || action.plan.blocked.length) return sendText(response, 409, '需要先查看并确认可执行的重建预览');
    if (!action.launching) action.launching = options.bridge.launch(action.plan.request, context);
    let accepted: { operationId: string };
    try { accepted = await action.launching; }
    catch (error) { action.launching = undefined; throw error; }
    action.operationId = accepted.operationId;
    if (response.destroyed || request.aborted) return;
    let closed = false;
    response.once('close', () => { closed = true; });
    response.once('finish', () => {
      if (!closed) void options.bridge.acknowledge(accepted.operationId, context).catch(() => options.log('重建响应已完成，但执行确认未保存；请本机查询 reset 状态，不将其视为已完成'));
    });
    sendJson(response, 202, { operationId: accepted.operationId, statusUrl: STATUS + accepted.operationId });
  };
}
