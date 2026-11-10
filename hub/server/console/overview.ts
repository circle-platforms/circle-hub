import {chart,parts,comparisons,timeline} from './charts.ts';
import {dot} from './ui.ts';
// 总览 (the design canvas's Main board): today's tasks with the span of their calls, each day's task results, the checks of
// those results, the main reasons items are held back, the business systems, the knowledge and the Hub's state. Every
// figure comes from the records the reader may see; a result is read for at most RECENT_LIMIT recent tasks, and the page
// says so when the window holds more. Nothing here is estimated.
import { TASK_RESULT, uiLabelOf, type TaskResult } from '../../../contracts/generated/vocabulary.ts';
import type { RunRecordView } from '../../../contracts/src/run.ts';
import type { CallLogLine } from '../../records/api.ts';
import { step } from '../../telemetry/api.ts';
import { html, table, link, liveModule, page, pageLayout, type Html } from './html.ts';
import { readableLines, type PageContext, type PageResult } from './pages.ts';
import { TASK_FILL, taskChip } from './status.ts';
import { loadTasks, packTitles, taskTitle, waitingRequests, type TaskRow } from './tasks.ts';
import { sizeText, storageFacts } from './settings.ts';
import { readsText, systemReads } from './trial.ts';
import { card, clock, count,  kpi, plannedCard, sectionHead, when } from './ui.ts';

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
    const listing = await ctx.deps.runs.listRuns(ctx.principal, { limit: Math.min(limit + 1, 500), cursor, requests: false });
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
    for(const layer of task.statistics?.checks??[]){
      if(layer.unknown){unknown+=layer.count;continue;}
      const key=`${layer.layer}:${layer.terminal}`;tally.set(key,(tally.get(key)??0)+layer.count);
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
    for(const item of task.statistics?.blockers??[]){
      const label=item.code??(item.reason?uiLabelOf('reason',item.reason):null);
      if(label!==null)tally.set(label,(tally.get(label)??0)+item.count);
    }
  }
  return [...tally].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 5);
}

