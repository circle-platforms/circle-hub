// The lines of `circle-hub health` and `circle-hub crashes`. A value nobody could read prints as 未知, never as 0.
import type { FieldSummary, HealthSummary } from './reader.ts';
import type { NumericField, ProcessEvent, ProcessEventKind, ReportSummary, RequestEntry } from './store.ts';

const UNKNOWN = '未知';
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const bytes = (value: number): string => (Math.abs(value) >= GB ? `${(value / GB).toFixed(2)} GB` : `${(value / MB).toFixed(1)} MB`);
const ms = (value: number): string => `${value.toFixed(1)} 毫秒`;
const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const count = (value: number): string => String(value);

type Format = (value: number) => string;

/** The resources of the design's table, in its order. */
const GROUPS: readonly (readonly [string, readonly (readonly [string, NumericField, Format])[]])[] = [
  ['主线程', [['进程 CPU（一核为 100%）', 'process_cpu_ratio', percent], ['事件循环利用率', 'event_loop_utilization', percent], ['延迟 p50', 'event_loop_delay_p50_ms', ms], ['延迟 p99', 'event_loop_delay_p99_ms', ms], ['延迟最大', 'event_loop_delay_max_ms', ms]]],
  ['内存', [['堆已用', 'heap_used_bytes', bytes], ['堆上限', 'heap_limit_bytes', bytes], ['常驻内存', 'rss_bytes', bytes], ['外部内存', 'external_bytes', bytes], ['数组缓冲区', 'array_buffers_bytes', bytes], ['垃圾回收暂停', 'gc_pause_ms', ms]]],
  ['沙箱', [['运行中', 'sandbox_running', count], ['上限', 'sandbox_limit', count], ['排队', 'sandbox_waiting', count], ['超时累计', 'sandbox_timeouts', count], ['队列满累计', 'sandbox_queue_full', count]]],
  ['连接池', [['连接', 'pool_total', count], ['上限', 'pool_limit', count], ['空闲', 'pool_idle', count], ['等待', 'pool_waiting', count], ['连接失败累计', 'pool_connection_failures', count]]],
  ['数据库', [['活动连接', 'pg_active_connections', count], ['缓存命中率', 'pg_cache_hit_ratio', percent], ['锁等待', 'pg_waiting_locks', count], ['死锁累计', 'pg_deadlocks', count]]],
  ['磁盘', [['数据目录可用空间', 'data_free_bytes', bytes], ['I/O 等待', 'io_wait_ratio', percent]]],
  ['连接', [['MCP 会话', 'mcp_sessions', count], ['实时推送流', 'console_streams', count]]],
  ['请求', [['处理中', 'requests_in_flight', count]]],
];

const shown = (value: number | null, format: Format): string => (value === null ? UNKNOWN : format(value));
function fieldText(label: string, field: FieldSummary, format: Format): string {
  if (field.current === null && field.min === null && field.max === null) return `${label} ${UNKNOWN}`;
  return `${label} ${shown(field.current, format)}（最小 ${shown(field.min, format)}，最大 ${shown(field.max, format)}）`;
}

export function healthLines(summary: HealthSummary): string[] {
  if (summary.samples === 0) return [`${summary.since} 以来没有资源样本；Hub 服务运行后每 10 秒写一个`];
  const lines = [`${summary.since} 以来 ${summary.samples} 个样本，最新 ${summary.latest}`];
  for (const [group, fields] of GROUPS) lines.push(`${group}：${fields.map(([label, field, format]) => fieldText(label, summary.fields[field], format)).join('；')}`);
  const clients = Object.entries(summary.mcp_sessions_by_client ?? {});
  if (clients.length > 0) lines.push(`按客户端声明：${clients.map(([name, sessions]) => `${name} ${sessions}`).join('、')}`);
  const failed = Object.entries(summary.failed_reads);
  if (failed.length > 0) lines.push(`读取失败：${failed.map(([name, samples]) => `${name} ${samples} 个样本`).join('、')}`);
  if (summary.dropped_samples > 0) lines.push(`没有写入的样本：${summary.dropped_samples} 个`);
  return lines;
}

export const KIND_TEXT: Readonly<Record<ProcessEventKind, string>> = { start: '启动', stop: '正常停止', abnormal_exit: '异常退出' };

function duration(value: number): string {
  const seconds = Math.floor(value / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function reportLine(report: ReportSummary): string {
  if (!report.readable) return `  崩溃报告 ${report.file}：读不出内容`;
  const heap = report.heap;
  const usage = report.resource_usage;
  return `  崩溃报告 ${report.file}：${report.event ?? UNKNOWN}（${report.trigger ?? UNKNOWN}）；堆 ${shown(heap?.used_bytes ?? null, bytes)} / 上限 ${shown(heap?.limit_bytes ?? null, bytes)}；常驻内存 ${shown(usage?.rss_bytes ?? null, bytes)}；CPU 用户 ${usage?.user_cpu_seconds ?? UNKNOWN} 秒，系统 ${usage?.kernel_cpu_seconds ?? UNKNOWN} 秒`;
}

function requestLine(request: RequestEntry): string {
  return `    ${request.started_at} ${request.origin ?? UNKNOWN} ${request.name}（用户 ${request.user ?? UNKNOWN}，追踪 ${request.trace ?? UNKNOWN}）`;
}

export function eventLines(events: readonly ProcessEvent[]): string[] {
  if (events.length === 0) return ['没有进程事件'];
  return events.flatMap((event) => {
    const head = [`${event.at} ${KIND_TEXT[event.kind] ?? event.kind}`, event.pid === null ? null : `PID ${event.pid}`, event.release === null ? null : `发布 ${event.release}`, event.node_version, event.uptime_ms === null ? null : `运行 ${duration(event.uptime_ms)}`].filter((part) => part !== null).join(' ');
    if (event.kind !== 'abnormal_exit') return [head];
    const requests = event.requests;
    return [
      `${head}${event.last_seen_at === null ? '' : `（最后一次活动 ${event.last_seen_at}）`}`,
      ...(event.reports === null ? ['  崩溃报告：目录读不出来'] : event.reports.length === 0 ? ['  没有崩溃报告'] : event.reports.map(reportLine)),
      requests === null ? '  当时在处理什么：未知（在途请求日志里没有这个进程）' : requests.length === 0 ? '  当时没有在处理的请求' : `  当时在处理 ${requests.length + event.requests_omitted} 个请求：`,
      ...(requests ?? []).map(requestLine),
      ...(event.requests_omitted > 0 ? [`    另有 ${event.requests_omitted} 个没有列出`] : []),
    ];
  });
}
