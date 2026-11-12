import {chart,parts,comparisons} from './charts.ts';
import {dot} from './ui.ts';
// 总览 (the design canvas's Main board): today's tasks with the span of their calls, each day's task results, the checks of
// those results, the main reasons items are held back, the business systems, the knowledge and the Hub's state. Every
// figure comes from the records the reader may see; a result is read for at most RECENT_LIMIT recent tasks, and the page
// says so when the window holds more. Nothing here is estimated.
import { TASK_RESULT, uiLabelOf, type TaskResult } from '../../../contracts/generated/vocabulary.ts';
import type { RunRecordView } from '../../../contracts/src/run.ts';
import { step } from '../../telemetry/api.ts';
import { html, table, link, liveModule, page, pageLayout, type Html } from './html.ts';
import { readableLines, type PageContext, type PageResult } from './pages.ts';
import { taskChip } from './status.ts';
import { loadTasks, packTitles, taskTitle, waitingRequests, type TaskRow } from './tasks.ts';
import { sizeText, storageFacts } from './settings.ts';
import { readsText, systemReads } from './trial.ts';
import { box, count, kpi, tile, when } from './ui.ts';

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
  const awaiting = tasks.filter((task) => task.result === 'awaiting').length;
  const kinds = new Set(requests.map((request) => request.missing)).size;
  const perRun = new Map<string, number>();
  for (const request of requests) if (request.run) perRun.set(request.run, (perRun.get(request.run) ?? 0) + 1);
  // The four figures of the page; each says what it counts, and the first leads to the list it counts.
  const kpis = html`<section class="ch-tiles" data-overview-kpis>
${tile(kpi('任务', count(today.length), { unit: '个', note: `${scope}共 ${count(tasks.length)} 个${awaiting > 0 ? ` · ${uiLabelOf('task_result', 'awaiting')} ${count(awaiting)}` : ''}`, state: 'info' }), '/console/runs', '查看任务列表')}
${tile(kpi(uiLabelOf('task_result', 'passed'), settled.length === 0 ? '—' : count(passed), { unit: settled.length === 0 ? '' : `/ ${count(settled.length)}`, note: `已有结果的 ${count(settled.length)} 个任务中 ${count(passed)} 个`, state: settled.length===0?'idle':'ok' }))}
${tile(kpi('未决项', count(pending), { unit: '项', hint: '已交付结果中尚无结论的要求项', state: pending > 0 ? 'unknown' : 'idle', ...(pending > 0 ? { tone: 'unk' as const } : {}) }))}
${tile(kpi(uiLabelOf('request_status','waiting')+'的请求', count(requests.length), { unit: '条', hint: '在接收人的客户端中处理', ...(kinds > 0 ? { note: `内容相同的归并后 ${count(kinds)} 类` } : {}), state: requests.length > 0 ? 'warn' : 'idle' }))}
</section>`;
  // Each day's results: a column per day stacked by task result, the held result only while one exists.
  const dayStarts = Array.from({ length: days }, (_, i) => startOfDay(now - (days - 1 - i) * DAY));
  const shown = TASK_RESULT.filter((result) => result !== 'held' || tasks.some((task) => task.result === 'held'));
  const columns = dayStarts.map((start, i) => {
    const end = i + 1 < dayStarts.length ? dayStarts[i + 1] : Infinity;
    const inDay = tasks.filter((task) => { const t = Date.parse(task.run.started_at); return t >= start && t < end; });
    const d = new Date(start);
    return { label: `${d.getMonth() + 1}/${d.getDate()}`, parts: shown.map((result) => inDay.filter((task) => task.result === result).length), all: inDay.length, unread: inDay.filter((task) => task.result === null).length };
  });
  const daily=chart('每日任务数量',columns.map((column)=>({label:column.label,values:[column.all]})),[{label:'任务'}],'bar',scope);
  const resultsTable=html`<details class="ch-tableview"><summary>按结果以表格查看</summary>${table(['日期',...shown.map(result=>uiLabelOf('task_result',result)),'结果暂不可用'],columns.map((column)=>[column.label,...column.parts,column.unread]))}</details>`;
  const checks=checkCounts(tasks),checkTotal=checks.reduce((sum,item)=>sum+item.value,0);
  const checkCard=box({title:'检查项结果',meta:`共 ${count(checkTotal)} 项`,hint:scope+'全部结果中的检查项；等待判定中不计入通过，未知与检查未完成单独统计，不计入未通过。'},parts(checks.map(item=>({label:item.label,value:item.value,className:item.fill})),'检查项结果分布'));
  const stuck=blockers(tasks);
  const stuckCard=stuck.length?box({title:'主要阻塞原因',hint:scope+'被退回或未完成的条目，按原因汇总'},comparisons('主要阻塞原因',stuck)):html``;
  const { resources, reads } = await step('read-systems', async () => {
    const resources = ctx.admin ? await ctx.deps.resources.list(ctx.principal) : [];
    return { resources, reads: await systemReads(ctx, resources.slice(0, 6).map((r) => r.id),now-since) };
  });
  const systems = !ctx.admin ? html`` : box({ title: '业务系统读取', hint: '只读访问，不修改业务数据；'+scope+'的读取次数与耗时', tail: link('/console/connections', '查看全部') }, resources.length === 0 ? html`<p class="ch-empty-text">尚无业务系统。</p>` : html`<div class="ch-list">${resources.slice(0, 6).map((r) => html`<a class="ch-row" href="/console/connections#systems">${dot(r.binding_error ? 'down' : r.enabled ? 'ok' : 'idle')}<span class="ch-row-body"><b>${r.name}</b><span class="ch-meta">${r.binding_error ? '配置有误' : r.enabled ? '启用' : '已停用'}</span><span class="ch-meta">${reads === null ? '暂不可用' : readsText(reads.get(r.id),scope)}</span></span></a>`)}</div>`, { flush: resources.length > 0 });
  let state: Html;
  if (ctx.admin) {
    const facts = ctx.hub;
    const storage = await step('read-storage', () => storageFacts(ctx));
    const backupNote = storage.backups === null ? '暂不可读' : storage.backups.count === 0 ? '尚无备份' : storage.backups.latest_at === null ? `${storage.backups.count} 份` : html`最近 ${when(storage.backups.latest_at)}`;
    state = box({ title: 'Hub 状态', tail: link('/console/settings#hub', '查看 Hub 状态') }, html`<div class="ch-list">
<a class="ch-row" href="/console/settings#hub">${dot('ok')}<span><b>服务</b><span class="ch-meta">运行中${facts?.release ? ` · ${facts.release}` : ''}</span></span></a>
<a class="ch-row" href="/console/settings#hub">${dot(facts?.certificate ? 'ok' : 'idle')}<span><b>证书</b><span class="ch-meta">${facts?.certificate ? '内置 HTTPS 已启用' : '未启用 HTTPS'}</span></span></a>
<a class="ch-row" href="/console/settings#hub">${dot('ok')}<span><b>数据库</b><span class="ch-meta">仅服务器本地连接${storage.database_bytes === null ? '' : ` · ${sizeText(storage.database_bytes)}`}</span></span></a>
<a class="ch-row" href="/console/settings#hub">${dot(storage.backups !== null && storage.backups.count > 0 ? 'ok' : 'idle')}<span><b>备份</b><span class="ch-meta">${backupNote}</span></span></a>
<a class="ch-row" href="/console/records">${dot('info')}<span><b>记录</b><span class="ch-meta">仅追加，不可修改</span></span></a>
</div>`, { flush: true });
  } else {
    const { lines, current } = await step('read-lines', async () => {
      const lines = await readableLines(ctx);
      const rooted = await Promise.all(lines.map(async (line) => (await ctx.deps.knowledge.builds(line.id)).some((build) => build.root !== null)));
      return { lines, current: rooted.filter(Boolean).length };
    });
    state = box({ title: '知识库', meta: '当前快照', hint: '按产品线统计，成员可读分配给自己的工作流所绑定的产品线。', tail: link('/console/knowledge', '打开知识库') }, html`<div class="ch-stats">${kpi('产品线',lines.length)}${kpi('已有知识的产品线',current)}</div>`);
  }
  const periods = html`<nav class="ch-seg" aria-label="时间范围">${PERIODS.map((n) => html`<a${n === days ? html` aria-current="page"` : ''} href="/console/overview?days=${n}">${n} 天</a>`)}</nav>`;
  const waiting=new Set(requests.map(request=>request.run));
  // First what waits for someone (a request or an undecided requirement), then what is not finished, then the rest; newest first within each.
  const attention=(task:TaskRow)=>waiting.has(task.run.run)||task.pending>0?0:task.result!=='passed'&&task.result!=='abandoned'?1:2;
  const recent=tasks.map((task,index)=>({task,index})).sort((a,b)=>attention(a.task)-attention(b.task)||a.index-b.index).slice(0,8).map(({task})=>task);
  const owing=(task:TaskRow)=>[task.pending>0?`${count(task.pending)} 项未决`:'',perRun.has(task.run.run)?`${count(perRun.get(task.run.run)!)} 条请求${uiLabelOf('request_status','waiting')}`:''].filter(Boolean).join(' · ');
  const rows:Html[]=[];
  for(const task of recent){
    const who=task.run.runner?await ctx.userName(task.run.runner):uiLabelOf('execution_host',task.run.host);
    rows.push(html`<a class="ch-row" href="${'/console/runs/'+task.run.run}"><span class="ch-row-body"><b>${taskTitle(task.run,titles)}</b> <span class="ch-meta">${who} · ${when(task.run.started_at)}</span></span> <span class="ch-row-end">${task.result===null?html`<span class="ch-meta">结果暂不可用</span>`:taskChip(task.result)}${owing(task)?html` <span class="ch-meta">${owing(task)}</span>`:''}</span></a>`);
  }
  const taskList=html`<section class="ch-section" data-overview-tasks>${box({title:'需要处理',meta:scope,hint:'优先列出有等待回应中的请求、未决项或尚未完成的任务，最多 8 个'},recent.length?html`<div class="ch-list">${rows}</div>`:html`<section class="ch-empty"><h3 class="ch-empty-title">所选时段没有任务</h3><p class="ch-empty-text">在客户端中运行工作流后，这里显示任务。</p>${link('/console/packs','查看工作流')}</section>`,{flush:recent.length>0,...(recent.length?{foot:link('/console/runs','查看全部任务')}:{})})}</section>`;
  // One question per page (decision 151): what needs attention. The figures first, the tasks beside their statistics; no
  // folded sections and nothing that is only planned.
  const body = html`${liveModule('overview-kpis', ['task.updated', 'request.updated'], kpis)}
<div class="ch-board">${liveModule('overview-priority', ['task.updated','request.updated'],taskList)}
<div class="ch-stack" data-overview-side>${liveModule('overview-results', ['task.updated'], html`<div class="ch-stack">${checkCard}${box({title:'每日任务',meta:scope},html`${daily}${resultsTable}`)}${stuckCard}</div>`)}
${liveModule('overview-state', ['task.updated', 'system.added', 'system.status', 'knowledge.published'], html`<div class="ch-stack">${systems}${state}</div>`)}</div></div>`;
  return {
    status: 200,
    body: page(ctx.chrome('总览', {
      active: 'overview',
      sub: html`${scope} · 截至 ${when(new Date(now).toISOString())}`,
      actions: periods,
    }),pageLayout(body,{inspector:null})),
  };
}
