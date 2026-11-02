// 总览 (the design canvas's Main board): today's tasks with the span of their calls, each day's task results, the checks of
// those results, the main reasons items are held back, the business systems, the knowledge and the Hub's state. Every
// figure comes from the records the reader may see; a result is read for at most RECENT_LIMIT recent tasks, and the page
// says so when the window holds more. Nothing here is estimated.
import { TASK_RESULT, uiLabelOf, type TaskResult } from '../../../contracts/generated/vocabulary.ts';
import type { RunRecordView } from '../../../contracts/src/run.ts';
import { isUnknownTerminal } from '../../../contracts/src/validation.ts';
import type { CallLogLine } from '../../records/api.ts';
import { html, link, liveModule, page, type Html } from './html.ts';
import { readableLines, type PageContext, type PageResult } from './pages.ts';
import { TASK_FILL, primaryResult, swatch, taskChip } from './status.ts';
import { loadTasks, packTitles, taskTitle, type TaskRow } from './tasks.ts';
import { sizeText, storageFacts } from './settings.ts';
import { readsText, systemReads } from './trial.ts';
import { card, clock, count, dayBars, donut, hbar, kpi, plannedCard, sectionHead, track, when } from './ui.ts';

export const PERIODS = [7, 14, 30] as const;
export const RECENT_LIMIT = 120;
const DAY = 86_400_000;

