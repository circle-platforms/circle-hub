// 运行状况 (decision 146, step 3 of docs/hub-r4-tasks/observability.md; the ninth place, decision 147): how the running Hub is
// doing, for administrators. It answers what a person would otherwise go to the server for: how busy it is, what it does when
// nobody uses it, what it was doing when it crashed. Diagnostic data: never grounds for anything (B08 R[5]).
//
// Reporting on load must not add to it (design section 10). So this page is a fixed number of statements, each bounded by a
// time window and a row limit and aggregated in SQL (the readers of hub/health and hub/telemetry say which index each runs
// off); a curve is a fixed number of points however long the deployment has run; only one crash is opened at a time; the
// page has no live updates; and `serve` gives its reads a connection of their own with a statement timeout, so they neither
// wait in the business pool nor take a connection from it. The one read through the records is the names of the accounts of
// the opened crash, by id. console-health.test.ts holds the statements and rows constant.
//
// Unknown stays 未知: a reading that failed or was never taken is not 0, and a read that failed here is not an empty table.
import { isTraceOrigin, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { KIND_TEXT, MAX_CLIENT_NAMES, RETENTION_MS, type CurvePoint, type HealthReader, type HealthSummary, type NumericField, type ReleaseRun, type ReportSummary, type StoredProcessEvent } from '../../health/api.ts';
import { BATCH_ROWS, FLUSH_MS, MAX_RELEASE_CALLS_READ, MAX_ROOTS_READ, MAX_ROUNDS_READ, QUEUE_ROWS, TIMED_BACKGROUND_STEPS, type BackgroundStep, type BackgroundTotal, type ClientTotal, type ClientTotals, type ReleaseTotal, type TraceReader, type WriterStats } from '../../telemetry/api.ts';
import { curve, type Curve } from './charts.ts';
import { fullTime, size } from './format.ts';
import { code, emptyBlock, href, html, page, table, type Html } from './html.ts';
import type { PageContext, PageResult } from './pages.ts';
import { evidence, facts, technical, technicalCode } from './presentation.ts';
import type { HubFacts } from './settings.ts';
import { card, chip, clock, count, dot, duration, kpi, when } from './ui.ts';

/** What the page reads; `serve` gives one. A Hub without it says 未知 everywhere, not 0. */
export interface HealthPageSources {
  health: HealthReader;
  traces: TraceReader;
  /** The trace writer's numbers of this process; null before it started. */
  writer(): WriterStats | null;
}

const DAY_MS = 86_400_000;
const GB = 1024 ** 3;
/** The curves of the last 24 hours: 288 points of 5 minutes, whatever the table holds. */
const CURVE_POINTS = 288;
const POINT_MS = DAY_MS / CURVE_POINTS;
const POINTS_PER_HOUR = 12;
/** Points one read-out of a 24-hour curve covers: half an hour. */
const POINTS_PER_READOUT = 6;
/** The curves before a crash: 5 minutes at the sampler's 10 seconds. */
const CRASH_WINDOW_MS = 300_000;
const CRASH_POINTS = 30;
const EVENTS_SHOWN = 20;
const EVENTS_COUNTED = 10_000;
const REQUESTS_SHOWN = 20;
const CLIENTS_SHOWN = 30;
const RELEASES_SHOWN = 5;
const RELEASE_EVENTS_READ = 10_000;

/** Display names until the model has these (hub/telemetry README, needs): the wording of the approved draft. */
const TASK_LABEL: Readonly<Record<BackgroundStep, string>> = { 'maintain-runs': '运行维护', 'index-citations': '引用索引', 'summarize-results': '补写结果摘要', 'index-knowledge': '知识搜索索引', 'sync-knowledge': '知识同步', 'poll-console': '控制台实时轮询', 'clean-staging': '清理暂存', 'renew-lease': '续租约', 'project-document': '投影文档', 'purge-traces': '清理追踪' };
const TIMED: ReadonlySet<string> = new Set(TIMED_BACKGROUND_STEPS);
/** Node's own words for a fatal error; anything else is shown as it stands. */
const CRASH_REASON: ReadonlyMap<string, string> = new Map([['Allocation failed - JavaScript heap out of memory', 'JavaScript 堆耗尽']]);

const UNKNOWN = html`<span class="t-unknown">未知</span>`;
const unknown = (hint?: string): Html => (hint === undefined ? UNKNOWN : html`<span class="t-unknown" title="${hint}">未知</span>`);
const shown = <T>(value: number | null | undefined, format: (value: number) => T): T | Html => (value === null || value === undefined ? UNKNOWN : format(value));
const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`;
const percent1 = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;
const gb = (value: number): string => (value === 0 ? '0' : (value / GB).toFixed(1));
const two = (n: number): string => String(n).padStart(2, '0');
const stamp = (at: string | number): Html => {
  const iso = typeof at === 'number' ? new Date(at).toISOString() : at;
  return html`<time class="nowrap ch-time" datetime="${iso}" title="${fullTime(iso)}">${clock(iso)}</time>`;
};
/** A period as the table says it: one unit, since it is an observed median and not a setting. */
function period(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分`;
  return `${Math.round(ms / 3_600_000)} 小时`;
}

/** The next round number at or above what was read: a quiet curve must not look like a busy one. */
function axisTop(values: readonly (number | null)[], least: number): number {
  const peak = Math.max(least, ...values.filter((value) => value !== null));
  const power = 10 ** Math.floor(Math.log10(peak));
  return [1, 2, 5, 10].map((step) => step * power).find((top) => top >= peak)!;
}
/** The same for bytes on an axis written in GB, whose round numbers are not those of bytes. */
const byteTop = (values: readonly (number | null)[]): number => axisTop(values.map((value) => (value === null ? null : value / GB)), 1) * GB;
const ticksOf = (top: number): number[] => [...new Set([0, top / 2, top])];

/** Names a time on a 24-hour curve. */
function pointLabel(at: number, now: Date): string {
  const day = new Date(at);
  const today = day.getFullYear() === now.getFullYear() && day.getMonth() === now.getMonth() && day.getDate() === now.getDate();
  return `${today ? '今天' : '昨天'} ${two(day.getHours())}:${two(day.getMinutes())}`;
}

