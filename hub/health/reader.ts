// What administrators read: the resource samples of a window and the process events. `circle-hub health`, `circle-hub crashes`
// and the console's 运行状况 page (decision 146, step 3) use this reader. Every read is bounded by a time window or a row limit
// and aggregates in SQL: what comes back does not grow with the age of the deployment.
import type { Principal } from '../records/api.ts';
import { NUMERIC_FIELDS, type HealthDatabase, type NumericField, type ProcessEventKind, type ReportSummary, type RequestEntry, type StoredProcessEvent } from './store.ts';

/** Rows `current` may look back: a reading that runs once a minute is in them, a value older than that is not current. */
const CURRENT_ROWS = 12;
export const DEFAULT_SINCE_MS = 3_600_000;
export const DEFAULT_EVENT_LIMIT = 20;
export const MAX_EVENT_LIMIT = 500;

export class HealthAccessError extends Error {
  constructor() {
    super('只有管理员可以读运行状况');
    this.name = 'HealthAccessError';
  }
}

export interface FieldSummary {
  current: number | null;
  min: number | null;
  max: number | null;
}

export interface HealthSummary {
  since: string;
  samples: number;
  /** Time of the newest sample of the window; null without one. */
  latest: string | null;
  fields: Record<NumericField, FieldSummary>;
  /** Of the newest sample; null when it has none. */
  mcp_sessions_by_client: Record<string, number> | null;
  /** How many samples of the window each reading failed in. */
  failed_reads: Record<string, number>;
  /** Samples of the window's processes that could not be written. */
  dropped_samples: number;
}

/**
 * The most an interval held, one point of a curve, so that a spike is not averaged away. Free disk is the least, for the same
 * reason. Null is a reading nobody has for the interval, which is not 0.
 */
export interface CurvePoint {
  /** Start of the interval. */
  at: string;
  /** Its newest sample; null without one. */
  last_at: string | null;
  /** Samples in the interval; 0 when there are none. */
  samples: number;
  /** Those with a reading that failed. */
  failed: number;
  /** Earlier samples these report as not written. */
  dropped: number;
  event_loop_delay_max_ms: number | null;
  heap_used_bytes: number | null;
  gc_pause_ms: number | null;
  sandbox_running: number | null;
  sandbox_waiting: number | null;
  /** Connections out of the pool: open less idle. */
  pool_in_use: number | null;
  pool_waiting: number | null;
  pg_active_connections: number | null;
  pg_waiting_locks: number | null;
  data_free_bytes: number | null;
  requests_in_flight: number | null;
}

export interface CurveQuery {
  from: Date;
  to: Date;
  /** Points of the curve, whatever the table holds. */
  points: number;
  /** Only this process's samples. */
  boot?: string;
}

/**
 * One run of a release as the process events know it, which is what a deploy starts: a deploy of an older commit brings an
 * earlier release back under its own id, and that is a run of its own. A restart goes on with the run it is in. A process counts
 * by whatever is left of it: retention takes the start of one that outlived it, and a start can be refused.
 */
export interface ReleaseRun {
  release: string;
  /** When the first process of the run the events still hold began: its start, or what its ending says; failing both, that ending. */
  first_start: string;
  /** Its latest event of any kind. */
  last_event: string;
}

export interface HealthReader {
  summary(by: Principal, input: { since: Date }): Promise<HealthSummary>;
  /** Newest first. */
  events(by: Principal, input: { limit: number }): Promise<StoredProcessEvent[]>;
  /** How many events there are, counted up to `limit`: a crash loop must not make the count itself long. */
  eventCount(by: Principal, input: { limit: number }): Promise<number>;
  /** Exactly `points` points, oldest first. */
  curve(by: Principal, input: CurveQuery): Promise<CurvePoint[]>;
  /** The newest run first, from the latest `events` events; `total` is how many runs those hold. */
  releases(by: Principal, input: { limit: number; events: number }): Promise<{ rows: ReleaseRun[]; total: number }>;
}

const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const time = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());

function requireAdmin(by: Principal): void {
  if (by.role !== 'admin') throw new HealthAccessError();
}

const RANGE = NUMERIC_FIELDS.map((field) => `min(${field}) AS min_${field},max(${field}) AS max_${field}`).join(',');

const CURVE_COLUMNS = ['event_loop_delay_max_ms', 'heap_used_bytes', 'gc_pause_ms', 'sandbox_running', 'sandbox_waiting', 'pool_in_use', 'pool_waiting', 'pg_active_connections', 'pg_waiting_locks', 'data_free_bytes', 'requests_in_flight'] as const;
const CURVE_SQL = `max(event_loop_delay_max_ms) AS event_loop_delay_max_ms,max(heap_used_bytes) AS heap_used_bytes,max(gc_pause_ms) AS gc_pause_ms,max(sandbox_running) AS sandbox_running,max(sandbox_waiting) AS sandbox_waiting,max(pool_total-pool_idle) AS pool_in_use,max(pool_waiting) AS pool_waiting,max(pg_active_connections) AS pg_active_connections,max(pg_waiting_locks) AS pg_waiting_locks,min(data_free_bytes) AS data_free_bytes,max(requests_in_flight) AS requests_in_flight`;
const emptyPoint = (at: string): CurvePoint => ({ at, last_at: null, samples: 0, failed: 0, dropped: 0, ...Object.fromEntries(CURVE_COLUMNS.map((column) => [column, null])) }) as CurvePoint;

