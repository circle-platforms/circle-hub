// The tasks of the console (the design canvas's 任务 board): a run with the result display rule 20 derives, its head and the
// waterfall of what happened, built only from what the Hub recorded: the call log lines of the run (each bar is the Hub's
// time on one call; the gap before a submission is Circle's own time, which the Hub does not observe), the Hub's checks of
// the authoritative result, the requests with their audience and due time, the dispatch jobs (administrators only) and the
// result. A time the Hub did not record is not drawn.
import { DYNAMIC_TERMINAL, LAYER, STATIC_TERMINAL, uiLabelOf, type EffectOutcome, type TaskResult } from '../../../contracts/generated/vocabulary.ts';
import { TOOLS } from '../../../contracts/src/tools.ts';
import type { RunRecordView } from '../../../contracts/src/run.ts';
import { isUnknownTerminal, type LayerResult, type RequirementResult } from '../../../contracts/src/validation.ts';
import type { RunDetail } from '../../ports.ts';
import type { CallLogLine } from '../../records/api.ts';
import { code, html, link, type Html } from './html.ts';
import { TASK_DOT, TASK_FILL, pendingCount, primaryResult, taskChip, taskResultOf } from './status.ts';
import { card, chip, dot, duration, hbar, track, when, clock, type DotState } from './ui.ts';
import type { PageContext } from './pages.ts';
import { environmentState } from './connections.ts';

export interface TaskRow {
  run: RunRecordView;
  /** Null when the run could not be read just now; its result is then not shown. */
  detail: RunDetail | null;
  result: TaskResult | null;
  pending: number;
}

/** The detail of each run, to derive its result; a run that cannot be read is listed without one. */
export async function loadTasks(ctx: PageContext, runs: readonly RunRecordView[]): Promise<TaskRow[]> {
  return Promise.all(runs.map(async (run): Promise<TaskRow> => {
    let detail: RunDetail | null = null;
    try {
      detail = await ctx.deps.runs.getRun(ctx.principal, run.run);
    } catch {
      detail = null;
    }
    return { run, detail, result: detail === null ? null : taskResultOf(detail), pending: detail === null ? 0 : pendingCount(detail) };
  }));
}

/** `id@version` to the pack's title, for the packs the reader may list. */
export async function packTitles(ctx: PageContext): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    for (const pack of await ctx.deps.packs.list(ctx.principal)) titles.set(`${pack.id}@${pack.version}`, pack.title);
  } catch {
    // Titles are a convenience: without them the pack id is shown.
  }
  return titles;
}

export const packIdOf = (ref: string): string => (ref.includes('@') ? ref.slice(0, ref.lastIndexOf('@')) : ref);

export function taskTitle(run: Pick<RunRecordView, 'pack'>, titles: ReadonlyMap<string, string>): string {
  return titles.get(run.pack) ?? packIdOf(run.pack);
}

export function resultCell(row: Pick<TaskRow, 'result' | 'pending'>): Html {
  if (row.result === null) return chip('结果暂不可用', 'unchecked');
  return html`${taskChip(row.result)}${row.result === 'delivered_pending' && row.pending > 0 ? html` ${chip(`${row.pending} 项未决`, 'unknown')}` : ''}`;
}

// ---------------------------------------------------------------- the head of one task

export async function taskHead(ctx: PageContext, detail: RunDetail, titles: ReadonlyMap<string, string>): Promise<Html> {
  const run = detail.run;
  const result = taskResultOf(detail);
  const pending = pendingCount(detail);
  const who = run.runner === undefined ? uiLabelOf('execution_host', run.host) : await ctx.userName(run.runner);
  const line = [run.product, run.version, run.build].filter(Boolean).join(' / ');
  return card(null, html`<div class="dhead"><div class="grow">
<div class="row"><h2>${taskTitle(run, titles)}</h2>${resultCell({ result, pending })}</div>
<p class="sub mt4">任务包 ${run.pack}${line ? ` · ${line}` : ''} · 执行人 ${who} · 开始于 ${when(run.started_at)} · 运行 ${code(run.run)}</p>
</div><div class="actions"><span class="chip plain">需人工处理的事项在对应的 Circle 中完成</span></div></div>`);
}

// ---------------------------------------------------------------- the waterfall

/** One step of a task's waterfall: times in milliseconds since the epoch, a fill class and a dot state for the page. */
export interface Step {
  name: string;
  sub: string;
  fill: string;
  dot: DotState;
  start: number;
  end: number;
  /** A moment rather than a span. */
  point?: boolean;
  /** Still going on: drawn to now. */
  open?: boolean;
  depth: 0 | 1;
  dur: string;
}

