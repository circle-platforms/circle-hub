// Public surface of the telemetry package (B08, decision 146): the trace context (usage.ts, the one file the packages below
// records may import directly), the writer, the retention job and the permission-checked reader. Code above records calls
// the context through this file; startTelemetry belongs to whoever owns the process (serve, one CLI command).
import type { Environment } from '../../contracts/generated/vocabulary.ts';
import type { DatabaseConfig } from '../config/index.ts';
import { createPool, Database } from '../records/db.ts';
import { TraceReader } from './reader.ts';
import { scheduleRetention, type RetentionSchedule } from './retention.ts';
import { installTraceSink } from './usage.ts';
import { FLUSH_MS, INSERT_SPANS, TraceWriter, type StoredSpanRow, type WriterStats } from './writer.ts';

export { ACCOUNTED_USAGE, BACKGROUND_STEPS, STEP_NAMES, TIMED_BACKGROUND_STEPS, USAGE_NAMES, commandStep, consoleStep, isUsageName, mcpStep, syncStep, type BackgroundStep, type StepName, type UsageName } from './names.ts';
export { MAX_RELEASE_CALLS_READ, MAX_ROOTS_READ, MAX_ROUNDS_READ, MAX_SHOWN_STEPS, TraceReader, type BackgroundQuery, type BackgroundTotal, type ClientQuery, type ClientTotal, type ClientTotals, type ReadBounds, type ReleaseQuery, type ReleaseTotal, type TraceDetail, type TraceListQuery, type TraceNode, type TraceStep, type TraceTopQuery, type TraceTotal } from './reader.ts';
export { RETENTION_DAYS, purgeExpired, scheduleRetention, type RetentionSchedule } from './retention.ts';
export {
  MAX_TRACE_STEPS,
  SLOW_QUERY_MS,
  addEvent,
  addUsage,
  background,
  currentTrace,
  installTraceSink,
  recordQuery,
  recordSourceRead,
  setTraceStatus,
  startTrace,
  step,
  traceSinkInstalled,
  tracing,
  updateTrace,
  withoutTrace,
  type SpanRow,
  type TraceFields,
  type TraceOptions,
  type TraceSink,
  type Usage,
} from './usage.ts';
export { BATCH_ROWS, FLUSH_MS, QUEUE_ROWS, TraceWriter, type StoredSpanRow, type WriterOptions, type WriterStats } from './writer.ts';

/** How long close() waits for the last write; a process that is stopping does not wait for a database that is gone. */
const CLOSE_WAIT_MS = 5000;

export interface TelemetryOptions {
  database: DatabaseConfig;
  release?: string | null;
  environment?: Environment | null;
  /** The operator's log (failed writes); default none. */
  log?: (line: string) => void;
  /** Delete expired rows on a schedule: for the serving process, not for one command. */
  retention?: boolean;
  /** Tests: replace the insert, change the bounds. */
  insert?: (rows: readonly StoredSpanRow[]) => Promise<void>;
  flushMs?: number;
  batchRows?: number;
  queueRows?: number;
}

export interface Telemetry {
  /** Writes what is queued now. */
  flush(): Promise<void>;
  stats(): WriterStats;
  /** The retention job, when `retention` was asked for. */
  readonly retention: RetentionSchedule | null;
  /** Stops tracing, writes what is left (bounded) and closes the connection; never rejects. */
  close(): Promise<void>;
}

/** Installs the trace sink of this process on a connection of its own. One at a time: the last one started wins. */
export function startTelemetry(options: TelemetryOptions): Telemetry {
  const pool = createPool(options.database, 1);
  const writer = new TraceWriter({
    insert: options.insert ?? (async (rows) => {
      await pool.query(INSERT_SPANS, [JSON.stringify(rows)]);
    }),
    release: options.release ?? null,
    environment: options.environment ?? null,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.batchRows === undefined ? {} : { batchRows: options.batchRows }),
    ...(options.queueRows === undefined ? {} : { queueRows: options.queueRows }),
  });
  const uninstall = installTraceSink(writer);
  const timer = setInterval(() => void writer.flush(), options.flushMs ?? FLUSH_MS);
  timer.unref();
  const retention = options.retention === true ? scheduleRetention(new Database(pool), options.log === undefined ? {} : { log: options.log }) : null;
  let closing: Promise<void> | undefined;
  return {
    flush: () => writer.flush(),
    stats: () => writer.stats(),
    retention,
    close: () =>
      (closing ??= (async () => {
        clearInterval(timer);
        const last = (async () => {
          await retention?.stop();
          uninstall();
          await writer.close();
          await pool.end();
        })().catch(() => {});
        let wait: NodeJS.Timeout | undefined;
        await Promise.race([last, new Promise<void>((resolve) => { wait = setTimeout(resolve, CLOSE_WAIT_MS); wait.unref(); })]);
        clearTimeout(wait);
      })()),
  };
}

/** A reader on a connection of its own, for a process that has none to share; `close` ends the connection. */
export function openTraceReader(database: DatabaseConfig): { reader: TraceReader; close(): Promise<void> } {
  const db = new Database(createPool(database, 1));
  return { reader: new TraceReader(db), close: () => db.end() };
}
