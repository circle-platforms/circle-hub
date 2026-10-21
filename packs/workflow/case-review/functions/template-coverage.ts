// Template coverage (pack function): which categories of the team template the items of a run show, with the item ids as
// evidence. A cross-item fact: tables/template-v3-coverage.json (coverage@1) judges `required`, `covered` and `skipped`.
// A category is shown by a canonical tag, or by a keyword (contains / prefix / equals) in the texts it names. Literal
// keywords only, no patterns, so the template stays an admissible table (C04 R[0]); a template that fails admission is refused.
import { PACK, failure, guarded, isRecord, warningSink } from './common.ts';
import { CANONICAL_TAGS, canonicalTags } from './tags.ts';
import { collapseRuns, fold, isBlank } from './text.ts';
import type { CanonicalTag, CategoryFact, CoverageOutput, CoverageSkip, TemplateField } from './types.ts';

const FIELDS: readonly TemplateField[] = ['path', 'title', 'steps', 'expected', 'preconditions'];
const DEFAULT_FIELDS: readonly TemplateField[] = ['path', 'title'];
const MAX_EVIDENCE = 50;
const CATEGORY_ID = /^[a-z][a-z0-9_]{0,63}$/;

const ARROW = /\s*(?:→|⟶|⇒|=>|—>|–>|-+>)\s*/gu;

/** Matching form of item texts: NFKC, lower case, white space collapsed and trimmed, every arrow written as "->". */
export function matchForm(text: string): string {
  return fold(text).replace(ARROW, '->');
}

/** Matching form of a keyword: like matchForm, but a space at either end stays, so " add " does not match "address". */
export function keywordForm(keyword: string): string {
  return collapseRuns(keyword.normalize('NFKC')).toLowerCase().replace(ARROW, '->');
}

type Category = {
  id: string;
  label: string;
  group: string | null;
  required: boolean;
  tags: CanonicalTag[];
  contains: string[];
  prefixes: string[];
  equals: string[];
  fields: TemplateField[];
};

const TEMPLATE_KEYS = new Set(['schema', 'id', 'origin', 'description', 'categories']);
const CATEGORY_KEYS = new Set(['id', 'label', 'group', 'required', 'tags', 'contains', 'prefixes', 'equals', 'fields']);
const shown = (value: unknown): string => String(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 40);

/** Keywords: absent, or an array of non-blank strings; null when the value is not that. */
function keywords(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && !isBlank(entry))) return null;
  return value as string[];
}

function readCategory(entry: unknown, seen: Set<string>): Category | string {
  if (!isRecord(entry)) return '不是对象';
  for (const key of Object.keys(entry)) if (!CATEGORY_KEYS.has(key)) return `多了不认识的成员 ${shown(key)}`;
  if (typeof entry.id !== 'string' || !CATEGORY_ID.test(entry.id)) return 'id 不合法（小写字母开头，只含小写字母、数字和下划线）';
  if (seen.has(entry.id)) return `id ${entry.id} 重复`;
  if (entry.label !== undefined && (typeof entry.label !== 'string' || isBlank(entry.label))) return 'label 不是非空文字';
  if (entry.group !== undefined && (typeof entry.group !== 'string' || isBlank(entry.group))) return 'group 不是非空文字';
  if (entry.required !== undefined && typeof entry.required !== 'boolean') return 'required 不是布尔值';
  const tags = entry.tags === undefined ? [] : entry.tags;
  if (!Array.isArray(tags) || !tags.every((tag) => (CANONICAL_TAGS as readonly unknown[]).includes(tag))) return `tags 只能列规范类别（${CANONICAL_TAGS.join('、')}）`;
  const fields = entry.fields === undefined ? [...DEFAULT_FIELDS] : entry.fields;
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every((field) => (FIELDS as readonly unknown[]).includes(field))) return `fields 只能列 ${FIELDS.join('、')}`;
  const contains = keywords(entry.contains);
  const prefixes = keywords(entry.prefixes);
  const equals = keywords(entry.equals);
  if (contains === null || prefixes === null || equals === null) return 'contains、prefixes、equals 要么不写，要么是非空文字的数组';
  if (tags.length === 0 && contains.length === 0 && prefixes.length === 0 && equals.length === 0) return '没有任何判定条件';
  return {
    id: entry.id,
    label: typeof entry.label === 'string' ? entry.label : entry.id,
    group: typeof entry.group === 'string' ? entry.group : null,
    required: entry.required !== false,
    tags: tags as CanonicalTag[],
    contains: contains.map(keywordForm),
    prefixes: prefixes.map(keywordForm),
    equals: equals.map(matchForm),
    fields: fields as TemplateField[],
  };
}

