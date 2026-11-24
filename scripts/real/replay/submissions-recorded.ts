import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { digestOf } from '../../../hub/records/api.ts';

export type RecordedKind = 'run' | 'submission' | 'validation_result' | 'result_summary';

const KINDS: readonly string[] = ['run', 'submission', 'validation_result', 'result_summary'];

export interface RecordedEntry {
  seq: number;
  kind: RecordedKind;
  run: string;
  pack: string;
  at: string;
  bytes: number;
  sha256: string;
  file: string;
}

export interface ValidationTask {
  seq: number;
  run: string;
  pack: string;
  at: string;
  file: string;
  sha256: string;
  entry: RecordedEntry;
  judged: string;
  submission: { seq: number; file: string; digest: string; entry: RecordedEntry } | null;
  ordinal: number;
}

export interface RecordedExport {
  dir: string;
  entries: RecordedEntry[];
  runs: Map<string, RecordedEntry>;
  tasks: ValidationTask[];
  unvalidated: RecordedEntry[];
  problems: string[];
  read(entry: Pick<RecordedEntry, 'file' | 'bytes' | 'sha256'>): Promise<unknown>;
}

export class ExportError extends Error {
  readonly code: 'index' | 'missing' | 'integrity';
  constructor(code: 'index' | 'missing' | 'integrity', message: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

export function parseIndex(text: string): RecordedEntry[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new ExportError('index', 'index.tsv 是空的');
  const header = lines[0].split('\t');
  const expected = ['seq', 'kind', 'run', 'pack', 'at', 'bytes', 'sha256'];
  if (expected.some((name, i) => header[i] !== name)) throw new ExportError('index', `index.tsv 的表头应为 ${expected.join('\\t')}`);
  return lines.slice(1).map((line, at) => {
    const cells = line.split('\t');
    if (cells.length !== 7) throw new ExportError('index', `index.tsv 第 ${at + 2} 行不是 7 列`);
    const [seq, kind, run, pack, time, bytes, sha256] = cells;
    if (!KINDS.includes(kind)) throw new ExportError('index', `index.tsv 第 ${at + 2} 行的种类 ${kind} 不认识`);
    if (!/^[0-9]+$/.test(seq) || !/^[0-9]+$/.test(bytes) || !/^[0-9a-f]{64}$/.test(sha256)) throw new ExportError('index', `index.tsv 第 ${at + 2} 行的序号、字节数或摘要格式不对`);
    return { seq: Number(seq), kind: kind as RecordedKind, run, pack, at: time, bytes: Number(bytes), sha256, file: join(run, `${seq}-${kind}.json`) };
  });
}

async function readChecked(dir: string, entry: Pick<RecordedEntry, 'file' | 'bytes' | 'sha256'>): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, entry.file));
  } catch {
    throw new ExportError('missing', `导出文件 ${entry.file} 读不出来`);
  }
  if (bytes.length !== entry.bytes) throw new ExportError('integrity', `导出文件 ${entry.file} 的大小 ${bytes.length} 与 index.tsv 的 ${entry.bytes} 不符`);
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new ExportError('integrity', `导出文件 ${entry.file} 的 SHA-256 与 index.tsv 不符`);
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new ExportError('integrity', `导出文件 ${entry.file} 不是 JSON`);
  }
}

export async function readRecordedExport(dir: string): Promise<RecordedExport> {
  let text: string;
  try {
    text = await readFile(join(dir, 'index.tsv'), 'utf8');
  } catch {
    throw new ExportError('missing', `导出目录 ${dir} 里没有 index.tsv`);
  }
  const entries = parseIndex(text).sort((a, b) => a.seq - b.seq);
  const problems: string[] = [];
  const runs = new Map<string, RecordedEntry>();
  for (const entry of entries) if (entry.kind === 'run') runs.set(entry.run, entry);
  const read = (entry: Pick<RecordedEntry, 'file' | 'bytes' | 'sha256'>) => readChecked(dir, entry);
  const digests = new Map<string, { seq: number; file: string; digest: string; entry: RecordedEntry }>();
  for (const entry of entries.filter((e) => e.kind === 'submission')) {
    try {
      const digest = digestOf(await read(entry));
      digests.set(`${entry.run}\0${digest}`, { seq: entry.seq, file: entry.file, digest, entry });
    } catch (error) {
      problems.push(`提交 ${entry.file}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const named = new Set<string>();
  const ordinals = new Map<string, number>();
  const tasks: ValidationTask[] = [];
  for (const entry of entries.filter((e) => e.kind === 'validation_result')) {
    let judged = '';
    try {
      const body = (await read(entry)) as { submission?: unknown };
      judged = typeof body.submission === 'string' ? body.submission : '';
    } catch (error) {
      problems.push(`核对结果 ${entry.file}：${error instanceof Error ? error.message : String(error)}`);
    }
    const key = `${entry.run}\0${judged}`;
    const submission = digests.get(key) ?? null;
    if (submission !== null) named.add(key);
    const ordinal = submission === null ? 0 : (ordinals.get(key) ?? 0) + 1;
    if (submission !== null) ordinals.set(key, ordinal);
    tasks.push({ seq: entry.seq, run: entry.run, pack: entry.pack, at: entry.at, file: entry.file, sha256: entry.sha256, entry, judged, submission, ordinal });
  }
  const unvalidated = entries.filter((e) => e.kind === 'submission' && ![...named].some((key) => digests.get(key)?.seq === e.seq));
  return { dir, entries, runs, tasks, unvalidated, problems, read };
}
