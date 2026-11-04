// What an administrator reads: an unknown value is said to be unknown, never printed as 0, and a crash says what is known.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FieldSummary, HealthSummary } from './reader.ts';
import { NUMERIC_FIELDS, type NumericField, type ProcessEvent, type ReportSummary } from './store.ts';
import { eventLines, healthLines } from './text.ts';

function summary(fields: Partial<Record<NumericField, FieldSummary>>, extra: Partial<HealthSummary> = {}): HealthSummary {
  const all = Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, { current: null, min: null, max: null }])) as Record<NumericField, FieldSummary>;
  return { since: '2026-01-02T03:00:00.000Z', samples: 6, latest: '2026-01-02T03:01:00.000Z', fields: { ...all, ...fields }, mcp_sessions_by_client: null, failed_reads: {}, dropped_samples: 0, ...extra };
}

const line = (lines: string[], start: string): string => lines.find((text) => text.startsWith(start)) ?? '';

test('every resource has a line, and each value its current, lowest and highest', () => {
  const lines = healthLines(summary({
    event_loop_utilization: { current: 0.125, min: 0.01, max: 0.5 },
    event_loop_delay_p99_ms: { current: 5.25, min: 1, max: 88 },
    heap_used_bytes: { current: 1.5 * 1024 ** 3, min: 512 * 1024 ** 2, max: 2 * 1024 ** 3 },
    sandbox_waiting: { current: 0, min: 0, max: 12 },
  }));
  assert.equal(lines[0], '2026-01-02T03:00:00.000Z 以来 6 个样本，最新 2026-01-02T03:01:00.000Z');
  assert.deepEqual(lines.slice(1).map((text) => text.split('：')[0]), ['主线程', '内存', '沙箱', '连接池', '数据库', '磁盘', '连接', '请求']);
  assert.match(line(lines, '主线程'), /事件循环利用率 12\.5%（最小 1\.0%，最大 50\.0%）/);
  assert.match(line(lines, '主线程'), /延迟 p99 5\.3 毫秒（最小 1\.0 毫秒，最大 88\.0 毫秒）/);
  assert.match(line(lines, '内存'), /堆已用 1\.50 GB（最小 512\.0 MB，最大 2\.00 GB）/);
  assert.match(line(lines, '沙箱'), /排队 0（最小 0，最大 12）/, 'a real 0 stays 0');
});

test('a value nobody could read says unknown, once, and is never 0', () => {
  const lines = healthLines(summary({ io_wait_ratio: { current: null, min: null, max: null }, pg_cache_hit_ratio: { current: null, min: 0.9, max: 1 } }));
  assert.match(line(lines, '磁盘'), /I\/O 等待 未知$/);
  assert.match(line(lines, '数据库'), /缓存命中率 未知（最小 90\.0%，最大 100\.0%）/, 'a range without a current value');
  assert.doesNotMatch(lines.slice(1).join('\n'), /[^0-9.]0(\.0)?( |%|（|；|$)/);
});

test('sessions by client, failed readings and lost samples are listed only when there are any', () => {
  const plain = healthLines(summary({}));
  assert.ok(!plain.some((text) => /按客户端声明|读取失败|没有写入/.test(text)));
  const lines = healthLines(summary({}, { mcp_sessions_by_client: { 'client-a': 3, 'client-b': 1 }, failed_reads: { disk: 2, postgres: 1 }, dropped_samples: 4 }));
  assert.ok(lines.includes('按客户端声明：client-a 3、client-b 1'));
  assert.ok(lines.includes('读取失败：disk 2 个样本、postgres 1 个样本'));
  assert.ok(lines.includes('没有写入的样本：4 个'));
});

test('an empty window says so', () => {
  assert.deepEqual(healthLines(summary({}, { samples: 0, latest: null })), ['2026-01-02T03:00:00.000Z 以来没有资源样本；Hub 服务运行后每 10 秒写一个']);
});

const base: ProcessEvent = { at: '2026-01-02T03:00:00.000Z', kind: 'start', boot: 'boot-a', pid: 4242, release: 'synthetic-release', node_version: 'v24.22.0', heap_limit_bytes: 1, uptime_ms: null, last_seen_at: null, requests: null, requests_omitted: 0, reports: null };
const exit: ProcessEvent = { ...base, kind: 'abnormal_exit', uptime_ms: 7_530_000, last_seen_at: '2026-01-02T02:59:58.000Z', requests: [], reports: [] };
const report: ReportSummary = { file: 'report.20260102.030405.4242.0.001.json', readable: true, event: 'Allocation failed - JavaScript heap out of memory', trigger: 'OOMError', dumped_at: null, pid: 4242, node_version: null, heap: { used_bytes: 2 * 1024 ** 3, total_bytes: null, available_bytes: null, limit_bytes: 4 * 1024 ** 3 }, resource_usage: null };

test('starts and stops are one line each', () => {
  assert.deepEqual(eventLines([base, { ...base, kind: 'stop', uptime_ms: 65_000 }, { ...base, kind: 'stop', uptime_ms: 5_000, release: null, pid: null }]), [
    '2026-01-02T03:00:00.000Z 启动 PID 4242 发布 synthetic-release v24.22.0',
    '2026-01-02T03:00:00.000Z 正常停止 PID 4242 发布 synthetic-release v24.22.0 运行 1 分 5 秒',
    '2026-01-02T03:00:00.000Z 正常停止 v24.22.0 运行 5 秒',
  ]);
  assert.deepEqual(eventLines([]), ['没有进程事件']);
});

test('an abnormal exit tells what ran and why, and tells the unknown from the empty', () => {
  const known = eventLines([{ ...exit, requests: [{ trace: 'a'.repeat(32), origin: 'mcp', name: 'get_nodes', user: 'usr_synthetic', started_at: '2026-01-02T02:59:50.000Z' }, { trace: null, origin: 'console', name: 'GET /console/runs', user: null, started_at: '2026-01-02T02:59:51.000Z' }], requests_omitted: 3, reports: [report] }]);
  assert.equal(known[0], '2026-01-02T03:00:00.000Z 异常退出 PID 4242 发布 synthetic-release v24.22.0 运行 2 小时 5 分（最后一次活动 2026-01-02T02:59:58.000Z）');
  assert.match(known[1]!, /Allocation failed - JavaScript heap out of memory（OOMError）；堆 2\.00 GB \/ 上限 4\.00 GB；常驻内存 未知；CPU 用户 未知 秒，系统 未知 秒/);
  assert.equal(known[2], '  当时在处理 5 个请求：');
  assert.match(known[3]!, /mcp get_nodes（用户 usr_synthetic，追踪 a{32}）/);
  assert.match(known[4]!, /console GET \/console\/runs（用户 未知，追踪 未知）/);
  assert.equal(known[5], '    另有 3 个没有列出');
  assert.ok(eventLines([exit]).includes('  当时没有在处理的请求'));
  assert.ok(eventLines([exit]).includes('  没有崩溃报告'));
  assert.ok(eventLines([{ ...exit, requests: null }]).includes('  当时在处理什么：未知（在途请求日志里没有这个进程）'));
  assert.ok(eventLines([{ ...exit, reports: null }]).includes('  崩溃报告：目录读不出来'));
  assert.ok(eventLines([{ ...exit, reports: [{ ...report, readable: false }] }]).includes(`  崩溃报告 ${report.file}：读不出内容`));
});