interface Line {
  label: string;
  tableLabel?:string;
  tableValue?:(value:number)=>unknown;
  className?: string;
  field: Exclude<keyof CurvePoint, 'at' | 'last_at' | 'samples' | 'failed' | 'dropped'>;
}

type CurveHead = Pick<Curve, 'title' | 'note' | 'max' | 'ticks' | 'tick' | 'value' | 'marks'>;

/** A 24-hour curve from the points of the reader; its read-outs show the half hours and its table the hours, each the largest of its points (`least`: the smallest). */
function dayCurve(points: readonly CurvePoint[], now: Date, lines: readonly Line[], head: CurveHead, least = false): Html {
  const stamps = points.map((point) => Date.parse(point.at));
  const fold = (values: readonly (number | null)[]): number | null => {
    const read = values.filter((value) => value !== null);
    return read.length === 0 ? null : least ? Math.min(...read) : Math.max(...read);
  };
  const hours = Array.from({ length: Math.ceil(points.length / POINTS_PER_HOUR) }, (_, hour) => points.slice(hour * POINTS_PER_HOUR, (hour + 1) * POINTS_PER_HOUR));
  const axis = [0, 72, 144, 216, CURVE_POINTS - 1].map((index) => [index, pointLabel(stamps[index]!, now).slice(-5)] as const);
  return curve({
    ...head,
    note:[head.note,`曲线每 5 分钟${least?'取最小值':'取最大值'}；提示每 30 分钟、表格每小时分别${least?'取最小值':'取最大值'}。缺测保持未知。`].filter(Boolean).join(' '),
    labels: stamps.map((at) => pointLabel(at, now)),
    series: lines.map((line) => ({ label: line.label, ...(line.className ? { className: line.className } : {}), values: points.map((point) => point[line.field]) })),
    xLabels: axis,
    hoverEvery: POINTS_PER_READOUT,
    least,
    table: {
      head: ['时间', ...lines.map((line) => line.tableLabel??`${line.label}（${least ? '最小' : '最大'}）`)],
      rows: hours.map((slice) => [pointLabel(Date.parse(slice[0]!.at), now), ...lines.map((line) => {
        const value = fold(slice.map((point) => point[line.field]));
        return value === null ? '未知' : (line.tableValue??head.value)(value);
      })]),
    },
  });
}

/** A resource: its value now, what it is, the rest of its readings and its curves. The value is the first thing read. */
function resourceCard(input: { title: string; value: unknown; unit?: string | null; label: unknown; note: unknown; failure?: string | null; figures: Html }): Html {
  return html`<section class="ch-section ch-resource"><h2 class="ch-section-label">${input.title}</h2><div class="ch-stat"><span class="ch-stat-value">${input.value}${input.unit ? html`<span class="ch-stat-unit"> ${input.unit}</span>` : ''}</span><span class="ch-stat-label">${input.label}</span><span class="ch-stat-note">${input.note}</span>${input.failure ? html`<span class="ch-stat-note">${input.failure}</span>` : ''}</div>${input.figures}</section>`;
}

