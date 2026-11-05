// The two diagnostic tables of migration 28. Everything here runs on the health package's own connection, never on the
// business pool. Null is an unavailable reading, never zero (B08: diagnostic data, not part of the record chain).

/** What the health package needs from a database connection; hub/records' Database has this shape. */
export interface HealthDatabase {
  query<R extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

/** Every numeric reading of a sample; each is a column of resource_samples and may be null. */
export const NUMERIC_FIELDS = [
  'process_cpu_ratio', 'event_loop_utilization', 'event_loop_delay_p50_ms', 'event_loop_delay_p99_ms', 'event_loop_delay_max_ms',
  'heap_used_bytes', 'heap_limit_bytes', 'rss_bytes', 'external_bytes', 'array_buffers_bytes', 'gc_pause_ms',
  'sandbox_running', 'sandbox_limit', 'sandbox_waiting', 'sandbox_timeouts', 'sandbox_queue_full',
  'pool_limit', 'pool_total', 'pool_idle', 'pool_waiting', 'pool_connection_failures',
  'pg_active_connections', 'pg_cache_hit_ratio', 'pg_waiting_locks', 'pg_deadlocks',
  'data_free_bytes', 'io_wait_ratio',
  'mcp_sessions', 'console_streams', 'requests_in_flight',
] as const;
export type NumericField = (typeof NUMERIC_FIELDS)[number];

export type SampleValues = { [K in NumericField]: number | null } & { mcp_sessions_by_client: Record<string, number> | null };

export interface ResourceSample extends SampleValues {
  sampled_at: string;
  /** The process that took it: the boot of its start event. */
  boot: string;
  /** Since the sample before it; null for a process's first. */
  interval_ms: number | null;
  /** Names of the readings that failed for this sample; their fields are null. */
  failed_reads: string[];
  /** Earlier samples of this process that could not be written, since the last one that was. */
  dropped_samples: number;
}

export function emptyValues(): SampleValues {
  const values = Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, null])) as { [K in NumericField]: null };
  return { ...values, mcp_sessions_by_client: null };
}

const finite = (value: number | null): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const SAMPLE_COLUMNS = ['sampled_at', 'boot', 'interval_ms', ...NUMERIC_FIELDS, 'mcp_sessions_by_client', 'failed_reads', 'dropped_samples'] as const;
const INSERT_SAMPLE = `INSERT INTO public.resource_samples(${SAMPLE_COLUMNS.join(',')}) VALUES(${SAMPLE_COLUMNS.map((_, index) => `$${index + 1}`).join(',')})`;

export async function insertSample(db: HealthDatabase, sample: ResourceSample): Promise<void> {
  await db.query(INSERT_SAMPLE, [
    sample.sampled_at,
    sample.boot,
    sample.interval_ms,
    ...NUMERIC_FIELDS.map((field) => finite(sample[field])),
    sample.mcp_sessions_by_client === null ? null : JSON.stringify(sample.mcp_sessions_by_client),
    sample.failed_reads,
    sample.dropped_samples,
  ]);
}

/** Local constants until the model has this axis (README, needs from other packages). */
export const PROCESS_EVENT_KINDS = ['start', 'stop', 'abnormal_exit'] as const;
export type ProcessEventKind = (typeof PROCESS_EVENT_KINDS)[number];

/** One request the log says was still running. Never its arguments. */
export interface RequestEntry {
  trace: string | null;
  origin: string | null;
  name: string;
  user: string | null;
  started_at: string;
}

export interface ReportSummary {
  file: string;
  /** False when the file could not be read or parsed: its existence is the only fact. */
  readable: boolean;
  event: string | null;
  trigger: string | null;
  dumped_at: string | null;
  pid: number | null;
  node_version: string | null;
  heap: { used_bytes: number | null; total_bytes: number | null; available_bytes: number | null; limit_bytes: number | null } | null;
  resource_usage: { rss_bytes: number | null; max_rss_bytes: number | null; user_cpu_seconds: number | null; kernel_cpu_seconds: number | null; free_memory_bytes: number | null; available_memory_bytes: number | null; total_memory_bytes: number | null } | null;
}

