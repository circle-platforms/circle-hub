// What administrators read: the resource samples of a window and the process events. No console page yet (decision 146,
// step 3); `circle-hub health` and `circle-hub crashes` use this reader, and a page will too.
import type { Principal } from '../records/api.ts';
import { NUMERIC_FIELDS, type HealthDatabase, type NumericField, type ProcessEvent, type ProcessEventKind, type ReportSummary, type RequestEntry } from './store.ts';

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

export interface HealthReader {
  summary(by: Principal, input: { since: Date }): Promise<HealthSummary>;
  /** Newest first. */
  events(by: Principal, input: { limit: number }): Promise<ProcessEvent[]>;
}

const number = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const time = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(value as string | Date).toISOString());

function requireAdmin(by: Principal): void {
  if (by.role !== 'admin') throw new HealthAccessError();
}

const RANGE = NUMERIC_FIELDS.map((field) => `min(${field}) AS min_${field},max(${field}) AS max_${field}`).join(',');

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
      const { rows } = await db.query('SELECT at,kind,boot,pid,release,node_version,heap_limit_bytes,uptime_ms,last_seen_at,requests,requests_omitted,reports FROM public.process_events ORDER BY seq DESC LIMIT $1', [limit]);
      return rows.map((row) => ({
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
  };
}

/** `--since`: a span back from now (`30m`, `6h`, `7d`) or a time; null when it is neither. */
export function parseSince(text: string, now: Date): Date | null {
  const span = /^([1-9][0-9]{0,4})(m|h|d)$/.exec(text);
  if (span !== null) return new Date(now.getTime() - Number(span[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2] as 'm' | 'h' | 'd']);
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time);
}
