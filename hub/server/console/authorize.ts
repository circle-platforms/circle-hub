// The authorization page of the MCP standard authorization (decision 125, the "授权" board of the design canvas): the
// authorization endpoint (hub/server/oauth.ts) sends the browser here with an open request. The account is the one an
// invitation code names (the identity step) or, without one, the browser's console session; the page always names it, and
// a signed-in browser may still switch to an invitation. Approving sends the browser to the client's redirect URI with a
// one-time code, refusing with access_denied; both end the request. No password is asked (owner-confirmed item 1), and
// the page carries only the fixed theme script. The confirm page allows its form to lead to the redirect URI's origin (CSP form-action).
import {evidence,technical} from './presentation.ts';
import {UNREPORTED_CLIENT} from './client-provenance.ts';
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import type { InvitationCheck } from '../../records/api.ts';
import type { AuthorizationRequest } from '../oauth.ts';
import { AUTHORIZATION_REQUEST_TTL_MS, DEVICE_PAGE, UNNAMED_CLIENT, formatUserCode, redirectIsLocal } from '../oauth.ts';
import { CONTENT_SECURITY_POLICY, code, definitions, html, page, type Html } from './html.ts';
import { stepper } from './ui.ts';

const STEPS = ['身份', '确认连接', '完成'] as const;
/** Wrong invitation codes one authorization request accepts before it ends. */
export const MAX_INVITATION_FAILURES = 5;
/** User codes one sender may type on the device page in 15 minutes, right or wrong. */
export const MAX_DEVICE_CODE_ATTEMPTS = 10;

const chrome = (title: string, hint?: string, heading?: Html) => ({ title, hint, heading, user: null, csrf: null, wide: true });

/**
 * The page title names the client by the name it registered (client_name), shown exactly as recorded; a client that
 * registered none is 客户端. The document title stays generic, so a recorded name never reaches the browser tab unmarked.
 */
const named = (request: AuthorizationRequest): boolean => request.client.name !== UNNAMED_CLIENT && request.client.name !== '';
function allowChrome(request: AuthorizationRequest, hint: string) {
  return chrome('允许客户端连接', hint, named(request) ? html`允许 ${evidence(request.client.name)} 连接` : undefined);
}
/** The client's name as it registered it, or 客户端. */
const clientName = (request: AuthorizationRequest): Html => named(request) ? html`<b data-evidence>${request.client.name}</b>` : html`<b>${UNREPORTED_CLIENT}</b>`;

/** Where the redirect URI is, for the page: the origin of an http(s) URI, the scheme of a private-use one. */
export function redirectTarget(uri: string): string {
  const url = new URL(uri);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
}

/**
 * What the page says about where the code goes: nothing for a loopback address of this machine; for an https URI that it
 * leaves the machine; for a private-use scheme, that the app registered for it on this machine receives it.
 */
function redirectNotice(uri: string, account: string): Html | '' {
  // A device request has no redirect URI: the code goes nowhere, the client's own poll picks up the decision.
  if (uri === '' || redirectIsLocal(uri)) return '';
  const target = redirectTarget(uri);
  if (target.startsWith('https://')) return callout('warn', html`<span><b>回调地址不在这台电脑上。</b>确认后，连接码发送到 ${target}；该地址的服务可凭它以 ${evidence(account)} 的身份连接本 Hub。仅在确认该服务可信时允许连接。</span>`);
  return callout('info', html`<span>连接码交给这台电脑上处理 ${target} 链接的应用；仅在确认该应用可信时允许连接。</span>`);
}

/** The console's policy with form-action widened to the redirect URI, so the approval may lead there; unchanged without one. */
export function authorizeSecurityPolicy(uri: string): string {
  if (uri === '') return CONTENT_SECURITY_POLICY;
  const target = redirectTarget(uri);
  return CONTENT_SECURITY_POLICY.replace("form-action 'self'", `form-action 'self' ${target}`);
}

function facts(request: AuthorizationRequest): Html {
  const values = [
    ['客户端', clientName(request)],
    request.device ? ['设备码', code(formatUserCode(request.device.userCode))] : ['回调地址', code(request.redirectUri)],
    ['访问范围', '本 Hub 的 MCP 服务（' + request.resource + '）'],
    ['有效期', `连接请求 ${AUTHORIZATION_REQUEST_TTL_MS / 60_000} 分钟内有效`],
  ];
  return html`<dl class="ch-kv">${values.map(([label,value])=>html`<dt>${label}</dt><dd>${value}</dd>`)}</dl>${technical(definitions([['名称来源', named(request) ? 'OAuth client_name' : '未报告'], ['已登记的客户端', code(request.client.id)]]))}`;
}

function callout(tone: 'info' | 'warn', body: Html): Html {
  return html`<p class="ch-meta" role="note"><span class="ch-dot ${tone === 'warn' ? 'ch-dot--warn' : 'ch-dot--info'}" aria-hidden="true"></span>${body}</p>`;
}

function invitationForm(request: AuthorizationRequest, error: string | null, primary: boolean): Html {
  return html`<form method="post" action="/console/authorize/${request.id}">
<div class="ch-field"><label class="ch-field-label" for="invitation">邀请码</label><div class="ch-input"><input id="invitation" name="code" autocomplete="off" size="20" maxlength="64" required placeholder="XXXX-XXXX-XXXX"></div></div>
${error === null ? '' : html`<p class="error">${error}</p>`}
<input type="hidden" name="csrf" value="${request.csrf}"><input type="hidden" name="step" value="identity">
<button type="submit" class="ch-btn ${primary ? 'ch-btn--primary' : 'ch-btn--secondary'}">验证邀请码</button>
</form>`;
}

