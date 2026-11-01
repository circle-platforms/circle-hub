// 连接 (the design canvas's Connections board): the Circles connected with a token, the business systems the Hub reads
// (resources, administrators only: the catalog gives others none) and the runtime environments dispatch jobs go to (the
// registered executors, administrators only). The Hub only reads business systems; a write route is never opened here.
// Enabling, disabling and re-authenticating a system or an environment are commands for the administrator's Circle
// (proposal decision 6 of 2026-10-31); connecting a business system is one of the console's four operations.
import { ENVIRONMENT_STATE, axisUiLabel, isEnvironment, uiLabelOf, type EnvironmentState } from '../../../contracts/generated/vocabulary.ts';
import type { TokenInfo } from '../../records/api.ts';
import type { ExecutorView } from '../api.ts';
import type { ResourceListing } from '../../ports.ts';
import { commands } from './commands.ts';
import { code, html, icon, link, liveModule, logo, page, table, type Html } from './html.ts';
import type { PageContext, PageResult } from './pages.ts';
import { readsText, systemReads } from './trial.ts';
import { button, callout, card, chip, commandLink, commandModal, duration, kpi, plannedCard, sectionHead, seg, when, type CommandDialog, type DotState, type Tone } from './ui.ts';

export interface Circle {
  owner: string;
  token: TokenInfo;
}

const DAY = 86_400_000;

export async function circlesOf(ctx: PageContext): Promise<Circle[]> {
  const users = ctx.admin ? await ctx.deps.records.principals.list() : [{ id: ctx.principal.id, name: ctx.principal.name, disabled: false }];
  const out: Circle[] = [];
  for (const user of users) {
    if (user.disabled) continue;
    for (const token of await ctx.deps.records.principals.tokens(user.id)) if (token.revoked_at === null) out.push({ owner: user.name, token });
  }
  return out.sort((a, b) => (b.token.last_used_at ?? '').localeCompare(a.token.last_used_at ?? ''));
}

const shortJob = (job: string): string => job.slice(0, 12);


/**
 * A runtime environment's state on the page, from the facts the dispatch journal establishes (ExecutorView.state):
 * 已停用 when disabled; 未知 when its occupancy could not be read; 已冻结 when a job holding it waits for a disposition of
 * an unconfirmed result, or a job left it unrestored (an open bed hold); 使用中 when a job holds it; 可用 otherwise.
 * `detail` says why, one line each.
 */
export function environmentState(view: ExecutorView): { code: EnvironmentState; text: string; tone: Tone; dot: DotState; detail: string[] } {
  const as = (code: EnvironmentState, tone: Tone, dot: DotState, detail: string[]) => ({ code, text: uiLabelOf('environment_state', code), tone, dot, detail });
  const state = view.state;
  if (!view.enabled) {
    const waiting = state?.holding?.filter((job) => job.frozen).length ?? 0;
    return as('deactivated', 'unchecked', 'idle', waiting > 0 ? [`仍有 ${waiting} 个作业的派发结果未确认，等待处置中`] : []);
  }
  if (state === undefined || !state.known.occupancy || state.holding === null) {
    return as('unknown', 'unknown', 'unknown', state !== undefined && state.missing.length > 0 ? [...state.missing] : ['占用与冻结状态暂不可读']);
  }
  const frozen = state.holding.filter((job) => job.frozen);
  const detail: string[] = [];
  for (const job of frozen) detail.push(`作业 ${shortJob(job.job)} 的派发结果未确认，等待处置中`);
  if (state.bed_hold !== null) detail.push(`作业 ${shortJob(state.bed_hold.job)} 结束后运行环境未恢复（${state.bed_hold.bed}），等待管理员确认中`);
  if (frozen.length > 0 || state.bed_hold !== null) return as('frozen', 'fail', 'down', detail);
  if (state.holding.length > 0) return as('in_use', 'judgment', 'info', state.holding.map((job) => `作业 ${shortJob(job.job)}（${axisUiLabel('effect_outcome')}：${uiLabelOf('effect_outcome', job.outcome)}）`));
  return as('available', 'pass', 'ok', []);
}

