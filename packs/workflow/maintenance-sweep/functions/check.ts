import { CHANGE_KIND } from './generated/vocabulary.ts';
import type { ChangeKind, Verdict, CheckTier, Reason as UnknownReason } from '../../../../contracts/generated/vocabulary.ts';
// Pack checks. command_exists: a case on a removed path is a blocking refutation. command_unchanged: first the whole
// command diff as one cross-item fact (one line per changed path with its earlier-build case count, grounded on the
// impact view), then a case on a modified path whose definition data differ is an advisory refutation. A well-formed
// item can carry both. Nothing is
// claimed about cases the index does not hold: when the subject carries the projection note, command_exists adds that
// disclosure stays in the projection note; skipped sources and truncated impact remain unknown. Samples omit the note, so their polarity stays
// the verdict of the item.
// A reason on an item is only the index of its path in note.details and the change kind; path strings, field
// differences and definition references are joined from that run-level table, so an outcome stays small at any
// scale. One ground per outcome (the item's location).

import { groundsOf } from './sweep.ts';
import { CHANGE_LABEL, FIX, PACK, clip, guarded, isRecord } from './text.ts';

const REMOVED = `${PACK}.case.command_removed`;
const CHANGED = `${PACK}.case.command_changed`;

interface ParsedField {
  path: string;
  before: unknown;
  after: unknown;
  absent?: 'before' | 'after';
}

interface ParsedReason {
  detail: number;
  change: ChangeKind;
}

interface DetailRow {
  path: string;
  change: string;
  fields: ParsedField[];
  /** Definition digests the view named but did not carry: the comparison of that path is a missing fact. */
  missing?: string[];
}

interface Outcome {
  missing?: string;
  verdict: Extract<Verdict, 'support' | 'refute' | 'unknown'>;
  code?: string;
  statement: string;
  grounds: string[];
  tier: CheckTier;
  reason?: Extract<UnknownReason, 'missing_input' | 'integrity_unproven' | 'check_error'>;
  item?: string;
  data?: { [key: string]: unknown };
}

interface Item {
  id: string;
  label: string;
  fields: { [key: string]: unknown };
  location?: unknown;
}

function itemsOf(subject: unknown): Item[] {
  const raw = isRecord(subject) ? subject : {};
  return (Array.isArray(raw.items) ? raw.items : [])
    .filter(isRecord)
    .map((item) => ({ id: typeof item.id === 'string' ? item.id : '', label: typeof item.label === 'string' ? item.label : '', fields: isRecord(item.fields) ? item.fields : {}, location: item.location }))
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

/** The note's detail rows (the paths the reasons index), or none when the subject carries no usable table. */
function detailRowsOf(subject: unknown): DetailRow[] {
  const note = noteOf(subject);
  if (note === null || !Array.isArray(note.details)) return [];
  const out: DetailRow[] = [];
  for (const raw of note.details) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || typeof raw.change !== 'string') continue;
    const missing = Array.isArray(raw.missing) ? raw.missing.filter((digest): digest is string => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)) : [];
    out.push({ path: raw.path, change: raw.change, fields: fieldsOf(raw.fields) ?? [], ...(missing.length > 0 ? { missing } : {}) });
  }
  return out;
}

function reasonsOf(item: Item, details: DetailRow[]): ParsedReason[] | null {
  const value = item.fields.reasons;
  if (!Array.isArray(value)) return null;
  const out: ParsedReason[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.detail !== 'number' || !Number.isInteger(raw.detail) || raw.detail < 0) return null;
    const change=CHANGE_KIND.find(kind=>kind===raw.change);
    if(change===undefined)return null;
    out.push({ detail: raw.detail, change });
  }
  return out;
}

/** The path of a reason's detail row; a removed or modified reason without its row is a pack defect (check error). */
function pathOf(details: DetailRow[], reason: ParsedReason): string | null {
  return reason.detail < details.length ? details[reason.detail].path : null;
}

function removed(reason: ParsedReason): boolean {
  return reason.change === 'removed';
}