/** The identity step: the invitation code, or signing in to the console first. */
export function identityPage(request: AuthorizationRequest, error: string | null): Html {
  return page(allowChrome(request, '输入管理员签发的邀请码确认账号；也可用密码登录控制台后确认连接。'), html`${stepper(STEPS, 0)}
<p>${clientName(request)} 请求连接本 Hub。</p>
<section class="ch-section">${facts(request)}</section>
<div>${invitationForm(request, error, true)}</div>
<p class="ch-meta">邀请码 24 小时内有效，仅可使用一次。${html`<a href="/console/login?next=${encodeURIComponent(`/console/authorize/${request.id}`)}">登录控制台</a>`}</p>`);
}

/**
 * The confirm step for `account`; `via` says whether it comes from an invitation or the console session. The form names the
 * account, and the approval is refused when it is no longer the one the page showed.
 */
export function confirmPage(request: AuthorizationRequest, account: { id: string; name: string; role: string }, via: 'invitation' | 'session', csrf: string, error: string | null): Html {
  const decide = html`<form method="post" action="/console/authorize/${request.id}" class="ch-actions">
<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="step" value="decide"><input type="hidden" name="account" value="${account.id}">
<button type="submit" class="ch-btn ch-btn--secondary" name="decision" value="deny">拒绝</button>
<button type="submit" class="ch-btn ch-btn--primary" name="decision" value="approve">允许连接</button>
</form>`;
  const other = via === 'session'
    ? html`<details><summary>以其他账号连接</summary><div>${invitationForm(request, null, false)}</div></details>`
    : '';
  return page(allowChrome(request, '管理员在团队页管理连接；成员在设置页查看本人的客户端。断开由管理员生成命令执行。'), html`${stepper(STEPS, 1)}
${error === null ? '' : html`<p class="error">${error}</p>`}
<p>以 <b data-evidence>${account.name}</b>（${account.role}）的身份允许 ${clientName(request)} 连接本 Hub。</p>
<section class="ch-section">${facts(request)}</section>
${redirectNotice(request.redirectUri, account.name)}
${!request.device ? '' : callout('warn', html`<span>只在上面的设备码与客户端显示的一致、且连接由本人发起时允许；他人发来的设备码请拒绝。</span>`)}
${callout('info', html`<span>确认后，该客户端可以 ${evidence(account.name)} 的身份调用 Hub 的工具，权限与该账号相同。</span>`)}
${decide}${other}`);
}

/** A request that already ended (the browser came back to it). */
export function endedPage(request: AuthorizationRequest): Html {
  const approved = request.ended === 'approved';
  const next = request.device ? '客户端随后自动完成连接，可关闭本页。' : '可关闭本页。';
  return page(chrome(approved ? '已允许连接' : '已拒绝'), html`${stepper(STEPS, 2)}
<p>${approved ? html`已允许 ${clientName(request)} 连接本 Hub，${next}` : html`已拒绝 ${clientName(request)} 的连接请求，该客户端未获连接。`}</p>`);
}

/** The device page: the user code a client shows is typed here (RFC 8628 3.3); `typed` is kept after a wrong code. */
export function deviceCodePage(typed: string, nonce: string, error: string | null): Html {
  return page(chrome('连接客户端', '输入客户端显示的设备码；下一步确认以哪个账号允许连接。'), html`${stepper(STEPS, 0)}
${error === null ? '' : html`<p class="error">${error}</p>`}
<form method="post" action="${DEVICE_PAGE}">
<div class="ch-field"><label class="ch-field-label" for="user-code">设备码</label><div class="ch-input"><input id="user-code" name="user_code" value="${typed}" autocomplete="off" autocapitalize="characters" spellcheck="false" size="12" maxlength="20" required placeholder="XXXX-XXXX"></div></div>
<input type="hidden" name="csrf" value="${nonce}">
<button type="submit" class="ch-btn ch-btn--primary">继续</button>
</form>
<p class="ch-meta">设备码 ${AUTHORIZATION_REQUEST_TTL_MS / 60_000} 分钟内有效，Hub 重启后失效。</p>`);
}

/** A request that does not exist for this browser (expired, ended by too many wrong codes, a restart, another browser's). */
export function expiredPage(message = `连接请求已过期、不存在，或不是由本浏览器发起的。连接请求 ${AUTHORIZATION_REQUEST_TTL_MS / 60_000} 分钟内有效，Hub 重启后失效。`): Html {
  return page(chrome('连接请求已失效'), html`<p>${message}</p><p class="ch-meta">请在客户端中重新连接，浏览器将打开新的连接确认页。</p>`);
}

/** An authorization request the endpoint cannot answer at a redirect URI (unknown client, mismatched redirect URI). */
export function refusedPage(message: string): Html {
  return page(chrome('连接请求无效'), html`<p class="error">${message}</p>`);
}

/** The message for an invitation that cannot be used. */
export function invitationProblem(reason: Extract<InvitationCheck, { ok: false }>['reason']): string {
  if (reason === 'used') return '邀请码已使用：请管理员重新签发';
  if (reason === 'expired') return '邀请码已过期：请管理员重新签发';
  if (reason === 'disabled') return `该账号${uiLabelOf('account_status','disabled')}，不能连接`;
  return '邀请码不正确';
}
