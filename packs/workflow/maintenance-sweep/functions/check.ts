// Pack checks. command_exists: a case on a removed path is a blocking refutation. command_unchanged: a case on a
// modified path whose definition data differ is an advisory refutation. A well-formed item can carry both. Nothing is
// claimed about cases the index does not hold: when the subject carries the projection note, command_exists adds that
// unknown (and, when the view was truncated, an integrity unknown). Samples omit the note, so their polarity stays
// the verdict of the item.

import { groundsOf } from './sweep.ts';
import { FIX, PACK, clip, guarded, isRecord } from './text.ts';

const REMOVED = `${PACK}.case.command_removed`;
const CHANGED = `${PACK}.case.command_changed`;

interface ParsedField {
  path: string;
  before: unknown;
  after: unknown;
  absent?: 'before' | 'after';
}

interface ParsedReason {
  code: string;
  path: string;
  change: 'added' | 'removed' | 'modified';
  references: string[];
  case: { entry: string; reference: string };
}

interface Outcome {
  verdict: 'support' | 'refute' | 'unknown';
  code?: string;
  statement: string;
  grounds: string[];
  tier: 'blocking' | 'advisory';
  reason?: 'missing_input' | 'integrity_unproven' | 'check_error';
  item?: string;
  data?: { [key: string]: unknown };
}

interface Item {
  id: string;
  fields: { [key: string]: unknown };
}

function itemsOf(subject: unknown): Item[] {
  const raw = isRecord(subject) ? subject : {};
  return (Array.isArray(raw.items) ? raw.items : [])
    .filter(isRecord)
    .map((item) => ({ id: typeof item.id === 'string' ? item.id : '', fields: isRecord(item.fields) ? item.fields : {} }))
    .filter((item) => item.id !== '')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function noteOf(subject: unknown): { [key: string]: unknown } | null {
  const raw = isRecord(subject) ? subject : {};
  return isRecord(raw.note) ? raw.note : null;
}

function fieldsOf(value: unknown): ParsedField[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: ParsedField[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || !Object.hasOwn(raw, 'before') || !Object.hasOwn(raw, 'after')) return null;
    const row: ParsedField = { path: raw.path, before: raw.before, after: raw.after };
    if (raw.absent === 'before' || raw.absent === 'after') row.absent = raw.absent;
    out.push(row);
  }
  return out;
}

function reasonsOf(item: Item): ParsedReason[] | null {
  const value = item.fields.reasons;
  if (!Array.isArray(value)) return null;
  const out: ParsedReason[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || (raw.change !== 'added' && raw.change !== 'modified' && raw.change !== 'removed')) return null;
    const caseRef = isRecord(raw.case) && typeof raw.case.reference === 'string' && typeof raw.case.entry === 'string' ? { entry: raw.case.entry, reference: raw.case.reference } : null;
    if (caseRef === null) return null;
    if (!Array.isArray(raw.references) || raw.references.some((r) => typeof r !== 'string')) return null;
    out.push({ code: typeof raw.code === 'string' ? raw.code : '', path: raw.path, change: raw.change, references: raw.references as string[], case: caseRef });
  }
  return out;
}

function removed(reason: ParsedReason): boolean {
  return reason.change === 'removed' || reason.code === REMOVED;
}

/** The per-path field differences from the note's details, by path (written once per path; items never repeat them). */
function detailFieldsOf(note: unknown): Map<string, ParsedField[]> {
  const raw = isRecord(note) ? note : {};
  const out = new Map<string, ParsedField[]>();
  if (!Array.isArray(raw.details)) return out;
  for (const row of raw.details) {
    if (!isRecord(row) || typeof row.path !== 'string') continue;
    const fields = fieldsOf(row.fields);
    if (fields !== null) out.set(row.path, fields);
  }
  return out;
}