function changed(reason: ParsedReason, details: DetailRow[]): boolean {
  return reason.change === 'modified' && reason.detail < details.length && details[reason.detail].fields.length > 0;
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

const MAX_DIFF_SECTION_LEN = 200;

function formatDiffsText(diffs: readonly ParsedReason[], details: DetailRow[]): string {
  if (diffs.length === 0) return '';

  const render = (kList: number[]): string => {
    const parts: string[] = [];
    for (let i = 0; i < diffs.length; i++) {
      const diff = diffs[i];
      const path = details[diff.detail].path;
      const fields = details[diff.detail].fields;
      const total = fields.length;
      const k = kList[i];
      const header = diffs.length === 1 ? `字段差异 ${total} 处：` : `${path} 字段差异 ${total} 处：`;
      if (total === 0) {
        parts.push(diffs.length === 1 ? '字段差异 0 处' : `${path} 字段差异 0 处`);
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

  const kList = diffs.map((d) => Math.min(3, details[d.detail].fields.length));
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

function commandExists(subject: unknown): Outcome[] {
  const details = detailRowsOf(subject);
  const out: Outcome[] = [];
  for (const item of itemsOf(subject)) {
    const reasons = reasonsOf(item, details);
    const title = item.label !== '' ? item.label : item.id;
    if (reasons === null) {
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`用例 ${item.id} 没有可读的维护原因`), reason: 'check_error', statement: `用例 ${item.id} 没有可读的维护原因`, grounds: [], tier: 'blocking', item: item.id });
      continue;
    }
    const grounds = groundsOf(item);
    const gone = reasons.filter(removed);
    if (gone.length > 0) {
      if (gone.some((reason) => pathOf(details, reason) === null)) {
        out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`用例 ${item.id} 的删除原因点名的运行级详情行不存在（任务包缺陷）`), reason: 'check_error', statement: `用例 ${item.id} 的删除原因点名的运行级详情行不存在（任务包缺陷）`, grounds: [], tier: 'blocking', item: item.id });
        continue;
      }
      const paths = gone.map((reason) => pathOf(details, reason)).join('、');
      out.push({
        verdict: 'refute',
        code: REMOVED,
        statement: `用例 ${item.id}（${title}）所在的命令已删除（${paths}）。${FIX}`,
        grounds,
        tier: 'blocking',
        item: item.id,
        data: { fix: FIX, paths: gone.map((reason) => details[reason.detail].path), reasons },
      });
      continue;
    }
    out.push({
      verdict: 'support',
      statement: `用例 ${item.id} 所在的命令仍在。`,
      grounds,
      tier: 'blocking',
      item: item.id,
      data: { reasons },
    });
  }
  const note = noteOf(subject);
  if (note !== null) {
    const skipped = typeof note.skipped_from === 'number' && note.skipped_from > 0 ? note.skipped_from : 0;
    // Only skipped documents are an unknown (the view says which sources it could not use); a fully read scope with
    // no maintenance items is a deterministic empty support, never an unconditional unknown.
    if (skipped > 0) {
      const viewNotes = Array.isArray(note.view_notes) ? note.view_notes.filter((row): row is string => typeof row === 'string') : [];
      const statement = `较早构建的索引缺少 ${skipped} 份列出的文档，没有维护项并不能证明没有过期的用例${viewNotes.length > 0 ? `（${viewNotes.join('；')}）` : ''}。缺少这些文档里用例的命令归属事实；下一步由集成者按视图说明补齐来源、重新同步知识库后重跑巡检，不能把未读范围当成没有。`;
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (statement), reason: 'missing_input', statement, grounds: [], tier: 'blocking' });
    }
    if (note.truncated === true) {
      const total = typeof note.changed_paths === 'number' ? String(note.changed_paths) : '未知';
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`影响视图被截断，列出的路径不是全部（变更路径共 ${total} 条），完整性无法证明。`), reason: 'integrity_unproven', statement: `影响视图被截断，列出的路径不是全部（变更路径共 ${total} 条），完整性无法证明。`, grounds: [], tier: 'blocking' });
    }
  }
  if (out.length === 0) {
    if (note === null) out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('维护巡检的检查里没有用例'), reason: 'check_error', statement: '维护巡检的检查里没有用例', grounds: [], tier: 'blocking' });
    else out.push({ verdict: 'support', statement: '已读来源里没有需要维护的用例，巡检范围是空的。', grounds: [], tier: 'blocking' });
  }
  return out;
}

interface DiffRow {
  path: string;
  change: string;
  /** Earlier-build cases on the path, counted by the projection (missing or unreadable counts as 0). */
  cases: number;
}

