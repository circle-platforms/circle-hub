// The team case template (tables/template-v3.json) and which of its categories the cases of a document show (ported from
// case-review's template coverage). A category is shown by a canonical tag, or by a literal keyword (contains / prefix /
// equals) in the case texts it names. Literal keywords only, no patterns, so the template stays an admissible table (C04
// R[0]): a template that fails admission is refused. The evidence of a category is the sorted ids of the cases that show it,
// so the report of a document does not depend on the order of its cases.
// Cost stays linear in the document: every node text is put in its matching form once, and a category's ancestor-path
// keywords are matched once per node, top down, instead of once per case and ancestor.
import type { DocumentCases } from './cases.ts';
import { isRecord } from './common.ts';
import { CANONICAL_TAGS, canonicalTags } from './tags.ts';
import { collapseRuns, fold, isBlank } from './text.ts';
import type { CanonicalTag, CategoryFact, TemplateField } from './types.ts';

export const TEMPLATE_SCHEMA = 'template-gap.template@1';
/** Case ids kept as the evidence of one category; `count` counts them all. */
export const MAX_EVIDENCE = 20;

const FIELDS: readonly TemplateField[] = ['path', 'title', 'steps', 'expected', 'preconditions'];
const DEFAULT_FIELDS: readonly TemplateField[] = ['path', 'title'];
const CATEGORY_ID = /^[a-z][a-z0-9_]{0,63}$/;

// Texts reach this pattern with white space already folded to single spaces, so ` ?` takes the space around an arrow; the
// lookbehind starts a dash arrow only at the first dash of a run. Both keep it linear (a `\s*` or a bare `-+>` backtracks
// quadratically on a long run of dashes or of U+FEFF, which `\s` matches and the white space fold keeps).
const ARROW = / ?(?:→|⟶|⇒|=>|—>|–>|(?<!-)-+>) ?/gu;

/** Matching form of case texts: NFKC, lower case, white space collapsed and trimmed, every arrow written as "->". */
export function matchForm(text: string): string {
  return fold(text).replace(ARROW, '->');
}

/** Matching form of a keyword: like matchForm, but a space at either end stays, so " add " does not match "address". */
export function keywordForm(keyword: string): string {
  return collapseRuns(keyword.normalize('NFKC')).toLowerCase().replace(ARROW, '->');
}

export type Category = {
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

export type Template = { id: string; categories: Category[] };

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

/** Admission of the template table (C04 R[0]): a closed shape, literal keywords only, and an origin. A string says why not. */
export function readTemplate(raw: unknown): Template | string {
  if (!isRecord(raw)) return '不是对象';
  for (const key of Object.keys(raw)) if (!TEMPLATE_KEYS.has(key)) return `多了不认识的成员 ${shown(key)}`;
  if (raw.schema !== TEMPLATE_SCHEMA) return `schema 应为 ${TEMPLATE_SCHEMA}`;
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

/** Whether one text in its matching form shows the category by a keyword. */
function textShows(category: Category, text: string): boolean {
  // Padded, so a keyword with a space at an end also matches at the start or the end of the text.
  const padded = ` ${text} `;
  if (category.contains.some((keyword) => padded.includes(keyword))) return true;
  if (category.prefixes.some((prefix) => text.startsWith(prefix))) return true;
  return category.equals.includes(text);
}

type Searchable = { id: string; parent: number; tags: Set<CanonicalTag>; texts: Map<Exclude<TemplateField, 'path'>, string[]> };

const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What the cases show of every category, in template order; evidence sorted, at most MAX_EVIDENCE ids. */
export function categoryFacts(template: Template, document: Pick<DocumentCases, 'cases' | 'nodes'>, options: { evidenceLimit?: number } = {}): CategoryFact[] {
  const { cases, nodes } = document;
  const forms = nodes.texts.map(matchForm);
  const items: Searchable[] = cases.map((record) => ({
    id: record.id,
    parent: nodes.parents[record.visit],
    tags: new Set(canonicalTags(record.tags)),
    texts: new Map([
      ['title', [forms[record.visit]]],
      ['steps', record.steps.map(matchForm)],
      ['expected', record.expected.map(matchForm)],
      ['preconditions', record.preconditions.map(matchForm)],
    ]),
  }));
  return template.categories.map((category) => {
    // above[v]: node v or one of its ancestors shows the category, so a case shows it by its path when its parent's flag is set.
    let above: Uint8Array | null = null;
    if (category.fields.includes('path')) {
      above = new Uint8Array(forms.length);
      for (let v = 0; v < forms.length; v++) {
        const parent = nodes.parents[v];
        above[v] = (parent !== -1 && above[parent] === 1) || textShows(category, forms[v]) ? 1 : 0;
      }
    }
    const shows = (item: Searchable): boolean => {
      if (category.tags.some((tag) => item.tags.has(tag))) return true;
      if (above !== null && item.parent !== -1 && above[item.parent] === 1) return true;
      for (const field of category.fields) {
        if (field === 'path') continue;
        for (const text of item.texts.get(field) ?? []) if (textShows(category, text)) return true;
      }
      return false;
    };
    const ids = items.filter(shows).map((item) => item.id);
    const evidence = ids.sort(byCodeUnits).slice(0, options.evidenceLimit ?? MAX_EVIDENCE);
    return { id: category.id, label: category.label, group: category.group, required: category.required, present: ids.length > 0, count: ids.length, evidence };
  });
}