export const startOfDay = (time: number): number => {
  const d = new Date(time);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The runs that started since `since`, newest first, at most `limit`; `more` when the window holds others. */
export async function runsSince(ctx: PageContext, since: number, limit: number): Promise<{ runs: RunRecordView[]; more: boolean }> {
  const runs: RunRecordView[] = [];
  let cursor: string | null = null;
  do {
    const listing = await ctx.deps.runs.listRuns(ctx.principal, { limit: 50, cursor });
    for (const run of listing.items) {
      if (Date.parse(run.started_at) < since) return { runs, more: false };
      if (runs.length === limit) return { runs, more: true };
      runs.push(run);
    }
    cursor = listing.next;
  } while (cursor !== null);
  return { runs, more: false };
}

/** The checks of the results, each layer terminal under its interface term (display rule 5: unknown kept apart). */
export function checkCounts(tasks: readonly TaskRow[]): { label: string; value: number; stroke: string; fill: string }[] {
  const tally = new Map<string, number>();
  let unknown = 0;
  for (const task of tasks) {
    const primary = task.detail === null ? null : primaryResult(task.detail);
    if (primary === null || primary.result.acceptance !== 'accepted') continue;
    for (const item of Object.values(primary.result.partitions).flat()) for (const r of item.requirements) for (const layer of r.layers) {
      if (isUnknownTerminal(layer)) { unknown += 1; continue; }
      const key = `${layer.layer}:${layer.terminal}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const sum = (keys: readonly string[]) => keys.reduce((n, key) => n + (tally.get(key) ?? 0), 0);
  return [
    { label: uiLabelOf('static_terminal', 'pass'), value: sum(['static:pass', 'dynamic:pass']), stroke: 'stroke-pass', fill: 'fill-pass' },
    { label: uiLabelOf('static_terminal', 'violation'), value: sum(['static:violation', 'dynamic:fail']), stroke: 'stroke-fail', fill: 'fill-fail' },
    { label: uiLabelOf('static_terminal', 'judgment'), value: sum(['static:judgment']), stroke: 'stroke-judgment', fill: 'fill-judgment' },
    { label: uiLabelOf('dynamic_terminal', 'no_verdict'), value: sum(['dynamic:no_verdict']), stroke: 'stroke-judgment', fill: 'fill-judgment' },
    { label: uiLabelOf('nature', 'unknown'), value: unknown, stroke: 'stroke-unknown', fill: 'fill-unknown' },
    { label: uiLabelOf('static_terminal', 'incomplete'), value: sum(['static:incomplete', 'dynamic:incomplete']), stroke: 'stroke-incomplete', fill: 'fill-incomplete' },
  ];
}

/** Why items were held back: the codes of rejected items and the reasons of incomplete and held items, most frequent first. */
export function blockers(tasks: readonly TaskRow[]): { label: string; value: number }[] {
  const tally = new Map<string, number>();
  for (const task of tasks) {
    const primary = task.detail === null ? null : primaryResult(task.detail);
    if (primary === null || primary.result.acceptance !== 'accepted') continue;
    const parts = primary.result.partitions;
    for (const item of [...parts.rejected, ...parts.incomplete, ...parts.quarantined]) {
      const label = 'code' in item ? item.code : 'reason' in item ? uiLabelOf('reason', item.reason) : null;
      if (label !== null) tally.set(label, (tally.get(label) ?? 0) + 1);
    }
  }
  return [...tally].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 5);
}

async function todayTasks(ctx: PageContext, today: readonly TaskRow[], titles: ReadonlyMap<string, string>, now: number): Promise<Html> {
  let calls: readonly CallLogLine[] = [];
  try {
    calls = (await ctx.deps.records.callLog.query(ctx.principal, { from: new Date(startOfDay(now)).toISOString(), limit: 500 })).items;
  } catch {
    calls = [];
  }
  const spans = new Map<string, { start: number; end: number }>();
  for (const line of calls) {
    if (line.run === null) continue;
    const end = Date.parse(line.at);
    const start = end - line.duration_ms;
    const span = spans.get(line.run);
    spans.set(line.run, span === undefined ? { start, end } : { start: Math.min(span.start, start), end: Math.max(span.end, end) });
  }
  const rows = today.slice(0, 20);
  if (rows.length === 0) return html`<p class="empty">今日尚无任务。</p>`;
  const starts = rows.map((row) => Math.min(Date.parse(row.run.started_at), spans.get(row.run.run)?.start ?? Infinity));
  const t0 = Math.min(...starts);
  const t1 = Math.max(now, ...rows.map((row) => spans.get(row.run.run)?.end ?? 0));
  const at = (t: number): number => ((t - t0) / Math.max(t1 - t0, 1)) * 100;
  const lines: Html[] = [];
  for (const [i, row] of rows.entries()) {
    const span = spans.get(row.run.run);
    const start = starts[i];
    const end = row.result === 'awaiting' ? now : span?.end ?? start;
    const who = row.run.runner === undefined ? uiLabelOf('execution_host', row.run.host) : await ctx.userName(row.run.runner);
    lines.push(html`<a class="wf-row" href="/console/runs/${row.run.run}"><span class="wf-name"><b>${taskTitle(row.run, titles)}</b><span class="sub">${who} · ${clock(row.run.started_at)}</span></span><span class="wf-track">${track(at(start), at(end), row.result === null ? 'fill-unchecked' : row.result === 'awaiting' ? 'fill-wait' : 'fill-circle', { label: taskTitle(row.run, titles) })}</span><span class="wf-dur">${row.result === null ? '—' : taskChip(row.result)}</span></a>`);
  }
  const ticks = [0, 1, 2, 3, 4].map((k) => clock(t0 + ((t1 - t0) * k) / 4));
  return html`<div class="wf-legend"><span><i class="k-circle"></i>Circle 调用</span><span><i class="k-wait"></i>等待提交中</span></div>
<div class="wf tasks task-list"><div class="wf-axis"><span class="sub">任务 · 执行人 · 开始时间</span><span class="wf-ticks flex">${ticks.map((t) => html`<span>${t}</span>`)}</span><span class="wf-dur">结果</span></div>
<div class="wf-rows">${lines}</div></div>${today.length > rows.length ? html`<p class="note">今日共 ${today.length} 个任务，显示最近的 ${rows.length} 个；${link('/console/runs', '查看全部任务')}。</p>` : ''}`;
}

export async function overviewPage(ctx: PageContext): Promise<PageResult> {
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const raw = Number(ctx.url.searchParams.get('days') ?? '7');
  const days = (PERIODS as readonly number[]).includes(raw) ? raw : 7;
  const since = startOfDay(now - (days - 1) * DAY);
  const [{ runs, more }, titles] = await Promise.all([runsSince(ctx, since, RECENT_LIMIT), packTitles(ctx)]);
  const tasks = await loadTasks(ctx, runs);
  const today = tasks.filter((task) => Date.parse(task.run.started_at) >= startOfDay(now));
  const settled = tasks.filter((task) => task.result !== null && task.result !== 'awaiting');
  const passed = settled.filter((task) => task.result === 'passed').length;
  const pending = tasks.reduce((n, task) => n + task.pending, 0);
  const requests = (await ctx.deps.runs.listRequests?.(ctx.principal) ?? []).filter((r) => r.answered_by === null);
  const scope = more ? `最近 ${days} 天内最近的 ${RECENT_LIMIT} 个任务` : `最近 ${days} 天`;
  const kpis = html`<section class="grid g4 section">
${kpi('今日任务', count(today.length), { unit: '个', note: `${scope}共 ${count(tasks.length)} 个`, state: 'info' })}
${kpi(uiLabelOf('task_result', 'passed'), settled.length === 0 ? '—' : `${Math.round((passed / settled.length) * 100)}`, { unit: settled.length === 0 ? '' : '%', note: `已有结果的 ${count(settled.length)} 个任务中 ${count(passed)} 个`, state: 'ok' })}
${kpi('未决项', count(pending), { unit: '项', note: '已交付结果中尚无结论的要求项', state: pending > 0 ? 'unknown' : 'idle', ...(pending > 0 ? { tone: 'unk' as const } : {}) })}
${kpi('等待回应中的请求', count(requests.length), { unit: '条', note: '在接收人的 Circle 中处理', state: requests.length > 0 ? 'warn' : 'idle' })}
</section>`;
  // Each day's results: a column per day stacked by task result, the held result only while one exists.
  const dayStarts = Array.from({ length: days }, (_, i) => startOfDay(now - (days - 1 - i) * DAY));
  const shown = TASK_RESULT.filter((result) => result !== 'held' || tasks.some((task) => task.result === 'held'));
  const columns = dayStarts.map((start, i) => {
    const end = i + 1 < dayStarts.length ? dayStarts[i + 1] : Infinity;
    const inDay = tasks.filter((task) => { const t = Date.parse(task.run.started_at); return t >= start && t < end; });
    const d = new Date(start);
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, parts: shown.map((result) => ({ value: inDay.filter((task) => task.result === result).length, fill: TASK_FILL[result] })) };
  });
  const totals = new Map<TaskResult, number>();
  for (const task of tasks) if (task.result !== null) totals.set(task.result, (totals.get(task.result) ?? 0) + 1);
  const legend = html`<div class="result-legend">${shown.filter((result) => (totals.get(result) ?? 0) > 0 || result === 'passed').map((result) => html`<span>${swatch(TASK_FILL[result])}${uiLabelOf('task_result', result)} <b class="num">${totals.get(result) ?? 0}</b></span>`)}</div>`;
  const daily = card({ title: '每日任务结果', hint: `按任务结果统计，${scope}` }, html`${legend}${dayBars(columns, `${scope}每天的任务结果`)}<div class="axis"><span>${columns[0].label}</span><span>${columns[Math.floor(columns.length / 2)].label}</span><span>今日</span></div>`);
  const checks = checkCounts(tasks);
  const checkTotal = checks.reduce((n, c) => n + c.value, 0);
  const checkCard = card({ title: '检查项结果', hint: `${scope}全部结果中的检查项` }, html`<div class="donut-box">${donut(checks.map((c) => ({ value: c.value, stroke: c.stroke })), { value: count(checkTotal), label: '项检查' }, '检查项结果的分布')}
<ul class="dlist">${checks.map((c) => html`<li>${swatch(c.fill)}<span>${c.label}</span><b class="num">${c.value}</b><em class="num">${checkTotal === 0 ? '—' : `${Math.round((c.value / checkTotal) * 100)}%`}</em></li>`)}</ul></div>
<p class="note">“等待判定中”不计入通过；“未知”与“检查未完成”单独统计，不计入未通过。</p>`);
  const stuck = blockers(tasks);
  const stuckCard = card({ title: '主要阻塞原因', hint: `${scope}被退回或未完成的条目，按原因汇总` }, html`${stuck.length === 0 ? html`<p class="empty">没有被退回或未完成的条目。</p>` : html`<div class="funnel">${stuck.map((s) => html`<div class="frow"><span class="fname" title="${s.label}">${s.label}</span>${hbar(s.value, stuck[0].value, 'fill-wait')}<span class="fval num">${s.value}</span></div>`)}</div>`}
<p class="note">相关请求已下发至对应的 Circle，在 Circle 中处理。</p>`);
  const resources = ctx.admin ? await ctx.deps.resources.list(ctx.principal) : [];
  const reads = await systemReads(ctx, resources.slice(0, 6).map((r) => r.id));
  const systems = card({ title: '业务系统', hint: '只读访问；近 24 小时的读取次数与耗时' }, html`${!ctx.admin ? html`<p class="sub">业务系统的配置仅管理员可见。</p>` : resources.length === 0 ? html`<p class="empty">尚无业务系统。</p>` : html`<div class="syslist">${resources.slice(0, 6).map((r) => html`<a class="sysrow" href="/console/connections#systems"><span class="dot ${r.binding_error ? 'down' : r.enabled ? 'ok' : 'idle'}" aria-hidden="true"></span><span class="sys-t"><b>${r.name}</b><span class="sub">${r.system_pack} · ${r.binding_error ? '配置有误' : r.enabled ? '启用' : '已停用'}</span></span><span class="sub">${reads === null ? '暂不可用' : readsText(reads.get(r.id))}</span></a>`)}</div>`}
<div class="card-f"><span class="chip plain">只读访问，不修改业务数据</span>${link('/console/connections', '查看全部')}</div>`);
  const lines = await readableLines(ctx);
  let current = 0;
  for (const line of lines) {
    for (const build of await ctx.deps.knowledge.builds(line.id)) if (build.root !== null) { current += 1; break; }
  }
  const knowledge = card({ title: '知识库', hint: '按产品线统计' }, html`<div class="kstats two"><div><span class="sub">产品线</span><b class="num">${lines.length}</b></div><div><span class="sub">已有知识的产品线</span><b class="num">${current}</b></div></div>
<p class="sub">每条知识均附出处；成员可读分配给自己的工作流所绑定的产品线。</p><div class="card-f"><span></span>${link('/console/knowledge', '打开知识库')}</div>`);
  const facts = ctx.hub;
  const storage = await storageFacts(ctx);
  const backupNote = storage.backups === null ? '暂不可读' : storage.backups.count === 0 ? '尚无备份' : storage.backups.latest_at === null ? `${storage.backups.count} 份` : `最近 ${when(storage.backups.latest_at)}`;
  const health = html`<div class="health">
<a class="hcell" href="/console/settings#hub"><span class="dot ok" aria-hidden="true"></span><span><b>服务</b><span class="sub">运行中${facts?.release ? ` · ${facts.release}` : ''}</span></span></a>
<a class="hcell" href="/console/settings#hub"><span class="dot ${facts?.certificate ? 'ok' : 'idle'}" aria-hidden="true"></span><span><b>证书</b><span class="sub">${facts?.certificate ? '内置 HTTPS 已启用' : '未启用 HTTPS'}</span></span></a>
<a class="hcell" href="/console/settings#hub"><span class="dot ok" aria-hidden="true"></span><span><b>数据库</b><span class="sub">仅本机连接${storage.database_bytes === null ? '' : ` · ${sizeText(storage.database_bytes)}`}</span></span></a>
<a class="hcell" href="/console/settings#hub"><span class="dot ${storage.backups !== null && storage.backups.count > 0 ? 'ok' : 'idle'}" aria-hidden="true"></span><span><b>备份</b><span class="sub">${backupNote}</span></span></a>
<a class="hcell" href="/console/records"><span class="dot info" aria-hidden="true"></span><span><b>记录</b><span class="sub">仅追加，不可修改</span></span></a>
</div>`;
  const periods = html`<nav class="seg" aria-label="时间范围">${PERIODS.map((n) => html`<a${n === days ? html` class="on" aria-current="true"` : ''} href="/console/overview?days=${n}">${n} 天</a>`)}</nav>`;
  const body = html`${liveModule('overview-kpis', ['task.updated', 'request.updated'], kpis)}
${liveModule('overview-today', ['task.updated'], html`<section class="card section"><div class="card-h"><h3 title="每行一个任务，点击查看执行过程">今日任务</h3></div>${await todayTasks(ctx, today, titles, now)}</section>`)}
${liveModule('overview-results', ['task.updated'], html`<section class="grid g-2-1 section">${daily}${checkCard}</section>`)}
${liveModule('overview-state', ['task.updated', 'system.added', 'system.status', 'knowledge.published'], html`<section class="grid g3 section">${stuckCard}${systems}${knowledge}</section>`)}
${sectionHead('规划中的功能', undefined, undefined, undefined, '已规划、尚未上线的功能，上线后在此处启用')}
<section class="grid g3">${plannedCard('多终端协同', '各终端 Circle 的工作状态同步至 Hub，可在任一终端继续任务。', 'terminal')}${plannedCard('消息通知', '经 Hub 收发消息、转交任务；需先开放“消息通知”。', 'chat')}${plannedCard('定时任务与机器人', '按时间或事件自动执行知识导入、系统巡检与未知项汇总。', 'clock')}</section>
${sectionHead('运行状况', undefined, undefined, undefined, '服务、证书、数据库、备份与记录')}
${health}`;
  return {
    status: 200,
    body: page(ctx.chrome('总览', {
      active: 'overview',
      sub: `${scope} · 截至 ${when(new Date(now).toISOString())}`,
      actions: periods,
    }), body),
  };
}
