// Presence over exact, valid author declarations; a multi-tag case can contribute multiple rows, never multiple cases.
import {declaredResourceTag} from './generated/vocabulary.ts';
import { CANONICAL_TAGS, canonicalTag, TYPE_LABELS } from './tags.ts';
import type { FacetViewData, GroupBoard, TypeCoverage } from './types.ts';

export function attachCoverage(groups: GroupBoard[], view: FacetViewData): void {
  const partial = view.truncated || view.skipped > 0;
  const facts = new Map<string, { present: Set<string>; untagged: number; sawNull: boolean; invalid: Map<string,number>; invalidSource:boolean }>();
  for (const row of view.rows) {
    const line = typeof row.values.line === 'string' ? row.values.line : null;
    const module = typeof row.values.module === 'string' ? row.values.module : null;
    const key = JSON.stringify([line, module]);
    const held = facts.get(key) ?? { present: new Set<string>(), untagged: 0, sawNull: false, invalid:new Map(),invalidSource:false };
    if(row.values.tag_valid===false)held.invalidSource=true;
    if (row.values.tags === null && row.values.resource_empty===true) { held.untagged += row.count; held.sawNull = true; }
    else if(row.values.tag_valid===true){const tag=canonicalTag(row.values.tags);if(tag!==null)held.present.add(tag);}
    else if(typeof row.values.tags==='string'&&declaredResourceTag(row.values.tags)===null){held.invalid.set(row.values.tags,(held.invalid.get(row.values.tags)??0)+row.count);}
    facts.set(key, held);
  }
  for (const group of groups) {
    const held = facts.get(JSON.stringify([group.line, group.module]));
    const present = held?.present ?? new Set<string>();
    group.coverage = { present: CANONICAL_TAGS.filter((tag) => present.has(tag)).map((tag) => TYPE_LABELS[tag]), missing: CANONICAL_TAGS.filter((tag) => !present.has(tag)).map((tag) => TYPE_LABELS[tag]), untagged: held?.sawNull || !view.truncated ? held?.untagged ?? 0 : null, type_undeclared:group.counts.type_unclassified??0,invalid_source:held?.invalidSource??false, invalid_values:[...(held?.invalid??new Map())].map(([raw,count])=>({raw,count})), partial, source: view.source };
  }
}
export function coverageSummary(coverage?: TypeCoverage): string {
  if (!coverage) return '';
  const scope = coverage.partial || (coverage.type_undeclared??0)>0 ? '在已读且有效声明类型的用例里未见这些标签' : '没有有效声明用例带这些类型的标签';
  return `；未打标签 ${coverage.untagged === null ? '数未读到' : `${coverage.untagged} 个`}；${scope}；测试类型未声明 ${coverage.type_undeclared??0} 个，下一步作者按闭集补 resource 后重产：${coverage.missing.join('、') || '无'}`;
}
