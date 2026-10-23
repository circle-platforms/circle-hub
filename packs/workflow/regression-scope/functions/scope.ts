import { CHANGE_KIND } from './generated/vocabulary.ts';
import type { ChangeKind } from '../../../../contracts/generated/vocabulary.ts';
// Regression scope (capability 4a). A case is in scope when the later build places it on an added or modified path.
// One case on several such paths is one item. Removed paths are neither in scope nor uncovered. A changed path with no
// case in the later build is uncovered: unknown, never a failure. The priority filter does not create uncovered paths.
// Output order follows ids and paths, never the order of the view.

import { CHANGE_LABEL, DEFINITION_CHANGE_LABEL, PACK, clip, isRecord, uniqueSorted } from './text.ts';
import type { Cited, NormView } from './view.ts';

export interface Parameters {
  /** null: keep every priority. An array keeps only those numbers; an empty array keeps nothing. */
  priorities: number[] | null;
  includeAdded: boolean;
}

export interface Reason {
  /** The index of the path in the run-level details table (note.details); the path string is there, once. */
  detail: number;
  change: Extract<ChangeKind, Extract<ChangeKind, 'added' | 'modified'>>;
}

/** One row per changed path at the run level: the kind, the definition change, a short line for a person, the first 3
 * field diffs with 另有 M 处, and the tree references of the changed definition entries. Written once in the note;
 * the items cite the row by its index, never repeating it. */
export interface PathDetail {
  path: string;
  change: ChangeKind;
  definition_change: ChangeKind | 'none';
  conclusion: string;
  differences: string[];
  references: string[];
  /** Later-build case entries the view files on this path (the command-diff summary counts them; removed paths have none). */
  cases: number;
}

export interface ScopeItem {
  id: string;
  label: string;
  summary: string;
  document: string;
  node: string;
  title: string;
  priority: number | null;
  negative: boolean;
  /** Digest of the case entry the item's location points at (the least digest). */
  entry: string;
  reasons: Reason[];
}

export interface PathNote {
  path: string;
  change: Extract<ChangeKind, Extract<ChangeKind, 'added' | 'modified'>>;
}

export interface Warning {
  code: string;
  message: string;
}

export interface ScopeNote {
  kind: typeof PACK;
  considered: PathNote[];
  /** Changed paths with no later-build case, computed before the priority filter. */
  uncovered: PathNote[];
  skipped_to: number;
  skipped_from: number;
  truncated: boolean;
  changed_paths: number;
  include_added: boolean;
  message: string;
  /** One row per changed path: the kind, the definition change, a short line, the first 3 field differences and the
   * tree references of the changed definition entries (the reasons cite a row by its index, so every path has a row). */
  details: PathDetail[];
}

export interface ScopeResult {
  items: ScopeItem[];
  note: ScopeNote;
  warnings: Warning[];
}

interface Side {
  change: ChangeKind;
  before: string[];
  after: string[];
}

interface Acc {
  document: string;
  node: string;
  title: string;
  priority: number | null;
  negative: boolean;
  chosen: string;
  reasons: Map<string, Reason['change']>;
}

const MAX_ID = 200;
const MAX_SUMMARY = 200;
const MAX_LABEL = 200;

export function readParameters(value: unknown): { parameters: Parameters; ignored: string[] } {
  const raw = isRecord(value) ? value : {};
  const ignored: string[] = [];
  let priorities: number[] | null = null;
  if (Object.hasOwn(raw, 'priorities')) {
    const list = raw.priorities;
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'number' || !Number.isFinite(item))) ignored.push('priorities');
    else priorities = list;
  }
  let includeAdded = true;
  if (Object.hasOwn(raw, 'include_added')) {
    if (typeof raw.include_added !== 'boolean') ignored.push('include_added');
    else includeAdded = raw.include_added;
  }
  return { parameters: { priorities, includeAdded }, ignored };
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? null : text;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function cited(view: NormView, digests: readonly string[], warnings: Warning[], seen: Set<string>, path: string): Cited[] {
  const out: Cited[] = [];
  for (const digest of uniqueSorted(digests)) {
    const entry = view.entries.get(digest);
    if (entry === undefined) {
      if (!seen.has(digest)) {
        seen.add(digest);
        warnings.push({ code: `${PACK}.missing_entry`, message: `路径 ${path} 点名的条目 ${digest.slice(0, 12)} 不在视图里` });
      }
      continue;
    }
    out.push({ entry: entry.entry, kind: entry.kind, reference: entry.reference });
  }
  return out;
}

