// Process events. A process records its start after it holds the port, so a second `serve` that fails to bind neither
// judges the running process nor rotates its log. A start with no ending is the previous process going away without a
// clean stop: the in-flight log says what it was running, a crash report why. A clean-stop marker in the log and no stop
// event means only that the database refused the event at that moment; the event is written now.
import type { Recovered, RequestLogHandle } from './inflight.ts';
import { readNewReports, retireReports } from './reports.ts';
import { insertEvent, openStarts, type HealthDatabase, type OpenStart, type ProcessEvent, type ReportSummary, type RequestEntry } from './store.ts';

/** Requests kept on one abnormal-exit event, oldest first: the long-running ones are the likelier cause. */
export const MAX_EVENT_REQUESTS = 200;

export interface ProcessIdentity {
  boot: string;
  pid: number;
  release: string | null;
  nodeVersion: string;
  heapLimitBytes: number;
  startedAt: Date;
}

const elapsed = (from: string, to: string | null): number | null => (to === null ? null : Math.max(0, Date.parse(to) - Date.parse(from)));

function latest(...times: (string | null | undefined)[]): string | null {
  return times.reduce<string | null>((newest, time) => (typeof time === 'string' && time !== '' && (newest === null || time > newest) ? time : newest), null);
}

function capped(requests: RequestEntry[] | null): { requests: RequestEntry[] | null; requests_omitted: number } {
  if (requests === null) return { requests: null, requests_omitted: 0 };
  return { requests: requests.slice(0, MAX_EVENT_REQUESTS), requests_omitted: Math.max(0, requests.length - MAX_EVENT_REQUESTS) };
}

function exitOf(start: OpenStart, recovered: Recovered, reports: ReportSummary[] | null, at: string): ProcessEvent {
  const seen = recovered.processes.get(start.boot);
  const lastSeen = latest(start.last_sample_at, seen?.lastAt, ...(reports ?? []).map((report) => report.dumped_at));
  return {
    at,
    kind: 'abnormal_exit',
    boot: start.boot,
    pid: start.pid,
    release: start.release,
    node_version: start.node_version,
    heap_limit_bytes: start.heap_limit_bytes,
    uptime_ms: elapsed(start.at, lastSeen),
    last_seen_at: lastSeen,
    // A readable log with no line of this process says nothing about it: unknown, not an empty list.
    ...capped(recovered.readable && seen !== undefined ? seen.open : null),
    reports,
  };
}

function belongs(report: ReportSummary, start: OpenStart): boolean {
  return report.pid !== null && report.pid === start.pid && (report.dumped_at === null || report.dumped_at >= start.at);
}

/**
 * Closes every earlier process that has no ending, ingests the crash reports, and returns the abnormal exits written.
 * Reports that match no start are a process that crashed before it recorded one (before it listened): their own event.
 */
export async function recoverEarlierProcesses(db: HealthDatabase, requests: Pick<RequestLogHandle, 'recover' | 'rotate'>, reportsDir: string, identity: ProcessIdentity, now: () => Date): Promise<ProcessEvent[]> {
  const recovered = requests.recover();
  const { reports, skipped } = await readNewReports(reportsDir);
  const unclaimed = new Set(reports ?? []);
  const written: ProcessEvent[] = [];
  const at = now().toISOString();
  for (const start of await openStarts(db, identity.boot)) {
    const seen = recovered.processes.get(start.boot);
    if (seen?.stoppedAt) {
      await insertEvent(db, { ...exitOf(start, recovered, [], seen.stoppedAt), kind: 'stop', uptime_ms: elapsed(start.at, seen.stoppedAt), last_seen_at: null, requests: null, requests_omitted: 0, reports: null });
      continue;
    }
    const own = reports === null ? null : [...unclaimed].filter((report) => belongs(report, start));
    for (const report of own ?? []) unclaimed.delete(report);
    const event = exitOf(start, recovered, own, at);
    if (await insertEvent(db, event)) written.push(event);
  }
  if (unclaimed.size > 0) {
    const orphans = [...unclaimed];
    const [first] = orphans;
    const lastSeen = latest(...orphans.map((report) => report.dumped_at));
    const event: ProcessEvent = { at, kind: 'abnormal_exit', boot: null, pid: first?.pid ?? null, release: null, node_version: first?.node_version ?? null, heap_limit_bytes: first?.heap?.limit_bytes ?? null, uptime_ms: null, last_seen_at: lastSeen, requests: null, requests_omitted: 0, reports: orphans };
    if (await insertEvent(db, event)) written.push(event);
  }
  // Only now: if the database refused anything above, the log and the reports are still there for the next start.
  requests.rotate();
  await retireReports(reportsDir, [...(reports ?? []).map((report) => report.file), ...skipped]);
  return written;
}

function eventOf(identity: ProcessIdentity, kind: 'start' | 'stop', at: string, uptimeMs: number | null): ProcessEvent {
  return { at, kind, boot: identity.boot, pid: identity.pid, release: identity.release, node_version: identity.nodeVersion, heap_limit_bytes: identity.heapLimitBytes, uptime_ms: uptimeMs, last_seen_at: null, requests: null, requests_omitted: 0, reports: null };
}

export async function recordStart(db: HealthDatabase, identity: ProcessIdentity): Promise<void> {
  await insertEvent(db, eventOf(identity, 'start', identity.startedAt.toISOString(), null));
}

export async function recordStop(db: HealthDatabase, identity: ProcessIdentity, at: Date): Promise<void> {
  await insertEvent(db, eventOf(identity, 'stop', at.toISOString(), Math.max(0, at.getTime() - identity.startedAt.getTime())));
}
