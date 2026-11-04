// Public surface of the health package (decision 146, step 2): what the running process itself reads about its resources
// and how it ended. Diagnostic data, not part of the record chain and no ground for anything (B08). createHealth is the
// process side, healthReader what administrators read; other packages import only from this file.
import { randomBytes } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { createRequestLog, type RequestLog } from './inflight.ts';
import { recordStart, recordStop, recoverEarlierProcesses, type ProcessIdentity } from './lifecycle.ts';
import { connectionsReading, cpuReading, diskReading, eventLoopReading, ioWaitReading, memoryReading, observeGcPauses, poolReading, postgresReading, requestsReading, sandboxReading, startDelayHistogram, type PoolCounters, type SandboxCounters } from './readings.ts';
import { bounded, createSampler, type Reading, type Sampler } from './sampler.ts';
import { createSessionTracker, type SessionTracker } from './sessions.ts';
import { insertSample, pruneExpired, type HealthDatabase } from './store.ts';

export type { RequestEnd, RequestInfo, RequestLog } from './inflight.ts';
export { INFLIGHT_FILE, INFLIGHT_ROTATED } from './inflight.ts';
export type { FieldSummary, HealthReader, HealthSummary } from './reader.ts';
export { DEFAULT_EVENT_LIMIT, DEFAULT_SINCE_MS, HealthAccessError, MAX_EVENT_LIMIT, healthReader, parseSince } from './reader.ts';
export type { PoolCounters, SandboxCounters } from './readings.ts';
export type { SessionCounts, SessionTracker } from './sessions.ts';
export type { HealthDatabase, NumericField, ProcessEvent, ProcessEventKind, ReportSummary, RequestEntry, ResourceSample } from './store.ts';
export { NUMERIC_FIELDS, PROCESS_EVENT_KINDS, pruneExpired } from './store.ts';
export { eventLines, healthLines } from './text.ts';

/** Diagnostic rows older than this are deleted (decision 146). */
export const RETENTION_MS = 14 * 24 * 3600 * 1000;
const RETENTION_FIRST_MS = 60_000;
const RETENTION_EVERY_MS = 3_600_000;
/** Each wait of a stop; together they must fit between the last request and the service manager's kill. */
const STOP_WAIT_MS = 2_000;

/** What the HTTP surface reports to. */
export interface RequestObservers {
  readonly requests: RequestLog;
  readonly sessions: SessionTracker;
}

export interface HealthOptions {
  /** A connection of its own: nothing here waits in the business pool or takes a connection from it. */
  db: HealthDatabase;
  /** Where the in-flight log lives; a write here is on the request path, so it is memory where the host offers it (`serve`). */
  requestLogDir: string;
  /** Where the service tells Node to write crash reports. */
  reportsDir: string;
  /** The operator's log. */
  log: (line: string) => void;
  now?: () => Date;
  /** Default 10 s. */
  sampleIntervalMs?: number;
  /** Until the first retention pass after a start; default a minute. */
  retentionDelayMs?: number;
  /** The longest a stop waits for a start in progress, and for its event to be written; default 2 s each. */
  stopWaitMs?: number;
}

/** What the process knows once it is listening. */
export interface HealthSources {
  release: string | null;
  dataDir: string;
  pool(): PoolCounters | undefined;
  sandbox(): SandboxCounters;
  consoleStreams(): number;
}

export interface Health extends RequestObservers {
  /** Identifies this process in its samples, events and log lines. */
  readonly boot: string;
  /** Call once this process holds its port: settles what the previous process left, records the start, begins sampling. Never rejects, and nothing need wait for it. */
  start(sources: HealthSources): Promise<void>;
  /** Clean stop: waits (bounded) for a start in progress, ends sampling and records the stop. Never rejects. */
  stop(): Promise<void>;
  /** A process that goes no further: ends sampling and releases the log, records nothing. */
  abandon(): void;
}

