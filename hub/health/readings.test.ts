// The readings themselves. Sources are injected; the platform's own values only where the test asks what they are not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectionsReading, cpuReading, DELAY_RESOLUTION_MS, diskReading, eventLoopReading, ioWaitReading, memoryReading, observeGcPauses, parseCpuTimes, poolReading, POSTGRES_EVERY, postgresReading, requestsReading, sandboxReading, startDelayHistogram, type DelayHistogram } from './readings.ts';
import type { HealthDatabase } from './store.ts';

function histogram(values: { p50: number; p99: number; max: number; count?: number }): DelayHistogram & { resets: number } {
  const ms = 1e6;
  return {
    resets: 0,
    percentile: (p) => (p === 50 ? values.p50 : values.p99) * ms,
    max: values.max * ms,
    count: values.count ?? 10,
    reset() {
      this.resets += 1;
    },
  };
}

test('the delay is what the loop added to the timer period, per interval: the period comes off, never below 0', async () => {
  const source = histogram({ p50: DELAY_RESOLUTION_MS + 2, p99: DELAY_RESOLUTION_MS + 30, max: DELAY_RESOLUTION_MS - 1 });
  const values = await eventLoopReading(source, () => ({ utilization: 0.25 })).read();
  assert.deepEqual(values, { event_loop_utilization: 0.25, event_loop_delay_p50_ms: 2, event_loop_delay_p99_ms: 30, event_loop_delay_max_ms: 0 });
  assert.equal(source.resets, 1, 'the next sample is the next interval');
});

test('a histogram with no sample is unknown delay, not zero delay', async () => {
  const values = await eventLoopReading(histogram({ p50: 0, p99: 0, max: 0, count: 0 }), () => ({ utilization: 1 })).read();
  assert.deepEqual(values, { event_loop_utilization: 1, event_loop_delay_p50_ms: null, event_loop_delay_p99_ms: null, event_loop_delay_max_ms: null });
});

test('process CPU is CPU time per wall-clock time since the last read, from the first sample on: 1 is one core', async () => {
  let cpu = 1000;
  let at = 0;
  const reading = cpuReading(() => ({ user: cpu * 800, system: cpu * 200 }), () => at);
  cpu += 2500;
  at += 10_000;
  assert.deepEqual(await reading.read(), { process_cpu_ratio: 0.25 });
  cpu += 15_000;
  at += 10_000;
  assert.deepEqual(await reading.read(), { process_cpu_ratio: 1.5 }, 'several threads can pass one core');
  assert.deepEqual(await reading.read(), { process_cpu_ratio: null }, 'no time passed: unknown');
});

test('the real sources give finite numbers', async () => {
  const delay = startDelayHistogram();
  const gc = observeGcPauses();
  try {
    await new Promise((resolve) => setTimeout(resolve, DELAY_RESOLUTION_MS * 3));
    const loop = await eventLoopReading(delay).read();
    assert.ok(Number.isFinite(loop.event_loop_utilization));
    assert.ok(Number.isFinite(loop.event_loop_delay_max_ms));
    assert.ok(Number.isFinite((await cpuReading().read()).process_cpu_ratio ?? 0));
    const memory = await memoryReading(gc).read();
    for (const field of ['heap_used_bytes', 'heap_limit_bytes', 'rss_bytes', 'external_bytes', 'array_buffers_bytes'] as const) assert.ok(Number(memory[field]) > 0, field);
    assert.ok(Number(memory.heap_limit_bytes) > Number(memory.heap_used_bytes));
    assert.ok(Number(memory.gc_pause_ms) >= 0);
  } finally {
    delay.disable();
    gc.close();
  }
});

test('garbage-collection pause is per interval: taking it resets it', () => {
  let pause = 12.5;
  const gc = { take: () => { const taken = pause; pause = 0; return taken; } };
  assert.equal((memoryReading(gc).read() as { gc_pause_ms: number }).gc_pause_ms, 12.5);
  assert.equal((memoryReading(gc).read() as { gc_pause_ms: number }).gc_pause_ms, 0);
});

