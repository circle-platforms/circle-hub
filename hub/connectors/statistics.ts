// What the records hold about the reads of a business system: every read that reached planning wrote its read-manifest@1
// (kind action, index connectors.resource) with its start, end and result. The console shows, per resource, how many reads
// started in a window, how they ended and how long the completed ones took, computed from those records alone; nothing is
// kept for it. A resource with more reads in the window than the scan limit says so: its numbers are then lower bounds.
import { ACTION_RESULT, isActionResult, type ActionResult } from '../../contracts/generated/vocabulary.ts';
import type { Page, RecordStore, StoredRecord } from '../records/api.ts';

export const STATISTICS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Read manifests examined per resource at most. */
export const STATISTICS_SCAN_LIMIT = 2000;
const PAGE = 500;

export interface ReadStatistics {
  resource: string;
  /** The window: reads that started from `since` up to `until`. */
  since: string;
  until: string;
  reads: number;
  /** How the reads ended (the B05 action result of each manifest). */
  results: Record<ActionResult, number>;
  /** Median and longest time from start to end of the completed reads, in milliseconds; null without one. */
  median_ms: number | null;
  slowest_ms: number | null;
  /** When the newest read in the window started. */
  last_at: string | null;
  /** True when the window held more reads than were examined: the numbers are lower bounds. */
  partial: boolean;
}

interface ManifestTimes {
  started_at?: unknown;
  ended_at?: unknown;
  result?: unknown;
}

/** The reads of each resource that started in the `windowMs` before `now`, newest manifests first. */
export async function readStatistics(
  store: Pick<RecordStore, 'find'>,
  resources: readonly string[],
  now: Date,
  windowMs = STATISTICS_WINDOW_MS,
  limit = STATISTICS_SCAN_LIMIT,
): Promise<ReadStatistics[]> {
  const until = now.getTime();
  const since = until - windowMs;
  const out: ReadStatistics[] = [];
  for (const resource of resources) {
    const results = Object.fromEntries(ACTION_RESULT.map((result) => [result, 0])) as Record<ActionResult, number>;
    const durations: number[] = [];
    let reads = 0;
    let examined = 0;
    let last: number | null = null;
    let partial = false;
    let cursor: string | null = null;
    scan: for (;;) {
      const page: Page<StoredRecord<ManifestTimes>> = await store.find<ManifestTimes>({ key: 'connectors.resource', value: resource, kind: 'action', newestFirst: true, limit: PAGE, cursor });
      for (const record of page.items) {
        const started = typeof record.body.started_at === 'string' ? Date.parse(record.body.started_at) : Number.NaN;
        const ended = typeof record.body.ended_at === 'string' ? Date.parse(record.body.ended_at) : Number.NaN;
        // Manifests are written when a read ends, so the newest first are the latest to end: one that ended before the
        // window closes the scan.
        if (Number.isFinite(ended) && ended < since) break scan;
        if (examined >= limit) {
          partial = true;
          break scan;
        }
        examined += 1;
        if (!Number.isFinite(started) || started < since || started > until) continue;
        reads += 1;
        if (isActionResult(record.body.result)) results[record.body.result] += 1;
        if (record.body.result === 'completed' && Number.isFinite(ended) && ended >= started) durations.push(ended - started);
        if (last === null || started > last) last = started;
      }
      if (page.next === null || page.next === undefined) break;
      cursor = page.next;
    }
    durations.sort((a, b) => a - b);
    const median = durations.length === 0 ? null : durations.length % 2 === 1 ? durations[(durations.length - 1) / 2] : Math.round((durations[durations.length / 2 - 1] + durations[durations.length / 2]) / 2);
    out.push({
      resource,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      reads,
      results,
      median_ms: median,
      slowest_ms: durations.length === 0 ? null : durations[durations.length - 1],
      last_at: last === null ? null : new Date(last).toISOString(),
      partial,
    });
  }
  return out;
}
