// Pack checks. in_scope: one support per case, data holding the reasons; a scope is not a defect, so a well-formed item
// never refutes. uncovered_changes: each changed path with no later-build case is unknown (missing input), a cross-item
// claim, never a failure. The only refutations are contradictions a well-formed projection does not produce; the publish
// check requires a negative sample (C05 R[0]).

import { groundsOf } from './scope.ts';
import { uniqueSorted } from './text.ts';
import { CHANGE_LABEL, PACK, guarded, isRecord } from './text.ts';

const TIER = 'advisory' as const;

interface ParsedReason {
  path: string;
  change: 'added' | 'modified' | 'removed';
  definition_change: 'added' | 'removed' | 'modified' | 'none';
  references: string[];
  case: { entry: string; reference: string };
}

interface Outcome {
  verdict: 'support' | 'refute' | 'unknown';
  code?: string;
  statement: string;
  grounds: string[];
  tier: 'advisory';
  reason?: 'missing_input' | 'integrity_unproven' | 'check_error';
  item?: string;
  data?: { [key: string]: unknown };
}

interface Item {
  id: string;
  fields: { [key: string]: unknown };
  location?: unknown;
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

function reasonsOf(item: Item): ParsedReason[] | null {
  const value = item.fields.reasons;
  if (!Array.isArray(value)) return null;
  const out: ParsedReason[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || (raw.change !== 'added' && raw.change !== 'modified' && raw.change !== 'removed')) return null;
    if (raw.definition_change !== 'added' && raw.definition_change !== 'removed' && raw.definition_change !== 'modified' && raw.definition_change !== 'none') return null;
    if (!Array.isArray(raw.references) || raw.references.some((r) => typeof r !== 'string')) return null;
    const caseRef = isRecord(raw.case) && typeof raw.case.reference === 'string' && typeof raw.case.entry === 'string' ? { entry: raw.case.entry, reference: raw.case.reference } : null;
    if (caseRef === null) return null;
    out.push({ path: raw.path, change: raw.change, definition_change: raw.definition_change, references: raw.references as string[], case: caseRef });
  }
  return out;
}

function pathsOf(items: readonly Item[]): Set<string> {
  const covered = new Set<string>();
  for (const item of items) {
    const reasons = reasonsOf(item);
    if (reasons === null) continue;
    for (const reason of reasons) if (reason.change === 'added' || reason.change === 'modified') covered.add(reason.path);
  }
  return covered;
}

function pathNotes(value: unknown): Array<{ path: string; change: 'added' | 'modified' }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ path: string; change: 'added' | 'modified' }> = [];
  for (const raw of value) {
    if (!isRecord(raw) || typeof raw.path !== 'string' || (raw.change !== 'added' && raw.change !== 'modified')) continue;
    out.push({ path: raw.path, change: raw.change });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function inScope(subject: unknown): Outcome[] {
  const note = noteOf(subject);
  const includeAdded = note?.include_added !== false;
  const out: Outcome[] = [];
  for (const item of itemsOf(subject)) {
    const reasons = reasonsOf(item);
    const title = typeof item.fields.title === 'string' ? item.fields.title : item.id;
    if (reasons === null || reasons.length === 0) {
      out.push({ verdict: 'unknown', reason: 'check_error', statement: `用例 ${item.id} 没有可读的范围原因`, grounds: [], tier: TIER, item: item.id });
      continue;
    }
    const grounds = groundsOf(reasons);
    const bad = reasons.filter((reason) => reason.change === 'removed' || (reason.change !== 'added' && reason.change !== 'modified') || (!includeAdded && reason.change === 'added'));
    if (bad.length > 0) {
      out.push({
        verdict: 'refute',
        code: `${PACK}.not_in_scope`,
        statement: `用例 ${item.id} 的原因里有不是后一构建新增或修改的路径（${bad.map((reason) => reason.path).join('、')}），不能算进回归范围`,
        grounds,
        tier: TIER,
        item: item.id,
        data: { reasons },
      });
      continue;
    }
    const names = reasons.map((reason) => `${reason.path} ${reason.change === 'added' ? CHANGE_LABEL.added : CHANGE_LABEL.modified}`).join('、');
    out.push({
      verdict: 'support',
      statement: `用例 ${item.id}（${title}）在回归范围内，涉及 ${names}`,
      grounds,
      tier: TIER,
      item: item.id,
      data: { reasons },
    });
  }
  if (out.length === 0) out.push({ verdict: 'unknown', reason: 'check_error', statement: '回归范围的检查里没有用例', grounds: [], tier: TIER });
  return out;
}

function uncoveredStatement(path: string, change: 'added' | 'modified', skippedTo: number): string {
  const skip = skippedTo > 0 ? `后一构建的索引缺少 ${skippedTo} 份列出的文档，这条路径上的用例可能没有被读到。` : '';
  return `变更路径 ${path}（${CHANGE_LABEL[change]}）在后一构建里没有用例。用例索引在这里没有条目，所以这不是失败。${skip}`;
}

function uncovered(subject: unknown): Outcome[] {
  const note = noteOf(subject);
  const items = itemsOf(subject);
  const covered = pathsOf(items);
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
    verdict: 'unknown' as const,
    reason: 'missing_input' as const,
    statement: uncoveredStatement(row.path, row.change, skippedTo),
    grounds: [],
    tier: TIER,
  }));
  if (derived.length === 0 && skippedTo > 0) {
    out.push({
      verdict: 'unknown',
      reason: 'missing_input',
      statement: `后一构建的索引缺少 ${skippedTo} 份列出的文档，列出的变更路径虽然都有用例，也不能据此说没有遗漏。`,
      grounds: [],
      tier: TIER,
    });
  }
  if (truncated) {
    out.push({
      verdict: 'unknown',
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
  if (check === 'uncovered_changes') return uncovered(subject);
  if (check === 'in_scope') return inScope(subject);
  return [{ verdict: 'unknown', reason: 'check_error', statement: '这个函数没有对应的检查', grounds: [], tier: TIER }];
}

export default function check(input: unknown): unknown {
  return guarded(
    () => {
      const raw = isRecord(input) ? input : {};
      const id = typeof raw.check === 'string' ? raw.check : null;
      return checkOutcomes(id, raw.subject);
    },
    (message): Outcome[] => [{ verdict: 'unknown', reason: 'check_error', statement: `回归范围的检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