/** The Chinese name of each of the six tools (contracts/src/tools.ts), by the name the protocol uses. */
export const TOOL_LABELS: ReadonlyMap<string, string> = new Map(TOOLS.map((tool) => [tool.name, tool.label]));

/** A tool of the call log by its Chinese name; a protocol method that is not a tool keeps its name. */
export const toolName = (tool: string): string => TOOL_LABELS.get(tool) ?? tool;

function callDot(line: CallLogLine): DotState {
  if (line.call_result !== 'ok') return 'down';
  if (line.acceptance === 'not_accepted') return 'warn';
  return 'ok';
}

function callSub(line: CallLogLine, run: RunRecordView): string {
  const parts: string[] = [];
  if (line.tool === 'start_run') parts.push(`任务包 ${run.pack}`);
  if (line.acceptance !== null) parts.push(uiLabelOf('acceptance', line.acceptance));
  if (line.call_result !== 'ok') parts.push(uiLabelOf('call_result', line.call_result));
  if (line.error_code !== null) parts.push(line.error_code);
  return parts.join(' · ');
}

/** The colour of a requirement's checks: a failure first, then unknown, then a judgment still to be made, else passed. */
function requirementLook(results: readonly RequirementResult[]): { fill: string; dot: DotState } {
  const layers = results.flatMap((r) => r.layers);
  if (layers.some((l) => l.terminal === 'violation' || l.terminal === 'fail')) return { fill: 'fill-fail', dot: 'down' };
  if (layers.some((l) => isUnknownTerminal(l)) || results.some((r) => r.status === 'pending')) return { fill: 'fill-wait', dot: 'unknown' };
  if (layers.some((l) => l.terminal === 'judgment' || l.terminal === 'no_verdict')) return { fill: 'fill-hand', dot: 'info' };
  if (layers.some((l) => l.terminal === 'incomplete')) return { fill: 'fill-incomplete', dot: 'warn' };
  return { fill: 'fill-hub', dot: 'ok' };
}

/** Each declared layer with the count of every terminal its items reached, in vocabulary order. */
function layerSummary(results: readonly RequirementResult[]): string {
  const out: string[] = [];
  for (const layer of LAYER) {
    const found: LayerResult[] = results.flatMap((r) => r.layers.filter((l) => l.layer === layer));
    if (found.length === 0) continue;
    const order: readonly string[] = layer === 'static' ? STATIC_TERMINAL : DYNAMIC_TERMINAL;
    const counts = order.map((terminal) => [terminal, found.filter((l) => l.terminal === terminal).length] as const).filter(([, n]) => n > 0);
    const words = counts.map(([terminal, n]) => `${layer === 'static' ? uiLabelOf('static_terminal', terminal as never) : uiLabelOf('dynamic_terminal', terminal as never)} ${n}`);
    out.push(`${uiLabelOf('layer', layer)}：${words.join('、')}`);
  }
  return out.join(' · ');
}

const DISPATCH_DOT: Readonly<Record<EffectOutcome, DotState>> = { issued: 'info', effective: 'ok', read_back_consistent: 'ok', read_back_mismatch: 'down', target_rejected: 'down', not_dispatched: 'idle', proven_not_executed: 'idle', unknown: 'unknown' };

