// Subjects of the core checks (pack function). The structure tables judge the list `subjects` (nodes $.subjects[*]),
// because duplicates and spelling consistency are only visible across items; the catalog table judges one subject each.
// Duplicates are keyed by (document, path) and the whole content of a case (title, steps, expected results, preconditions):
// real documents reuse a short title for variants that differ in their steps, and repeat titles under different paths.
// Tag spelling is judged inside one document: a category written several ways there is an inconsistent field format; each
// variant spelling carries the usual spelling of its category in the document (the tag check names both).
import { PACK, failure, guarded, isRecord, warningSink } from './common.ts';
import { CANONICAL_TAGS, normalizeTag } from './tags.ts';
import { codePointLength, collapseWhitespace, fold, textOf, trimWhitespace } from './text.ts';
import type { CanonicalTag, CatalogSubject, JsonValue, StructureSubject, SubjectOutput, TagVariant } from './types.ts';

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) if (typeof entry === 'string') out.push(entry);
  return out;
}

/** The priority as written (input is JSON), so the structure check can report a wrong type; missing becomes null. */
function jsonPriority(value: unknown): JsonValue {
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) return null;
  return value as JsonValue;
}

/** The reference URI of an item as the Hub holds it (any `scheme:` form the Hub writes); parser and selector give null. */
function locationOf(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\S/.test(value) ? value : null;
}

/** Key of the duplicate group: the document and the path, normalized the way titles are compared. */
export function groupKey(document: string, path: readonly string[]): string {
  return JSON.stringify([document, ...path.map(fold)]);
}

/** Steps, expected results and preconditions in the matching form, as JSON text. */
export function contentKey(fields: { [key: string]: unknown }): string {
  const steps = Array.isArray(fields.steps) ? fields.steps.map((step) => (isRecord(step) && typeof step.text === 'string' ? fold(step.text) : '')) : [];
  return JSON.stringify([steps, strings(fields.expected).map(fold), strings(fields.preconditions).map(fold)]);
}

export function toStructureSubject(item: unknown): StructureSubject {
  const record = isRecord(item) ? item : {};
  const fields = isRecord(record.fields) ? record.fields : {};
  const document = textOf(fields.document) ?? '';
  const path = strings(fields.path);
  const title = typeof fields.title === 'string' ? fields.title : '';
  const tags = strings(fields.tags);
  const categories = new Set<CanonicalTag>();
  const categoryTags: string[] = [];
  const otherTags: string[] = [];
  for (const tag of tags) {
    const { canonical } = normalizeTag(tag);
    if (canonical === null) otherTags.push(tag);
    else {
      categories.add(canonical);
      categoryTags.push(tag);
    }
  }
  const expected = strings(fields.expected);
  const count = fields.expectedCount;
  const tagCount = tags.filter((tag) => trimWhitespace(tag) !== '').length;
  return {
    kind: 'case',
    id: textOf(record.id) ?? '',
    location: locationOf(record.location),
    document,
    nodeId: typeof fields.nodeId === 'string' ? fields.nodeId : null,
    group: groupKey(document, path),
    path,
    title,
    titleLength: codePointLength(trimWhitespace(title)),
    content: contentKey(fields),
    priority: jsonPriority(fields.priority),
    tags,
    tagCount,
    categories: CANONICAL_TAGS.filter((tag) => categories.has(tag)),
    categoryTags,
    tagVariants: [],
    otherTags,
    expected,
    expectedCount: typeof count === 'number' && Number.isSafeInteger(count) && count >= expected.length ? count : expected.length,
    negative: tagCount === 0 ? null : categories.has('Negative'),
  };
}

/**
 * The usual spelling of each category in each document: the most frequent one; a tie goes to the canonical name, else to
 * the spelling seen first. Spellings are compared as written, with white space collapsed.
 */
const spellingKey = (document: string, tag: string): string => JSON.stringify([document, normalizeTag(tag).canonical]);

