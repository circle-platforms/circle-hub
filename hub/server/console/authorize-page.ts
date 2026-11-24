import type { IncomingMessage, ServerResponse } from 'node:http';
import { uiLabelOf, type TokenScope } from '../../../contracts/generated/vocabulary.ts';
import { cookiesOf, setCommonHeaders } from '../http.ts';
import {
  AUTHORIZATION_REQUEST_TTL_MS, AUTHORIZE_COOKIE, AUTHORIZE_PAGE, DEVICE_PAGE,
  SECURE_AUTHORIZE_COOKIE, peerOf, responseUri,
} from '../oauth.ts';
import {
  MAX_DEVICE_CODE_ATTEMPTS, MAX_INVITATION_FAILURES, authorizeSecurityPolicy,
  confirmPage, deviceCodePage, endedPage, expiredPage, identityPage, invitationProblem, refusedPage,
} from './authorize.ts';
import { isBotEnabled } from '../personal-bot.ts';
import { html, page } from './html.ts';
import {
  DEVICE_COOKIE, SECURE_DEVICE_COOKIE, cookie, type ConsoleSession,
} from './session.ts';
import {
  type ConsoleOptions, sendHtml, redirect, anonymous, forbidden, sameOrigin, formOf,
} from './console-http.ts';

export function authorizeRefusal(response: ServerResponse, status: number, message: string): void {
  sendHtml(response, status, refusedPage(message));
}