function resourceCards(summary: HealthSummary | null, points: readonly CurvePoint[], crashes: readonly StoredProcessEvent[], now: Date): Html {
  const current = (field: NumericField): number | null => summary?.fields[field].current ?? null;
  const failed = (...readings: readonly string[]): string | null => {
    const samples = Math.max(0, ...readings.map((reading) => summary?.failed_reads[reading] ?? 0));
    return samples === 0 ? null : `近 24 小时 ${count(samples)} 个样本读取失败`;
  };
  const start = Date.parse(points[0]!.at);
  const inWindow = crashes.map((event) => Math.floor((Date.parse(crashTime(event)) - start) / POINT_MS)).filter((index) => index >= 0 && index < points.length);
  // Only the newest crash is named: several names would overprint, and each still has its line.
  const marks = inWindow.map((index, order) => ({ index, label: order === 0 ? '异常退出' : '', side: index < 72 ? ('right' as const) : ('left' as const) }));
  const values = (field: Line['field']) => points.map((point) => point[field]);
  const counts = (fields: readonly Line['field'][], limit: number | null): Pick<Curve, 'max' | 'ticks' | 'tick' | 'value'> => {
    // An even top: the tick halfway must be a whole number, or the axis would round it and lie about where its line is.
    const max = Math.ceil(Math.max(axisTop(fields.flatMap(values), 2), limit ?? 0) / 2) * 2;
    return { max, ticks: ticksOf(max), tick: count, value: count };
  };
  const delay = current('event_loop_delay_max_ms'), heap = current('heap_used_bytes'), limit = current('heap_limit_bytes');
  const delayTop = axisTop(values('event_loop_delay_max_ms'), 100);
  const heapTop = limit ?? byteTop(values('heap_used_bytes'));
  const main = resourceCard({
    title: '主线程', value: shown(delay, duration), label: '事件循环延迟最大值 · 最近 10 秒',
    note: html`延迟 p99 ${shown(current('event_loop_delay_p99_ms'), duration)} · 事件循环利用率 ${shown(current('event_loop_utilization'), percent)} · 进程 CPU ${shown(current('process_cpu_ratio'), percent)}（一核为 100%）`,
    failure: failed('event-loop', 'cpu'),
    figures: dayCurve(points, now, [{ label: '延迟最大值', field: 'event_loop_delay_max_ms',tableLabel:'延迟最大值（毫秒）',tableValue:value=>value }], { title: '近 24 小时 · 延迟最大值（毫秒）', note: '每 5 分钟取最大值，以保留短时峰值。最近 10 秒内的单次长阻塞可能未体现在 p99 中，因此此处显示延迟最大值。', max: delayTop, ticks: ticksOf(delayTop), tick: (value) => count(Math.round(value)), value: duration, marks }),
  });
  const memory = resourceCard({
    title: '内存', value: shown(heap, size), unit: limit === null ? null : `/ 上限 ${size(limit)}`,
    label: html`堆已用 · 占上限 ${heap === null || limit === null ? UNKNOWN : percent(heap / limit)}`,
    note: html`常驻内存 ${shown(current('rss_bytes'), size)} · 垃圾回收暂停 ${shown(current('gc_pause_ms'), duration)}`,
    failure: failed('memory'),
    figures: dayCurve(points, now, [{ label: '堆已用', field: 'heap_used_bytes' }], { title: '近 24 小时 · 堆已用（GB）', note: '每 5 分钟取最大值。', max: heapTop, ticks: ticksOf(heapTop), tick: gb, value: size, marks }),
  });
  const sandboxLimit = current('sandbox_limit');
  const sandbox = resourceCard({
    title: '沙箱', value: shown(current('sandbox_running'), count), unit: sandboxLimit === null ? null : `/ 上限 ${count(sandboxLimit)}`, label: '运行中',
    note: html`排队 ${shown(current('sandbox_waiting'), count)} · 超时累计 ${shown(current('sandbox_timeouts'), count)} · 队列满累计 ${shown(current('sandbox_queue_full'), count)}`,
    failure: failed('sandbox'),
    figures: dayCurve(points, now, [{ label: '运行中', className: 's1', field: 'sandbox_running' }, { label: '排队', className: 's2', field: 'sandbox_waiting' }], { title: '近 24 小时 · 运行中和排队数', note: '每 5 分钟取最大值。累计数从进程启动算起。', ...counts(['sandbox_running', 'sandbox_waiting'], sandboxLimit) }),
  });
  const poolTotal = current('pool_total'), poolIdle = current('pool_idle'), poolLimit = current('pool_limit');
  const pool = resourceCard({
    title: '连接池', value: poolTotal === null || poolIdle === null ? UNKNOWN : count(poolTotal - poolIdle), unit: poolLimit === null ? null : `/ 上限 ${count(poolLimit)}`, label: '使用中',
    note: html`等待 ${shown(current('pool_waiting'), count)} · 连接失败累计 ${shown(current('pool_connection_failures'), count)}`,
    failure: failed('pool'),
    figures: dayCurve(points, now, [{ label: '使用中', className: 's1', field: 'pool_in_use' }, { label: '等待', className: 's2', field: 'pool_waiting' }], { title: '近 24 小时 · 使用中和等待数', note: '使用中 = 已开连接减去空闲连接。每 5 分钟取最大值。', ...counts(['pool_in_use', 'pool_waiting'], poolLimit) }),
  });
  const database = resourceCard({
    title: '数据库', value: shown(current('pg_active_connections'), count), label: '活动连接',
    note: html`缓存命中率 ${shown(current('pg_cache_hit_ratio'), percent1)} · 锁等待 ${shown(current('pg_waiting_locks'), count)} · 死锁累计 ${shown(current('pg_deadlocks'), count)}`,
    failure: failed('postgres'),
    figures: dayCurve(points, now, [{ label: '活动连接', className: 's1', field: 'pg_active_connections' }, { label: '锁等待', className: 's2', field: 'pg_waiting_locks' }], { title: '近 24 小时 · 活动连接和锁等待', note: '每分钟读一次，每 5 分钟取最大值。', ...counts(['pg_active_connections', 'pg_waiting_locks'], null) }),
  });
  const diskTop = byteTop(values('data_free_bytes'));
  const disk = resourceCard({
    title: '磁盘和请求', value: shown(current('data_free_bytes'), size), label: '数据文件夹可用空间',
    note: html`处理中的请求 ${shown(current('requests_in_flight'), count)} · I/O 等待 ${shown(current('io_wait_ratio'), percent1)}`,
    failure: failed('disk', 'requests'),
    figures: html`${dayCurve(points, now, [{ label: '可用空间', field: 'data_free_bytes' }], { title: '近 24 小时 · 可用空间（GB）', note: '每 5 分钟取最小值。', max: diskTop, ticks: ticksOf(diskTop), tick: gb, value: size }, true)}${dayCurve(points, now, [{ label: '处理中', field: 'requests_in_flight' }], { title: '近 24 小时 · 处理中的请求', note: '每 5 分钟取最大值。实时推送流不算请求。', ...counts(['requests_in_flight'], null) })}`,
  });
  return html`<div data-cards>${main}${memory}${sandbox}${pool}${database}${disk}</div>`;
}

const unreadable = (what: string): Html => html`<p class="ch-meta">${unknown()} · 这次没有读出${what}，原因记在服务日志；刷新页面重读。这不是没有数据。</p>`;

function backgroundTable(tasks: readonly BackgroundTotal[] | null, now: Date): Html {
  const hint = '每轮后台任务都是一条追踪。行数和大小来自这一轮根步骤的用量，含它的子步骤；大小是返回行里字符串列的长度之和，jsonb 列不算。每轮的值是近 24 小时的平均。间隔是定时任务近 24 小时相邻两轮的中位数。';
  if (tasks === null) return card({ title: '后台任务', hint }, unreadable('后台任务'));
  if (tasks.length === 0) return card({ title: '后台任务' }, emptyBlock({ title: '还没有后台任务的记录', text: '每轮后台任务结束后写一条追踪，这里按占用排序列出每种任务的间隔、上次耗时、读的行数和大小。' }));
  const total = tasks.reduce((sum, task) => sum + task.db_rows, 0);
  const top = tasks[0]!;
  const rows = tasks.map((task) => {
    const ran = task.rounds > 0;
    const interval = !TIMED.has(task.name) ? '按需' : task.gap_ms !== null ? period(task.gap_ms) : ran ? '只跑过 1 次' : '近 24 小时没有运行';
    return [
      html`<span class="ch-tool">${TASK_LABEL[task.name]} ${code(task.name)}</span>`,
      ran ? count(Math.round(task.db_rows / task.rounds)) : '—',
      ran ? size(task.db_bytes / task.rounds) : '—',
      interval, duration(task.last_ms), when(task.last_at, now), count(task.db_rows), size(task.db_bytes),
      task.capped ? `${count(task.rounds)} 以上` : count(task.rounds),
    ];
  });
  const capped = tasks.some((task) => task.capped) ? ` · 超过 ${count(MAX_ROUNDS_READ)} 轮的任务只算最新的 ${count(MAX_ROUNDS_READ)} 轮` : '';
  const share = total === 0 ? '' : ` · 合计 ${count(total)} 行，${TASK_LABEL[top.name]}占 ${percent1(top.db_rows / total)}`;
  return card({ title: '后台任务', meta: `按近 24 小时读的行数排序${share}${capped}`, hint }, table(['任务', '每轮读的行数', '每轮读的大小', '间隔', '上次耗时', '上次运行', '近 24 小时读的行数 ↓', '近 24 小时读的大小', '近 24 小时轮数'], rows, '没有后台任务', 'background'));
}

