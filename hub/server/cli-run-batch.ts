// `circle-hub run batch` (issue 32, decision 156): an administrator starts runs of a workflow for the external objects a
// file lists, as the runner: one run per object, or one per group of objects where the slot takes many. It is for workflows whose requirements are all facts, where start_run computes the result
// itself and no model is asked: a workflow that waits for a submission is refused before anything starts, since a batch of
// it would only leave runs waiting. The Hub generates nothing here; each run is an ordinary start_run under the
// administrator's account, bounded in parallel and in rate, and the failures are summed up at the end.
import type { Principal } from '../records/api.ts';
import type { RunsService } from '../ports.ts';
import { newTraceId } from './trace.ts';

export const RUN_BATCH_USAGE = 'run batch --pack <工作流> --slot <输入槽> --from <文件> [--product <产品>] [--version <版本线>] [--per-run <每次运行的对象数>] [--concurrency <1–8>] [--interval-ms <毫秒>] [--failed-out <文件>] [--json]';
export const BATCH_MAX_OBJECTS = 5000, BATCH_MAX_CONCURRENCY = 8, BATCH_DEFAULT_CONCURRENCY = 2, BATCH_MAX_INTERVAL_MS = 60_000, BATCH_MAX_PER_RUN = 100;

export interface BatchPlan {
  pack: string;
  slot: string;
  product?: string;
  version?: string;
  objects: readonly string[];
  /** How many objects one run binds to the slot: 1, or more for a slot that takes many. */
  perRun: number;
  concurrency: number;
  intervalMs: number;
}
export interface BatchRow {
  /** The objects this run was started for, in the order of the file. */
  objects: string[];
  /** The run the Hub started, when it started one. */
  run?: string;
  /** Reference of the result the Hub computed at start. */
  result?: string;
  /** Protocol codes of a start that was refused, or `error` for a failure outside the protocol. */
  codes?: string[];
  message?: string;
  ms: number;
}
export interface BatchSummary {
  /** Objects, and the runs they were grouped into. */
  objects: number;
  total: number;
  started: number;
  failed: number;
  /** Failures by code, most frequent first. */
  by_code: Array<{ code: string; count: number }>;
  elapsed_ms: number;
  /** Wall-clock time per object at this concurrency and rate, and what a hundred objects would take at it. */
  per_object_ms: number;
  hundred_ms: number;
  rows: BatchRow[];
}

/** One external object id per line; blank lines and lines starting with # are skipped; a repeated id is started once. */
export function objectsOf(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const id = line.trim();
    if (id && !id.startsWith('#')) seen.add(id);
  }
  return [...seen];
}

type Start = RunsService['startRun'];
export interface BatchHooks {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRow?: (row: BatchRow, done: number) => void;
}

/**
 * Starts the runs: at most `concurrency` at a time, and no two starts closer than `intervalMs`. A start that throws is that
 * object's failure, never the batch's: the others go on, and the summary counts it.
 */
export async function startBatch(start: Start, by: Principal, plan: BatchPlan, hooks: BatchHooks = {}): Promise<BatchSummary> {
  const now = hooks.now ?? (() => performance.now());
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const began = now();
  const groups: string[][] = [];
  for (let at = 0; at < plan.objects.length; at += plan.perRun) groups.push(plan.objects.slice(at, at + plan.perRun));
  const rows: BatchRow[] = new Array(groups.length);
  let next = 0, done = 0, gate = Promise.resolve(), last = -Infinity;
  // One start leaves the gate at a time, each no sooner than the interval after the one before it.
  const turn = () => {
    const mine = gate.then(async () => { const wait = last + plan.intervalMs - now(); if (wait > 0) await sleep(wait); last = now(); });
    gate = mine.catch(() => {});
    return mine;
  };
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= groups.length) return;
      const objects = groups[index];
      await turn();
      const at = now();
      let row: BatchRow;
      try {
        const answer = await start(by, {
          pack: plan.pack,
          ...(plan.product === undefined ? {} : { product: plan.product }),
          ...(plan.version === undefined ? {} : { version: plan.version }),
          inputs: { [plan.slot]: plan.perRun === 1 ? { external: objects[0] } : objects.map((external) => ({ external })) },
        }, { traceId: newTraceId(), sessionId: null });
        row = answer.call_result === 'ok' && answer.run
          ? { objects, run: answer.run.run, ...(answer.result ? { result: answer.result.reference } : {}), ms: now() - at }
          : { objects, codes: [...new Set(answer.errors.map((error) => String(error.code)))], message: answer.errors[0]?.message ?? '没有开始运行', ms: now() - at };
      } catch (error) {
        row = { objects, codes: ['error'], message: error instanceof Error ? error.message : String(error), ms: now() - at };
      }
      rows[index] = row;
      hooks.onRow?.(row, ++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(plan.concurrency, groups.length) }, worker));
  const elapsed = now() - began;
  const failed = rows.filter((row) => row.run === undefined);
  const counts = new Map<string, number>();
  for (const row of failed) for (const code of row.codes ?? ['error']) counts.set(code, (counts.get(code) ?? 0) + 1);
  const perObject = plan.objects.length ? elapsed / plan.objects.length : 0;
  return {
    objects: plan.objects.length,
    total: rows.length,
    started: rows.length - failed.length,
    failed: failed.length,
    by_code: [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    elapsed_ms: Math.round(elapsed),
    per_object_ms: Math.round(perObject),
    hundred_ms: Math.round(perObject * 100),
    rows,
  };
}

/** A whole number of an option within its bounds, or the default when the option is absent. */
export function boundedOption(name: string, value: string | undefined, fallback: number, min: number, max: number, fail: (message: string) => Error): number {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || Number(value) < min || Number(value) > max) throw fail(`${name} 要 ${min} 到 ${max} 的整数`);
  return Number(value);
}

/** A run's objects in one line: the one object, or the first with how many there are. */
export const labelOfRow = (row: Pick<BatchRow, 'objects'>) => row.objects.length === 1 ? row.objects[0] : `${row.objects[0]} 等 ${row.objects.length} 个`;
const seconds = (ms: number) => ms < 1000 ? `${ms} 毫秒` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} 秒` : `${(ms / 60_000).toFixed(1)} 分钟`;

/** The summary as lines for a terminal. Object ids and messages come from files and systems: the caller makes each line safe. */
export function batchLines(summary: BatchSummary, plan: Pick<BatchPlan, 'concurrency' | 'intervalMs' | 'perRun'>): string[] {
  const lines = [
    `共 ${summary.objects} 个对象、${summary.total} 次运行：开始并得到结果 ${summary.rows.filter((row) => row.result !== undefined).length} 次，开始但没有结果 ${summary.rows.filter((row) => row.run !== undefined && row.result === undefined).length} 次，没有开始 ${summary.failed} 次`,
    `用时 ${seconds(summary.elapsed_ms)}，平均每个对象 ${seconds(summary.per_object_ms)}（每次运行 ${plan.perRun} 个，并发 ${plan.concurrency}，间隔 ${plan.intervalMs} 毫秒）；按这个速度 100 个对象约 ${seconds(summary.hundred_ms)}`,
  ];
  if (summary.by_code.length) lines.push(`没有开始的原因：${summary.by_code.map((row) => `${row.code} ${row.count} 次`).join('，')}`);
  for (const row of summary.rows.filter((row) => row.run === undefined)) lines.push(`- 没有开始 ${labelOfRow(row)}：${(row.codes ?? []).join('、')} ${row.message ?? ''}`.trimEnd());
  return lines;
}
