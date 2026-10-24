import { CHANGE_KIND } from './generated/vocabulary.ts';
import type { ChangeKind, Verdict, Reason as UnknownReason } from '../../../../contracts/generated/vocabulary.ts';
// Pack checks. in_scope: one support per case, data holding the reasons (each only the detail index and the change
// kind); a scope is not a defect, so a well-formed item never refutes. uncovered_changes: first the whole command diff
// as one cross-item fact (one line per changed path with its later-build case count, grounded on the impact view), then
// each changed path with no later-build case as unknown (missing input), a cross-item claim, never a failure. The only
// refutations are contradictions a well-formed projection does not produce; the publish check requires a negative sample
// (C05 R[0]). One ground per outcome (the item's case reference); path strings and definition references are joined from
// the run-level note.details, so an outcome stays small at any scale.

import { groundsOf } from './scope.ts';
import { uniqueSorted } from './text.ts';
import { CHANGE_LABEL, PACK, guarded, isRecord } from './text.ts';

const TIER = 'advisory' as const;

interface ParsedReason {
  detail: number;
  change: ChangeKind;
}

interface DetailRow {
  path: string;
  change: string;
  /** Later-build cases on the path, counted by the projection (missing or unreadable counts as 0). */
  cases: number;
}

interface Outcome {
  missing?: string;
  verdict: Extract<Verdict, 'support' | 'refute' | 'unknown'>;
  code?: string;
  statement: string;
  grounds: string[];
  tier: 'advisory';
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

function reasonsOf(item: Item, details: DetailRow[]): ParsedReason[] | null {
  const value = item.fields.reasons;
  if (!Array.isArray(value)) return null;
  const out: ParsedReason[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.detail !== 'number' || !Number.isInteger(raw.detail) || raw.detail < 0 || raw.detail >= details.length) return null;
    const change=CHANGE_KIND.find(kind=>kind===raw.change);
    if(change===undefined)return null;
    out.push({ detail: raw.detail, change });
  }
  return out;
}

/** The note's detail rows (the paths the reasons index), or none when the subject carries no usable table. */
function detailRowsOf(subject: unknown): DetailRow[] {
  const note = noteOf(subject);
  if (note === null || !Array.isArray(note.details)) return [];
  const out: DetailRow[] = [];
  for (const raw of note.details) {
    if (isRecord(raw) && typeof raw.path === 'string' && typeof raw.change === 'string') {
      out.push({ path: raw.path, change: raw.change, cases: typeof raw.cases === 'number' && Number.isInteger(raw.cases) && raw.cases >= 0 ? raw.cases : 0 });
    }
  }
  return out;
}

function pathsOf(items: readonly Item[], details: DetailRow[]): Set<string> {
  const covered = new Set<string>();
  for (const item of items) {
    const reasons = reasonsOf(item, details);
    if (reasons === null) continue;
    for (const reason of reasons) if (reason.change === 'added' || reason.change === 'modified') covered.add(details[reason.detail].path);
  }
  return covered;
}

function pathNotes(value: unknown): Array<{ path: string; change: Extract<ChangeKind, Extract<ChangeKind, Extract<ChangeKind, 'added' | 'modified'>>> }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ path: string; change: Extract<ChangeKind, Extract<ChangeKind, Extract<ChangeKind, 'added' | 'modified'>>> }> = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.path !== 'string') continue;
    const change=CHANGE_KIND.find(kind=>kind===raw.change);
    if(change===undefined)continue;
    if(change!=='added' && change!=='modified')continue;
    out.push({ path: raw.path, change });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function inScope(subject: unknown): Outcome[] {
  const note = noteOf(subject);
  const includeAdded = note?.include_added !== false;
  const details = detailRowsOf(subject);
  const out: Outcome[] = [];
  for (const item of itemsOf(subject)) {
    const reasons = reasonsOf(item, details);
    const title = typeof item.label === 'string' && item.label !== '' ? item.label : item.id;
    if (reasons === null || reasons.length === 0) {
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`用例 ${item.id} 没有可读的范围原因`), reason: 'check_error', statement: `用例 ${item.id} 没有可读的范围原因`, grounds: [], tier: TIER, item: item.id });
      continue;
    }
    const grounds = groundsOf(item);
    const bad = reasons.filter((reason) => reason.change === 'removed' || (reason.change !== 'added' && reason.change !== 'modified') || (!includeAdded && reason.change === 'added'));
    if (bad.length > 0) {
      out.push({
        verdict: 'refute',
        code: `${PACK}.not_in_scope`,
        statement: `用例 ${item.id} 的原因里有不是后一构建新增或修改的路径（${bad.map((reason) => details[reason.detail].path).join('、')}），不能算进回归范围`,
        grounds,
        tier: TIER,
        item: item.id,
        data: { reasons },
      });
      continue;
    }
    const names = reasons.map((reason) => `${details[reason.detail].path} ${reason.change === 'added' ? CHANGE_LABEL.added : CHANGE_LABEL.modified}`).join('、');
    out.push({
      verdict: 'support',
      statement: `用例 ${item.id}（${title}）在回归范围内，涉及 ${names}`,
      grounds,
      tier: TIER,
      item: item.id,
      data: { reasons },
    });
  }
  if (out.length === 0) {
    if (note === null) out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('回归范围的检查里没有用例'), reason: 'check_error', statement: '回归范围的检查里没有用例', grounds: [], tier: TIER });
    else out.push({ verdict: 'support', statement: '投影给出的回归范围里没有用例：两个构建之间没有纳入范围的用例，回归范围是空的。', grounds: [], tier: TIER });
  }
  return out;
}

