import { CHANGE_KIND } from './generated/vocabulary.ts';
import type { ChangeKind } from '../../../../contracts/generated/vocabulary.ts';
// Maintenance sweep (capability 4b). A case of the earlier build needs maintenance when it sits on a removed path, or
// on a modified path whose definition data differ. A behaviour-only change is not an item. An added path is not an
// item. One case on several such paths is one item. Output order follows ids and paths, never the order of the view.

import { definitionDiff, type FieldDiff } from './diff.ts';
import { CHANGE_LABEL, PACK, clip, isRecord, uniqueSorted } from './text.ts';
import type { Cited, NormView } from './view.ts';

export interface Parameters {
  /** Top-level definition fields left out of the diff. Default none. */
  ignoreFields: string[];
}

export interface Reason {
  /** The index of the path in the run-level details table (note.details); the path string is there, once. */
  detail: number;
  change: Extract<ChangeKind, Extract<ChangeKind, Extract<ChangeKind, 'removed' | 'modified'>>>;
}

/** One row per changed path at the run level: the change kind, the field differences (the check reads 字段差异 N 处
 * from here) and the tree references of the changed definition entries; the items cite the row by its index and
 * never repeat it. */
export interface PathDetail {
  path: string;
  change: Extract<ChangeKind, Extract<ChangeKind, Extract<ChangeKind, 'removed' | 'modified'>>>;
  fields: FieldDiff[];
  references: string[];
  /** Definition digests the view named but did not carry (never compared, never fabricated). */
  missing?: string[];
}