export interface ProcessEvent {
  at: string;
  kind: ProcessEventKind;
  /** The process it is about; null only for an exit known from a report no start event matches. */
  boot: string | null;
  pid: number | null;
  release: string | null;
  node_version: string | null;
  heap_limit_bytes: number | null;
  uptime_ms: number | null;
  /** The last sign of life of an abnormally ended process; null when none was left. */
  last_seen_at: string | null;
  /** What was running at an abnormal exit, oldest first; null when that is unknown (the log says nothing of this process). */
  requests: RequestEntry[] | null;
  requests_omitted: number;
  /** The crash reports of an abnormal exit; null when the directory could not be read. */
  reports: ReportSummary[] | null;
}

/** An event as read back; `seq` is how a reader names it, newest highest. */
export interface StoredProcessEvent extends ProcessEvent {
  seq: number;
}

const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

/** False when this process's ending was already recorded (by another start, or a late stop marker). */
export async function insertEvent(db: HealthDatabase, event: ProcessEvent): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO public.process_events(at,kind,boot,pid,release,node_version,heap_limit_bytes,uptime_ms,last_seen_at,requests,requests_omitted,reports)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
    [event.at, event.kind, event.boot, event.pid, event.release, event.node_version, event.heap_limit_bytes, event.uptime_ms, event.last_seen_at, json(event.requests), event.requests_omitted, json(event.reports)],
  );
  return result.rowCount === 1;
}

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());
const count = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export interface OpenStart {
  at: string;
  boot: string;
  pid: number | null;
  release: string | null;
  node_version: string | null;
  heap_limit_bytes: number | null;
  last_sample_at: string | null;
}

/** Starts of other processes with no ending, newest first: normally none, or the one process that just went away. */
export async function openStarts(db: HealthDatabase, ownBoot: string, limit = 20): Promise<OpenStart[]> {
  const { rows } = await db.query(
    `SELECT s.at,s.boot,s.pid,s.release,s.node_version,s.heap_limit_bytes,
            (SELECT max(r.sampled_at) FROM public.resource_samples r WHERE r.boot=s.boot) AS last_sample_at
       FROM public.process_events s
      WHERE s.kind='start' AND s.boot<>$1
        AND NOT EXISTS (SELECT 1 FROM public.process_events e WHERE e.boot=s.boot AND e.kind<>'start')
      ORDER BY s.seq DESC LIMIT $2`,
    [ownBoot, limit],
  );
  return rows.map((row) => ({
    at: iso(row.at)!,
    boot: String(row.boot),
    pid: count(row.pid),
    release: row.release === null ? null : String(row.release),
    node_version: row.node_version === null ? null : String(row.node_version),
    heap_limit_bytes: count(row.heap_limit_bytes),
    last_sample_at: iso(row.last_sample_at),
  }));
}

export interface PruneOptions {
  /** Rows per statement, so a large backlog never holds one long delete. */
  batch?: number;
  /** Statements per table in one pass; the next pass goes on. */
  maxBatches?: number;
}

/**
 * Deletes rows older than `cutoff` in batches. The running process's own events stay whatever their age: its start must
 * still be there when it crashes, or the next start could not tell.
 */
export async function pruneExpired(db: HealthDatabase, cutoff: Date, ownBoot: string, options: PruneOptions = {}): Promise<{ samples: number; events: number }> {
  const batch = options.batch ?? 1000;
  const maxBatches = options.maxBatches ?? 100;
  const drain = async (statement: string, values: unknown[]): Promise<number> => {
    let total = 0;
    for (let round = 0; round < maxBatches; round += 1) {
      const deleted = (await db.query(statement, values)).rowCount ?? 0;
      total += deleted;
      if (deleted < batch) break;
    }
    return total;
  };
  const at = cutoff.toISOString();
  return {
    samples: await drain('DELETE FROM public.resource_samples WHERE seq IN (SELECT seq FROM public.resource_samples WHERE sampled_at<$1 ORDER BY seq LIMIT $2)', [at, batch]),
    events: await drain('DELETE FROM public.process_events WHERE seq IN (SELECT seq FROM public.process_events WHERE at<$1 AND boot IS DISTINCT FROM $2 ORDER BY seq LIMIT $3)', [at, ownBoot, batch]),
  };
}
