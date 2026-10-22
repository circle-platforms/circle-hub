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
  code: string;
  path: string;
  change: 'removed' | 'modified';
  /** Tree references to the changed definition entries of the path — the detail lives on the run-level note, once. */
  references: string[];
  case: { entry: string; reference: string };
}

/** One row per changed path at the run level: the change kind and the field differences (the check reads 字段差异 N 处
 * from here; the items never repeat the diffs). */
export interface PathDetail {
  path: string;
  change: 'removed' | 'modified';
  fields: FieldDiff[];
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
  /** One row per changed path (at most 400): the change kind and the field differences of that path. */
  details: PathDetail[];
}

export interface SweepResult {
  items: SweepItem[];
  note: SweepNote;
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

function definitionData(view: NormView, digests: readonly string[], warnings: Warning[], seen: Set<string>, path: string): { data: unknown[]; missing: boolean } {
  const data: unknown[] = [];
  let missing = false;
  for (const digest of uniqueSorted(digests)) {
    const entry = view.entries.get(digest);
    if (entry === undefined) {
      missing = true;
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

/** What the run note says about cases the index does not hold. */
export function indexNote(skippedFrom: number): string {
  const base = '索引没有收录的用例，这里不作结论。';
  if (skippedFrom > 0) return `较早构建的索引缺少 ${skippedFrom} 份列出的文档，没有维护项并不能证明没有过期的用例。${base}`;
  return base;
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

  const hasCaseKind = view.attachedKinds.includes('case');
  if (!hasCaseKind) warnings.push({ code: `${PACK}.no_case_kind`, message: '影响视图的附着种类里没有用例（case），维护巡检里不会有用例' });

  const byId = new Map<string, Acc>();
  for (const path of [...byPath.keys()].sort()) {
    const side = byPath.get(path)!;
    if (side.change === 'added') continue;
    if (side.change !== 'removed' && side.change !== 'modified') continue;
    let fields: FieldDiff[] = [];
    if (side.change === 'modified') {
      const before = definitionData(view, side.before, warnings, missing, path);
      const after = definitionData(view, side.after, warnings, missing, path);
      fields = definitionDiff(before.data, after.data, parameters.ignoreFields);
      // A named definition that is not in the view is not evidence that the two sides agree.
      if (fields.length === 0 && (before.missing || after.missing)) fields = [{ path: '/', before: null, after: null }];
    }
    if (side.change === 'modified' && fields.length === 0) continue;
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
      const previous = acc.reasons.get(path);
      if (previous === undefined || digest < previous.case.entry) {
        // The field differences stay on the per-path detail (once); the item cites the path and the tree references.
        const beforeCited = cited(view, side.before, warnings, missing, path);
        const afterCited = cited(view, side.after, warnings, missing, path);
        detailRows.set(path, { path, change: side.change, fields });
        acc.reasons.set(path, {
          code: side.change === 'removed' ? REMOVED : CHANGED,
          path,
          change: side.change,
          references: uniqueSorted([...beforeCited, ...afterCited].map((c) => c.reference).filter((r) => r !== '')),
          case: { entry: digest, reference: entry.reference },
        });
      }
    }
  }

  const kept = [...byId.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const items: SweepItem[] = kept.map(([id, acc]) => {
    const reasons = [...acc.reasons.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const first = reasons[0];
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
  parts.push(indexNote(view.skippedFrom));
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
      details: [...detailRows.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, 400),
    },
  };
}

const TREE = /^tree:[0-9a-f]{64}\/(?:[^/@]+(?:\/[^/@]+)*)?@[0-9a-f]{64}$/;

/** Tree references of the case entry and of the definition entries named on the reasons. */
export function groundsOf(reasons: readonly { case: { reference: string }; references: string[] }[]): string[] {
  const refs: string[] = [];
  for (const reason of reasons) {
    if (TREE.test(reason.case.reference)) refs.push(reason.case.reference);
    for (const reference of reason.references) {
      if (TREE.test(reference)) refs.push(reference);
    }
  }
  return uniqueSorted(refs);
}