function comparePath(a: PathNote, b: PathNote): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * What happened to the command definition of a path, from the definition-kind entries of its two sides: none before
 * and some after is added; some before and none after is removed; both with different digests is modified; equal
 * definitions (only behaviour texts moved) or no definition on either side is none.
 */
function definitionChangeOf(before: Cited[], after: Cited[]): PathDetail['definition_change'] {
  const beforeDefinitions = uniqueSorted(before.filter((row) => row.kind === 'definition').map((row) => row.entry));
  const afterDefinitions = uniqueSorted(after.filter((row) => row.kind === 'definition').map((row) => row.entry));
  if (beforeDefinitions.length === 0 && afterDefinitions.length > 0) return 'added';
  if (beforeDefinitions.length > 0 && afterDefinitions.length === 0) return 'removed';
  if (beforeDefinitions.length > 0 && afterDefinitions.length > 0) {
    return beforeDefinitions.join('\u0000') === afterDefinitions.join('\u0000') ? 'none' : 'modified';
  }
  return 'none';
}

/** The person-readable line of one reason: what happened to the command, not to the path's entries. */
/** The per-path change detail, computed once: the definition change kind, the person line, the tree references to the
 * changed entries, and the first 3 field differences (signatures and data fields of both sides' definitions). */
function detailsOf(path: string, side: Side, view: NormView, warnings: Warning[], missing: Set<string>): { definitionChange: ChangeKind | 'none'; references: string[]; differences: string[]; conclusion: string; change: Side['change'] } {
  const before = cited(view, side.before, warnings, missing, path);
  const after = cited(view, side.after, warnings, missing, path);
  const definitionChange = definitionChangeOf(before, after);
  const references = uniqueSorted([...before, ...after].map((c) => c.reference).filter((r) => r !== ''));
  const differences = fieldDifferences(before, after);
  return { definitionChange, references, differences, conclusion: conclusionOf(definitionChange), change: side.change };
}

/** The first 3 top-level field differences of the definitions on both sides (旧 x → 新 y), then 另有 M 处. */
function fieldDifferences(before: Cited[], after: Cited[]): string[] {
  const dataOfSide = (rows: readonly Cited[]): Record<string, unknown> => {
    for (const row of rows) {
      if ('data' in row && isRecord((row as unknown as { data: unknown }).data)) return (row as unknown as { data: Record<string, unknown> }).data;
    }
    return {};
  };
  const beforeData = dataOfSide(before);
  const afterData = dataOfSide(after);
  const keys = uniqueSorted([...Object.keys(beforeData), ...Object.keys(afterData)]);
  const rows: string[] = [];
  for (const key of keys) {
    const left = beforeData[key];
    const right = afterData[key];
    const same = JSON.stringify(left) === JSON.stringify(right);
    if (!same) rows.push(`${key} 旧 ${clip(JSON.stringify(left), 40)} → 新 ${clip(JSON.stringify(right), 40)}`);
  }
  return rows;
}

function conclusionOf(change: PathDetail['definition_change']): string {
  return DEFINITION_CHANGE_LABEL[change];
}

