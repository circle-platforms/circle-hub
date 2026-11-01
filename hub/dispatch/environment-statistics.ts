// Response times already observed by the dispatch journal. No request or new record is made for these statistics.
import { ACTION_RESULT, ActionKindSchema, isActionResult, type ActionResult } from '../../contracts/generated/vocabulary.ts';
import type { Page, RecordStore, StoredRecord } from '../records/api.ts';

export const ENVIRONMENT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ENVIRONMENT_SCAN_LIMIT = 2_000;
const PAGE = 500;
const ORDER_SLACK_MS = 5 * 60 * 1000;
const TIMED_READ_ACTIONS = ActionKindSchema.extract(['read', 'read_back', 'lease']);
const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The explicit send/receive times of an actual exchange, never the journal's default internal-action times. */
export function dispatchCallTiming(value: unknown): { started: number; ended: number; response: boolean; exchange: string } | null {
  const body = object(value), detail = object(body.detail);
  if (body.component !== 'dispatch@1' || typeof detail.phase !== 'string' || typeof detail.started_at !== 'string' || typeof detail.ended_at !== 'string') return null;
  const started = Date.parse(detail.started_at), ended = Date.parse(detail.ended_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null;
  const response = detail.phase.endsWith('.response') && typeof detail.source_record === 'string' && typeof detail.http_status === 'number';
  // read() and precheck also record the same exchange. They cover older histories whose response lacks timing metadata.
  if (!response && (detail.phase.endsWith('.response') || !(TIMED_READ_ACTIONS.safeParse(body.action).success || (body.action === 'validate' && /^precheck\.[1-9][0-9]*$/.test(detail.phase))))) return null;
  const source = Array.isArray(body.inputs) ? body.inputs.find((ref) => typeof ref === 'string' && ref.startsWith('src:')) : undefined;
  if (typeof detail.job !== 'string' || source === undefined) return null;
  return { started, ended, response, exchange: JSON.stringify([detail.job, started, ended, source]) };
}

export interface EnvironmentCalls {
  executor: string;
  since: string;
  until: string;
  calls: number;
  results: Record<ActionResult, number>;
  median_ms: number | null;
  slowest_ms: number | null;
  last_at: string | null;
  partial: boolean;
}

/** Each event's executor index comes from the job binding, the same binding its reservation records. */
export async function readEnvironmentCalls(store: Pick<RecordStore, 'find'>, executors: readonly string[], now: Date, windowMs = ENVIRONMENT_WINDOW_MS, limit = ENVIRONMENT_SCAN_LIMIT): Promise<EnvironmentCalls[]> {
  const until = now.getTime(), since = until - windowMs;
  const out: EnvironmentCalls[] = [];
  for (const executor of executors) {
    const timed: { timing: NonNullable<ReturnType<typeof dispatchCallTiming>>; result: unknown }[] = [];
    let examined = 0, partial = false, cursor: string | null = null;
    scan: for (;;) {
      const page: Page<StoredRecord> = await store.find({ kind: 'action', key: 'dispatch.executor', value: executor, newestFirst: true, limit: PAGE, cursor });
      for (const record of page.items) {
        // A late-written read can follow a newer response. Keep the same out-of-order allowance as readStatistics.
        if (Date.parse(record.created_at) < since - ORDER_SLACK_MS) break scan;
        if (examined >= limit) { partial = true; break scan; }
        examined += 1;
        const timing = dispatchCallTiming(record.body);
        if (timing !== null && timing.started >= since && timing.started <= until && timing.ended <= until) timed.push({ timing, result: object(record.body).result });
      }
      if (page.next === null) break;
      cursor = page.next;
    }
    const responses = new Set(timed.filter((row) => row.timing.response).map((row) => row.timing.exchange));
    const results = Object.fromEntries(ACTION_RESULT.map((result) => [result, 0])) as Record<ActionResult, number>;
    const durations: number[] = [];
    let calls = 0, last: number | null = null;
    for (const { timing, result } of timed) {
      if (!timing.response && responses.has(timing.exchange)) continue;
      calls += 1;
      if (isActionResult(result)) results[result] += 1;
      if (result === 'completed') durations.push(timing.ended - timing.started);
      last = last === null ? timing.started : Math.max(last, timing.started);
    }
    durations.sort((a, b) => a - b);
    const middle = Math.floor(durations.length / 2);
    out.push({ executor, since: new Date(since).toISOString(), until: now.toISOString(), calls, results,
      median_ms: durations.length === 0 ? null : durations.length % 2 ? durations[middle] : Math.round((durations[middle - 1] + durations[middle]) / 2),
      slowest_ms: durations.at(-1) ?? null, last_at: last === null ? null : new Date(last).toISOString(), partial });
  }
  return out;
}
