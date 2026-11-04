// What the sampler reads. Each reading is one source; it throws when the source fails. Unknown stays unknown: a value the
// platform does not give is null, never 0, and is not a failure.
import { readFile, statfs } from 'node:fs/promises';
import { getHeapStatistics } from 'node:v8';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';
import type { Reading } from './sampler.ts';
import type { SessionCounts } from './sessions.ts';
import type { HealthDatabase } from './store.ts';

/** Timer period of the delay histogram: the delay it can resolve, and what its raw values must have taken off. */
export const DELAY_RESOLUTION_MS = 20;
/** The PostgreSQL reading runs every this many ticks: 60 s at the 10 s interval. */
export const POSTGRES_EVERY = 6;

export interface PoolCounters {
  limit: number;
  total: number;
  idle: number;
  waiting: number;
  connectionFailures: number;
}

export interface SandboxCounters {
  running: number;
  limit: number;
  waiting: number;
  timeouts: number;
  queueFull: number;
}

/** The parts of the histogram of monitorEventLoopDelay this reading uses; values are nanoseconds. */
export interface DelayHistogram {
  percentile(percentile: number): number;
  readonly max: number;
  readonly count: number;
  reset(): void;
}

/**
 * Utilisation and delay since the last read. The histogram records the time between its timer's firings, so the period
 * comes off every value; an idle loop then reads about 2 ms. reset() also forgets when the timer last fired, so a stall
 * that begins within one period after the reset is not in the delay (measured on Node 24), though utilisation still shows it.
 */
export function eventLoopReading(histogram: DelayHistogram, utilization: () => { utilization: number } = eventLoopUtilization()): Reading {
  const delay = (nanoseconds: number): number => Math.max(0, nanoseconds / 1e6 - DELAY_RESOLUTION_MS);
  return {
    name: 'event-loop',
    read() {
      const idle = histogram.count === 0;
      const values = {
        event_loop_utilization: utilization().utilization,
        event_loop_delay_p50_ms: idle ? null : delay(histogram.percentile(50)),
        event_loop_delay_p99_ms: idle ? null : delay(histogram.percentile(99)),
        event_loop_delay_max_ms: idle ? null : delay(histogram.max),
      };
      histogram.reset();
      return values;
    },
  };
}

/**
 * CPU time of this process, all its threads, per second of wall clock since the last read: 1 is one core busy. It tells work
 * the event loop does not show (garbage collection and thread-pool threads) from idle. Pack functions run in child processes
 * and are not in it.
 */
export function cpuReading(usage: () => { user: number; system: number } = () => process.cpuUsage(), clock: () => number = () => performance.now()): Reading {
  const take = (): { cpuMs: number; at: number } => {
    const { user, system } = usage();
    return { cpuMs: (user + system) / 1000, at: clock() };
  };
  let previous = take();
  return {
    name: 'cpu',
    read() {
      const current = take();
      const elapsed = current.at - previous.at;
      const ratio = elapsed <= 0 ? null : (current.cpuMs - previous.cpuMs) / elapsed;
      previous = current;
      return { process_cpu_ratio: ratio };
    },
  };
}

function eventLoopUtilization(): () => { utilization: number } {
  let previous = performance.eventLoopUtilization();
  return () => {
    const current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, previous);
    previous = current;
    return delta;
  };
}

/** Garbage-collection pause time since the last read, in milliseconds. */
export interface GcPauses {
  take(): number;
  close(): void;
}

export function observeGcPauses(): GcPauses {
  let pause = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) pause += entry.duration;
  });
  observer.observe({ entryTypes: ['gc'] });
  return {
    take() {
      const taken = pause;
      pause = 0;
      return taken;
    },
    close() {
      observer.disconnect();
    },
  };
}

export function memoryReading(gc: Pick<GcPauses, 'take'>): Reading {
  return {
    name: 'memory',
    read() {
      const memory = process.memoryUsage();
      return {
        heap_used_bytes: memory.heapUsed,
        heap_limit_bytes: getHeapStatistics().heap_size_limit,
        rss_bytes: memory.rss,
        external_bytes: memory.external,
        array_buffers_bytes: memory.arrayBuffers,
        gc_pause_ms: gc.take(),
      };
    },
  };
}

export function sandboxReading(stats: () => SandboxCounters): Reading {
  return {
    name: 'sandbox',
    read() {
      const { running, limit, waiting, timeouts, queueFull } = stats();
      return { sandbox_running: running, sandbox_limit: limit, sandbox_waiting: waiting, sandbox_timeouts: timeouts, sandbox_queue_full: queueFull };
    },
  };
}