/** When a process really ended: the report's time. `at` is when the next start found out. */
function crashTime(event: StoredProcessEvent): string {
  return event.reports?.find((report) => report.dumped_at !== null)?.dumped_at ?? event.last_seen_at ?? event.at;
}

const reportOf = (event: StoredProcessEvent): ReportSummary | undefined => event.reports?.find((report) => report.readable);

function crashTitle(event: StoredProcessEvent): Html {
  const reason = reportOf(event)?.event ?? null;
  return html`${KIND_TEXT[event.kind]}${reason === null ? '' : html` · ${CRASH_REASON.get(reason) ?? evidence(reason)}`}`;
}

function runningText(event: StoredProcessEvent): Html {
  if (event.requests === null) return html`当时在处理什么：${UNKNOWN}`;
  const total = event.requests.length + event.requests_omitted;
  return total === 0 ? html`当时没有在处理的请求` : html`当时在处理 ${count(total)} 个请求`;
}

/** The accounts of a crash's requests, in one read; null when it failed. */
export type AccountNames = ReadonlyMap<string, string> | null;

function requestTable(event: StoredProcessEvent, names: AccountNames): Html {
  const crash = Date.parse(crashTime(event));
  const rows = (event.requests ?? []).slice(0, REQUESTS_SHOWN).map((request) => [
    stamp(request.started_at),
    duration(Math.max(0, crash - Date.parse(request.started_at))),
    request.origin !== null && isTraceOrigin(request.origin) ? uiLabelOf('trace_origin', request.origin) : UNKNOWN,
    code(request.name),
    request.user === null ? unknown('请求在认证之前') : names?.get(request.user) ?? UNKNOWN,
    request.trace === null ? unknown('这个请求没有带 traceparent，它的步骤随进程一起丢失') : technicalCode(request.trace),
  ]);
  return table(['开始', '崩溃时已运行', '入口', '请求', '账号', '追踪'], rows, '当时没有在处理的请求', 'inflight');
}

function crashFacts(event: StoredProcessEvent, last: CurvePoint | undefined): Html {
  const report = reportOf(event);
  const pairs: [string, unknown][] = [
    ['崩溃时间', report?.dumped_at ? stamp(report.dumped_at) : html`${UNKNOWN}（最后一次活动 ${event.last_seen_at === null ? UNKNOWN : stamp(event.last_seen_at)}）`],
    ['下次启动', stamp(event.at)],
    ['最后样本', last?.last_at ? html`${stamp(last.last_at)}（之后没有样本）` : UNKNOWN],
    ['运行时长', shown(event.uptime_ms, duration)],
  ];
  if (report !== undefined) {
    const { heap, resource_usage: usage } = report;
    pairs.push(['堆', html`${shown(heap?.used_bytes, size)} / 上限 ${shown(heap?.limit_bytes, size)}`], ['常驻内存', shown(usage?.rss_bytes, size)], ['CPU', html`用户 ${shown(usage?.user_cpu_seconds, (value) => value.toLocaleString('en-US'))} 秒，系统 ${shown(usage?.kernel_cpu_seconds, (value) => value.toLocaleString('en-US'))} 秒`]);
  }
  const details = technical(facts([
    ...(report === undefined ? [] : [['原因', evidence(`${report.event ?? '未知'}（${report.trigger ?? '未知'}）`)], ['崩溃报告', code(report.file)]] as [string, unknown][]),
    ['进程', html`PID ${shown(event.pid, String)}${event.node_version === null ? '' : html` · ${event.node_version}`}`],
    ['发布', event.release === null ? UNKNOWN : code(event.release)],
  ]), '查看');
  return html`${facts(pairs)}${details}`;
}

function crashCurves(event: StoredProcessEvent, points: readonly CurvePoint[], requestAt: number | null): Html {
  const end = Date.parse(crashTime(event));
  const start = end - CRASH_WINDOW_MS, step = CRASH_WINDOW_MS / CRASH_POINTS;
  // One more label than points: the last is the crash itself, which has no sample and may have a report.
  const labels = Array.from({ length: CRASH_POINTS + 1 }, (_, index) => clock(start + index * step));
  const xLabels = [[0, labels[0]!], [CRASH_POINTS / 2, labels[CRASH_POINTS / 2]!], [CRASH_POINTS, labels[CRASH_POINTS]!]] as const;
  const index = requestAt === null ? null : Math.round((requestAt - start) / step);
  const marks = index === null ? [] : [{ index, label: '请求开始', side: index < CRASH_POINTS / 3 ? ('right' as const) : ('left' as const), low: true }];
  const line = (field: Line['field']): (number | null)[] => [...points.map((point) => point[field]), null];
  const rows = (values: readonly (number | null)[], text: (value: number) => string) => labels.map((label, at) => [label, values[at] === null || values[at] === undefined ? '未知' : text(values[at]!)]);
  const heap = line('heap_used_bytes'), delay = line('event_loop_delay_max_ms'), gc = line('gc_pause_ms');
  const reported = reportOf(event)?.heap?.used_bytes ?? null;
  const limit = event.heap_limit_bytes ?? reportOf(event)?.heap?.limit_bytes ?? byteTop([...heap, reported]);
  const delayTop = axisTop(delay, 100), gcTop = axisTop(gc, 100);
  const pins = reported === null ? [] : [{ index: CRASH_POINTS, value: reported, label: `崩溃报告 ${size(reported)}` }];
  return html`<div data-cards>${curve({ title: '堆已用（GB）', labels, xLabels, series: [{ label: '堆已用', values: heap }], max: limit, ticks: ticksOf(limit), tick: gb, value: size, marks, points: pins, table: { head: ['时间', '堆已用'], rows: rows(heap, size) } })}${curve({ title: '事件循环延迟最大值（毫秒）', labels, xLabels, series: [{ label: '延迟最大值', values: delay }], max: delayTop, ticks: ticksOf(delayTop), tick: (value) => count(Math.round(value)), value: duration, marks, table: { head: ['时间', '延迟最大值'], rows: rows(delay, duration) } })}${curve({ title: '垃圾回收暂停（毫秒，每 10 秒合计）', labels, xLabels, series: [{ label: '垃圾回收暂停', values: gc }], max: gcTop, ticks: ticksOf(gcTop), tick: (value) => count(Math.round(value)), value: duration, marks, table: { head: ['时间', '垃圾回收暂停'], rows: rows(gc, duration) } })}</div>`;
}