function uncoveredStatement(path: string, change: Extract<ChangeKind, Extract<ChangeKind, Extract<ChangeKind, 'added' | 'modified'>>>, skippedTo: number): string {
  const skip = skippedTo > 0 ? `后一构建的索引缺少 ${skippedTo} 份列出的文档，这条路径上的用例可能没有被读到。` : '';
  return `变更路径 ${path}（${CHANGE_LABEL[change]}）在后一构建里没有用例。用例索引在这里没有条目，所以这不是失败。${skip}`;
}

/** Most paths the command-diff summary lists; past it the rest is counted and the run-level details hold the full table. */
const MAX_DIFF_ROWS = 200;
/** One statement stays under the answer's per-field clip (1,500 characters): a longer diff continues in a next claim. */
const MAX_DIFF_STATEMENT = 1400;

/**
 * The whole command diff as cross-item facts, computed from the run-level details: one compact line per changed path
 * (path, change kind, later-build case count; removed paths, never in scope, are marked), grounded on the impact view.
 * A statement longer than MAX_DIFF_STATEMENT continues in a next claim (第 k 部分，共 m 部分), paths in order, so the
 * answer's per-field clip never cuts a line off. They lead this check's outcomes so the diff is visible however many
 * items the answer pages away.
 */
function diffSummaries(subject: unknown): Outcome[] {
  const note = noteOf(subject);
  const details = detailRowsOf(subject);
  const includeAdded = note?.include_added !== false;
  const view = typeof note?.view === 'string' && note.view.startsWith('src:') ? note.view : null;
  const grounds = view === null ? [] : [view];
  const total = details.length;
  if (total === 0) {
    return [{ verdict: 'support', statement: '命令差共 0 条：两个构建的命令定义没有差异。', grounds, tier: TIER, data: { changed_paths: 0, listed: 0 } }];
  }
  // A truncated view: the head says the whole count and that only the listed part follows; completeness stays unknown.
  const cut = note?.truncated === true && typeof note?.changed_paths === 'number' && note.changed_paths > total ? note.changed_paths : null;
  const headOf = (part: number, parts: number): string => {
    const which = parts > 1 ? `第 ${part} 部分，共 ${parts} 部分；` : '';
    if (cut === null) return `命令差共 ${total} 条（${which}路径、变更种类、后一构建用例数）：`;
    return `命令差共 ${cut} 条（影响视图被截断，这 ${total} 条是列出的部分；${which}路径、变更种类、后一构建用例数）：`;
  };
  const rows = details.slice(0, MAX_DIFF_ROWS).map((row) => {
    const label = (CHANGE_KIND as readonly string[]).includes(row.change) ? CHANGE_LABEL[row.change as ChangeKind] : row.change;
    const out = row.change === 'removed' || (!includeAdded && row.change === 'added') ? '（不进范围）' : '';
    return `- ${row.path} ${label} ${row.cases} 条${out}`;
  });
  const listed = rows.length;
  if (total > MAX_DIFF_ROWS) rows.push(`- 另有 ${total - MAX_DIFF_ROWS} 条，完整的表在运行级详情里`);
  // Greedy packing against the longest head (two-digit part numbers); the real heads are never longer.
  const parts: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const row of rows) {
    if (current.length > 0 && size + row.length + 1 > MAX_DIFF_STATEMENT) {
      parts.push(current);
      current = [];
      size = 0;
    }
    if (current.length === 0) size = headOf(parts.length + 1, 99).length + 1;
    current.push(row);
    size += row.length + 1;
  }
  parts.push(current);
  const m = parts.length;
  return parts.map((partRows, i) => ({
    verdict: 'support' as const,
    statement: [headOf(i + 1, m), ...partRows].join('\n'),
    grounds,
    tier: TIER,
    data: m === 1 ? { changed_paths: cut ?? total, listed } : { changed_paths: cut ?? total, listed, part: i + 1, parts: m },
  }));
}