export async function authorizePage(request: IncomingMessage, response: ServerResponse, options: ConsoleOptions, session: ConsoleSession | null, secure: boolean, rest: string[]): Promise<void> {
  const store = options.authorizations;
  const open = rest.length === 1 && store !== undefined ? store.get(rest[0]) : null;
  const bound = open !== null && cookiesOf(request).get(secure ? SECURE_AUTHORIZE_COOKIE : AUTHORIZE_COOKIE) === open.browser;
  if (open === null || open.secure !== secure || !bound) {
    request.resume();
    return sendHtml(response, 410, expiredPage());
  }
  const principals = options.deps.records.principals;
  const signedIn = session === null ? null : await (principals.authenticateConsoleSession?.(`Bearer ${session.token}`) ?? principals.authenticate(`Bearer ${session.token}`));
  const named = open.invitation !== null ? { id: open.invitation.user, name: open.invitation.name, role: open.invitation.role, via: 'invitation' as const } : signedIn !== null ? { ...signedIn, via: 'session' as const } : null;
  const show = async (status: number, error: string | null): Promise<void> => {
    if (named === null) return sendHtml(response, status, identityPage(open, error));
    const botEnabled = await isBotEnabled(options.deps.records?.vault);
    sendHtml(response, status, confirmPage(open, { id: named.id, name: named.name, role: uiLabelOf('permission_role', named.role) }, named.via, open.csrf, error, botEnabled), { 'content-security-policy': authorizeSecurityPolicy(open.redirectUri) });
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
  if (typeof form === 'string' || form.get('csrf') !== open.csrf) return forbidden(response, '表单已过期或不是本控制台发出的，请在客户端中重新连接');
  const step = form.get('step');
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
        return sendHtml(response, 410, expiredPage(`邀请码连续 ${MAX_INVITATION_FAILURES} 次验证错误，该连接请求已结束。`));
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
  const here = { location: `${AUTHORIZE_PAGE}/${open.id}` };
  const deviceGone = { status: 409, error: '设备码已过期或已在其他页面处理：请在客户端中重新连接' };
  const decide = async (): Promise<{ location: string } | { status: number; error: string }> => {
    if (decision === 'deny') {
      if (open.device !== null) {
        if (!store!.decideDevice(open, null)) return deviceGone;
      } else open.ended = 'denied';
      options.log(`标准授权：客户端 ${open.client.id}（${open.client.name}）的授权请求被拒绝`);
      return open.device !== null ? here : to({ error: 'access_denied', error_description: 'the request was refused' });
    }
    if (named === null) return { status: 401, error: '请先输入邀请码' };
    if (form.get('account') !== named.id) return { status: 409, error: '页面显示的账号已变化：请核对下面的账号后重新确认连接' };
    if (open.device !== null && !store!.devicePending(open)) return deviceGone;
    if (named.via === 'invitation' && (await principals.takeInvitation(open.invitation!.id, open.client.id)) === null) {
      open.invitation = null;
      return { status: 409, error: `邀请码已失效（已使用、已过期，或账号${uiLabelOf('account_status', 'disabled')}）：请管理员重新签发` };
    }
    const consented: readonly TokenScope[] = (await isBotEnabled(options.deps.records?.vault)) && (open.requestedScopes ?? []).includes('bot') && form.get('scope_bot') === '1' ? ['bot'] : [];
    if (open.device !== null) {
      if (!store!.decideDevice(open, named.id, consented)) return deviceGone;
      options.log(`标准授权：客户端 ${open.client.id}（${open.client.name}）获设备码授权，账号 ${named.id}`);
      return here;
    }
    const code = store!.grant(open, named.id, consented);
    if (code === null) return { status: 409, error: '该连接请求已处理' };
    options.log(`标准授权：客户端 ${open.client.id}（${open.client.name}）获授权，账号 ${named.id}`);
    return to({ code });
  };
  open.decision = decide();
  const decided = await open.decision;
  if (!('location' in decided)) open.decision = null;
  if ('location' in decided) return go(decided.location);
  return decided.status === 409 && open.invitation === null && named?.via === 'invitation' ? sendHtml(response, 409, identityPage(open, decided.error)) : show(decided.status, decided.error);
}

export async function devicePage(request: IncomingMessage, response: ServerResponse, url: URL, options: ConsoleOptions, secure: boolean): Promise<void> {
  const store = options.authorizations;
  if (store === undefined) {
    request.resume();
    return sendHtml(response, 404, page(anonymous('没有这个页面'), html`<p>没有这个页面</p>`));
  }
  const show = (status: number, typed: string, error: string | null): void => {
    const nonce = options.sessions.issueNonce(secure);
    sendHtml(response, status, deviceCodePage(typed, nonce, error), { 'set-cookie': cookie(secure ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE, nonce, DEVICE_PAGE, 15 * 60, secure) });
  };
  if (request.method === 'GET') {
    request.resume();
    return show(200, (url.searchParams.get('user_code') ?? '').slice(0, 20), null);
  }
  if (request.method !== 'POST') {
    request.resume();
    return sendHtml(response, 405, page(anonymous('方法不允许'), html`<p>只接受 GET 和 POST</p>`), { allow: 'GET, POST' });
  }
  if (!sameOrigin(request, options.ownOrigins())) {
    request.resume();
    return forbidden(response, '设备码表单只能从本控制台的页面提交');
  }
  const form = await formOf(request);
  if (form === 'aborted') return void response.destroy();
  if (typeof form === 'string') return forbidden(response, '设备码请求的格式不对');
  const nonce = form.get('csrf') ?? '';
  if (nonce.length === 0 || cookiesOf(request).get(secure ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE) !== nonce || !options.sessions.takeNonce(nonce, secure)) return forbidden(response, '表单已过期或不是本控制台发出的，请重新打开设备码页面');
  const typed = (form.get('user_code') ?? '').trim().slice(0, 64);
  const peer = peerOf(request);
  if (!options.sessions.takeLoginAttempt('device:' + peer, MAX_DEVICE_CODE_ATTEMPTS)) return show(429, '', '设备码输入次数过多，请在 15 分钟后重试');
  const device = store.deviceByUserCode(typed);
  if (device === null || device.secure !== secure) return show(400, typed.slice(0, 20), '设备码不正确或已过期：请核对客户端显示的设备码，或在客户端中重新连接');
  const opened = store.open({ client: device.client, redirectUri: '', redirectSent: false, state: null, challenge: '', requestedScopes: device.requestedScopes, peer, resource: device.resource, issuer: device.issuer, secure, device: { id: device.id, userCode: device.userCode } });
  if (opened === null) return show(503, typed.slice(0, 20), '当前待处理的授权请求过多，请稍后重试');
  const path = `${AUTHORIZE_PAGE}/${opened.id}`;
  setCommonHeaders(response);
  response.writeHead(303, {
    location: path,
    'content-length': '0',
    'set-cookie': [cookie(secure ? SECURE_AUTHORIZE_COOKIE : AUTHORIZE_COOKIE, opened.browser, path, AUTHORIZATION_REQUEST_TTL_MS / 1000, secure, true), cookie(secure ? SECURE_DEVICE_COOKIE : DEVICE_COOKIE, '', DEVICE_PAGE, 0, secure)],
    'cache-control': 'no-store',
  });
  response.end();
}