/** The note's diff rows (the whole command diff, written by the projection), or none when the subject has no usable table. */
function diffRowsOf(subject: unknown): DiffRow[] {
  const note = noteOf(subject);
  if (note === null || !Array.isArray(note.diff)) return [];
  const out: DiffRow[] = [];
  for (const raw of note.diff) {
    if (isRecord(raw) && typeof raw.path === 'string' && typeof raw.change === 'string') {
      out.push({ path: raw.path, change: raw.change, cases: typeof raw.cases === 'number' && Number.isInteger(raw.cases) && raw.cases >= 0 ? raw.cases : 0 });
    }
  }
  return out;
}

/** Most paths the command-diff summary lists; past it the rest is counted and the run-level note.diff holds the full table. */
const MAX_DIFF_ROWS = 200;
/** One statement stays under the answer's per-field clip (1,500 characters): a longer diff continues in a next claim. */
const MAX_DIFF_STATEMENT = 1400;

/**
 * The whole command diff as cross-item facts, computed from the run-level note.diff: one compact line per changed path
 * (path, change kind, earlier-build case count; added paths, never maintenance items, are marked), grounded on the
 * impact view. A statement longer than MAX_DIFF_STATEMENT continues in a next claim (第 k 部分，共 m 部分), paths in
 * order, so the answer's per-field clip never cuts a line off. They lead this check's outcomes so the diff is visible
 * however many items the answer pages away.
 */
function diffSummaries(subject: unknown): Outcome[] {
  const note = noteOf(subject);
  const rows = diffRowsOf(subject);
  const view = typeof note?.view === 'string' && note.view.startsWith('src:') ? note.view : null;
  const grounds = view === null ? [] : [view];
  const total = rows.length;
  if (total === 0) {
    return [{ verdict: 'support', statement: '命令差共 0 条：两个构建的命令定义没有差异。', grounds, tier: 'advisory', data: { changed_paths: 0, listed: 0 } }];
  }
  // A truncated view: the head says the whole count and that only the listed part follows; completeness stays unknown.
  const cut = note?.truncated === true && typeof note?.changed_paths === 'number' && note.changed_paths > total ? note.changed_paths : null;
  // Detail rows name the definition digests the view did not carry: those paths are a missing fact, disclosed here.
  const missingByPath = new Map<string, number>();
  if (note !== null && Array.isArray(note.details)) {
    for (const raw of note.details) {
      if (!isRecord(raw) || typeof raw.path !== 'string' || !Array.isArray(raw.missing)) continue;
      const count = raw.missing.filter((digest): digest is string => typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)).length;
      if (count > 0) missingByPath.set(raw.path, count);
    }
  }
  const headOf = (part: number, parts: number): string => {
    const which = parts > 1 ? `第 ${part} 部分，共 ${parts} 部分；` : '';
    if (cut === null) return `命令差共 ${total} 条（${which}路径、变更种类、前一构建用例数）：`;
    return `命令差共 ${cut} 条（影响视图被截断，这 ${total} 条是列出的部分；${which}路径、变更种类、前一构建用例数）：`;
  };
  const lines = rows.slice(0, MAX_DIFF_ROWS).map((row) => {
    const label = (CHANGE_KIND as readonly string[]).includes(row.change) ? CHANGE_LABEL[row.change as ChangeKind] : row.change;
    const missing = missingByPath.get(row.path) ?? 0;
    const noteText = missing > 0 ? `（有 ${missing} 个点名的定义条目视图未带出，无从比较）` : '';
    return `- ${row.path} ${label} ${row.cases} 条${row.change === 'added' ? '（不进范围）' : ''}${noteText}`;
  });
  const listed = lines.length;
  if (total > MAX_DIFF_ROWS) lines.push(`- 另有 ${total - MAX_DIFF_ROWS} 条，完整的表在运行级详情里`);
  // Greedy packing against the longest head (two-digit part numbers); the real heads are never longer.
  const parts: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (current.length > 0 && size + line.length + 1 > MAX_DIFF_STATEMENT) {
      parts.push(current);
      current = [];
      size = 0;
    }
    if (current.length === 0) size = headOf(parts.length + 1, 99).length + 1;
    current.push(line);
    size += line.length + 1;
  }
  parts.push(current);
  const m = parts.length;
  return parts.map((partRows, i) => ({
    verdict: 'support' as const,
    statement: [headOf(i + 1, m), ...partRows].join('\n'),
    grounds,
    tier: 'advisory' as const,
    data: m === 1 ? { changed_paths: cut ?? total, listed } : { changed_paths: cut ?? total, listed, part: i + 1, parts: m },
  }));
}

