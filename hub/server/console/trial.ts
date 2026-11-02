import {technicalCode} from './presentation.ts';
// 接入业务系统's 尝试连接 (connectors' trial.ts through ServerDeps.systems) and the reads each business system had in the last
// day (connectors' statistics.ts over the read manifests). The trial takes the very form of the operation: its addresses,
// plaintext roles, credential items and the credential contents typed with them. Only the trial action is saved; nothing of
// the answers is shown: the report names each route's result, status, time and size. The form comes back filled in, except the
// credential contents, which never go back into a page.
import { ACTION_RESULT, isEnvironment, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { ConnectorError, readStatistics, type ReadStatistics, type SystemTrialInput, type SystemTrialReport, type SystemTrialForget } from '../../connectors/api.ts';
import { html, table, type Html } from './html.ts';
import { FormError, credentialValues, pairs, word, type Form } from './manage.ts';
import type { PageContext } from './pages.ts';
import { card, chip, duration } from './ui.ts';

/** The trial input of the operation's form; throws FormError for a line it cannot read. */
export function trialInputOf(form: Form): SystemTrialInput {
  const environment = form.get('environment');
  if (!isEnvironment(environment)) throw new FormError('请选择环境');
  const origins: Record<string, string> = {};
  for (const line of pairs(form, 'origins', '访问地址')) {
    const at = line.indexOf('=');
    const role = line.slice(0, at).trim();
    if (Object.hasOwn(origins, role)) throw new FormError(`角色 ${role} 的地址写了两次`);
    origins[role] = line.slice(at + 1).trim();
  }
  if (Object.keys(origins).length === 0) throw new FormError('至少写一行 角色=地址');
  const plaintext = new Set<string>();
  for (const role of form.get('plaintext').split(/[,，\s]+/).filter(Boolean)) {
    if (!Object.hasOwn(origins, role)) throw new FormError(`允许明文的角色 ${role} 没有填写地址`);
    let url: URL;
    try {
      url = new URL(origins[role]);
    } catch {
      throw new FormError(`角色 ${role} 的地址不是 URL`);
    }
    if (url.protocol !== 'http:') throw new FormError(`角色 ${role} 的地址不是 http，不需要允许明文`);
    plaintext.add(url.origin);
  }
  // Each credential item names a credential; its content is the one typed under that name.
  const typed = credentialValues(form);
  const credentials: Record<string, string> = {};
  for (const line of pairs(form, 'credentials', '凭据项')) {
    const at = line.indexOf('=');
    const name = line.slice(at + 1).trim();
    if (Object.hasOwn(typed, name)) credentials[line.slice(0, at).trim()] = typed[name];
  }
  return { system_pack: word(form, 'system_pack', uiLabelOf('pack_kind', 'system')), environment, origins, ...(plaintext.size > 0 ? { allow_plaintext: [...plaintext] } : {}), credentials };
}

export type TrialOutcome = { report: SystemTrialReport } | { status: number; message: string };
export type ForgetOutcome = { forgotten: SystemTrialForget } | { status: number; message: string };

/** The form and JSON interface share the same administrator-only targeted reset; never run a trial afterwards. */
export async function runForgetTrial(ctx: PageContext, form: Form): Promise<ForgetOutcome> {
  if (ctx.deps.systems === undefined) return { status: 503, message: '尝试连接暂不可用：这个 Hub 进程没有接上业务系统连接' };
  try {
    return { forgotten: await ctx.deps.systems.forgetTrialLogin(ctx.principal, trialInputOf(form)) };
  } catch (error) {
    if (error instanceof FormError) return { status: 400, message: error.message };
    if (error instanceof ConnectorError && error.code === 'ACCESS_DENIED') return { status: 404, message: '' };
    if (error instanceof ConnectorError && error.code === 'STORE_FAILED') return { status: 503, message: '登录失败记录未能清除' };
    if (error instanceof ConnectorError && ['RESOURCE_INVALID', 'PACK_UNAVAILABLE', 'PROFILE_INVALID'].includes(error.code)) return { status: 400, message: error.message };
    throw error;
  }
}

export function forgetTrialMessage(result: SystemTrialForget): string {
  return !result.found ? '没有这组凭据的失败记录' : result.cleared ? '这组凭据的失败记录已清除；未发送登录，之后可再次尝试连接' : '失败记录在清除期间有更新，未清除；请确认账户状态后重试';
}

/** Runs the trial of `form` for the signed-in administrator. */
export async function runTrial(ctx: PageContext, form: Form): Promise<TrialOutcome> {
  if (ctx.deps.systems === undefined) return { status: 503, message: '尝试连接暂不可用：这个 Hub 进程没有接上业务系统连接' };
  let input: SystemTrialInput;
  try {
    input = trialInputOf(form);
  } catch (error) {
    if (error instanceof FormError) return { status: 400, message: error.message };
    throw error;
  }
  try {
    return { report: await ctx.deps.systems.trial(ctx.principal, input) };
  } catch (error) {
    if (error instanceof ConnectorError && ['RESOURCE_INVALID', 'PACK_UNAVAILABLE', 'PROFILE_INVALID'].includes(error.code)) return { status: 400, message: error.message };
    if (error instanceof ConnectorError && error.code === 'ACCESS_DENIED') return { status: 404, message: '' };
    throw error;
  }
}

const AUTH_KIND: Readonly<Record<SystemTrialReport['auth']['kind'], string>> = { none: '不需要认证', static_header: '固定凭据', login_token: '登录换取令牌' };

function authLine(report: SystemTrialReport): Html {
  const auth = report.auth;
  const state = auth.ok === true
    ? chip(auth.kind === 'login_token' ? '登录成功' : '凭据有效', 'pass')
    : auth.ok === false
      ? chip(auth.kind === 'login_token' ? '登录失败' : '凭据被拒绝', 'fail')
      : chip(auth.kind === 'none' ? '不需要认证' : '未检验', 'unchecked');
  const said = auth.message ?? auth.reason;
  return html`<p>${state} <span class="ch-meta">${AUTH_KIND[auth.kind]}${auth.ms === null ? '' : ` · 用时 ${duration(auth.ms)}`}${said === null ? '' : ` · ${said}`}</span></p>`;
}

/** The trial's report: authentication, then every route with its result; never a body, a header value or a credential. */
export function trialCard(report: SystemTrialReport): Html {
  const rows = report.routes.map((route) => [
    html`<b>${route.route}</b><div class="ch-meta">${route.method} ${route.path}</div>`,
    !route.tried ? chip('未尝试读取', 'unchecked') : route.ok === true ? chip('可读取', 'pass') : route.ok === false ? chip('读取失败', 'fail') : chip('结果未知', 'unchecked'),
    route.status === null ? '—' : `HTTP ${route.status}`,
    route.ms === null ? '—' : duration(route.ms),
    route.bytes === null ? '—' : `${route.bytes} 字节`,
    route.message ?? route.reason ?? '',
  ]);
  const tried = report.routes.filter((route) => route.tried).length;
  const spent = Date.parse(report.ended_at) - Date.parse(report.started_at);
  return card(
    { title: '尝试连接结果', meta: `${uiLabelOf('environment', report.environment)} · 尝试读取 ${tried} 个接口 · 用时 ${duration(spent)}` },
    html`${technicalCode(`${report.system_pack.id}@${report.system_pack.version}`)}${authLine(report)}${table(['接口', '结果', '状态', '耗时', '大小', '说明'], rows, '业务系统接入没有声明接口')}<p class="ch-meta">每次尝试连接记一条尝试读取记录，包含操作者、时间与各接口的结果；不保存配置、凭据内容或来源原文。登录失败时，加密保存用于防止重复登录的摘要。需要参数的接口不尝试读取；登录失败后，同样的凭据不再发送。</p>`,
  );
}

/** The reads of the last day of each business system; null when they cannot be read now (unknown stays unknown). */
export async function systemReads(ctx: PageContext, ids: readonly string[]): Promise<Map<string, ReadStatistics> | null> {
  if (!ctx.admin || ids.length === 0) return new Map();
  try {
    const stats = await readStatistics(ctx.deps.records.store, ids, ctx.deps.now?.() ?? new Date());
    return new Map(stats.map((item) => [item.resource, item]));
  } catch {
    return null;
  }
}

/** One line for a table or the overview: the reads of the window, those not completed by result, the median time. */
export function readsText(stats: ReadStatistics | null | undefined): string {
  if (stats === null || stats === undefined) return '暂不可用';
  if (stats.reads === 0) return '近 24 小时无读取';
  const others = ACTION_RESULT.filter((result) => result !== 'completed' && stats.results[result] > 0).map((result) => `${uiLabelOf('action_result', result)} ${stats.results[result]} 次`);
  return `${stats.partial ? '至少 ' : ''}${stats.reads} 次${others.length > 0 ? `（${others.join('，')}）` : ''}${stats.median_ms === null ? '' : ` · 中位 ${duration(stats.median_ms)}`}`;
}

/** The statistics as the JSON interface answers them. */
export function readsJson(stats: ReadStatistics | null | undefined): Record<string, unknown> | null {
  if (stats === null || stats === undefined) return null;
  return { since: stats.since, until: stats.until, reads: stats.reads, results: stats.results, results_label: Object.fromEntries(ACTION_RESULT.map((result) => [result, uiLabelOf('action_result', result)])), median_ms: stats.median_ms, slowest_ms: stats.slowest_ms, last_at: stats.last_at, partial: stats.partial };
}

/** The report as the JSON interface answers it: the same fields, nothing of the answers. */
export function trialJson(report: SystemTrialReport): Record<string, unknown> {
  return { ...report, environment_label: uiLabelOf('environment', report.environment) };
}