function usualSpellings(subjects: readonly StructureSubject[]): Map<string, string> {
  type Seen = { count: number; first: number };
  const tally = new Map<string, { canonical: string; spellings: Map<string, Seen> }>();
  let order = 0;
  for (const subject of subjects) {
    for (const tag of subject.categoryTags) {
      const key = spellingKey(subject.document, tag);
      const entry = tally.get(key) ?? { canonical: String(normalizeTag(tag).canonical), spellings: new Map<string, Seen>() };
      tally.set(key, entry);
      const spelling = collapseWhitespace(tag);
      const seen = entry.spellings.get(spelling) ?? { count: 0, first: order++ };
      seen.count += 1;
      entry.spellings.set(spelling, seen);
    }
  }
  const usual = new Map<string, string>();
  for (const [key, { canonical, spellings }] of tally) {
    let best: [string, Seen] | null = null;
    for (const candidate of spellings) {
      if (best === null) best = candidate;
      else if (candidate[1].count !== best[1].count) {
        if (candidate[1].count > best[1].count) best = candidate;
      } else if ((candidate[0] === canonical) !== (best[0] === canonical)) {
        if (candidate[0] === canonical) best = candidate;
      } else if (candidate[1].first < best[1].first) best = candidate;
    }
    if (best !== null) usual.set(key, best[0]);
  }
  return usual;
}

/** Subjects of several items, with the tag spellings compared inside each document. */
export function toStructureSubjects(items: readonly unknown[]): StructureSubject[] {
  const subjects = items.map(toStructureSubject);
  const usual = usualSpellings(subjects);
  for (const subject of subjects) {
    const variants: TagVariant[] = [];
    for (const tag of subject.categoryTags) {
      const category = normalizeTag(tag).canonical;
      const spelling = usual.get(spellingKey(subject.document, tag));
      if (category === null || spelling === undefined || spelling === collapseWhitespace(tag) || variants.some((v) => v.tag === tag)) continue;
      variants.push({ tag, usual: spelling, category });
    }
    subject.tagVariants = variants;
  }
  return subjects;
}

function catalogFrom(subject: StructureSubject, commands: unknown): CatalogSubject {
  return { kind: 'case', id: subject.id, location: subject.location, negative: subject.negative, commands: strings(commands) };
}

/** The subject of the catalog check: the negative flag and the command phrases the product pack found in the case. */
export function toCatalogSubject(item: unknown, commands: unknown = []): CatalogSubject {
  return catalogFrom(toStructureSubject(item), commands);
}

/**
 * `{ items, commands?, parameters? }` (commands: item id to the phrases the product pack extracted) to the subject lists.
 * The scan of the case texts for commands (tables/catalog.json) is off unless parameters.scanCaseCommands is true; when
 * it is off, `catalog` is empty.
 */
export function buildSubjects(input: unknown): SubjectOutput {
  if (!isRecord(input) || !Array.isArray(input.items)) return failure('invalid_input', '输入里没有 items 数组', '按 { items: [...] } 传入投影出的条目');
  const warnings = warningSink();
  const parameters = isRecord(input.parameters) ? input.parameters : {};
  let scan = false;
  if (Object.hasOwn(parameters, 'scanCaseCommands')) {
    if (typeof parameters.scanCaseCommands === 'boolean') scan = parameters.scanCaseCommands;
    else warnings.note({ code: `${PACK}.parameter_ignored`, message: '参数 scanCaseCommands 不是布尔值，按 false 处理（不扫描用例文字里的命令）', data: { parameter: 'scanCaseCommands' } });
  }
  const commands = isRecord(input.commands) ? input.commands : {};
  const subjects = toStructureSubjects(input.items);
  const catalog = scan ? subjects.map((subject) => catalogFrom(subject, Object.hasOwn(commands, subject.id) ? commands[subject.id] : [])) : [];
  return { subjects, catalog, warnings: warnings.list() };
}

export default function (input: unknown): unknown {
  return guarded(() => buildSubjects(input));
}