/** What the opened crash needs beyond its own row. */
interface CrashDetail {
  event: StoredProcessEvent;
  /** The samples before it; null when they could not be read. */
  points: readonly CurvePoint[] | null;
  names: AccountNames;
}

function crashBody({ event, points, names }: CrashDetail): Html {
  const requests = event.requests;
  const first = requests?.[0];
  const firstAt = first === undefined ? null : Date.parse(first.started_at);
  const crashAt = Date.parse(crashTime(event));
  // The samples read are the window before the crash: a start earlier than that has neither a heap in them nor a place on the curves.
  const early = firstAt !== null && firstAt < crashAt - CRASH_WINDOW_MS;
  const markedAt = firstAt !== null && !early && firstAt <= crashAt ? firstAt : null;
  const sampled = points?.filter((point) => point.samples > 0) ?? [];
  const lastSample = sampled.at(-1);
  const heapAt = (at: number): number | null => points?.find((point) => Date.parse(point.at) + CRASH_WINDOW_MS / CRASH_POINTS > at)?.heap_used_bytes ?? null;
  const lastHeap = sampled.findLast((point) => point.heap_used_bytes !== null)?.heap_used_bytes ?? null;
  const startHeap = markedAt === null ? null : heapAt(markedAt);
  const heaps = early
    ? html`它在崩溃前 5 分钟之前开始，开始时堆 ${UNKNOWN}${lastHeap === null ? '' : `，最后一个样本 ${size(lastHeap)}`}。`
    : startHeap === null || lastHeap === null ? '' : `它开始时堆 ${size(startHeap)}，最后一个样本 ${size(lastHeap)}。`;
  const who = first?.user === null || first?.user === undefined ? UNKNOWN : names?.get(first.user) ?? UNKNOWN;
  const finding = first === undefined
    ? requests === null
      ? html`<p class="ch-finding">当时在处理什么：${UNKNOWN}。在途请求日志里没有这个进程，这不等于当时没有请求；主机重启会清掉这个日志。</p>`
      : html`<p class="ch-finding">当时没有在处理的请求。</p>`
    : html`<p class="ch-finding">运行最久的是 ${code(first.name)}（${who}），崩溃时已运行 ${duration(Math.max(0, crashAt - firstAt!))}。${heaps}</p>`;
  const total = (requests?.length ?? 0) + event.requests_omitted;
  const running = requests === null || total === 0 ? '' : html`<div class="ch-section"><h3 class="ch-figure-title">当时在处理 ${count(total)} 个请求</h3><p class="ch-meta">显示 ${count(Math.min(requests.length, REQUESTS_SHOWN))} / 共 ${count(total)} · 先开始的在前</p>${requestTable(event, names)}</div>`;
  const report = html`<div class="ch-section"><h3 class="ch-figure-title">崩溃报告</h3>${event.reports === null ? html`<p class="ch-meta">崩溃报告文件夹读不出来，有没有报告：${UNKNOWN}</p>` : event.reports.length === 0 ? html`<p class="ch-meta">没有崩溃报告</p>` : ''}${crashFacts(event, lastSample)}</div>`;
  const legend = first === undefined ? '' : markedAt !== null ? html`竖线是 ${code(first.name)} 开始的时间（${stamp(firstAt!)}）。` : early ? html`${code(first.name)} 开始于 ${stamp(firstAt!)}，早于这 5 分钟，图上没有它的竖线。` : '';
  const before = points === null
    ? unreadable('崩溃之前的样本')
    : event.boot === null || sampled.length === 0
      ? html`<p class="ch-meta">这个进程崩溃之前 5 分钟没有样本。</p>`
      : html`<p class="ch-meta">${legend}曲线断开的一段没有样本${reportOf(event)?.heap?.used_bytes === null || reportOf(event)?.heap?.used_bytes === undefined ? '' : '；红点是崩溃报告里的值'}。</p>${crashCurves(event, points, markedAt)}`;
  return html`<div class="ch-event-body">${finding}<div class="ch-event-top">${running}${report}</div><div class="ch-section"><h3 class="ch-figure-title">崩溃前 5 分钟</h3>${before}</div></div>`;
}

function eventRow(event: StoredProcessEvent, opened: CrashDetail | null, now: Date): Html {
  const anchor = `event-${event.seq}`;
  if (event.kind !== 'abnormal_exit') {
    return html`<div class="ch-row" id="${anchor}">${dot(event.kind === 'start' ? 'ok' : 'idle')}<span class="ch-row-body"><span class="ch-row-title">${KIND_TEXT[event.kind]}</span><span class="ch-row-meta">${event.uptime_ms === null ? '' : html`<span>运行 ${duration(event.uptime_ms)}</span>`}</span>${when(event.at, now)}</span></div>`;
  }
  const line = html`${dot('down')}<span class="ch-row-body"><span class="ch-row-title">${crashTitle(event)}</span><span class="ch-row-meta">${event.uptime_ms === null ? '' : html`<span>运行 ${duration(event.uptime_ms)}</span>`}${event.reports?.length === 0 ? html`<span>没有崩溃报告</span>` : ''}<span>${runningText(event)}</span></span>${when(crashTime(event), now)}</span>`;
  // One crash is open at a time, so the page reads one crash's samples however many the list shows.
  if (opened?.event.seq === event.seq) return html`<details class="ch-event" id="${anchor}" open><summary class="ch-row">${line}</summary>${crashBody(opened)}</details>`;
  return html`<a class="ch-row ch-event-link" id="${anchor}" href="${href('/console/health', { event: event.seq })}#${anchor}">${line}</a>`;
}