export function createHealth(options: HealthOptions): Health {
  const { db, log } = options;
  const now = options.now ?? (() => new Date());
  const boot = randomBytes(8).toString('hex');
  const requests = createRequestLog({ directory: options.requestLogDir, boot, now });
  const sessions = createSessionTracker({ now });
  const said = (what: string, error: unknown): void => log(`${what}（不影响服务）：${error instanceof Error ? error.message : String(error)}`);
  let identity: ProcessIdentity | null = null;
  let sampler: Sampler | null = null;
  let release: (() => void) | null = null;
  let retention: NodeJS.Timeout | null = null;
  let starting: Promise<void> | null = null;
  let stopped = false;

  const prune = async (): Promise<void> => {
    try {
      await pruneExpired(db, new Date(now().getTime() - RETENTION_MS), boot);
    } catch (error) {
      // Cut off by a stop, a pass simply goes on at the next start.
      if (!stopped) said('清理过期的运行观测数据失败', error);
    }
    if (stopped) return;
    retention = setTimeout(() => void prune(), RETENTION_EVERY_MS);
    retention.unref();
  };

  const readingsOf = (sources: HealthSources): Reading[] => {
    const histogram = startDelayHistogram();
    const gc = observeGcPauses();
    release = () => {
      histogram.disable();
      gc.close();
    };
    return [
      cpuReading(),
      eventLoopReading(histogram),
      memoryReading(gc),
      sandboxReading(sources.sandbox),
      poolReading(sources.pool),
      postgresReading(db),
      diskReading(sources.dataDir),
      ioWaitReading(),
      connectionsReading(sessions.counts, sources.consoleStreams),
      requestsReading(() => requests.inFlight),
    ];
  };

  const begin = async (sources: HealthSources): Promise<void> => {
    const self: ProcessIdentity = { boot, pid: process.pid, release: sources.release, nodeVersion: process.version, heapLimitBytes: getHeapStatistics().heap_size_limit, startedAt: now() };
    identity = self;
    try {
      for (const exit of await recoverEarlierProcesses(db, requests, options.reportsDir, self, now)) {
        log(`上一个进程（PID ${exit.pid ?? '未知'}）没有正常停止；circle-hub crashes 看当时在处理什么`);
      }
    } catch (error) {
      said('读取上一个进程的结局失败', error);
    }
    try {
      await recordStart(db, self);
    } catch (error) {
      said('写入进程启动事件失败', error);
    }
    if (stopped) return;
    try {
      sampler = createSampler({
        boot,
        readings: readingsOf(sources),
        write: (sample) => insertSample(db, sample),
        now,
        log,
        otherFailures: () => (requests.takeFailures() > 0 ? ['inflight-log'] : []),
        ...(options.sampleIntervalMs === undefined ? {} : { intervalMs: options.sampleIntervalMs }),
      });
      sampler.start();
    } catch (error) {
      said('资源采样没有启动', error);
    }
    retention = setTimeout(() => void prune(), options.retentionDelayMs ?? RETENTION_FIRST_MS);
    retention.unref();
  };

  return {
    boot,
    requests,
    sessions,

    start(sources) {
      starting = begin(sources);
      return starting;
    },

    async stop() {
      stopped = true;
      if (retention !== null) clearTimeout(retention);
      // The marker first: it needs no database, so a clean stop stays known whatever the waits below come to.
      requests.markStopped();
      const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
      await bounded(starting, stopWaitMs).catch(() => {});
      await sampler?.stop();
      release?.();
      if (identity !== null) {
        try {
          await bounded(recordStop(db, identity, now()), stopWaitMs);
        } catch (error) {
          said('写入进程停止事件失败，下次启动时补写', error);
        }
      }
      requests.close();
    },

    abandon() {
      stopped = true;
      if (retention !== null) clearTimeout(retention);
      void sampler?.stop();
      release?.();
      requests.close();
    },
  };
}
