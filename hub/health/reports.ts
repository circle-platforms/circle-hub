// Node's diagnostic reports (--report-on-fatalerror, written to <data root>/logs/reports). A start reads the ones it has not
// seen, keeps only the reason, the heap numbers and the resource usage, renames each to <name>.ingested, and keeps a bounded
// number of files. header.dumpEventTime is local time wrongly marked Z (measured on Node 24), so dumpEventTimeStamp is used.
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReportSummary } from './store.ts';

const REPORT_NAME = /^report\.[0-9]{8}\.[0-9]{6}\.[0-9]+\.[0-9]+\.[0-9]+\.json$/;
const INGESTED = '.ingested';
/** About 20 to 50 KB each. */
export const MAX_REPORT_FILES = 20;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const TEXT_LIMIT = 200;

const text = (value: unknown): string | null => (typeof value === 'string' ? [...value].slice(0, TEXT_LIMIT).join('') : null);
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const object = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

/** The file name still says which process wrote it: report.<date>.<time>.<pid>.<thread>.<sequence>.json. */
function unreadable(file: string): ReportSummary {
  return { file, readable: false, event: null, trigger: null, dumped_at: null, pid: Number(file.split('.')[3]), node_version: null, heap: null, resource_usage: null };
}

function dumpedAt(header: Record<string, unknown>): string | null {
  const stamp = Number(header.dumpEventTimeStamp);
  return Number.isFinite(stamp) && stamp > 0 ? new Date(stamp).toISOString() : null;
}

/** The part of a parsed report that is kept. */
export function summarizeReport(file: string, report: unknown): ReportSummary {
  const root = object(report);
  const header = object(root?.header);
  if (root === null || header === null) return unreadable(file);
  const heap = object(root.javascriptHeap);
  const usage = object(root.resourceUsage);
  return {
    file,
    readable: true,
    event: text(header.event),
    trigger: text(header.trigger),
    dumped_at: dumpedAt(header),
    pid: number(header.processId),
    node_version: text(header.nodejsVersion),
    heap: heap === null ? null : { used_bytes: number(heap.usedMemory), total_bytes: number(heap.totalMemory), available_bytes: number(heap.availableMemory), limit_bytes: number(heap.memoryLimit) },
    resource_usage: usage === null ? null : {
      rss_bytes: number(usage.rss),
      max_rss_bytes: number(usage.maxRss),
      user_cpu_seconds: number(usage.userCpuSeconds),
      kernel_cpu_seconds: number(usage.kernelCpuSeconds),
      free_memory_bytes: number(usage.free_memory),
      available_memory_bytes: number(usage.available_memory),
      total_memory_bytes: number(usage.total_memory),
    },
  };
}

async function readReport(directory: string, file: string): Promise<ReportSummary> {
  try {
    const handle = await open(join(directory, file), 'r');
    try {
      if ((await handle.stat()).size > MAX_REPORT_BYTES) return unreadable(file);
      return summarizeReport(file, JSON.parse(await handle.readFile('utf8')));
    } finally {
      await handle.close();
    }
  } catch {
    return unreadable(file);
  }
}

async function byAge(directory: string, names: readonly string[]): Promise<string[]> {
  const stamped = await Promise.all(names.map(async (name) => ({ name, at: (await stat(join(directory, name)).catch(() => null))?.mtimeMs ?? 0 })));
  return stamped.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name)).map(({ name }) => name);
}

export interface NewReports {
  /** Newest first, at most MAX_REPORT_FILES; null when the directory could not be read. */
  reports: ReportSummary[] | null;
  /** Reports past the bound, not read. */
  skipped: string[];
}

export async function readNewReports(directory: string, limit = MAX_REPORT_FILES): Promise<NewReports> {
  let names: string[];
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    names = (await readdir(directory)).filter((name) => REPORT_NAME.test(name));
  } catch {
    return { reports: null, skipped: [] };
  }
  const ordered = await byAge(directory, names);
  return { reports: await Promise.all(ordered.slice(0, limit).map((file) => readReport(directory, file))), skipped: ordered.slice(limit) };
}

/** Marks the files as read and removes all but the newest `keep`. Never throws: a file left behind is read again next start. */
export async function retireReports(directory: string, files: readonly string[], keep = MAX_REPORT_FILES): Promise<void> {
  await Promise.all(files.map((file) => rename(join(directory, file), join(directory, `${file}${INGESTED}`)).catch(() => {})));
  try {
    const kept = (await readdir(directory)).filter((name) => name.endsWith(INGESTED) && REPORT_NAME.test(name.slice(0, -INGESTED.length)));
    const ordered = await byAge(directory, kept);
    await Promise.all(ordered.slice(keep).map((name) => rm(join(directory, name), { force: true }).catch(() => {})));
  } catch {
    // The directory went away; there is nothing to bound.
  }
}