async function periodTasks(ctx: PageContext, today: readonly TaskRow[], titles: ReadonlyMap<string, string>, now: number,since:number): Promise<Html> {
  let calls: readonly CallLogLine[] = [];
  try {
    calls = (await step('read-call-log', () => ctx.deps.records.callLog.query(ctx.principal, { from: new Date(since).toISOString(),to:new Date(now).toISOString(), limit: 500 }))).items;
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
  if (rows.length === 0) return html`<section class="ch-empty"><h3 class="ch-empty-title">所选时段没有任务</h3><p class="ch-empty-text">在客户端中运行工作流后，这里显示任务。</p>${link('/console/packs','查看工作流')}</section>`;
  const spansToShow=[];
  for(const row of rows){const span=spans.get(row.run.run),start=Date.parse(row.run.started_at),end=row.result==='awaiting'?now:span?.end??start,who=row.run.runner?await ctx.userName(row.run.runner):uiLabelOf('execution_host',row.run.host);spansToShow.push({label:taskTitle(row.run,titles),detail:who+' · '+(row.result?uiLabelOf('task_result',row.result):'结果暂不可用'),start,end:Math.max(start,end),url:'/console/runs/'+row.run.run});}
  return html`${timeline('期间任务',spansToShow,'最多显示最近 20 个任务；调用扫描上限 500 条，等待区间右端是当前截至时间')}${today.length>rows.length?html`<p>${link('/console/runs','查看全部任务')}</p>`:''}`;
}

export async function overviewPage(ctx: PageContext): Promise<PageResult> {
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const raw = Number(ctx.url.searchParams.get('days') ?? '7');
  const days = (PERIODS as readonly number[]).includes(raw) ? raw : 7;
  const since = startOfDay(now - (days - 1) * DAY);
  const [{ runs, more }, titles] = await Promise.all([step('list-runs', () => runsSince(ctx, since, RECENT_LIMIT)), packTitles(ctx)]);
  const tasks = await step('load-tasks', () => loadTasks(ctx, runs));
  const today=tasks;
  const settled = tasks.filter((task) => task.result !== null && task.result !== 'awaiting');
  const passed = settled.filter((task) => task.result === 'passed').length;
  const pending = tasks.reduce((n, task) => n + task.pending, 0);
  const requests = await step('list-requests', () => waitingRequests(ctx, tasks));
  const scope = more ? `最近 ${days} 天内最近的 ${RECENT_LIMIT} 个任务` : `最近 ${days} 天`;
  const kpis = html`<section class="ch-section" data-columns="4">
${kpi('任务', count(today.length), { unit: '个', note: `${scope}共 ${count(tasks.length)} 个`, state: 'info' })}
${kpi(uiLabelOf('task_result', 'passed'), settled.length === 0 ? '—' : `${Math.round((passed / settled.length) * 100)}`, { unit: settled.length === 0 ? '' : '%', note: `已有结果的 ${count(settled.length)} 个任务中 ${count(passed)} 个`, state: 'ok' })}
${kpi('未决项', count(pending), { unit: '项', hint: '已交付结果中尚无结论的要求项', state: pending > 0 ? 'unknown' : 'idle', ...(pending > 0 ? { tone: 'unk' as const } : {}) })}
${kpi(uiLabelOf('request_status','waiting')+'的请求', count(requests.length), { unit: '条', hint: '在接收人的客户端中处理', state: requests.length > 0 ? 'warn' : 'idle' })}
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
  const daily=chart('每日任务数量',columns.map((column,i)=>({label:column.label,values:[tasks.filter(task=>{const at=Date.parse(task.run.started_at);return at>=dayStarts[i]&&(i===dayStarts.length-1||at<dayStarts[i+1]);}).length]})),[{label:'任务'}],'bar',scope);
  const resultsTable=html`<details class="ch-tableview"><summary>按结果以表格查看</summary>${table(['日期',...shown.map(result=>uiLabelOf('task_result',result)),'结果暂不可用'],columns.map((column,i)=>[column.label,...column.parts.map(part=>part.value),tasks.filter(task=>task.result===null&&Date.parse(task.run.started_at)>=dayStarts[i]&&(i===dayStarts.length-1||Date.parse(task.run.started_at)<dayStarts[i+1])).length]))}</details>`;
  const checks=checkCounts(tasks),checkTotal=checks.reduce((sum,item)=>sum+item.value,0);
  const checkCard=card({title:'检查项结果',hint:scope+'全部结果中的检查项；等待判定中不计入通过，未知与检查未完成单独统计，不计入未通过。'},html`${kpi('检查项',checkTotal)}${parts(checks.map(item=>({label:item.label,value:item.value,className:item.fill})),'检查项结果分布')}`);
  const stuck=blockers(tasks),stuckCard=card({title:'主要阻塞原因',hint:scope+'被退回或未完成的条目，按原因汇总'},stuck.length?comparisons('主要阻塞原因',stuck):html`<p class="ch-empty-text">没有被退回或未完成的条目。</p>`);
  const { resources, reads } = await step('read-systems', async () => {
    const resources = ctx.admin ? await ctx.deps.resources.list(ctx.principal) : [];
    return { resources, reads: await systemReads(ctx, resources.slice(0, 6).map((r) => r.id),now-since) };
  });
  const systems = card({ title: '业务系统读取', meta:'当前配置 · '+scope+'读取', hint: '只读访问；'+scope+'的读取次数与耗时' }, html`${!ctx.admin ? html`<p class="ch-meta">业务系统的配置仅管理员可见。</p>` : resources.length === 0 ? html`<p class="empty">尚无业务系统。</p>` : html`<div class="ch-list">${resources.slice(0, 6).map((r) => html`<a class="ch-row" href="/console/connections#systems">${dot(r.binding_error ? 'down' : r.enabled ? 'ok' : 'idle')}<span class="ch-row-body"><b>${r.name}</b><span class="ch-meta">${r.binding_error ? '配置有误' : r.enabled ? '启用' : '已停用'}</span><span class="ch-meta">${reads === null ? '暂不可用' : readsText(reads.get(r.id),scope)}</span></span></a>`)}</div>`}
<div class="ch-actions"><span class="ch-tag">只读访问，不修改业务数据</span>${link('/console/connections', '查看全部')}</div>`);
  const { lines, current } = await step('read-lines', async () => {
    const lines = await readableLines(ctx);
    const rooted = await Promise.all(lines.map(async (line) => (await ctx.deps.knowledge.builds(line.id)).some((build) => build.root !== null)));
    return { lines, current: rooted.filter(Boolean).length };
  });
  const knowledge = card({ title: '知识库', meta:'当前快照', hint: '按产品线统计，成员可读分配给自己的工作流所绑定的产品线。' }, html`<div class="ch-stats">${kpi('产品线',lines.length)}${kpi('已有知识的产品线',current)}</div>
<div class="ch-actions"><span></span>${link('/console/knowledge', '打开知识库')}</div>`);
  const facts = ctx.hub;
  const storage = await step('read-storage', () => storageFacts(ctx));
  const backupNote = storage.backups === null ? '暂不可读' : storage.backups.count === 0 ? '尚无备份' : storage.backups.latest_at === null ? `${storage.backups.count} 份` : html`最近 ${when(storage.backups.latest_at)}`;
  const health = html`<div class="ch-list">
<a class="ch-row" href="/console/settings#hub">${dot('ok')}<span><b>服务</b><span class="ch-meta">运行中${facts?.release ? ` · ${facts.release}` : ''}</span></span></a>
<a class="ch-row" href="/console/settings#hub">${dot(facts?.certificate ? 'ok' : 'idle')}<span><b>证书</b><span class="ch-meta">${facts?.certificate ? '内置 HTTPS 已启用' : '未启用 HTTPS'}</span></span></a>
<a class="ch-row" href="/console/settings#hub">${dot('ok')}<span><b>数据库</b><span class="ch-meta">仅本机连接${storage.database_bytes === null ? '' : ` · ${sizeText(storage.database_bytes)}`}</span></span></a>
<a class="ch-row" href="/console/settings#hub">${dot(storage.backups !== null && storage.backups.count > 0 ? 'ok' : 'idle')}<span><b>备份</b><span class="ch-meta">${backupNote}</span></span></a>
<a class="ch-row" href="/console/records">${dot('info')}<span><b>记录</b><span class="ch-meta">仅追加，不可修改</span></span></a>
</div>`;
  const periods = html`<nav class="ch-seg" aria-label="时间范围">${PERIODS.map((n) => html`<a${n === days ? html` aria-current="page"` : ''} href="/console/overview?days=${n}">${n} 天</a>`)}</nav>`;
  const body = html`${liveModule('overview-kpis', ['task.updated', 'request.updated'], kpis)}
${liveModule('overview-today', ['task.updated'], html`<section class="ch-section">${await periodTasks(ctx,today,titles,now,since)}</section>`)}
${liveModule('overview-results', ['task.updated'], html`<section class="ch-section" data-columns="2"><div class="ch-section">${daily}${resultsTable}</div>${checkCard}</section>`)}
${liveModule('overview-state', ['task.updated', 'system.added', 'system.status', 'knowledge.published'], html`<section class="ch-section" data-columns="3">${stuckCard}${systems}${knowledge}</section>`)}
${sectionHead('规划中的功能', undefined, undefined, undefined, '已规划、尚未上线的功能，上线后在此处启用')}
<section class="ch-section" data-columns="3">${plannedCard('多终端协同', '各终端客户端的工作状态同步至 Hub，可在任一终端继续任务。', 'terminal')}${plannedCard('消息通知', '经 Hub 收发消息、转交任务；需先开放“消息通知”。', 'chat')}${plannedCard('定时任务与机器人', '按时间或事件自动执行知识导入、系统巡检与未知项汇总。', 'clock')}</section>
${sectionHead('当前运行状况', undefined, undefined, undefined, '服务、证书、数据库、备份与记录')}
${health}`;
  return {
    status: 200,
    body: page(ctx.chrome('总览', {
      active: 'overview',
      sub: html`${scope} · 截至 ${when(new Date(now).toISOString())}`,

    }),pageLayout(html`${periods}${body}`,{inspector:html`<h2 class="ch-panel-title">总览</h2><p class="ch-meta">${scope}</p>${kpi('任务',tasks.length)}${kpi('未决项',pending)}${card({title:'最近任务'},html`<ul class="ch-feed">${tasks.slice(0,3).map(task=>html`<li>${link('/console/runs/'+task.run.run,taskTitle(task.run,titles))}${task.result?taskChip(task.result):'结果暂不可用'}</li>`)}</ul>`)}`})),
  };
}
