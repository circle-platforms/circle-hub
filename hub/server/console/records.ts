import {technicalCode,stat,facts} from './presentation.ts';
// 记录 (the design canvas's Audit board): the append-only call log with its filters, the calls per day and tool, per member
// and per result over the last 14 days, and the lines themselves. Administrators see every call with the admin notes; a
// member sees their own calls only (the call log answers so itself). /console/admin/calls is the administrators' path of
// the same page (decision 75).
import { CALL_RESULT, uiLabelOf, type CallResult } from '../../../contracts/generated/vocabulary.ts';
import { TOOLS } from '../../../contracts/src/tools.ts';
import { TRIAL_REPORT_SCHEMA, TrialRecord } from '../../connectors/api.ts';
import type { CallLogLine, Page } from '../../records/api.ts';
import { html, link, page, pageLayout, table, type Html } from './html.ts';
import { callTable, names, neutralPage, type PageContext, type PageResult } from './pages.ts';
import { TOOL_LABELS, toolName } from './tasks.ts';
import { card, count, dayBars, duration, hbar, kpi, plannedCard, sectionHead, stackBar } from './ui.ts';
import { spaceRecords } from './space-records.ts';

/** Trial actions are administrator-only and separate from the MCP call log and the real reads' statistics. */
async function trials(ctx: PageContext, path: string, user: string | undefined, from: string | undefined, to: string | undefined): Promise<Html> {
  if (!ctx.admin || param(ctx, 'tool') !== undefined || param(ctx, 'run') !== undefined) return html``;
  const found = user === '' ? { items: [], next: null } : await ctx.deps.records.store.find({
    kind: 'action', key: user === undefined ? 'action.kind' : 'action.user', value: user ?? 'trial',
    newestFirst: true, limit: 100, cursor: param(ctx, 'trial_cursor') ?? null,
  });
  const rows = [];
  for (const record of found.items) {
    if (record.schema !== TRIAL_REPORT_SCHEMA || (from !== undefined && record.created_at < from) || (to !== undefined && record.created_at > to)) continue;
    const parsed = TrialRecord.safeParse(record.body);
    if (!parsed.success) {
      rows.push([record.created_at, uiLabelOf('action_kind', 'trial'), '记录格式不可读', '', '', '', '']);
      continue;
    }
    const body = parsed.data;
    const outcome = (ok: boolean | null) => uiLabelOf('action_result', ok === null ? 'unknown' : ok ? 'completed' : 'error');
    const routes = body.routes.map((r) => [r.route, r.tried ? outcome(r.ok) : '未尝试读取', r.status === null ? '—' : `HTTP ${r.status}`, r.code ?? '—', r.ms === null ? '—' : duration(r.ms)]);
    rows.push([body.started_at, uiLabelOf('action_kind', body.action), await ctx.userName(body.principal), technicalCode(`${body.system_pack.id}@${body.system_pack.version}`),
      uiLabelOf('environment', body.environment), body.auth.sent ? `${outcome(body.auth.ok)}${body.auth.code === null ? '' : ` · ${body.auth.code}`}` : '未发送登录',
      html`<details><summary>${body.routes.length} 个接口</summary>${table(['接口', '结果', '状态码', '错误码', '耗时'], routes, '没有接口')}<p class="ch-meta">结束于 ${body.ended_at}</p></details>`,
    ]);
  }
  const next = found.next === null ? html`` : link(path, '下一页尝试读取记录', { user: param(ctx, 'user'), from: param(ctx, 'from'), to: param(ctx, 'to'), trial_cursor: found.next });
  return card({ title: `${uiLabelOf('action_kind', 'trial')}记录`, meta: '仅管理员可见 · 新的在前' },
    html`${table(['开始时间', '操作', '成员', uiLabelOf('pack_kind', 'system'), '环境', '登录', '接口结果'], rows, '本页没有尝试读取记录')}${next}`);
}

const param = (ctx: PageContext, name: string): string | undefined => {
  const value = ctx.url.searchParams.get(name);
  return value === null || value === '' ? undefined : value;
};