export function poolReading(stats: () => PoolCounters | undefined): Reading {
  return {
    name: 'pool',
    read() {
      const counters = stats();
      if (counters === undefined) return {};
      return { pool_limit: counters.limit, pool_total: counters.total, pool_idle: counters.idle, pool_waiting: counters.waiting, pool_connection_failures: counters.connectionFailures };
    },
  };
}

// Catalog views any role may read. pg_stat_activity shows the state of the role's own sessions only, which are all the
// Hub's; a backup's session (another role) has a null state and is not counted.
const POSTGRES = `SELECT
 (SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity a WHERE a.datname=pg_catalog.current_database() AND a.state='active' AND a.pid<>pg_catalog.pg_backend_pid())::pg_catalog.int4 AS active,
 (SELECT pg_catalog.count(*) FROM pg_catalog.pg_locks l WHERE NOT l.granted)::pg_catalog.int4 AS waiting_locks,
 d.blks_hit::pg_catalog.text AS blocks_hit,d.blks_read::pg_catalog.text AS blocks_read,d.deadlocks::pg_catalog.text AS deadlocks
 FROM pg_catalog.pg_stat_database d WHERE d.datname=pg_catalog.current_database()`;

/**
 * Connections, locks and deadlocks as PostgreSQL reports them (deadlocks since its statistics began), and the cache hit
 * ratio of the last interval: since the statistics began it would barely move. With nothing read in the interval, or
 * statistics that were reset, the ratio is unknown.
 */
export function postgresReading(db: HealthDatabase): Reading {
  let previous: { hit: number; read: number } | null = null;
  return {
    name: 'postgres',
    every: POSTGRES_EVERY,
    async read() {
      const row = (await db.query(POSTGRES)).rows[0];
      if (row === undefined) throw new Error('no statistics for this database');
      const counters = { hit: Number(row.blocks_hit), read: Number(row.blocks_read) };
      const hit = previous === null ? 0 : counters.hit - previous.hit;
      const read = previous === null ? 0 : counters.read - previous.read;
      previous = counters;
      return {
        pg_active_connections: Number(row.active),
        pg_waiting_locks: Number(row.waiting_locks),
        pg_deadlocks: Number(row.deadlocks),
        pg_cache_hit_ratio: hit < 0 || read < 0 || hit + read === 0 ? null : hit / (hit + read),
      };
    },
  };
}

export function diskReading(dataDir: string, read: typeof statfs = statfs): Reading {
  return {
    name: 'disk',
    async read() {
      const stats = await read(dataDir);
      return { data_free_bytes: stats.bavail * (stats.frsize || stats.bsize) };
    },
  };
}

/** The first line of /proc/stat: ticks spent waiting for I/O, and in every state. Throws on anything else. */
export function parseCpuTimes(text: string): { ioWait: number; total: number } {
  const line = text.split('\n', 1)[0] ?? '';
  const fields = line.trim().split(/\s+/);
  // user nice system idle iowait irq softirq steal; guest time is already counted in user.
  const ticks = fields.slice(1, 9).map(Number);
  if (fields[0] !== 'cpu' || ticks.length < 5 || !ticks.every(Number.isSafeInteger)) throw new Error('/proc/stat 的格式看不懂');
  return { ioWait: ticks[4]!, total: ticks.reduce((sum, value) => sum + value, 0) };
}

/** Share of CPU time spent waiting for I/O since the last read: Linux only, and unknown (null) until there is a baseline. */
export function ioWaitReading(platform: NodeJS.Platform = process.platform, read: () => Promise<string> = () => readFile('/proc/stat', 'utf8')): Reading {
  let previous: { ioWait: number; total: number } | null = null;
  return {
    name: 'io-wait',
    async read() {
      if (platform !== 'linux') return { io_wait_ratio: null };
      const times = parseCpuTimes(await read());
      const elapsed = previous === null ? 0 : times.total - previous.total;
      const ratio = previous === null || elapsed <= 0 ? null : (times.ioWait - previous.ioWait) / elapsed;
      previous = times;
      return { io_wait_ratio: ratio };
    },
  };
}

export function connectionsReading(sessions: () => SessionCounts, consoleStreams: () => number): Reading {
  return {
    name: 'connections',
    read() {
      const { total, byClient } = sessions();
      return { mcp_sessions: total, mcp_sessions_by_client: byClient, console_streams: consoleStreams() };
    },
  };
}

export function requestsReading(inFlight: () => number): Reading {
  return { name: 'requests', read: () => ({ requests_in_flight: inFlight() }) };
}

/** The histogram the event-loop reading uses; enable() starts its timer, disable() ends it. */
export function startDelayHistogram(): DelayHistogram & { disable(): void } {
  const histogram = monitorEventLoopDelay({ resolution: DELAY_RESOLUTION_MS });
  histogram.enable();
  return histogram as unknown as DelayHistogram & { disable(): void };
}