test('sandbox, pool, connection and request readings carry their counters', async () => {
  assert.deepEqual(await sandboxReading(() => ({ running: 2, limit: 8, waiting: 3, timeouts: 4, queueFull: 5 })).read(), { sandbox_running: 2, sandbox_limit: 8, sandbox_waiting: 3, sandbox_timeouts: 4, sandbox_queue_full: 5 });
  assert.deepEqual(await poolReading(() => ({ limit: 10, total: 10, idle: 4, waiting: 1, connectionFailures: 2 })).read(), { pool_limit: 10, pool_total: 10, pool_idle: 4, pool_waiting: 1, pool_connection_failures: 2 });
  assert.deepEqual(await poolReading(() => undefined).read(), {}, 'no pool to read: unknown');
  assert.deepEqual(await connectionsReading(() => ({ total: 3, byClient: { 'client-a': 2 } }), () => 7).read(), { mcp_sessions: 3, mcp_sessions_by_client: { 'client-a': 2 }, console_streams: 7 });
  assert.deepEqual(await requestsReading(() => 5).read(), { requests_in_flight: 5 });
});

test('the free space of the data root is what an unprivileged writer may use', async () => {
  const stats = { bavail: 1000, bfree: 5000, bsize: 8192, frsize: 4096 };
  const read = (async () => stats) as unknown as Parameters<typeof diskReading>[1];
  assert.deepEqual(await diskReading('/synthetic/root', read).read(), { data_free_bytes: 4_096_000 });
  const old = (async () => ({ ...stats, frsize: 0 })) as unknown as Parameters<typeof diskReading>[1];
  assert.deepEqual(await diskReading('/synthetic/root', old).read(), { data_free_bytes: 8_192_000 }, 'a file system without a fragment size counts in blocks');
});

test('a failing source throws for the sampler to count', async () => {
  await assert.rejects(async () => diskReading('/synthetic/root', (async () => { throw new Error('synthetic failure'); }) as unknown as Parameters<typeof diskReading>[1]).read());
});

const procStat = (user: number, ioWait: number) => `cpu  ${user} 0 100 1000 ${ioWait} 5 5 0 7 0\ncpu0 1 2 3 4 5 6 7 8 9 10\nintr 1\n`;

test('I/O wait on Linux is the share of CPU time since the last read; the first read has no baseline and is unknown', async () => {
  let text = procStat(100, 50);
  const reading = ioWaitReading('linux', async () => text);
  assert.deepEqual(await reading.read(), { io_wait_ratio: null }, 'no baseline yet, and not 0');
  text = procStat(150, 100);
  assert.deepEqual(await reading.read(), { io_wait_ratio: 0.5 });
  assert.deepEqual(await reading.read(), { io_wait_ratio: null }, 'no time passed');
});

test('I/O wait on macOS is unknown, never 0, and is not a failure', async () => {
  const reading = ioWaitReading('darwin', async () => { throw new Error('must not be read'); });
  assert.deepEqual(await reading.read(), { io_wait_ratio: null });
});

test('a /proc/stat that is not understood fails the reading rather than inventing a number', async () => {
  assert.deepEqual(parseCpuTimes('cpu  1 2 3 4 5 6 7 8 9 10\n'), { ioWait: 5, total: 36 });
  for (const text of ['', 'intr 1 2 3', 'cpu  1 2', 'cpu  a b c d e f g h']) assert.throws(() => parseCpuTimes(text), /格式/, JSON.stringify(text));
  await assert.rejects(async () => ioWaitReading('linux', async () => 'garbage').read(), /格式/);
});

function database(rows: Record<string, unknown>[][]): HealthDatabase {
  return { query: (async () => ({ rows: rows.shift() ?? [], rowCount: null })) as HealthDatabase['query'] };
}

const stats = (hit: number, read: number) => ({ active: 3, waiting_locks: 1, blocks_hit: String(hit), blocks_read: String(read), deadlocks: '2' });

test('PostgreSQL is read once a minute; the cache hit ratio is of the last interval, unknown without one', async () => {
  const reading = postgresReading(database([[stats(1000, 1000)], [stats(1090, 1010)], [stats(1090, 1010)], [stats(10, 1)]]));
  assert.equal(reading.every, POSTGRES_EVERY);
  assert.deepEqual(await reading.read(), { pg_active_connections: 3, pg_waiting_locks: 1, pg_deadlocks: 2, pg_cache_hit_ratio: null }, 'no baseline');
  assert.equal((await reading.read()).pg_cache_hit_ratio, 0.9);
  assert.equal((await reading.read()).pg_cache_hit_ratio, null, 'nothing read in the interval');
  assert.equal((await reading.read()).pg_cache_hit_ratio, null, 'statistics that were reset');
});

test('a database with no statistics row fails the reading', async () => {
  await assert.rejects(async () => postgresReading(database([[]])).read(), /no statistics/);
});