function changed(reason: ParsedReason, fieldsOfPath: Map<string, ParsedField[]>): boolean {
  return reason.code === CHANGED || (reason.change === 'modified' && (fieldsOfPath.get(reason.path)?.length ?? 0) > 0);
}

function flatFields(reasons: readonly ParsedReason[], fieldsOfPath: Map<string, ParsedField[]>): Array<{ command: string; path: string; before: unknown; after: unknown; absent?: 'before' | 'after' }> {
  const out: Array<{ command: string; path: string; before: unknown; after: unknown; absent?: 'before' | 'after' }> = [];
  for (const reason of reasons) {
    for (const field of fieldsOfPath.get(reason.path) ?? []) {
      const row: { command: string; path: string; before: unknown; after: unknown; absent?: 'before' | 'after' } = { command: reason.path, path: field.path, before: field.before, after: field.after };
      if (field.absent !== undefined) row.absent = field.absent;
      out.push(row);
    }
  }
  return out;
}

function commandExists(subject: unknown): Outcome[] {
  const out: Outcome[] = [];
  for (const item of itemsOf(subject)) {
    const reasons = reasonsOf(item);
    const title = typeof item.fields.title === 'string' ? item.fields.title : item.id;
    if (reasons === null) {
      out.push({ verdict: 'unknown', reason: 'check_error', statement: `用例 ${item.id} 没有可读的维护原因`, grounds: [], tier: 'blocking', item: item.id });
      continue;
    }
    const gone = reasons.filter(removed);
    if (gone.length > 0) {
      const paths = gone.map((reason) => reason.path).join('、');
      out.push({
        verdict: 'refute',
        code: REMOVED,
        statement: `用例 ${item.id}（${title}）所在的命令已删除（${paths}）。${FIX}`,
        grounds: groundsOf(reasons),
        tier: 'blocking',
        item: item.id,
        data: { fix: FIX, paths: gone.map((reason) => reason.path), reasons },
      });
      continue;
    }
    out.push({
      verdict: 'support',
      statement: `用例 ${item.id} 所在的命令仍在。`,
      grounds: groundsOf(reasons),
      tier: 'blocking',
      item: item.id,
      data: { reasons },
    });
  }
  const note = noteOf(subject);
  if (note !== null) {
    const skipped = typeof note.skipped_from === 'number' && note.skipped_from > 0 ? note.skipped_from : 0;
    const base = '索引没有收录的用例，这里不作结论。';
    const statement = skipped > 0 ? `较早构建的索引缺少 ${skipped} 份列出的文档，没有维护项并不能证明没有过期的用例。${base}` : base;
    out.push({ verdict: 'unknown', reason: 'missing_input', statement, grounds: [], tier: 'blocking' });
    if (note.truncated === true) {
      const total = typeof note.changed_paths === 'number' ? String(note.changed_paths) : '未知';
      out.push({ verdict: 'unknown', reason: 'integrity_unproven', statement: `影响视图被截断，列出的路径不是全部（变更路径共 ${total} 条），完整性无法证明。`, grounds: [], tier: 'blocking' });
    }
  }
  if (out.length === 0) out.push({ verdict: 'unknown', reason: 'check_error', statement: '维护巡检的检查里没有用例', grounds: [], tier: 'blocking' });
  return out;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return clip(JSON.stringify(value), 60);
    } catch {
      return clip(String(value), 60);
    }
  }
  return clip(String(value), 60);
}

function formatField(field: ParsedField): string {
  const left = field.absent === 'before' ? '旧值：无' : `旧 ${formatValue(field.before)}`;
  const right = field.absent === 'after' ? '新值：无' : `新 ${formatValue(field.after)}`;
  return `${field.path} ${left} → ${right}`;
}

const MAX_DIFF_SECTION_LEN = 400;

