// Presence only: a case with several synonymous tags may contribute several rows, so no per-type case count is stated.
import { CANONICAL_TAGS, canonicalTag, TYPE_LABELS } from './tags.ts';
import type { FacetViewData, GroupBoard, TypeCoverage } from './types.ts';

export function attachCoverage(groups: GroupBoard[], view: FacetViewData): void {
  const partial = view.truncated || view.skipped > 0;
  const facts = new Map<string, { present: Set<string>; untagged: number; sawNull: boolean }>();
  for (const row of view.rows) {
    const line = typeof row.values.line === 'string' ? row.values.line : null;
    const module = typeof row.values.module === 'string' ? row.values.module : null;
    const key = JSON.stringify([line, module]);
    const held = facts.get(key) ?? { present: new Set<string>(), untagged: 0, sawNull: false };
    if (row.values.tags === null) { held.untagged += row.count; held.sawNull = true; }
    else { const tag = canonicalTag(row.values.tags); if (tag !== null) held.present.add(tag); }
    facts.set(key, held);
  }
  for (const group of groups) {
    const held = facts.get(JSON.stringify([group.line, group.module]));
    const present = held?.present ?? new Set<string>();
    group.coverage = { present: CANONICAL_TAGS.filter((tag) => present.has(tag)).map((tag) => TYPE_LABELS[tag]), missing: CANONICAL_TAGS.filter((tag) => !present.has(tag)).map((tag) => TYPE_LABELS[tag]), untagged: held?.sawNull || !view.truncated ? held?.untagged ?? 0 : null, partial, source: view.source };
  }
}
export function coverageSummary(coverage?: TypeCoverage): string {
  if (!coverage) return '';
  const scope = coverage.partial ? '（部分）在已读的来源里没看到这些类型的标签' : '没有用例带这些类型的标签';
  return `；未打标签 ${coverage.untagged === null ? '数未读到' : `${coverage.untagged} 个`}；${scope}：${coverage.missing.join('、') || '无'}`;
}
