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
  path: string;
  change: 'added' | 'modified';
  /** What happened to the command definition on the path, read from the definition entries of both sides. */
  definition_change: 'added' | 'removed' | 'modified' | 'none';
  /** One line for a person: 新增命令 / 删除命令 / 命令定义有变更 / 仅说明文字有变更. */
  conclusion: string;
  before: Cited[];
  after: Cited[];
  case: { entry: string; reference: string };
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
  change: 'added' | 'modified';
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
}

export interface ScopeResult {
  items: ScopeItem[];
  note: ScopeNote;
  warnings: Warning[];
}

interface Side {
  change: 'added' | 'removed' | 'modified';
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
  reasons: Map<string, Reason>;
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
function definitionChangeOf(before: Cited[], after: Cited[]): Reason['definition_change'] {
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
function conclusionOf(change: Reason['definition_change']): string {
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
    let kind: Side['change'] = change.change === 'added' || change.change === 'removed' || change.change === 'modified' ? change.change : 'modified';
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
      const previous = acc.reasons.get(row.path);
      if (previous === undefined || digest < previous.case.entry) {
        const before = cited(view, side.before, warnings, missing, row.path);
        const after = cited(view, side.after, warnings, missing, row.path);
        const definitionChange = definitionChangeOf(before, after);
        acc.reasons.set(row.path, {
          path: row.path,
          change: row.change,
          definition_change: definitionChange,
          conclusion: conclusionOf(definitionChange),
          before,
          after,
          case: { entry: digest, reference: entry.reference },
        });
      }
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

  const items: ScopeItem[] = kept.map(([id, acc]) => {
    const reasons = [...acc.reasons.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const first = reasons[0];
    const priority = acc.priority === null ? '未给出' : String(acc.priority);
    const summary = clip(`优先级 ${priority}；文档 ${acc.document}；${reasons.length} 条命令有变更；${first.path} ${conclusionOf(first.definition_change)}`, MAX_SUMMARY);
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
    },
  };
}

const TREE = /^tree:[0-9a-f]{64}\/(?:[^/@]+(?:\/[^/@]+)*)?@[0-9a-f]{64}$/;

/** Tree references of the case entry and of the definition entries named on the reasons. */
export function groundsOf(reasons: readonly { case: { reference: string }; before: Cited[]; after: Cited[] }[]): string[] {
  const refs: string[] = [];
  for (const reason of reasons) {
    if (TREE.test(reason.case.reference)) refs.push(reason.case.reference);
    for (const side of [...reason.before, ...reason.after]) {
      if (side.kind === 'definition' && TREE.test(side.reference)) refs.push(side.reference);
    }
  }
  return uniqueSorted(refs);
}