function uncovered(subject: unknown): Outcome[] {
  const note = noteOf(subject);
  const items = itemsOf(subject);
  const covered = pathsOf(items, detailRowsOf(subject));
  const explicit = note !== null && Object.hasOwn(note, 'uncovered') ? pathNotes(note.uncovered) : null;
  const derived = explicit ?? pathNotes(note?.considered)?.filter((row) => !covered.has(row.path)) ?? [];
  const overlap = derived.filter((row) => covered.has(row.path));
  if (overlap.length > 0) {
    return [
      {
        verdict: 'refute',
        code: `${PACK}.not_uncovered`,
        statement: `路径 ${overlap.map((row) => row.path).join('、')} 既被记为没有用例，又有范围内的用例，两边矛盾`,
        grounds: [],
        tier: TIER,
      },
    ];
  }
  const skippedTo = typeof note?.skipped_to === 'number' && note.skipped_to > 0 ? note.skipped_to : 0;
  const truncated = note?.truncated === true;
  const changedPaths = typeof note?.changed_paths === 'number' ? note.changed_paths : derived.length;
  const out: Outcome[] = derived.map((row) => ({
    verdict: 'unknown' as const, missing: '尚未取得本检查所需的事实：' + (uncoveredStatement(row.path, row.change, skippedTo)),
    reason: 'missing_input' as const,
    statement: uncoveredStatement(row.path, row.change, skippedTo),
    grounds: [],
    tier: TIER,
  }));
  if (derived.length === 0 && skippedTo > 0) {
    out.push({
      verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`后一构建的索引缺少 ${skippedTo} 份列出的文档，列出的变更路径虽然都有用例，也不能据此说没有遗漏。`),
      reason: 'missing_input',
      statement: `后一构建的索引缺少 ${skippedTo} 份列出的文档，列出的变更路径虽然都有用例，也不能据此说没有遗漏。`,
      grounds: [],
      tier: TIER,
    });
  }
  if (truncated) {
    out.push({
      verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`影响视图被截断，列出的路径不是全部（变更路径共 ${changedPaths} 条），完整性无法证明。`),
      reason: 'integrity_unproven',
      statement: `影响视图被截断，列出的路径不是全部（变更路径共 ${changedPaths} 条），完整性无法证明。`,
      grounds: [],
      tier: TIER,
    });
  }
  if (out.length === 0) {
    const empty = (pathNotes(note?.considered)?.length ?? 0) === 0 && (explicit === null || explicit.length === 0);
    out.push({
      verdict: 'support',
      statement: empty ? '两个构建之间没有纳入范围的变更路径，回归范围是空的。' : '列出的变更路径在后一构建里都有用例。',
      grounds: [],
      tier: TIER,
    });
  }
  return out;
}

export function checkOutcomes(check: string | null, subject: unknown): Outcome[] {
  if (check === 'uncovered_changes') return [...diffSummaries(subject), ...uncovered(subject)];
  if (check === 'in_scope') return inScope(subject);
  return [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('这个函数没有对应的检查'), reason: 'check_error', statement: '这个函数没有对应的检查', grounds: [], tier: TIER }];
}

export default function check(input: unknown): unknown {
  return guarded(
    () => {
      const raw = isRecord(input) ? input : {};
      const id = typeof raw.check === 'string' ? raw.check : null;
      return checkOutcomes(id, raw.subject);
    },
    (message): Outcome[] => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`回归范围的检查出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `回归范围的检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