/** The cases in scope, the uncovered paths and the run-level note. */
export function scopeOf(view: NormView, parameters: Parameters): ScopeResult {
  const warnings: Warning[] = [];
  const missing = new Set<string>();
  const byPath = new Map<string, Side>();
  for (const change of view.changes) {
    const prior = byPath.get(change.path);
    const before = uniqueSorted([...(prior?.before ?? []), ...change.before]);
    const after = uniqueSorted([...(prior?.after ?? []), ...change.after]);
    let kind: Side['change'] = (CHANGE_KIND as readonly string[]).includes(change.change) ? change.change as ChangeKind : 'modified';
    if (prior !== undefined && prior.change !== kind) {
      if (before.length === 0 && after.length > 0) kind = 'added';
      else if (after.length === 0 && before.length > 0) kind = 'removed';
      else kind = 'modified';
    }
    byPath.set(change.path, { change: kind, before, after });
  }
  const placed = new Map<string, { from: string[]; to: string[] }>();
  for (const placement of view.placements) {
    const prior = placed.get(placement.path);
    placed.set(placement.path, {
      from: uniqueSorted([...(prior?.from ?? []), ...placement.from]),
      to: uniqueSorted([...(prior?.to ?? []), ...placement.to]),
    });
  }

  const considered: PathNote[] = [];
  for (const path of [...byPath.keys()].sort()) {
    const side = byPath.get(path)!;
    if (side.change === 'removed') continue;
    if (side.change === 'added' && !parameters.includeAdded) continue;
    if (side.change !== 'added' && side.change !== 'modified') continue;
    considered.push({ path, change: side.change });
  }

  const hasCaseKind = view.attachedKinds.includes('case');
  if (!hasCaseKind) warnings.push({ code: `${PACK}.no_case_kind`, message: '影响视图的附着种类里没有用例（case），回归范围里不会有用例' });

  const byId = new Map<string, Acc>();
  const uncovered: PathNote[] = [];
  let casesBeforeFilter = 0;
  for (const row of considered) {
    const digests = placed.get(row.path)?.to ?? [];
    let sawCase = false;
    for (const digest of digests) {
      const entry = view.entries.get(digest);
      if (entry === undefined) {
        if (!missing.has(digest)) {
          missing.add(digest);
          warnings.push({ code: `${PACK}.missing_entry`, message: `路径 ${row.path} 点名的条目 ${digest.slice(0, 12)} 不在视图里` });
        }
        continue;
      }
      if (entry.kind !== 'case') continue;
      sawCase = true;
      const document = scalar(entry.data.document);
      const node = scalar(entry.data.node);
      if (document === null || node === null) {
        warnings.push({ code: `${PACK}.case_without_id`, message: `路径 ${row.path} 上有一条用例没有文档编号或节点编号，没有列入范围` });
        continue;
      }
      const id = `${document}:${node}`;
      if (id.length > MAX_ID) {
        warnings.push({ code: `${PACK}.case_id_too_long`, message: `用例 ${clip(id, 40)} 的编号超过 ${MAX_ID} 个字符，没有列入范围` });
        continue;
      }
      const title = typeof entry.data.title === 'string' && entry.data.title.trim() !== '' ? entry.data.title.trim() : entry.statement.trim() !== '' ? entry.statement.trim() : '（无标题）';
      const priority = typeof entry.data.priority === 'number' && Number.isFinite(entry.data.priority) ? entry.data.priority : null;
      const negative = entry.data.negative === true;
      const side = byPath.get(row.path)!;
      let acc = byId.get(id);
      if (acc === undefined) {
        acc = { document, node, title, priority, negative, chosen: digest, reasons: new Map() };
        byId.set(id, acc);
      } else if (digest < acc.chosen) {
        acc.chosen = digest;
        acc.title = title;
        acc.priority = priority;
        acc.negative = negative;
      }
      // The reason only remembers the change kind of its path; the detail row is joined by index after the details
      // are sorted. The item's ground is the least digest's reference, by comparison — never the view's order.
      if (acc.reasons.get(row.path) === undefined) acc.reasons.set(row.path, row.change);
    }
    if (!sawCase) uncovered.push(row);
  }
  casesBeforeFilter = byId.size;

  let kept = [...byId.entries()];
  if (parameters.priorities !== null) {
    const wanted = new Set(parameters.priorities);
    kept = kept.filter(([, acc]) => acc.priority !== null && wanted.has(acc.priority));
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  uncovered.sort(comparePath);
  considered.sort(comparePath);

  // The per-path details (once per path): the kind, the definition change, a short line, the first 3 field
  // differences, the tree references of the changed definition entries and the count of the later-build cases on it.
  const detailRows = new Map<string, PathDetail>();
  for (const [path, side] of byPath) {
    const detail = detailsOf(path, side, view, warnings, missing);
    const cases = (placed.get(path)?.to ?? []).filter((digest) => view.entries.get(digest)?.kind === 'case').length;
    detailRows.set(path, { path, change: detail.change, definition_change: detail.definitionChange, conclusion: detail.conclusion, differences: detail.differences.slice(0, 3), references: detail.references, cases });
  }
  const details = [...detailRows.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const detailIndex = new Map(details.map((row, index) => [row.path, index]));

  const items: ScopeItem[] = kept.map(([id, acc]) => {
    const reasons = [...acc.reasons.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, change]) => ({ detail: detailIndex.get(path) as number, change }));
    const first = details[reasons[0].detail];
    const priority = acc.priority === null ? '未给出' : String(acc.priority);
    const summary = clip(`优先级 ${priority}；文档 ${acc.document}；${reasons.length} 条命令有变更；${first.path} ${first.conclusion}`, MAX_SUMMARY);
    return {
      id,
      label: clip(acc.title, MAX_LABEL),
      summary,
      document: acc.document,
      node: acc.node,
      title: acc.title,
      priority: acc.priority,
      negative: acc.negative,
      entry: acc.chosen,
      reasons,
    };
  });

  const parts: string[] = [`比较 ${view.fromBuild} 与 ${view.toBuild}。`];
  if (items.length === 0) {
    if (considered.length === 0) parts.push('两个构建之间没有纳入范围的变更路径，回归范围是空的。');
    else if (parameters.priorities !== null && casesBeforeFilter > 0) parts.push('按优先级筛选后没有用例留在回归范围内。');
    else parts.push('变更路径上没有后一构建的用例，回归范围是空的。');
  } else parts.push(`回归范围共 ${items.length} 条用例。`);
  if (view.skippedTo > 0) parts.push(`后一构建的索引缺少 ${view.skippedTo} 份列出的文档，未覆盖的路径可能是用例没有被读到。`);
  if (view.truncated) parts.push(`影响视图被截断，变更路径共 ${view.changedPaths} 条，列出的不是全部。`);
  const message = parts.join('');
  if (items.length === 0) warnings.unshift({ code: `${PACK}.empty_scope`, message });
  if (view.skippedTo > 0) warnings.push({ code: `${PACK}.index_skipped`, message: `后一构建的索引缺少 ${view.skippedTo} 份列出的文档，未覆盖的路径可能是用例没有被读到。` });
  if (view.truncated) warnings.push({ code: `${PACK}.truncated`, message: `影响视图被截断，变更路径共 ${view.changedPaths} 条，列出的不是全部。` });

  return {
    items,
    warnings,
    note: {
      kind: PACK,
      considered,
      uncovered,
      skipped_to: view.skippedTo,
      skipped_from: view.skippedFrom,
      truncated: view.truncated,
      changed_paths: view.changedPaths,
      include_added: parameters.includeAdded,
      message,
      details,
    },
  };
}

/** The one ground of an item's outcome: the item's own location reference (the case entry fragment; definition
 * references live once per path in note.details, never repeated per claim). */
export function groundsOf(item: { location?: unknown }): string[] {
  return typeof item.location === 'string' ? [item.location] : [];
}