export async function taskSteps(ctx: PageContext, detail: RunDetail, calls: readonly CallLogLine[], now: number): Promise<Step[]> {
  const run = detail.run;
  const steps: Step[] = [];
  const lines = [...calls].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let previousEnd: number | null = null;
  for (const line of lines) {
    const end = Date.parse(line.at);
    const start = end - line.duration_ms;
    if (line.tool === 'submit_result' && previousEnd !== null && start - previousEnd > 1000) {
      steps.push({ name: 'Circle 本机处理', sub: '两次调用之间的时间，Hub 未观测', fill: 'fill-circle', dot: 'idle', start: previousEnd, end: start, depth: 0, dur: duration(start - previousEnd) });
    }
    steps.push({ name: toolName(line.tool), sub: callSub(line, run), fill: line.call_result === 'ok' ? 'fill-circle' : 'fill-fail', dot: callDot(line), start, end, depth: 0, dur: duration(line.duration_ms) });
    previousEnd = end;
  }

  const primary = primaryResult(detail);
  const recordTime = async (digest: string): Promise<number | null> => {
    try {
      const record = await ctx.deps.records.store.get(digest);
      return record === null ? null : Date.parse(record.created_at);
    } catch {
      return null;
    }
  };
  // The Hub's checks happen inside the call that produced the result: start_run for a production result, else the latest
  // accepted submission.
  let resultAt: number | null = null;
  if (primary !== null) {
    const producing = primary === detail.production
      ? lines.find((line) => line.tool === 'start_run' && line.call_result === 'ok')
      : [...lines].reverse().find((line) => line.tool === 'submit_result' && line.acceptance === 'accepted');
    resultAt = producing === undefined ? await recordTime(primary.record) : Date.parse(producing.at);
  }
  if (primary !== null && primary.result.acceptance === 'accepted' && resultAt !== null) {
    const items = Object.values(primary.result.partitions).flat();
    const all = items.flatMap((item) => item.requirements);
    steps.push({ name: 'Hub 校验', sub: `${items.length} 个条目 · ${run.requirements.length} 个要求项`, fill: 'fill-group', dot: requirementLook(all).dot, start: resultAt, end: resultAt, point: true, depth: 0, dur: '' });
    for (const requirement of run.requirements) {
      const results = all.filter((r) => r.requirement === requirement.key);
      if (results.length === 0) continue;
      const look = requirementLook(results);
      steps.push({ name: requirement.name, sub: layerSummary(results), fill: look.fill, dot: look.dot, start: resultAt, end: resultAt, point: true, depth: 1, dur: '' });
    }
  }

  for (const request of detail.requests ?? []) {
    const created = (await recordTime(request.record)) ?? Date.parse(run.started_at);
    const open = request.answered_by === null;
    const due = Date.parse(request.due);
    const overdue = open && Number.isFinite(due) && due < now;
    const audience = /^usr_[0-9a-z]{26}$/.test(request.audience) ? await ctx.userName(request.audience) : request.audience;
    const state = open ? (overdue ? '已逾期，等待回应中' : '等待回应中') : '已回答';
    steps.push({
      name: uiLabelOf('request_kind', request.kind),
      sub: `接收人 ${audience} · 期限 ${when(request.due)} · ${state}`,
      fill: open ? 'fill-wait' : 'fill-pass',
      dot: open ? (overdue ? 'down' : 'warn') : 'ok',
      start: created,
      end: open ? now : created,
      point: !open,
      open,
      depth: 0,
      dur: open ? '等待中' : '',
    });
  }

  if (ctx.admin && ctx.deps.dispatch !== undefined) {
    try {
      const jobs = await ctx.deps.dispatch.jobs(ctx.principal, run.run);
      // The environment each job went to, and its state now, when the registry can be read.
      const environments = jobs.some((job) => job.executor !== undefined) ? await ctx.deps.dispatch.executors(ctx.principal).catch(() => []) : [];
      for (const job of jobs) {
        const at = resultAt ?? Date.parse(run.started_at);
        const parts = [uiLabelOf('effect_outcome', job.outcome)];
        const environment = environments.find((e) => e.id === job.executor);
        if (environment !== undefined) parts.push(`运行环境 ${environment.target}（当前${environmentState(environment).text}）`);
        // A job that holds its environment without an open disposition request has not been declared unconfirmed: its
        // result has not arrived yet (D03 R[1], R[7]: the target is frozen with the disposition request).
        const held = environment?.state?.holding?.find((holder) => holder.job === job.job);
        if (job.frozen) parts.push(held !== undefined && !held.frozen ? '等待派发结果中，不可重发' : '运行环境已冻结，不可重发');
        if (job.disposition !== undefined) parts.push(`处置：${uiLabelOf('disposition', job.disposition)}`);
        steps.push({ name: '派发到运行环境', sub: parts.join(' · '), fill: job.outcome === 'unknown' ? 'fill-unknown' : 'fill-hub', dot: DISPATCH_DOT[job.outcome], start: at, end: at, point: true, depth: 0, dur: '' });
      }
    } catch {
      steps.push({ name: '派发到运行环境', sub: '派发记录暂不可用', fill: 'fill-unchecked', dot: 'idle', start: resultAt ?? Date.parse(run.started_at), end: resultAt ?? Date.parse(run.started_at), point: true, depth: 0, dur: '' });
    }
  }

  const result = taskResultOf(detail);
  const resultMoment = resultAt ?? (lines.length > 0 ? Date.parse(lines[lines.length - 1].at) : Date.parse(run.started_at));
  steps.push({ name: '任务结果', sub: uiLabelOf('task_result', result), fill: TASK_FILL[result], dot: TASK_DOT[result], start: resultMoment, end: resultMoment, point: true, depth: 0, dur: '' });
  return steps;
}