function commandUnchanged(subject: unknown): Outcome[] {
  const details = detailRowsOf(subject);
  const out: Outcome[] = [];
  for (const item of itemsOf(subject)) {
    const reasons = reasonsOf(item, details);
    const title = item.label !== '' ? item.label : item.id;
    if (reasons === null) {
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`用例 ${item.id} 没有可读的维护原因`), reason: 'check_error', statement: `用例 ${item.id} 没有可读的维护原因`, grounds: [], tier: 'advisory', item: item.id });
      continue;
    }
    const grounds = groundsOf(item);
    const modified = reasons.filter((reason) => reason.change === 'modified');
    if (modified.some((reason) => pathOf(details, reason) === null)) {
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`用例 ${item.id} 的变更原因点名的运行级详情行不存在（任务包缺陷）`), reason: 'check_error', statement: `用例 ${item.id} 的变更原因点名的运行级详情行不存在（任务包缺陷）`, grounds: [], tier: 'advisory', item: item.id });
      continue;
    }
    const diffs = reasons.filter((reason) => changed(reason, details));
    // A named definition the view did not carry is a missing fact, never evidence of agreement: without the entry's
    // content the two sides cannot be compared, so the item is an unknown with the next step, and a fabricated
    // "/ null → null" difference is never written.
    const missingRows = modified.filter((reason) => reason.detail < details.length && (details[reason.detail].missing?.length ?? 0) > 0);
    if (diffs.length > 0) {
      const paths = diffs.map((reason) => details[reason.detail].path).join('、');
      const diffText = formatDiffsText(diffs, details);
      const missingNote = missingRows.length > 0 ? `（另有 ${missingRows.reduce((sum, reason) => sum + (details[reason.detail].missing?.length ?? 0), 0)} 个点名的定义条目视图未带出，差异可能不止这些）` : '';
      out.push({
        verdict: 'refute',
        code: CHANGED,
        statement: `用例 ${item.id}（${title}）所在命令的定义有变更（${paths}）。${diffText}${missingNote}`,
        grounds,
        tier: 'advisory',
        item: item.id,
        data: { reasons },
      });
      continue;
    }
    if (missingRows.length > 0) {
      const digests = [...new Set(missingRows.flatMap((reason) => details[reason.detail].missing ?? []))];
      const statement = `影响视图没有带出用例 ${item.id} 所在命令定义的条目（${digests.map((digest) => digest.slice(0, 12)).join('、')}），两边是否一致无从核对`;
      out.push({
        verdict: 'unknown',
        missing: '尚未取得本检查所需的事实：' + statement + '；下一步：不带 attached_fields 瘦身重读影响视图或提高视图上限，补全该条目后重跑巡检',
        reason: 'missing_input',
        statement,
        grounds,
        tier: 'advisory',
        item: item.id,
        data: { reasons, missing: digests },
      });
      continue;
    }
    out.push({
      verdict: 'support',
      statement: `用例 ${item.id} 所在命令的定义没有需要维护的差异。`,
      grounds,
      tier: 'advisory',
      item: item.id,
      data: { reasons },
    });
  }
  if (out.length === 0) {
    if (noteOf(subject) === null) out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('维护巡检的检查里没有用例'), reason: 'check_error', statement: '维护巡检的检查里没有用例', grounds: [], tier: 'advisory' });
    else out.push({ verdict: 'support', statement: '已读来源里没有需要维护的用例，巡检范围是空的。', grounds: [], tier: 'advisory' });
  }
  return out;
}

export function checkOutcomes(check: string | null, subject: unknown): Outcome[] {
  if (check === 'command_exists') return commandExists(subject);
  if (check === 'command_unchanged') return [...diffSummaries(subject), ...commandUnchanged(subject)];
  return [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('这个函数没有对应的检查'), reason: 'check_error', statement: '这个函数没有对应的检查', grounds: [], tier: 'advisory' }];
}

export default function check(input: unknown): unknown {
  return guarded(
    () => {
      const raw = isRecord(input) ? input : {};
      const id = typeof raw.check === 'string' ? raw.check : null;
      return checkOutcomes(id, raw.subject);
    },
    (message): Outcome[] => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`维护巡检的检查出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `维护巡检的检查出错（任务包缺陷）：${message}`, grounds: [], tier: 'advisory' }],
  );
}