/** The note under the environments count: how many are in use, frozen, disabled or unknown. */
function environmentNote(executors: readonly ExecutorView[]): string {
  const counts = new Map<EnvironmentState, number>();
  for (const e of executors) {
    const code = environmentState(e).code;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const head = `${uiLabelOf('environment_state', 'available')} / 全部`;
  const parts = ENVIRONMENT_STATE.filter((code) => code !== 'available' && (counts.get(code) ?? 0) > 0).map((code) => `${uiLabelOf('environment_state', code)} ${counts.get(code)}`);
  return parts.length > 0 ? `${head}；${parts.join('，')}` : head;
}

function systemState(resource: ResourceListing): { text: string; tone: Tone; dot: DotState } {
  if (resource.binding_error !== undefined) return { text: '配置有误', tone: 'fail', dot: 'down' };
  return resource.enabled ? { text: '启用', tone: 'pass', dot: 'ok' } : { text: '已停用', tone: 'unchecked', dot: 'idle' };
}

/** Curves from each node of a column to the middle of the Hub node, in a 120 x 212 box stretched to its cell. */
function wires(count: number, toRight: boolean): Html {
  const n = Math.max(count, 1);
  const paths = Array.from({ length: n }, (_, i) => {
    const y = n === 1 ? 106 : 22 + (i * 168) / (n - 1);
    return toRight ? `M0 ${y.toFixed(1)} C60 ${y.toFixed(1)} 60 106 120 106` : `M0 106 C60 106 60 ${y.toFixed(1)} 120 ${y.toFixed(1)}`;
  });
  return html`<svg class="wires" viewBox="0 0 120 212" preserveAspectRatio="none" aria-hidden="true">${paths.map((d) => html`<path class="wire${count === 0 ? ' ghost' : ''}" d="${d}"></path>`)}</svg>`;
}

export async function connectionsPage(ctx: PageContext): Promise<PageResult> {
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const circles = await circlesOf(ctx);
  const resources = ctx.admin ? await ctx.deps.resources.list(ctx.principal) : [];
  let executors: ExecutorView[] | null = null;
  let executorsFailed = false;
  if (ctx.admin && ctx.deps.dispatch !== undefined) {
    try {
      executors = await ctx.deps.dispatch.executors(ctx.principal);
    } catch {
      executorsFailed = true;
    }
  }
  const dialogs: CommandDialog[] = [];
  const recent = circles.filter((c) => c.token.last_used_at !== null && now - Date.parse(c.token.last_used_at) < DAY).length;
  const kpis = html`<section class="grid g4 section">
${kpi('已连接的 Circle', circles.length, { unit: '个', note: `24 小时内使用过 ${recent} 个`, state: circles.length > 0 ? 'ok' : 'idle' })}
${ctx.admin ? kpi('业务系统', resources.filter((r) => r.enabled).length, { unit: `/ ${resources.length}`, note: '启用 / 全部，只读访问', state: resources.some((r) => r.binding_error) ? 'down' : 'ok' }) : kpi('业务系统', '—', { note: '仅管理员可见', state: 'idle' })}
${ctx.admin ? kpi('运行环境', executors === null ? '—' : executors.filter((e) => environmentState(e).code === 'available').length, { unit: executors === null ? '' : `/ ${executors.length}`, note: executors === null ? (executorsFailed ? '暂不可用' : '派发未接入') : environmentNote(executors), state: executors !== null && executors.some((e) => environmentState(e).code === 'frozen') ? 'down' : 'idle' }) : kpi('运行环境', '—', { note: '仅管理员可见', state: 'idle' })}
${kpi('业务系统写操作', '未开放', { note: '消息通知与数据回写均未开放', state: 'idle' })}
</section>`;
  const leftNodes = circles.slice(0, 5).map((c) => html`<div class="tnode"><span class="dot ${c.token.last_used_at !== null && now - Date.parse(c.token.last_used_at) < DAY ? 'ok' : 'idle'}" aria-hidden="true"></span><b>${c.owner}</b><span class="sub">${c.token.label || c.token.id}</span></div>`);
  const rightNodes = resources.slice(0, 5).map((r) => { const s = systemState(r); return html`<div class="tnode"><span class="dot ${s.dot}" aria-hidden="true"></span><b>${r.name}</b><span class="sub">${r.system_pack}</span></div>`; });
  const topology = card({ title: '连接拓扑', meta: '左侧为已连接的 Circle，右侧为业务系统；Hub 只执行只读访问' }, html`<div class="topo">
<div class="topo-col">${leftNodes.length === 0 ? html`<div class="tnode ghost">尚无已连接的 Circle</div>` : leftNodes}</div>
${wires(leftNodes.length, true)}
<div class="tnode hubn">${logo(true)}<b>circle-hub</b><span class="sub">MCP 服务</span></div>
${wires(rightNodes.length, false)}
<div class="topo-col">${rightNodes.length === 0 ? html`<div class="tnode ghost">${ctx.admin ? '尚无业务系统' : '业务系统仅管理员可见'}</div>` : rightNodes}</div>
</div>${circles.length > 5 || resources.length > 5 ? html`<p class="note">各列最多显示 5 个；完整列表见下文。</p>` : ''}`);
  const circleRows = circles.map((c) => [c.owner, c.token.label || '—', code(c.token.id), when(c.token.created_at), when(c.token.last_used_at)]);
  const circlesCard = card(null, table(['成员', '标签', '令牌', '签发时间', '最近使用'], circleRows, '尚无已连接的 Circle'));
  let systemsBody: Html;
  if (!ctx.admin) {
    systemsBody = html`<p class="sub">业务系统的配置仅管理员可见；任务中对业务系统的读取显示在各任务的执行过程中。</p>`;
  } else {
    const reads = await systemReads(ctx, resources.map((r) => r.id));
    const rows = resources.map((r) => {
      const s = systemState(r);
      const toggle = commands.resourceToggle(r);
      const relogin = commands.resourceResetLogin(r);
      dialogs.push(toggle, relogin);
      return [
        html`<span class="namecell"><span class="pack-i o" aria-hidden="true">${icon('sys')}</span><span><b>${r.name}</b><span class="digest">${r.id}</span></span></span>`,
        r.system_pack,
        isEnvironment(r.environment) ? uiLabelOf('environment', r.environment) : r.environment,
        r.origins === undefined ? '—' : html`${Object.entries(r.origins).map(([role, origin]) => html`<div>${role}：${code(origin)}</div>`)}`,
        html`${chip('只读', 'judgment')}${(r.allow_plaintext ?? []).length > 0 ? html` <span class="sub">明文 http：${(r.allow_plaintext ?? []).join('、')}</span>` : ''}`,
        html`${chip(s.text, s.tone)}${r.binding_error ? html`<div class="error small">${r.binding_error.message}</div>` : ''}`,
        reads === null ? '暂不可用' : readsText(reads.get(r.id)),
        html`${commandLink(toggle, r.enabled ? '停用' : '启用')} ${commandLink(relogin, '重新认证')}`,
      ];
    });
    const period = reads === null ? undefined : [...reads.values()][0];
    systemsBody = html`${table(['系统', '系统包', '环境', '访问地址', '访问方式', '状态', '近 24 小时读取', '操作'], rows, '尚无业务系统')}<p class="note">${period === undefined ? '' : `统计时段 ${when(period.since)} 至 ${when(period.until)}；`}读取次数与耗时取自每次读取的读取清单，耗时是已完成读取从开始到结束的时间的中位数。</p>`;
  }
  let environmentsBody: Html;
  if (!ctx.admin) environmentsBody = html`<p class="sub">运行环境仅管理员可见。</p>`;
  else if (executors === null) environmentsBody = html`<p class="sub">${executorsFailed ? '运行环境列表暂不可用。' : '这个 Hub 进程未接入派发；运行环境在 Hub 所在主机上以 circle-hub executor 登记。'}</p>`;
  else {
    environmentsBody = html`${table(['运行环境', '执行器', '执行器版本', '网关', '资源', '最近派发', '响应时间', '状态', '操作'], executors.map((e) => {
      const disable = commands.executorDisable(e);
      if (e.enabled) dialogs.push(disable);
      let gateway = e.endpoint;
      try { gateway = new URL(e.endpoint).origin; } catch { /* shown as written */ }
      const s = environmentState(e);
      const latest = e.state?.latest ?? null;
      const calls = e.calls_24h;
      const clear = e.state?.bed_hold ? commands.bedHoldClear(e) : null;
      if (clear !== null) dialogs.push(clear);
      // A frozen job is disposed of on the command line; its status names the disposition request and the choices. Two
      // environments on one physical target list the same job, and its dialog once.
      const frozen = (e.state?.holding ?? []).find((job) => job.frozen);
      const dispose = frozen === undefined ? null : commands.jobDispose(frozen.job);
      if (dispose !== null && !dialogs.some((dialog) => dialog.id === dispose.id)) dialogs.push(dispose);
      return [
        html`<b>${e.target}</b>`,
        code(e.id),
        e.state?.known.version !== true ? html`<span class="sub">未知</span>` : e.state.reported_version !== null ? code(e.state.reported_version) : html`<span class="sub">未上报</span>`,
        code(gateway),
        e.resources.length,
        e.state?.known.latest !== true
          ? html`<span class="sub">未知</span>`
          : latest === null
            ? html`<span class="sub">尚无派发</span>`
            : html`${latest.run === null ? when(latest.at) : link(`/console/runs/${latest.run}`, when(latest.at))}<div class="sub">${uiLabelOf('effect_outcome', latest.outcome)}${latest.frozen ? ' · 派发结果未确认' : ''}</div>`,
        calls === null || calls === undefined ? html`<span class="sub">暂不可用</span>`
          : calls.calls === 0 && !calls.partial ? '近 24 小时无调用'
          : html`${calls.partial ? '至少 ' : ''}${calls.calls} 次<div class="sub">中位 ${calls.median_ms === null ? '未知' : duration(calls.median_ms)} · 最慢 ${calls.slowest_ms === null ? '未知' : duration(calls.slowest_ms)}</div>`,
        html`${chip(s.text, s.tone)}${s.detail.map((line) => html`<div class="sub">${line}</div>`)}`,
        html`${e.enabled ? commandLink(disable, '停用') : ''}${clear === null ? '' : html` ${commandLink(clear, '确认已恢复')}`}${dispose === null ? '' : html` ${commandLink(dispose, '处置派发结果')}`}${frozen?.run ? html` ${link(`/console/runs/${frozen.run}`, '查看任务')}` : ''}`,
      ];
    }), '尚无运行环境')}<p class="note">响应时间取近 24 小时内已有发送与应答时刻的执行器调用；耗时为 Hub 发出请求到收到应答的时间，中位与最慢按已完成的调用计算。扫描受限时次数为下限，耗时只涵盖已扫描调用。</p>`;
  }
  const body = html`${liveModule('connections', ['member.connected', 'system.added', 'system.status', 'environment.status'], html`${kpis}
<div class="section">${topology}</div>`)}
${sectionHead('已连接的 Circle', ctx.admin ? '每台设备上的 Circle 以各自的令牌连接；断开在设置中生成命令' : '本人的 Circle，每台设备以各自的令牌连接', undefined, 'circles')}
${liveModule('circles', ['member.connected'], circlesCard)}
${sectionHead('业务系统', '凭据加密保存，页面与模型只可见名称；停用、启用与重新认证在 Circle 中执行', undefined, 'systems')}
${liveModule('systems', ['system.added', 'system.status'], card(null, systemsBody))}
${sectionHead('运行环境', '派发作业的执行环境，由管理员登记；派发结果未确认时冻结，不接受新的派发', undefined, 'envs')}
${liveModule('environments', ['environment.status'], card(null, environmentsBody))}
${executors !== null && executors.length > 0 ? callout('info', '占用与冻结取自派发记录：有作业持有时为使用中，派发结果未确认或作业结束后未恢复时为已冻结；执行器版本取自 Hub 与该执行器最近一次会话。') : ''}
${sectionHead('多终端协同与消息通知', '各终端 Circle 的工作状态同步，经 Hub 收发消息、转交任务', undefined, 'more')}
<section class="grid g2">${plannedCard('多终端协同', '各终端 Circle 的工作状态同步至 Hub，可在任一终端查看并继续任务。', 'terminal')}${plannedCard('消息通知', '接入 Telegram、微信、企业微信、飞书，经 Hub 收发消息、转交任务；需先开放“消息通知”。', 'chat')}</section>
${liveModule('dialogs', ['member.connected', 'system.added', 'system.status', 'environment.status'], dialogs.map(commandModal))}`;
  return {
    status: 200,
    body: page(ctx.chrome('连接', {
      active: 'connections',
      sub: 'Hub 以只读方式访问业务系统，不修改业务数据；派发作业的运行环境在此查看。',
      actions: html`${seg([['circles', '已连接的 Circle'], ['systems', '业务系统'], ['envs', '运行环境'], ['more', '多终端与通知']], '连接分区')}${ctx.admin ? button('/console/operations/system', '接入业务系统', { primary: true, icon: 'plus' }) : ''}`,
    }), body),
  };
}