/** The execution process of one task, then its longest steps. */
export async function taskWaterfall(ctx: PageContext, detail: RunDetail, read?: readonly CallLogLine[]): Promise<Html> {
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  let calls: readonly CallLogLine[] = read ?? [];
  let callsShown = true;
  if (read === undefined) {
    try {
      calls = (await ctx.deps.records.callLog.query(ctx.principal, { runId: detail.run.run, limit: 200, newestFirst: false })).items;
    } catch {
      callsShown = false;
    }
  }
  const steps = await taskSteps(ctx, detail, calls, now);
  const started = Date.parse(detail.run.started_at);
  const t0 = Math.min(started, ...steps.map((s) => s.start).filter(Number.isFinite));
  let t1 = Math.max(...steps.map((s) => s.end).filter(Number.isFinite), t0);
  if (t1 - t0 < 1000) t1 = t0 + 1000;
  const at = (t: number): number => ((t - t0) / (t1 - t0)) * 100;
  const open = steps.some((s) => s.open === true);
  const ticks = [0, 1, 2, 3, 4].map((i) => clock(t0 + ((t1 - t0) * i) / 4));
  const rows = steps.map((s) => html`<div class="wf-row static"><span class="wf-name${s.depth === 1 ? ' d1' : ''}">${dot(s.dot)}<b>${s.name}</b><span class="sub">${s.sub}</span></span><span class="wf-track">${track(at(s.start), at(s.end), s.fill, { point: s.point === true, label: `${s.name} ${s.dur}`.trim() })}</span><span class="wf-dur">${s.dur}</span></div>`);
  const toolCalls = calls.length;
  const pending = pendingCount(detail);
  const waiting = steps.filter((s) => s.open === true).length;
  const total = calls.length === 0 ? null : Date.parse([...calls].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0].at) - Math.min(...calls.map((c) => Date.parse(c.at) - c.duration_ms));
  const summary = html`<div class="wf-sum">
<div><b class="num">${toolCalls}</b><span>工具调用</span></div>
<div><b class="num">${detail.run.items.length}</b><span>条目</span></div>
<div${pending > 0 ? html` class="unk"` : ''}><b class="num">${pending}</b><span>未决项</span></div>
<div${waiting > 0 ? html` class="unk"` : ''}><b class="num">${waiting}</b><span>等待回应中</span></div>
<div><b class="num">${total === null ? '—' : duration(total)}</b><span>从第一次调用到最后一次</span></div>
</div>`;
  const legend = html`<div class="wf-legend mt12"><span><i class="k-circle"></i>Circle 调用</span><span><i class="k-hub"></i>Hub 校验</span><span><i class="k-wait"></i>等待回应中</span><span><i class="k-hand"></i>等待判定中</span><span><i class="k-fail"></i>未通过</span></div>`;
  const process = card({ title: '执行过程', meta: open ? `截至 ${clock(now)}` : `${clock(t0)} 至 ${clock(t1)}` }, html`${summary}${legend}
<div class="wf mt16"><div class="wf-axis"><span class="sub">步骤</span><span class="wf-ticks flex">${ticks.map((t) => html`<span>${t}</span>`)}</span><span class="wf-dur">耗时</span></div>
<div class="wf-rows">${rows}</div></div>
${callsShown ? '' : html`<p class="note">调用记录暂不可用，只显示 Hub 校验与请求。</p>`}
<p class="note">每段工具调用的长度是 Hub 处理这次调用的时间；提交前的空档是 Circle 在本机的时间，Hub 不调用模型，也不观测这段时间。</p>`);
  const slow = [...calls].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 3);
  const longest = slow.length === 0 ? '' : card({ title: '耗时最长的调用' }, html`<ul class="slow">${slow.map((line) => html`<li><span><b>${toolName(line.tool)}</b> <span class="sub">${clock(line.at)}</span></span>${hbar(line.duration_ms, slow[0].duration_ms, 'fill-hub')}<span class="wf-dur">${duration(line.duration_ms)}</span></li>`)}</ul>`);
  return html`${process}${longest === '' ? '' : html`<div class="mt16">${longest}</div>`}`;
}

/** A tool of the call log by its Chinese name, with the name the protocol uses (a method that is not a tool shows only that). */
export function toolCell(tool: string): Html {
  const label = TOOL_LABELS.get(tool);
  return label === undefined ? code(tool) : html`${label} ${code(tool)}`;
}

/** A link to the full record of a run, for the list rows. */
export function runLink(run: Pick<RunRecordView, 'run'>, text: unknown): Html {
  return link(`/console/runs/${run.run}`, text);
}