function eventList(events: readonly StoredProcessEvent[] | null, total: number | null, opened: CrashDetail | null, now: Date): Html {
  const hint = '启动、正常停止和异常退出。异常退出的时间取崩溃报告的时间，没有报告时取最后一次活动。';
  if (events === null) return card({ title: '崩溃和重启', hint }, unreadable('进程事件'));
  if (events.length === 0) return card({ title: '崩溃和重启' }, emptyBlock({ title: '还没有进程事件', text: 'Hub 服务启动、正常停止和异常退出都记在这里。异常退出时能看到当时在处理的请求和之前 5 分钟的曲线。' }));
  const all = total === null ? UNKNOWN : total >= EVENTS_COUNTED ? `${count(EVENTS_COUNTED)} 以上` : count(total);
  return card({ title: '崩溃和重启', meta: html`显示 ${count(events.length)} / 共 ${all} · 新的在前`, hint }, html`<div class="ch-list ch-events" id="crashes">${events.map((event) => eventRow(event, opened, now))}</div>`);
}

function clientTable(totals: ClientTotals | null, summary: HealthSummary | null, oldest: Html | null): Html {
  const hint = '名字、版本和平台是客户端自己报的，只作声明；平台要等客户端在 MCP initialize 里声明才有。连接数是最新样本的值，只按名字分，不分平台；调用和 p95 是近 24 小时。';
  const sessions = summary?.fields.mcp_sessions.current ?? null, streams = summary?.fields.console_streams.current ?? null;
  const byClient = summary?.mcp_sessions_by_client ?? null;
  if (totals === null) return card({ title: '按客户端', hint }, unreadable('客户端的调用'));
  const open = byClient === null ? [] : Object.entries(byClient);
  // A name is whatever a client declares: `constructor` must not find what every object inherits.
  const connectionsOf = new Map(open);
  if (totals.rows.length === 0 && open.length === 0) return card({ title: '按客户端' }, emptyBlock({ title: '还没有客户端连接', text: '客户端连接 Hub 后，这里按客户端列出平台、连接数、调用量和 p95。' }));
  const named = new Set(totals.rows.filter((row) => row.origin === 'mcp').map((row) => row.client_name));
  /** Connections are counted by name: a name past the sample's bound is unknown, one the sample does not list has none. */
  const connections = (row: ClientTotal): unknown => {
    if (row.origin === 'sync') return unknown('同步请求不保持连接，样本里没有这个数');
    if (row.origin === 'console') return streams === null ? UNKNOWN : streams;
    if (byClient === null) return UNKNOWN;
    if (row.client_name === null) return sessions === null ? UNKNOWN : Math.max(0, sessions - Object.values(byClient).reduce((sum, value) => sum + value, 0));
    return connectionsOf.get(row.client_name) ?? (open.length >= MAX_CLIENT_NAMES ? UNKNOWN : 0);
  };
  const seen = new Set<string>();
  const rows: unknown[][] = totals.rows.map((row) => {
    const key = `${row.origin}/${row.client_name ?? ''}`;
    const repeat = seen.has(key);
    seen.add(key);
    const browser = row.origin === 'console';
    return [
      row.client_name !== null ? evidence(row.client_name) : browser ? '浏览器' : '未声明名字',
      browser ? '—' : row.client_platform === null ? unknown('客户端没有声明平台') : evidence(row.client_platform),
      uiLabelOf('trace_origin', row.origin),
      browser ? '—' : row.client_version === null ? UNKNOWN : evidence(row.client_version),
      repeat ? html`<span title="连接数只按名字分">同上</span>` : connections(row),
      count(row.calls),
      duration(row.p95_ms),
    ];
  });
  // A client that holds a session and has no row still has a line. It made no call in the window only if every MCP call was
  // read: the reader's rows start with MCP, so the last one shown says whether any were cut.
  const cut = totals.capped || (totals.groups > totals.rows.length && totals.rows.at(-1)?.origin === 'mcp');
  const outside = cut ? unknown('这个客户端的调用不在读到的范围里') : null;
  for (const [name, value] of open) if (!named.has(name)) rows.push([evidence(name), outside ?? unknown('近 24 小时没有调用，没有声明可读'), uiLabelOf('trace_origin', 'mcp'), UNKNOWN, value, outside ?? '0', outside ?? '无调用']);
  const parts: unknown[] = [sessions === null && streams === null ? '连接数未知，调用量和 p95 来自追踪，不受影响' : html`现在 ${shown(sessions, count)} 个 MCP 会话、${shown(streams, count)} 个实时推送流`];
  if (totals.groups > totals.rows.length) parts.push(`显示 ${count(totals.rows.length)} / 共 ${count(totals.groups)}`);
  if (oldest !== null) parts.push(html`近 24 小时的调用超过 ${count(MAX_ROOTS_READ)} 次，只算最新的 ${count(MAX_ROOTS_READ)} 次，从 ${oldest} 起`);
  return card({ title: '按客户端', meta: html`${parts.map((part, index) => html`${index === 0 ? '' : ' · '}${part}`)}`, hint }, table(['客户端', '平台', '入口', '版本', '现在的连接', '近 24 小时调用', '近 24 小时 p95'], rows, '没有客户端', 'clients'));
}

interface Runs {
  rows: readonly ReleaseRun[];
  total: number;
}

/** A process whose start the database refused has no line in the events, and it is a run all the same: the one going on now. */
function withRunNow(runs: Runs, hub: HubFacts | undefined, now: Date): Runs {
  if (hub === undefined || hub.release === null || runs.rows.length === 0 || runs.rows[0]!.release === hub.release) return runs;
  return { rows: [{ release: hub.release, first_start: hub.startedAt.toISOString(), last_event: now.toISOString() }, ...runs.rows], total: runs.total + 1 };
}

