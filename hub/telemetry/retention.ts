// Diagnostic data is kept 14 days (B08 R[5]). A background job deletes older rows in bounded batches, so one pass never
// holds a long transaction; the job is traced like every other background task.
import type { Database } from '../records/db.ts';
import { background } from './usage.ts';

export const RETENTION_DAYS = 14;
export const PURGE_BATCH_ROWS = 5000;
const DAY_MS = 24 * 3600 * 1000;
const PURGE_EVERY_MS = 3600 * 1000;
/** The first pass waits until the start of the process is over. */
const FIRST_PURGE_MS = 60_000;

/** Deletes the rows that started before `now` less the retention, batch by batch, and returns how many. */
export async function purgeExpired(db: Database, now: Date, options: { batchRows?: number; stop?: () => boolean } = {}): Promise<number> {
  const before = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
  const batchRows = options.batchRows ?? PURGE_BATCH_ROWS;
  let deleted = 0;
  for (;;) {
    const result = await db.query(
      `DELETE FROM trace_spans WHERE (trace_id, span_id) IN (SELECT trace_id, span_id FROM trace_spans WHERE started_at < $1 ORDER BY started_at LIMIT $2)`,
      [before, batchRows],
    );
    deleted += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batchRows || options.stop?.() === true) return deleted;
  }
}

export interface RetentionSchedule {
  /** One traced pass, now. */
  runNow(): Promise<number>;
  /** Ends the schedule and waits for a pass under way, which stops at its next batch. */
  stop(): Promise<void>;
}

/** Runs a pass an hour, the first one a minute from now. A pass that fails is reported and the next one tries again. */
export function scheduleRetention(db: Database, options: { now?: () => Date; log?: (line: string) => void; batchRows?: number } = {}): RetentionSchedule {
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<number> | null = null;
  const pass = (): Promise<number> =>
    (running ??= background('purge-traces', () => purgeExpired(db, now(), { stop: () => stopped, ...(options.batchRows === undefined ? {} : { batchRows: options.batchRows }) })).finally(() => {
      running = null;
    }));
  const arm = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void pass()
        .catch((error: unknown) => options.log?.(`清理过期的运行观测失败（下一轮重试）：${(error as { code?: unknown } | null)?.code ?? '没有错误码'}`))
        .finally(() => arm(PURGE_EVERY_MS));
    }, ms);
    timer.unref();
  };
  arm(FIRST_PURGE_MS);
  return {
    runNow: pass,
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await running?.catch(() => {});
    },
  };
}