function isoOrUndefined(value: string | undefined): string | undefined | null {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

const WINDOW_DAYS = 14;
const STATS_LIMIT = 500;
const TOOL_FILLS = ['fill-t1', 'fill-t2', 'fill-t3', 'fill-t4', 'fill-t5', 'fill-t6'] as const;
const RESULT_FILL: Readonly<Record<CallResult, string>> = { ok: 'fill-pass', error: 'fill-fail', transport_failure: 'fill-incomplete' };

const day = (time: number): string => {
  const d = new Date(time);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

async function statistics(ctx: PageContext, now: number): Promise<Html> {
  const from = new Date(now - WINDOW_DAYS * 86_400_000);
  from.setHours(0, 0, 0, 0);
  let lines: Page<CallLogLine>;
  try {
    lines = await ctx.deps.records.callLog.query(ctx.principal, { from: from.toISOString(), limit: STATS_LIMIT });
  } catch {
    return card({ title: '统计' }, html`<p class="error">统计暂不可用</p>`);
  }
  const items = lines.items;
  const capped = lines.next !== null;
  const scope = capped ? `最近 ${WINDOW_DAYS} 天内最近的 ${STATS_LIMIT} 次调用` : `最近 ${WINDOW_DAYS} 天`;
  const errors = items.filter((line) => line.call_result !== 'ok').length;
  const refused = items.filter((line) => line.acceptance === 'not_accepted').length;
  const users = new Set(items.map((line) => line.user).filter((user) => user !== null));
  const kpis = html`<section class="ch-section" data-columns="4">
${kpi('工具调用', count(items.length), { unit: '次', note: scope, state: 'info' })}
${kpi('提交结果', count(items.filter((line) => line.tool === 'submit_result').length), { unit: '次', note: `其中未受理 ${refused} 次`, state: 'ok' })}
${kpi('调用出错', count(errors), { unit: '次', note: '出错与传输失败', state: errors > 0 ? 'down' : 'ok', ...(errors > 0 ? { tone: 'bad' as const } : {}) })}
${kpi(ctx.admin ? '成员' : '本人', count(users.size), { unit: '人', note: ctx.admin ? '有调用的成员' : '仅显示本人的调用', state: 'idle' })}
</section>`;
  const days: { label: string; start: number }[] = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const start = new Date(now - i * 86_400_000);
    start.setHours(0, 0, 0, 0);
    days.push({ label: day(start.getTime()), start: start.getTime() });
  }
  const tools = TOOLS.map((t) => t.name);
  const perDay = days.map((d, i) => {
    const end = i + 1 < days.length ? days[i + 1].start : Infinity;
    const inDay = items.filter((line) => { const t = Date.parse(line.at); return t >= d.start && t < end; });
    return { label: d.label, parts: tools.map((tool, j) => ({ value: inDay.filter((line) => line.tool === tool).length, fill: TOOL_FILLS[j % TOOL_FILLS.length] })) };
  });
  const legend = html`<div class="result-legend">${tools.map((tool, j) => html`<span title="${tool}"><i class="${TOOL_FILLS[j % TOOL_FILLS.length].replace('fill-', '')}"></i>${toolName(tool)} <b class="num">${items.filter((line) => line.tool === tool).length}</b></span>`)}</div>`;
  const distribution = card({ title: '工具调用分布', hint: `按日、按工具统计，${scope}` }, html`${legend}${dayBars(perDay, '每日各工具的调用次数')}<div class="axis"><span>${days[0].label}</span><span>${days[Math.floor(days.length / 2)].label}</span><span>今日</span></div>`);
  const byUser = new Map<string, number>();
  for (const line of items) if (line.user !== null) byUser.set(line.user, (byUser.get(line.user) ?? 0) + 1);
  const top = [...byUser].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const people = [];
  for (const [user, n] of top) people.push(html`<div class="frow"><span class="fname">${await ctx.userName(user)}</span>${hbar(n, top[0][1], 'fill-hub')}<span class="fval num">${n}</span></div>`);
  const results = CALL_RESULT.map((result) => ({ result, n: items.filter((line) => line.call_result === result).length }));
  const side = card({ title: ctx.admin ? '按成员' : '调用状态', hint: ctx.admin ? `按成员统计，${scope}` : `按调用状态统计，${scope}` }, html`${ctx.admin ? html`<div class="funnel">${people.length === 0 ? html`<p class="empty">没有调用</p>` : people}</div>${sectionHead('调用状态')}` : ''}${stackBar(results.map((r) => ({ value: r.n, fill: RESULT_FILL[r.result] })), '调用结果的占比')}<div class="result-legend">${results.map((r) => html`<span><i class="${RESULT_FILL[r.result].replace('fill-', 'f-')}"></i>${uiLabelOf('call_result', r.result)} <b class="num">${r.n}</b></span>`)}</div>`);
  return html`${kpis}<section class="ch-section" data-columns="2">${distribution}${side}</section>`;
}

/** The records page at `path` (/console/records, or /console/admin/calls for administrators only). */
export async function recordsPage(ctx: PageContext, path: '/console/records' | '/console/admin/calls'): Promise<PageResult> {
  if (path === '/console/admin/calls' && !ctx.admin) return neutralPage(ctx);
  const user = ctx.admin ? param(ctx, 'user') : undefined;
  const tool = param(ctx, 'tool');
  const run = param(ctx, 'run');
  const from = isoOrUndefined(param(ctx, 'from'));
  const to = isoOrUndefined(param(ctx, 'to'));
  const cursor = param(ctx, 'cursor');
  const problems: string[] = [];
  if (from === null) problems.push('“从”不是时间');
  if (to === null) problems.push('“到”不是时间');
  let userId: string | undefined;
  if (user !== undefined) {
    userId = /^usr_[0-9a-z]{26}$/.test(user) ? user : ((await ctx.deps.records.principals.findByName(user))?.id ?? '');
  }
  const toolOptions = html`<option value="">全部工具</option>${TOOLS.map((t) => html`<option value="${t.name}"${t.name === tool ? html` selected` : ''}>${t.label}</option>`)}${tool !== undefined && !TOOL_LABELS.has(tool) ? html`<option value="${tool}" selected>${tool}</option>` : ''}`;
  const filters = html`<form class="ch-actions" data-filters method="get" action="${path}">
${ctx.admin ? html`<label>成员 <input name="user" value="${user ?? ''}"></label>` : ''}<label>工具 <select name="tool">${toolOptions}</select></label>
<label>运行 <input name="run" value="${run ?? ''}"></label><label>从 <input name="from" value="${param(ctx, 'from') ?? ''}" placeholder="2026-11-01"></label>
<label>到 <input name="to" value="${param(ctx, 'to') ?? ''}"></label><button class="ch-btn ch-btn--secondary" type="submit">筛选</button></form>`;
  const chrome = ctx.chrome('记录', { active: 'records', hint: ctx.admin ? '操作与校验记录仅追加、不可修改，可按成员、工具、运行与时间筛选' : '仅显示与本人相关的调用；记录仅追加、不可修改' });
  if (problems.length > 0 || from === null || to === null) {
    return { status: 400, body: page(chrome, html`${card(null, html`${filters}<p class="error">${problems.join('；')}</p>`)}`) };
  }
  const lines =
    userId === ''
      ? { items: [], next: null }
      : await ctx.deps.records.callLog.query(ctx.principal, {
          ...(userId === undefined ? {} : { userId }),
          ...(tool === undefined ? {} : { tool }),
          ...(run === undefined ? {} : { runId: run }),
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
          limit: 100,
          cursor: cursor ?? null,
        });
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const next = lines.next === null ? html`` : html`<p>${link(path, '下一页', { user, tool, run, from: param(ctx, 'from'), to: param(ctx, 'to'), cursor: lines.next })}</p>`;
  const selectedDigest=param(ctx,'call');
  const selected=selectedDigest?lines.items.find(line=>line.digest===selectedDigest):undefined;
  if(selectedDigest&&!selected)return neutralPage(ctx);
  const inspector=selected?html`<div data-inspector-content><span class="ch-tag">调用记录</span><h2 class="ch-panel-title">${toolName(selected.tool)}</h2>${facts([['时间',selected.at],['成员',await ctx.userName(selected.user)],['调用结果',uiLabelOf('call_result',selected.call_result)],['受理结果',selected.acceptance?uiLabelOf('acceptance',selected.acceptance):'—'],['错误码',selected.error_code??'—'],['耗时',duration(selected.duration_ms)],['任务',selected.run?link('/console/runs/'+selected.run,'查看任务'):'—']])}${ctx.admin&&selected.admin_note?card({title:'管理员备注'},html`<p>${selected.admin_note}</p>`):''}${technicalCode(JSON.stringify(selected,null,2))}</div>`:html`<h2 class="ch-panel-title">记录</h2>${stat('本页调用',lines.items.length)}${stat('本页调用出错',lines.items.filter(line=>line.call_result!=='ok').length)}${lines.items[0]?card({title:'最近调用'},html`<p>${toolName(lines.items[0].tool)}</p><p class="ch-meta">${lines.items[0].at}</p>`):''}`;
  const list = card({ title: '调用记录', meta: `本页 ${lines.items.length} 条 · 新的在前` }, html`${filters}${callTable(lines.items, ctx.admin, await names(ctx, lines.items),{path,params:Object.fromEntries(ctx.url.searchParams),selected:selected?.digest})}${next}`);
  return {
    status: 200,
    body: page(chrome,pageLayout(html`${await statistics(ctx, now)}<div>${list}</div><div>${await trials(ctx, path, userId, from, to)}</div>${await spaceRecords(ctx, path, userId, from, to)}
${sectionHead('知识流向', undefined, undefined, undefined, '按成员、工作流追踪知识的来源、去向及所用流程')}
${plannedCard('知识流向', '记录中已包含每条知识的出处与每次引用；上线后在此将两者关联展示。', 'flow')}`,{inspector,detail:!!selected,back:link(path,'返回记录',Object.fromEntries([...ctx.url.searchParams].filter(([key])=>key!=='call')))})),
  };
}