function releaseTable(runs: Runs | null, totals: readonly ReleaseTotal[] | null, current: string | null, now: Date): Html {
  const hint = `一次部署一行：回到早先的发布也是部署，重启不是。部署时间是这次部署后第一次启动的时间。全部 MCP 调用都算，一行超过 ${count(MAX_RELEASE_CALLS_READ)} 次时只算最新的 ${count(MAX_RELEASE_CALLS_READ)} 次。每行算这次部署运行的最后 24 小时，和它下面一行比较。`;
  if (runs === null || totals === null) return card({ title: '按发布', hint }, unreadable('发布'));
  if (runs.rows.length === 0) return card({ title: '按发布' }, emptyBlock({ title: '还没有发布的调用记录', text: '有了调用之后，这里列出每个发布的 p95，部署前后是快了还是慢了一眼可比。' }));
  const retained = now.getTime() - RETENTION_MS;
  // One more was read than is shown: the last line shown still has a run to compare with. The totals are in the order of the runs.
  const listed = runs.rows.slice(0, RELEASES_SHOWN);
  const rows = listed.map((run, index) => {
    const total = totals[index];
    const before = totals[index + 1]?.p95_ms ?? null;
    const p95 = total?.p95_ms ?? null;
    const change = p95 === null
      ? '—'
      : runs.rows[index + 1] === undefined
        ? unknown('进程事件里没有上一个发布：已过 14 天保留期，或恢复备份时清空了')
        : before === null
          ? unknown('上一个发布没有 MCP 调用')
          : Math.round(Math.abs(p95 - before)) === 0 ? '没有变化' : `${p95 > before ? '慢了' : '快了'} ${duration(Math.abs(p95 - before))}`;
    const first = Date.parse(run.first_start), last = Date.parse(run.last_event);
    const running = index === 0 && run.release === current;
    const span = running ? html`已运行 ${duration(now.getTime() - first)}` : first <= retained ? html`运行到 ${when(run.last_event, now)}；只算保留期内` : html`运行 ${duration(last - first)}`;
    const deployed = new Date(first);
    return [
      html`<span class="ch-tool"><time class="ch-time" datetime="${run.first_start}" title="${fullTime(run.first_start)}">${two(deployed.getMonth() + 1)}-${two(deployed.getDate())} ${two(deployed.getHours())}:${two(deployed.getMinutes())}</time> 部署</span>${running ? html` ${chip('当前', 'pass')}` : ''}`,
      span,
      total === undefined ? UNKNOWN : total.capped ? `${count(total.calls)} 以上` : count(total.calls),
      p95 === null ? '无调用' : duration(p95),
      change,
      technicalCode(run.release),
    ];
  });
  const meta = `MCP 调用 · 每次部署运行的最后 24 小时，只算 14 天保留期内${runs.total > listed.length ? ` · 显示 ${count(listed.length)} / 共 ${count(runs.total)}` : ''}`;
  return card({ title: '按发布', meta, hint }, table(['发布', '运行时段', '调用', 'p95', '比上一个发布', '发布号'], rows, '没有发布', 'releases'));
}

function observation(writer: WriterStats | null, summary: HealthSummary | null, points: readonly CurvePoint[] | null): Html {
  const failed = points?.reduce((sum, point) => sum + point.failed, 0);
  const counted = (value: number | undefined): unknown => (value === undefined ? UNKNOWN : count(value));
  const first = html`<section class="ch-stats">${kpi('写入延迟 p95', shown(writer?.writeDelayP95Ms, duration), { note: writer !== null && writer.writeDelayP95Ms === null ? '还没有写入过' : `每 ${FLUSH_MS / 1000} 秒或攒够 ${BATCH_ROWS} 行写一次`, hint: '一行从进队列到写进数据库等了多久，最新 1,000 行的 p95。' })}${kpi('队列', counted(writer?.queued), { unit: '行', note: `上限 ${count(QUEUE_ROWS)} 行` })}${kpi('丢弃', counted(writer?.dropped), { unit: '行', note: '队列满时丢弃' })}${kpi('写入失败', counted(writer?.failed), { unit: '行' })}</section>`;
  const second = html`<section class="ch-stats">${kpi('已写入', counted(writer?.written), { unit: '行' })}${kpi('每批写入耗时', shown(writer?.lastBatchMs, duration), { note: '最近一批' })}${kpi('没有写入的样本', summary === null ? UNKNOWN : count(summary.dropped_samples), { unit: '个', note: '近 24 小时' })}${kpi('读取失败的样本', shown(failed, count), { unit: '个', note: '近 24 小时' })}</section>`;
  return card({ title: '观测自身', meta: '写入的计数从本次启动算起', hint: '观测不能成为负担：请求路径不等待写入，队列满时丢弃并计数。进程崩溃时队列里还没写的行随进程丢失，不计数。' }, html`${first}${second}`);
}

const SLOW_QUERIES = card({ title: '最慢的查询' }, html`<p class="ch-meta">这里还不显示。在 Hub 所在主机上执行 ${code('circle-hub db top')} 查看。</p>`);
const NO_SAMPLES = emptyBlock({ title: '近 24 小时没有资源样本', text: 'Hub 服务运行后每 10 秒写一个样本，这里会出现主线程、内存、沙箱、连接池、数据库、磁盘和请求的当前值和 24 小时曲线。' });
const HINT = '主线程、内存、沙箱、连接池、数据库、磁盘和请求的当前值和曲线，后台任务，崩溃和重启。只有管理员可见。诊断数据保留 14 天，不作根据。';

/** The tabs of the page, in the order shown. A crash asked for by `event` opens the tab that lists it. */
const HEALTH_TABS = ['resources', 'tasks', 'events', 'clients', 'releases', 'self'] as const;
type HealthTab = typeof HEALTH_TABS[number];
const HEALTH_TAB_LABEL: Record<HealthTab, string> = { resources: '资源', tasks: '后台任务', events: '崩溃和重启', clients: '按客户端', releases: '按发布', self: '观测自身' };

