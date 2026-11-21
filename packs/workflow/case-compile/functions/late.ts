// The late overlay of a run on the client: GET /run-export/<run>/late answers run-late@1, the per-item values the workflow's refresh
// function computed from the latest accepted result of a run bound after the start (W06 R[7]); tools/download-run.ts and
// tools/refresh-late.ts keep it as late.json beside run.json. Every local tool that reads a frozen item's recomposition goes through
// recompositionOf, so it sees the item the Hub's checks see: SubjectItem.late laid over the frozen fields. The checks themselves never
// import this module; they read item.late as the Hub hands it (functions/subject.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallFailure, isRecord } from './text.ts';

export const LATE_SCHEMA = 'run-late@1';
/** The file of the run directory that holds the run-late@1 answer, beside run.json. */
export const LATE_FILE = 'late.json';

export interface LateInput { slot: string; run: string; reference?: string; missing?: string }
export interface RunLate {
  schema: typeof LATE_SCHEMA;
  run: string;
  run_reference?: string;
  resolved_at: string;
  late: { inputs: LateInput[]; refresh: string | null };
  items: Array<{ id: string; late: Record<string, unknown> }>;
}

const RUN = /^run_[a-z0-9]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD = /^rec:[0-9a-f]{64}$/;

/** The run-late@1 answer of `run` read from `value`, or the sentence that says why `value` is not one. */
export function readLate(value: unknown, run?: string): RunLate | string {
  if (!isRecord(value)) return '顶层不是 JSON 对象';
  if (value.schema !== LATE_SCHEMA) return `schema 是 ${JSON.stringify(value.schema) ?? '没有'}，应是 ${LATE_SCHEMA}`;
  if (typeof value.run !== 'string' || !RUN.test(value.run)) return 'run 不是运行编号';
  if (run !== undefined && value.run !== run) return `它是运行 ${value.run} 的，不是运行 ${run} 的`;
  if (value.run_reference !== undefined && (typeof value.run_reference !== 'string' || !RECORD.test(value.run_reference))) return 'run_reference 不是 rec: 引用';
  if (typeof value.resolved_at !== 'string' || !value.resolved_at) return '缺 resolved_at';
  const late = value.late;
  if (!isRecord(late) || !Array.isArray(late.inputs) || !(late.refresh === null || (typeof late.refresh === 'string' && SHA256.test(late.refresh)))) return 'late 不是 {inputs, refresh}';
  const inputs: LateInput[] = [];
  for (const [index, row] of late.inputs.entries()) {
    if (!isRecord(row) || typeof row.slot !== 'string' || !row.slot || typeof row.run !== 'string' || !RUN.test(row.run)) return `late.inputs[${index}] 不是 {slot, run}`;
    if (row.reference !== undefined && (typeof row.reference !== 'string' || !RECORD.test(row.reference))) return `late.inputs[${index}].reference 不是不带片段的 rec: 引用`;
    if (row.missing !== undefined && (typeof row.missing !== 'string' || !/\S/.test(row.missing))) return `late.inputs[${index}].missing 是空的`;
    inputs.push({ slot: row.slot, run: row.run, ...(row.reference !== undefined ? { reference: row.reference as string } : {}), ...(row.missing !== undefined ? { missing: row.missing as string } : {}) });
  }
  if (!Array.isArray(value.items)) return '缺 items';
  const items: RunLate['items'] = [], seen = new Set<string>();
  for (const [index, row] of value.items.entries()) {
    if (!isRecord(row) || typeof row.id !== 'string' || !row.id || !isRecord(row.late)) return `items[${index}] 不是 {id, late}`;
    if (seen.has(row.id)) return `items 里条目 ${row.id} 出现了两次`;
    seen.add(row.id);
    items.push({ id: row.id, late: row.late });
  }
  return { schema: LATE_SCHEMA, run: value.run, ...(value.run_reference !== undefined ? { run_reference: value.run_reference as string } : {}), resolved_at: value.resolved_at, late: { inputs, refresh: late.refresh as string | null }, items };
}

/**
 * The late.json of a run directory, or null when there is none (the run binds nothing after its start, or it was downloaded
 * before the Hub answered the route). A file that is there but is no run-late@1 answer of `run` is refused, never ignored: the
 * local check would then judge a different item than the Hub.
 */
export function readLateFile(directory: string, run?: string): RunLate | null {
  let text: string;
  try { text = readFileSync(join(directory, LATE_FILE), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new CallFailure('invalid_parameters', `运行目录里的 ${LATE_FILE} 不是完整的 JSON`, '用 refresh-late.ts 重新取这个运行的晚绑定结果（它会覆盖写 late.json），不手改这个文件'); }
  const read = readLate(value, run);
  if (typeof read === 'string') throw new CallFailure('invalid_parameters', `运行目录里的 ${LATE_FILE} 不是${run === undefined ? '' : `运行 ${run} 的`} ${LATE_SCHEMA} 答复：${read}`, '用 refresh-late.ts 重新取这个运行的晚绑定结果（它会覆盖写 late.json），不手改这个文件');
  return read;
}

/** The overlay the late answer holds for one item, or undefined. */
export function overlayOf(late: RunLate | null | undefined, item: string): Record<string, unknown> | undefined {
  return late?.items.find((row) => row.id === item)?.late;
}

/** The item with its late overlay attached as `late`, as the Hub hands it to a subject builder (SubjectItem.late); unchanged without one. */
export function withLate<T>(item: T, late: RunLate | null | undefined): T {
  if (!isRecord(item) || typeof item.id !== 'string' || isRecord(item.late)) return item;
  const overlay = overlayOf(late, item.id);
  return overlay === undefined ? item : { ...item, late: overlay } as T;
}

/**
 * The recomposition proof a frozen item has for this evaluation: the late overlay's when the item carries one (item.late, or the
 * entry of `late` for its id), else the frozen field. Same rule as the plan subject: late.recomposition ?? fields.recomposition.
 */
export function recompositionOf(item: unknown, late?: RunLate | null): Record<string, unknown> | undefined {
  if (!isRecord(item)) return undefined;
  const overlay = isRecord(item.late) ? item.late : typeof item.id === 'string' ? overlayOf(late, item.id) : undefined;
  const fields = isRecord(item.fields) ? item.fields : {};
  const value = overlay?.recomposition ?? fields.recomposition;
  return isRecord(value) ? value : undefined;
}

/** The recomposition record itself (`recompositionOf(...).record`), or undefined. */
export function recompositionRecordOf(item: unknown, late?: RunLate | null): Record<string, unknown> | undefined {
  const proof = recompositionOf(item, late);
  return proof !== undefined && isRecord(proof.record) ? proof.record : undefined;
}
