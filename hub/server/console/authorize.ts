// The authorization page of the MCP standard authorization (decision 78, the "授权" board of the design canvas): the
// authorization endpoint (hub/server/oauth.ts) sends the browser here with an open request. The account is the one an
// invitation code names (the identity step) or, without one, the browser's console session; the page always names it, and
// a signed-in browser may still switch to an invitation. Approving sends the browser to the client's redirect URI with a
// one-time code, refusing with access_denied; both end the request. No password is asked (owner-confirmed item 1), and
// the page carries no script. The confirm page allows its form to lead to the redirect URI's origin (CSP form-action).
import type { InvitationCheck } from '../../records/api.ts';
import type { AuthorizationRequest } from '../oauth.ts';
import { AUTHORIZATION_REQUEST_TTL_MS } from '../oauth.ts';
import { CONTENT_SECURITY_POLICY, code, html, page, type Html } from './html.ts';
import { callout, card, kv, stepper } from './ui.ts';

const STEPS = ['身份', '确认授权', '完成'] as const;
/** Wrong invitation codes one authorization request accepts before it ends. */
export const MAX_INVITATION_FAILURES = 5;

const chrome = (title: string) => ({ title, user: null, csrf: null, wide: true });

/** Where the redirect URI is, for the page: the origin of an http(s) URI, the scheme of a private-use one. */
export function redirectTarget(uri: string): string {
  const url = new URL(uri);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
}

/** The console's policy with form-action widened to the redirect URI, so the approval may lead there. */
export function authorizeSecurityPolicy(uri: string): string {
  const target = redirectTarget(uri);
  return CONTENT_SECURITY_POLICY.replace("form-action 'self'", `form-action 'self' ${target}`);
}

function facts(request: AuthorizationRequest): Html {
  return kv([
    ['客户端', html`<b>${request.client.name}</b> <span class="digest">${request.client.id}</span>`],
    ['回调地址', code(request.redirectUri)],
    ['访问范围', '本 Hub 的 MCP 服务（' + request.resource + '）'],
    ['有效期', `授权请求 ${AUTHORIZATION_REQUEST_TTL_MS / 60_000} 分钟内有效`],
  ]);
}

function invitationForm(request: AuthorizationRequest, error: string | null, primary: boolean): Html {
  return html`<form method="post" action="/console/authorize/${request.id}">
<div class="field"><label for="invitation">邀请码</label><input id="invitation" class="input" name="code" autocomplete="off" size="20" maxlength="64" required placeholder="XXXX-XXXX-XXXX"></div>
${error === null ? '' : html`<p class="error">${error}</p>`}
<input type="hidden" name="csrf" value="${request.csrf}"><input type="hidden" name="step" value="identity">
<button type="submit" class="btn${primary ? ' primary' : ''}">验证邀请码</button>
</form>`;
}

/** The identity step: the invitation code, or signing in to the console first. */
export function identityPage(request: AuthorizationRequest, error: string | null): Html {
  return page(chrome('授权 Circle 连接 Hub'), html`${stepper(STEPS, 0)}
<p class="mt12"><b>${request.client.name}</b> 请求连接本 Hub。输入管理员签发的邀请码，确认以哪个账号授权。</p>
${card(null, facts(request), 'mt12')}
<div class="mt16">${invitationForm(request, error, true)}</div>
<p class="sub mt12">邀请码在添加成员时签发，24 小时内有效，仅可使用一次。也可先${html`<a href="/console/login?next=${encodeURIComponent(`/console/authorize/${request.id}`)}">登录控制台</a>`}，再以登录的账号授权。</p>`);
}

/** The confirm step for `account`; `via` says whether it comes from an invitation or the console session. */
export function confirmPage(request: AuthorizationRequest, account: { name: string; role: string }, via: 'invitation' | 'session', csrf: string, error: string | null): Html {
  const decide = html`<form method="post" action="/console/authorize/${request.id}" class="row mt16">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="step" value="decide">
<button type="submit" class="btn primary" name="decision" value="approve">授权</button>
<button type="submit" class="btn" name="decision" value="deny">拒绝</button>
</form>`;
  const other = via === 'session'
    ? html`<details class="mt16"><summary>以其他账号授权</summary><div class="mt12">${invitationForm(request, null, false)}</div></details>`
    : '';
  return page(chrome('授权 Circle 连接 Hub'), html`${stepper(STEPS, 1)}
${error === null ? '' : html`<p class="error mt12">${error}</p>`}
<p class="mt12">以 <b>${account.name}</b>（${account.role}）的身份授权 <b>${request.client.name}</b> 连接本 Hub。</p>
${card(null, facts(request), 'mt12')}
${callout('info', html`<span>授权后，该客户端以 ${account.name} 的身份调用 Hub 的工具，权限与该账号相同；在设置的“已连接的 Circle”中可随时断开。</span>`)}
${decide}${other}`);
}

/** A request that already ended (the browser came back to it). */
export function endedPage(request: AuthorizationRequest): Html {
  const approved = request.ended === 'approved';
  return page(chrome(approved ? '已授权' : '已拒绝'), html`${stepper(STEPS, 2)}
<p class="mt12">${approved ? html`已授权 <b>${request.client.name}</b> 连接本 Hub，可关闭本页。` : html`已拒绝 <b>${request.client.name}</b> 的授权请求，该客户端未获连接。`}</p>`);
}

/** A request that does not exist for this browser (expired, ended by too many wrong codes, a restart, another browser's). */
export function expiredPage(message = `授权请求已过期、不存在，或不是由本浏览器发起的。授权请求 ${AUTHORIZATION_REQUEST_TTL_MS / 60_000} 分钟内有效，Hub 重启后失效。`): Html {
  return page(chrome('授权请求已失效'), html`<p class="mt12">${message}</p><p class="sub">请在 Circle 中重新连接 Hub，浏览器将打开新的授权页。</p>`);
}

/** An authorization request the endpoint cannot answer at a redirect URI (unknown client, mismatched redirect URI). */
export function refusedPage(message: string): Html {
  return page(chrome('授权请求无效'), html`<p class="error mt12">${message}</p>`);
}

/** The message for an invitation that cannot be used. */
export function invitationProblem(reason: Extract<InvitationCheck, { ok: false }>['reason']): string {
  if (reason === 'used') return '邀请码已使用：请管理员重新签发';
  if (reason === 'expired') return '邀请码已过期：请管理员重新签发';
  if (reason === 'disabled') return '该账号已停用，不能授权';
  return '邀请码不正确';
}
