// The join of the traceability matrix: the defects of the build (the defect index of its release notes) against the case
// index keyed by the defect ids the case documents carry. Ids compare after the digit normalisation of ids.ts; both sides
// are grouped by the normalised id first, so the join is a lookup, not a cross product. Deterministic: every list is sorted
// in code-unit order and nothing depends on the member order of the views.
import { normalizeId } from './ids.ts';
import { clip, compareText, strings } from './text.ts';
import type { CaseRef, IndexViewData, MatrixRow, ViewEntry } from './types.ts';

/** The defect statuses an entry may carry (data.status of a release-note defect entry). */
export const STATUS_TEXT: Readonly<Record<string, string>> = { fixed: '已修复', known: '已知（未修复）' };
/** The short forms, for the conflict enumeration. */
export const STATUS_SHORT: Readonly<Record<string, string>> = { fixed: '已修复', known: '已知' };

/** The status part of a summary or a statement: one status, or the conflict spelled out. */
export function statusText(statuses: readonly string[]): string {
  if (statuses.length > 1) return `状态矛盾（${statuses.map((s) => STATUS_SHORT[s] ?? s).join('、')}）`;
  return statuses.length === 1 ? (STATUS_TEXT[statuses[0]] ?? statuses[0]) : '状态未知';
}

/** The collision note when the defect entries name more than one system: the matrix joins by the number alone. */
export function systemNote(systems: readonly string[]): string {
  return systems.length > 1 ? `；系统 ${systems.join('、')}（两个系统的缺陷号可能撞号）` : '';
}

/** The item summary: the status and the number of cases; an untraced defect says unknown, never a failure. */
export function summaryOf(row: Pick<MatrixRow, 'statuses' | 'cases' | 'systems'>): string {
  const traced = row.cases.length > 0 ? `${row.cases.length} 个用例` : '无已索引用例（未知）';
  return clip(`${statusText(row.statuses)}；${traced}${systemNote(row.systems)}`, 200);
}

/** A case entry as the matrix lists it: the case's node id (data.node, what the cases producer writes), else data.case,
 * else the digest. */
function caseRefOf(digest: string, entry: ViewEntry): CaseRef {
  const data = entry.data;
  const id = typeof data.node === 'string' && data.node !== '' ? data.node : typeof data.case === 'string' && data.case !== '' ? data.case : digest;
  const title = typeof data.title === 'string' && data.title !== '' ? data.title : entry.statement;
  const document = typeof data.document === 'string' && data.document !== '' ? data.document : null;
  const defects = [...new Set(strings(data.defects))].sort(compareText);
  return { case: id, title, document, reference: entry.reference, defects, entry: digest };
}

/**
 * The matrix: one row per normalised bug id the defects view lists with a selected status. The statuses filter applies to
 * the defect entries; a bug whose entries are all filtered out is no item at all. Case entries missing from the view's
 * entries record (warned about at the reading) simply take no part.
 */
export function buildMatrix(defects: IndexViewData, cases: IndexViewData, statuses: readonly string[]): MatrixRow[] {
  // The case index, re-keyed by the normalised id: normalised id -> digest -> entry.
  const byBug = new Map<string, Map<string, ViewEntry>>();
  for (const [raw, digests] of Object.entries(cases.keys)) {
    const norm = normalizeId(raw);
    let bucket = byBug.get(norm);
    if (bucket === undefined) byBug.set(norm, (bucket = new Map()));
    for (const digest of digests) {
      const entry = cases.entries[digest];
      if (entry !== undefined) bucket.set(digest, entry);
    }
  }
  // The defects, grouped by the normalised id: one bug may be written with leading zeros in one entry and plain in another.
  const groups = new Map<string, { ids: Set<string>; entries: Map<string, ViewEntry> }>();
  for (const [raw, digests] of Object.entries(defects.keys)) {
    const norm = normalizeId(raw);
    for (const digest of digests) {
      const entry = defects.entries[digest];
      if (entry === undefined) continue;
      const status = entry.data.status;
      if (typeof status !== 'string' || !statuses.includes(status)) continue;
      let group = groups.get(norm);
      if (group === undefined) groups.set(norm, (group = { ids: new Set(), entries: new Map() }));
      group.ids.add(raw);
      group.entries.set(digest, entry);
    }
  }
  const rows: MatrixRow[] = [];
  for (const [bug, group] of groups) {
    const entries = [...group.entries.entries()].sort(([a], [b]) => compareText(a, b));
    const statusList = [...new Set(entries.map(([, entry]) => entry.data.status as string))].sort(compareText);
    const systemList = [...new Set(entries.map(([, entry]) => entry.data.system).filter((system): system is string => typeof system === 'string' && system !== ''))].sort(compareText);
    const bucket = byBug.get(bug);
    const caseRefs: CaseRef[] = [];
    if (bucket !== undefined) {
      for (const [digest, entry] of bucket) caseRefs.push(caseRefOf(digest, entry));
      caseRefs.sort((a, b) => compareText(a.case, b.case) || compareText(a.document ?? '', b.document ?? '') || compareText(a.reference, b.reference));
    }
    rows.push({
      bug,
      ids: [...group.ids].sort(compareText),
      statuses: statusList,
      conflict: statusList.length > 1,
      statement: entries[0][1].statement,
      references: entries.map(([, entry]) => entry.reference).sort(compareText),
      digests: entries.map(([digest]) => digest),
      cases: caseRefs,
      systems: systemList,
    });
  }
  rows.sort((a, b) => compareText(a.bug, b.bug));
  return rows;
}