function formatDiffsText(diffs: readonly ParsedReason[], fieldsOfPath: Map<string, ParsedField[]>): string {
  if (diffs.length === 0) return '';

  const render = (kList: number[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const fields = fieldsOfPath.get(diff.path) ?? [];
      const total = fields.length;
      const k = kList[i];
      const header = diffs.length === 1 ? `字段差异 ${total} 处：` : `${diff.path} 字段差异 ${total} 处：`;
      if (total === 0) {
        parts.push(diffs.length === 1 ? '字段差异 0 处' : `${diff.path} 字段差异 0 处`);
        continue;
      }
      if (k >= total) {
        const itemsText = fields.map(formatField).join('；');
        parts.push(`${header}${itemsText}`);
      } else {
        const items = fields.slice(0, k);
        const itemsText = items.map(formatField).join('；');
        const remaining = total - k;
        const extra = itemsText ? `；另有 ${remaining} 处` : `另有 ${remaining} 处`;
        parts.push(`${header}${itemsText}${extra}`);
      }
    }
    return parts.join('；');
  };

  const kList = diffs.map((d) => Math.min(3, (fieldsOfPath.get(d.path) ?? []).length));
  let text = render(kList);

  while (text.length > MAX_DIFF_SECTION_LEN) {
    let maxK = -1;
    let targetIdx = -1;
    for (let i = diffs.length - 1; i >= 0; i--) {
      if (kList[i] > maxK && kList[i] > 0) {
        maxK = kList[i];
        targetIdx = i;
      }
    }
    if (targetIdx === -1) {
      text = clip(text, MAX_DIFF_SECTION_LEN);
      break;
    }
    kList[targetIdx]--;
    text = render(kList);
  }

  return text;
}

function commandUnchanged(subject: unknown): Outcome[] {
  const out: Outcome[] = [];
  const fieldsOfPath = detailFieldsOf(noteOf(subject));
  for (const item of itemsOf(subject)) {
    const reasons = reasonsOf(item);
    const title = typeof item.fields.title === 'string' ? item.fields.title : item.id;
    if (reasons === null) {
      out.push({ verdict: 'unknown', reason: 'check_error', statement: `用例 ${item.id} 没有可读的维护原因`, grounds: [], tier: 'advisory', item: item.id });
      continue;
    }
    const diffs = reasons.filter((reason) => changed(reason, fieldsOfPath));
    if (diffs.length > 0) {
      const paths = diffs.map((reason) => reason.path).join('、');
      const diffText = formatDiffsText(diffs, fieldsOfPath);
      out.push({
        verdict: 'refute',
        code: CHANGED,
        statement: `用例 ${item.id}（${title}）所在命令的定义有变更（${paths}）。${diffText}`,
        grounds: groundsOf(reasons),
        tier: 'advisory',
        item: item.id,
        data: { fields: flatFields(diffs, fieldsOfPath), reasons },
      });
      continue;
    }
    out.push({
      verdict: 'support',
      statement: `用例 ${item.id} 所在命令的定义没有需要维护的差异。`,
      grounds: groundsOf(reasons),
      tier: 'advisory',
      item: item.id,
      data: { reasons },
    });
  }
  if (out.length === 0) out.push({ verdict: 'unknown', reason: 'check_error', statement: '维护巡检的检查里没有用例', grounds: [], tier: 'advisory' });
  return out;
}

export function checkOutcomes(check: string | null, subject: unknown): Outcome[] {
  if (check === 'command_exists') return commandExists(subject);
  if (check === 'command_unchanged') return commandUnchanged(subject);
  return [{ verdict: 'unknown', reason: 'check_error', statement: '这个函数没有对应的检查', grounds: [], tier: 'advisory' }];
}

export default function check(input: unknown): unknown {
  return guarded(
    () => {
      const raw = isRecord(input) ? input : {};
      const id = typeof raw.check === 'string' ? raw.check : null;
      return checkOutcomes(id, raw.subject);
    },
    (message): Outcome[] => [{ verdict: 'unknown', reason: 'check_error', statement: `维护巡检的检查出错（任务包缺陷）：${message}`, grounds: [], tier: 'advisory' }],
  );
}