export async function healthPage(ctx: PageContext, sources: HealthPageSources | undefined, log: (line: string) => void): Promise<PageResult> {
  const now = ctx.deps.now?.() ?? new Date();
  const to = new Date(Math.ceil(now.getTime() / POINT_MS) * POINT_MS);
  const from = new Date(to.getTime() - DAY_MS);
  const retained = new Date(now.getTime() - RETENTION_MS).toISOString();
  const by = ctx.principal;
  /** One read of the page: a failure leaves its part unknown and the rest of the page as it is. */
  const read = async <T>(what: string, source: (sources: HealthPageSources) => Promise<T>): Promise<T | null> => {
    if (sources === undefined) return null;
    try {
      return await source(sources);
    } catch (error) {
      log(`运行状况页读取失败（${what}）：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  // Decision 151, step 8: one part a tab, and a tab reads only what it shows. The page used to make nine reads, one after the
  // other, for six blocks down one page. The latest sample is read on every tab: it is the line under the title.
  const asked = ctx.url.searchParams.get('tab');
  const tab: HealthTab = ctx.url.searchParams.has('event') ? 'events' : HEALTH_TABS.find((key) => key === asked) ?? 'resources';
  // One after the other: the reads share one connection, and a page that reports on load keeps to one at a time.
  const summary = await read('样本', (s) => s.health.summary(by, { since: from }));
  const uptime = ctx.hub === undefined ? '' : ` · 本次启动已运行 ${duration(now.getTime() - ctx.hub.startedAt.getTime())}`;
  const sub = summary === null ? html`最新样本 ${UNKNOWN}${uptime}` : summary.latest === null ? '近 24 小时没有样本 · Hub 服务运行后每 10 秒写一个' : html`最新样本 ${when(summary.latest, now)} · 每 10 秒一个${uptime}`;
  const curveOf = () => read('曲线', (s) => s.health.curve(by, { from, to, points: CURVE_POINTS }));
  const eventsOf = () => read('进程事件', (s) => s.health.events(by, { limit: EVENTS_SHOWN }));
  let content: Html;
  if (tab === 'resources') {
    const curvePoints = await curveOf();
    const crashes = (await eventsOf())?.filter((event) => event.kind === 'abnormal_exit') ?? [];
    const points = curvePoints ?? Array.from({ length: CURVE_POINTS }, (_, index): CurvePoint => ({ at: new Date(from.getTime() + index * POINT_MS).toISOString(), last_at: null, samples: 0, failed: 0, dropped: 0, event_loop_delay_max_ms: null, heap_used_bytes: null, gc_pause_ms: null, sandbox_running: null, sandbox_waiting: null, pool_in_use: null, pool_waiting: null, pg_active_connections: null, pg_waiting_locks: null, data_free_bytes: null, requests_in_flight: null }));
    const fresh = summary !== null && curvePoints !== null && summary.samples === 0;
    content = fresh ? card({ title: '资源' }, NO_SAMPLES) : resourceCards(summary, points, crashes, now);
  } else if (tab === 'tasks') {
    content = backgroundTable(await read('后台任务', (s) => s.traces.background(by, { since: from.toISOString(), retained })), now);
  } else if (tab === 'events') {
    const events = await eventsOf();
    const eventTotal = await read('进程事件数', (s) => s.health.eventCount(by, { limit: EVENTS_COUNTED }));
    const crashes = events?.filter((event) => event.kind === 'abnormal_exit') ?? [];
    const wanted = Number(ctx.url.searchParams.get('event'));
    const openEvent = crashes.find((event) => event.seq === wanted) ?? crashes[0] ?? null;
    let opened: CrashDetail | null = null;
    if (openEvent !== null) {
      const end = new Date(crashTime(openEvent));
      const boot = openEvent.boot;
      const points = boot === null ? [] : await read('崩溃之前的样本', (s) => s.health.curve(by, { from: new Date(end.getTime() - CRASH_WINDOW_MS), to: end, points: CRASH_POINTS, boot }));
      const ids = [...new Set((openEvent.requests ?? []).slice(0, REQUESTS_SHOWN).flatMap((request) => (request.user === null ? [] : [request.user])))];
      const accounts = ids.length === 0 ? new Map<string, string>() : await read('账号', async () => new Map((await ctx.deps.records.principals.some(ids)).map((user) => [user.id, user.deleted_at ? uiLabelOf('account_display_name', 'deleted_member') : user.name])));
      opened = { event: openEvent, points, names: accounts };
    }
    content = eventList(events, eventTotal, opened, now);
  } else if (tab === 'clients') {
    const clients = await read('客户端', (s) => s.traces.clients(by, { since: from.toISOString(), limit: CLIENTS_SHOWN }));
    content = clientTable(clients, summary, clients?.capped === true && clients.oldest !== null ? stamp(clients.oldest) : null);
  } else if (tab === 'releases') {
    const runs = await read('发布', async (s) => withRunNow(await s.health.releases(by, { limit: RELEASES_SHOWN + 1, events: RELEASE_EVENTS_READ }), ctx.hub, now));
    // A run ends where the line above it begins.
    const releases = runs === null ? null : await read('发布的调用', (s) => s.traces.releases(by, { runs: runs.rows.map((run, index) => ({ release: run.release, from: run.first_start, until: runs.rows[index - 1]?.first_start ?? null })), retained, windowMs: DAY_MS }));
    content = releaseTable(runs, releases, ctx.hub?.release ?? null, now);
  } else {
    content = html`${observation(sources?.writer() ?? null, summary, await curveOf())}
${SLOW_QUERIES}`;
  }
  const tabs = html`<nav class="ch-seg" aria-label="运行状况内容" data-health-tabs>${HEALTH_TABS.map((key) => html`<a href="${href('/console/health', key === 'resources' ? {} : { tab: key })}"${key === tab ? html` aria-current="page"` : ''}>${HEALTH_TAB_LABEL[key]}</a>`)}</nav>`;
  const body = html`<div class="ch-stack" data-health>${tabs}<div data-health-tab="${tab}">${content}</div></div>`;
  return { status: 200, body: page(ctx.chrome('运行状况', { active: 'health', hint: HINT, sub }), body) };
}