export interface SweepItem {
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

export interface Warning {
  code: string;
  message: string;
}

export interface SweepNote {
  kind: typeof PACK;
  skipped_to: number;
  skipped_from: number;
  truncated: boolean;
  changed_paths: number;
  ignore_fields: string[];
  message: string;
  /** The notes the view itself wrote (skipped sources, truncation), carried through for the check to name them. */
  view_notes: string[];
  /** One row per changed path (every path the reasons index): the change kind, the field differences and the tree
   * references of that path. */
  details: PathDetail[];
  /** The whole command diff, one row per changed path with the earlier-build case count on it; the command-diff
   * summary reads this (details covers only the maintenance paths, this table never drops one). */
  diff: { path: string; change: ChangeKind; cases: number }[];
}

export interface SweepResult {
  items: SweepItem[];
  note: SweepNote;
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
  reasons: Map<string, Extract<ChangeKind, Extract<ChangeKind, Extract<ChangeKind, 'removed' | 'modified'>>>>;
}

const MAX_ID = 200;
const MAX_SUMMARY = 200;
const MAX_LABEL = 200;
const REMOVED = `${PACK}.case.command_removed`;
const CHANGED = `${PACK}.case.command_changed`;

export function readParameters(value: unknown): { parameters: Parameters; ignored: string[] } {
  const raw = isRecord(value) ? value : {};
  const ignored: string[] = [];
  let ignoreFields: string[] = [];
  if (Object.hasOwn(raw, 'ignore_fields')) {
    const list = raw.ignore_fields;
    const ok = Array.isArray(list) && list.length <= 40 && list.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 80);
    if (!ok) ignored.push('ignore_fields');
    else ignoreFields = [...new Set(list)];
  }
  return { parameters: { ignoreFields }, ignored };
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

function definitionData(view: NormView, digests: readonly string[], warnings: Warning[], seen: Set<string>, path: string): { data: unknown[]; missing: string[] } {
  const data: unknown[] = [];
  const missing: string[] = [];
  for (const digest of uniqueSorted(digests)) {
    const entry = view.entries.get(digest);
    if (entry === undefined) {
      missing.push(digest);
      if (!seen.has(digest)) {
        seen.add(digest);
        warnings.push({ code: `${PACK}.missing_entry`, message: `路径 ${path} 点名的条目 ${digest.slice(0, 12)} 不在视图里` });
      }
      continue;
    }
    if (entry.kind === 'definition') data.push(entry.data);
  }
  return { data, missing };
}

/** What the run note says about cases the index does not hold; called only when sources were actually skipped. */
export function indexNote(skippedFrom: number): string {
  return `较早构建的索引缺少 ${skippedFrom} 份列出的文档，没有维护项并不能证明没有过期的用例。索引没有收录的用例，这里不作结论。缺少这些文档里用例的命令归属事实；下一步由集成者按视图说明补齐来源、重新同步知识库后重跑巡检，不能把未读范围当成没有。`;
}

/** The cases that need maintenance, and the run-level note. */
export function sweepOf(view: NormView, parameters: Parameters): SweepResult {
  const warnings: Warning[] = [];
  const missing = new Set<string>();
  const byPath = new Map<string, Side>();
  const detailRows = new Map<string, PathDetail>();
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

  const hasCaseKind = view.attachedKinds.includes('case');
  if (!hasCaseKind) warnings.push({ code: `${PACK}.no_case_kind`, message: '影响视图的附着种类里没有用例（case），维护巡检里不会有用例' });

  const byId = new Map<string, Acc>();
  for (const path of [...byPath.keys()].sort()) {
    const side = byPath.get(path)!;
    if (side.change === 'added') continue;
    if (side.change !== 'removed' && side.change !== 'modified') continue;
    let fields: FieldDiff[] = [];
    let missingEntries: string[] = [];
    if (side.change === 'modified') {
      const before = definitionData(view, side.before, warnings, missing, path);
      const after = definitionData(view, side.after, warnings, missing, path);
      fields = definitionDiff(before.data, after.data, parameters.ignoreFields);
      // A named definition that is not in the view is not evidence that the two sides agree: the digests are kept on
      // the detail row and the check records a missing fact for them; a "/ null → null" difference is never written.
      missingEntries = uniqueSorted([...before.missing, ...after.missing]);
    }
    if (side.change === 'modified' && fields.length === 0 && missingEntries.length === 0) continue;
    const digests = placed.get(path)?.from ?? [];
    for (const digest of digests) {
      const entry = view.entries.get(digest);
      if (entry === undefined) {
        if (!missing.has(digest)) {
          missing.add(digest);
          warnings.push({ code: `${PACK}.missing_entry`, message: `路径 ${path} 点名的条目 ${digest.slice(0, 12)} 不在视图里` });
        }
        continue;
      }
      if (entry.kind !== 'case') continue;
      const document = scalar(entry.data.document);
      const node = scalar(entry.data.node);
      if (document === null || node === null) {
        warnings.push({ code: `${PACK}.case_without_id`, message: `路径 ${path} 上有一条用例没有文档编号或节点编号，没有列入维护项` });
        continue;
      }
      const id = `${document}:${node}`;
      if (id.length > MAX_ID) {
        warnings.push({ code: `${PACK}.case_id_too_long`, message: `用例 ${clip(id, 40)} 的编号超过 ${MAX_ID} 个字符，没有列入维护项` });
        continue;
      }
      const title = typeof entry.data.title === 'string' && entry.data.title.trim() !== '' ? entry.data.title.trim() : entry.statement.trim() !== '' ? entry.statement.trim() : '（无标题）';
      const priority = typeof entry.data.priority === 'number' && Number.isFinite(entry.data.priority) ? entry.data.priority : null;
      const negative = entry.data.negative === true;
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
      if (acc.reasons.get(path) === undefined) {
        // The field differences and the tree references stay on the per-path detail (once); the item only remembers
        // the change kind of its path, and cites the detail row by index after the details are sorted.
        const beforeCited = cited(view, side.before, warnings, missing, path);
        const afterCited = cited(view, side.after, warnings, missing, path);
        const change = side.change as Reason['change'];
        detailRows.set(path, { path, change, fields, references: uniqueSorted([...beforeCited, ...afterCited].map((c) => c.reference).filter((r) => r !== '')), ...(missingEntries.length > 0 ? { missing: missingEntries } : {}) });
        acc.reasons.set(path, change);
      }
    }
  }

  const kept = [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const details = [...detailRows.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // The whole command diff (added paths and case-less ones included): the summary lists it, whatever needs maintenance.
  const diff = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, side]) => ({ path, change: side.change, cases: (placed.get(path)?.from ?? []).filter((digest) => view.entries.get(digest)?.kind === 'case').length }));
  const detailIndex = new Map(details.map((row, index) => [row.path, index]));
  const items: SweepItem[] = kept.map(([id, acc]) => {
    const reasons = [...acc.reasons.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, change]) => ({ detail: detailIndex.get(path) as number, change }));
    const first = details[reasons[0].detail];
    const priority = acc.priority === null ? '未给出' : String(acc.priority);
    const summary = clip(`优先级 ${priority}；文档 ${acc.document}；${reasons.length} 处需要维护；${first.path} ${CHANGE_LABEL[first.change]}`, MAX_SUMMARY);
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
  if (items.length === 0) parts.push('没有需要维护的用例。');
  else parts.push(`有 ${items.length} 条用例需要维护。`);
  // Only actually skipped sources make the index note; a fully read scope says so without an unknown.
  if (view.skippedFrom > 0) parts.push(indexNote(view.skippedFrom));
  if (view.truncated) parts.push(`影响视图被截断，变更路径共 ${view.changedPaths} 条，列出的不是全部。`);
  const message = parts.join('');
  if (items.length === 0) warnings.unshift({ code: `${PACK}.clean`, message });
  if (view.skippedFrom > 0 && items.length > 0) warnings.push({ code: `${PACK}.index_skipped`, message: indexNote(view.skippedFrom) });
  if (view.truncated) warnings.push({ code: `${PACK}.truncated`, message: `影响视图被截断，变更路径共 ${view.changedPaths} 条，列出的不是全部。` });

  return {
    items,
    warnings,
    note: {
      kind: PACK,
      skipped_to: view.skippedTo,
      skipped_from: view.skippedFrom,
      truncated: view.truncated,
      changed_paths: view.changedPaths,
      ignore_fields: parameters.ignoreFields,
      message,
      view_notes: view.notes,
      details,
      diff,
    },
  };
}

/** The one ground of an item's outcome: the item's own location reference (the case entry fragment; definition
 * references live once per path in note.details, never repeated per claim). */
export function groundsOf(item: { location?: unknown }): string[] {
  return typeof item.location === 'string' ? [item.location] : [];
}