/** Admission of the template table (C04 R[0]): a closed shape, literal keywords only, and an origin. */
function readTemplate(raw: unknown): { id: string; categories: Category[] } | string {
  if (!isRecord(raw)) return '不是对象';
  for (const key of Object.keys(raw)) if (!TEMPLATE_KEYS.has(key)) return `多了不认识的成员 ${shown(key)}`;
  if (raw.schema !== 'case-review.template@1') return 'schema 应为 case-review.template@1';
  if (typeof raw.id !== 'string' || isBlank(raw.id)) return 'id 缺失或为空';
  if (typeof raw.origin !== 'string' || isBlank(raw.origin)) return 'origin 缺失或为空（表要写明产生它的源文件或决定）';
  if (raw.description !== undefined && typeof raw.description !== 'string') return 'description 不是文字';
  if (!Array.isArray(raw.categories) || raw.categories.length === 0) return 'categories 不是非空数组';
  const categories: Category[] = [];
  const seen = new Set<string>();
  for (const [position, entry] of raw.categories.entries()) {
    const category = readCategory(entry, seen);
    if (typeof category === 'string') return `第 ${position + 1} 个类别${category}`;
    seen.add(category.id);
    categories.push(category);
  }
  return { id: raw.id, categories };
}

type Searchable = { id: string; tags: Set<CanonicalTag>; texts: Map<TemplateField, string[]> };

function searchable(item: unknown): Searchable | null {
  if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.fields)) return null;
  const fields = item.fields;
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  const steps = Array.isArray(fields.steps) ? fields.steps.filter(isRecord).map((step) => (typeof step.text === 'string' ? step.text : '')) : [];
  const tagSource = Array.isArray(fields.tags) ? fields.tags : strings(fields.tagsNormalized);
  const texts = new Map<TemplateField, string[]>([
    ['path', strings(fields.path).map(matchForm)],
    ['title', typeof fields.title === 'string' ? [matchForm(fields.title)] : []],
    ['steps', steps.map(matchForm)],
    ['expected', strings(fields.expected).map(matchForm)],
    ['preconditions', strings(fields.preconditions).map(matchForm)],
  ]);
  return { id: item.id, tags: new Set(canonicalTags(tagSource)), texts };
}

function shows(category: Category, item: Searchable): boolean {
  if (category.tags.some((tag) => item.tags.has(tag))) return true;
  for (const field of category.fields) {
    for (const text of item.texts.get(field) ?? []) {
      // Padded, so a keyword with a space at an end also matches at the start or the end of the text.
      const padded = ` ${text} `;
      if (category.contains.some((keyword) => padded.includes(keyword))) return true;
      if (category.prefixes.some((prefix) => text.startsWith(prefix))) return true;
      if (category.equals.includes(text)) return true;
    }
  }
  return false;
}

export function templateCoverage(input: unknown): CoverageOutput {
  const warnings = warningSink();
  if (!isRecord(input) || !Array.isArray(input.items)) return failure('invalid_input', '输入里没有 items 数组', '按 { items, template, skipped? } 传入投影出的条目和模板表');
  const template = readTemplate(input.template);
  if (typeof template === 'string') return failure('template_invalid', `模板表不可用：${template}`, '传入任务包里的 tables/template-v3.json，或按 case-review.template@1 改正模板表');
  const items: Searchable[] = [];
  let ignored = 0;
  for (const raw of input.items) {
    const item = searchable(raw);
    if (item === null) ignored += 1;
    else items.push(item);
  }
  if (ignored > 0) warnings.add({ code: `${PACK}.item_ignored`, message: `${ignored} 个条目缺少 id 或 fields，没有参与覆盖统计`, data: { count: ignored } });

  const known = new Set(template.categories.map((category) => category.id));
  const skipped: CoverageSkip[] = [];
  for (const raw of Array.isArray(input.skipped) ? input.skipped : []) {
    const category = isRecord(raw) && typeof raw.category === 'string' ? raw.category : null;
    const valid = category !== null && known.has(category) && isRecord(raw) && typeof raw.reason === 'string' && !isBlank(raw.reason);
    if (valid && !skipped.some((skip) => skip.category === category)) {
      skipped.push({ category, reason: raw.reason as string });
      continue;
    }
    // The first valid skip of a category counts; later ones and invalid ones are reported.
    const message = valid ? `类别 ${category} 已经声明过跳过，这一条已忽略` : '一条跳过声明没有已知的类别或没有写理由，已忽略';
    warnings.add({ code: `${PACK}.skip_ignored`, message, data: { category: category === null ? null : category.slice(0, 64) } });
  }
  const skippedIds = new Set(skipped.map((skip) => skip.category));

  const categories: CategoryFact[] = template.categories.map((category) => {
    const evidence: string[] = [];
    let count = 0;
    for (const item of items) {
      if (!shows(category, item)) continue;
      count += 1;
      if (evidence.length < MAX_EVIDENCE) evidence.push(item.id);
    }
    return { id: category.id, label: category.label, group: category.group, required: category.required, present: count > 0, count, evidence };
  });
  const required = categories.filter((fact) => fact.required).map((fact) => fact.id);
  const covered = categories.filter((fact) => fact.present).map((fact) => fact.id);
  const missing = categories.filter((fact) => fact.required && !fact.present && !skippedIds.has(fact.id)).map((fact) => fact.id);
  return { template: template.id, required, covered, missing, skipped, categories, warnings: warnings.list() };
}

export default function (input: unknown): unknown {
  return guarded(() => templateCoverage(input));
}