export function healthReader(db: HealthDatabase): HealthReader {
  return {
    async summary(by, { since }) {
      requireAdmin(by);
      const at = since.toISOString();
      const range = (await db.query(`SELECT count(*)::int AS samples,max(sampled_at) AS latest,coalesce(sum(dropped_samples),0)::int AS dropped,${RANGE} FROM public.resource_samples WHERE sampled_at>=$1`, [at])).rows[0]!;
      const recent = (await db.query(`SELECT ${NUMERIC_FIELDS.join(',')},mcp_sessions_by_client FROM public.resource_samples WHERE sampled_at>=$1 ORDER BY sampled_at DESC,seq DESC LIMIT ${CURRENT_ROWS}`, [at])).rows;
      const failures = (await db.query<{ name: string; n: number }>('SELECT f AS name,count(*)::int AS n FROM public.resource_samples s CROSS JOIN LATERAL pg_catalog.unnest(s.failed_reads) AS f WHERE s.sampled_at>=$1 GROUP BY f ORDER BY f', [at])).rows;
      const fields = Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, {
        current: number(recent.find((row) => row[field] !== null)?.[field]),
        min: number(range[`min_${field}`]),
        max: number(range[`max_${field}`]),
      }])) as Record<NumericField, FieldSummary>;
      return {
        since: at,
        samples: Number(range.samples),
        latest: time(range.latest),
        fields,
        mcp_sessions_by_client: (recent[0]?.mcp_sessions_by_client as Record<string, number> | null | undefined) ?? null,
        failed_reads: Object.fromEntries(failures.map(({ name, n }) => [name, n])),
        dropped_samples: Number(range.dropped),
      };
    },

    async events(by, { limit }) {
      requireAdmin(by);
      const { rows } = await db.query('SELECT seq,at,kind,boot,pid,release,node_version,heap_limit_bytes,uptime_ms,last_seen_at,requests,requests_omitted,reports FROM public.process_events ORDER BY seq DESC LIMIT $1', [limit]);
      return rows.map((row) => ({
        seq: Number(row.seq),
        at: time(row.at)!,
        kind: row.kind as ProcessEventKind,
        boot: row.boot as string | null,
        pid: number(row.pid),
        release: row.release as string | null,
        node_version: row.node_version as string | null,
        heap_limit_bytes: number(row.heap_limit_bytes),
        uptime_ms: number(row.uptime_ms),
        last_seen_at: time(row.last_seen_at),
        requests: row.requests as RequestEntry[] | null,
        requests_omitted: Number(row.requests_omitted),
        reports: row.reports as ReportSummary[] | null,
      }));
    },

    async eventCount(by, { limit }) {
      requireAdmin(by);
      const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM (SELECT 1 FROM public.process_events LIMIT $1) e', [limit]);
      return rows[0]!.n;
    },

    async curve(by, { from, to, points, boot }) {
      requireAdmin(by);
      const start = from.getTime();
      const width = (to.getTime() - start) / points;
      const values: unknown[] = [from.toISOString(), to.toISOString(), width, points];
      if (boot !== undefined) values.push(boot);
      const { rows } = await db.query(
        `SELECT pg_catalog.floor(EXTRACT(EPOCH FROM sampled_at-$1::pg_catalog.timestamptz)*1000/$3::pg_catalog.float8)::pg_catalog.int4 AS slot,max(sampled_at) AS last_at,count(*)::pg_catalog.int4 AS samples,
                count(*) FILTER (WHERE pg_catalog.cardinality(failed_reads)>0)::pg_catalog.int4 AS failed,coalesce(sum(dropped_samples),0)::pg_catalog.int4 AS dropped,${CURVE_SQL}
           FROM public.resource_samples WHERE sampled_at>=$1 AND sampled_at<$2${boot === undefined ? '' : ' AND boot=$5'}
          GROUP BY slot ORDER BY slot LIMIT $4`,
        values,
      );
      const curve = Array.from({ length: points }, (_, slot) => emptyPoint(new Date(start + slot * width).toISOString()));
      for (const row of rows) {
        const point = curve[Number(row.slot)];
        if (point === undefined) continue;
        point.last_at = time(row.last_at);
        point.samples = Number(row.samples);
        point.failed = Number(row.failed);
        point.dropped = Number(row.dropped);
        for (const column of CURVE_COLUMNS) point[column] = number(row[column]);
      }
      return curve;
    },

    async releases(by, { limit, events }) {
      requireAdmin(by);
      const { rows } = await db.query(
        `WITH e AS (SELECT boot,release,at,kind,uptime_ms,last_seen_at FROM public.process_events WHERE release IS NOT NULL ORDER BY seq DESC LIMIT $2),
              p AS (SELECT release,coalesce(min(at) FILTER (WHERE kind='start'),min(coalesce(last_seen_at,at)-uptime_ms*interval '1 millisecond'),min(at)) AS began,max(at) AS last_event FROM e GROUP BY boot,release),
              g AS (SELECT *,row_number() OVER (ORDER BY began)-row_number() OVER (PARTITION BY release ORDER BY began) AS run FROM p)
         SELECT release,min(began) AS first_start,max(last_event) AS last_event,count(*) OVER () AS total
           FROM g GROUP BY release,run ORDER BY first_start DESC LIMIT $1`,
        [limit, events],
      );
      return { rows: rows.map((row) => ({ release: String(row.release), first_start: time(row.first_start)!, last_event: time(row.last_event)! })), total: rows.length === 0 ? 0 : Number(rows[0]!.total) };
    },
  };
}

/** `--since`: a span back from now (`30m`, `6h`, `7d`) or a time; null when it is neither. */
export function parseSince(text: string, now: Date): Date | null {
  const span = /^([1-9][0-9]{0,4})(m|h|d)$/.exec(text);
  if (span !== null) return new Date(now.getTime() - Number(span[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as 'm' | 'h' | 'd']);
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time);
}
