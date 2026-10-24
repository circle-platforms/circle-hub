// Category metadata is a closed declaration, never a program over case text. Mandatory scope belongs to the policy table.
import POLICY from '../tables/template-v3-coverage.json' with { type: 'json' };
import type { DocumentCases } from './cases.ts';
import type { AuthoredCategoryFields } from '../../../../contracts/generated/shared-interfaces.ts';
import { isRecord } from './common.ts';
import { isBlank } from './text.ts';
import type { CategoryFact } from './types.ts';
export const TEMPLATE_SCHEMA = 'template-gap.template@2';
export const MAX_EVIDENCE = 20;
export type Category = { id: string; label: string; group: string | null; description: string; required: boolean };
export type Template = { id: string; categories: Category[] };
const TEMPLATE_KEYS = new Set(['schema', 'id', 'origin', 'description', 'categories']);
const CATEGORY_KEYS = new Set(['id', 'label', 'group', 'description']);
export function readTemplate(raw: unknown): Template | string {
  if (!isRecord(raw)) return '不是对象';
  for (const key of Object.keys(raw)) if (!TEMPLATE_KEYS.has(key)) return `多了不认识的成员 ${key}`;
  if (raw.schema !== TEMPLATE_SCHEMA) return `schema 应为 ${TEMPLATE_SCHEMA}`;
  for (const key of ['id', 'origin']) if (typeof raw[key] !== 'string' || isBlank(raw[key] as string)) return `${key} 缺失或为空`;
  if (raw.description !== undefined && typeof raw.description !== 'string') return 'description 不是文字';
  if (!Array.isArray(raw.categories) || !raw.categories.length) return 'categories 不是非空数组';
  const seen = new Set<string>();
  const categories: Category[] = [];
  for (const [at, row] of raw.categories.entries()) {
    const error = (message: string) => `第 ${at + 1} 个类别${message}`;
    if (!isRecord(row)) return error('不是对象');
    for (const key of Object.keys(row)) if (!CATEGORY_KEYS.has(key)) return error(`多了不认识的成员 ${key}`);
    if (typeof row.id !== 'string' || !row.id.length || row.id.length > 200) return error('id 不合法');
    if (seen.has(row.id)) return error(`id ${row.id} 重复`);
    for (const key of ['label', 'group', 'description']) if (typeof row[key] !== 'string' || isBlank(row[key] as string)) return error(`${key} 缺失或为空`);
    seen.add(row.id);
    categories.push({ id: row.id, label: row.label as string, group: row.group as string, description: row.description as string, required: POLICY.required.values.includes(row.id) });
  }
  return { id: raw.id as string, categories };
}
/** The original author's category field, without trimming, folding, tag aliases or semantic inference. */
export function authoredCategories(template: Template, raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const known = new Set(template.categories.map(c => c.id));
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 256 || !raw.every(id => typeof id === 'string' && known.has(id))) {
    throw new Error(`category_ids 必须是非空数组，每项精确等于闭集编号：${[...known].join('、')}`);
  }
  const ids: NonNullable<AuthoredCategoryFields['category_ids']> = raw;
  return [...new Set(ids)];
}
export function categoryFacts(template: Template, document: Pick<DocumentCases, 'cases' | 'nodes'>, options: { evidenceLimit?: number; memberships?: ReadonlyMap<string, readonly string[]> } = {}): CategoryFact[] {
  const members = document.cases.map(c => ({ id: c.id, categories: options.memberships?.get(c.id) ?? authoredCategories(template, c.category_ids) ?? [] }));
  return template.categories.map(category => {
    const ids = [...new Set(members.filter(c => c.categories.includes(category.id)).map(c => c.id))].sort();
    return { id: category.id, label: category.label, group: category.group, required: category.required, present: ids.length > 0, count: ids.length, evidence: ids.slice(0, options.evidenceLimit ?? MAX_EVIDENCE) };
  });
}
