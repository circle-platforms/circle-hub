// Subjects of the core checks (pack function). The structure tables judge the list `subjects` (nodes $.subjects[*]),
// because duplicates and spelling consistency are only visible across items; the catalog table judges one subject each.
// Duplicates are keyed by (document, path) and the whole content of a case (title, steps, expected results, preconditions):
// real documents reuse a short title for variants that differ in their steps, and repeat titles under different paths.
// Type declarations are compared literally; frequency within a document never authorizes a value.
import { PACK, failure, guarded, isRecord, warningSink } from './common.ts';
import { CANONICAL_TAGS, normalizeTag, declareResourceTags } from './tags.ts';
import { codePointLength, collapseWhitespace, fold, textOf, trimWhitespace } from './text.ts';
import type { CanonicalTag, CatalogSubject, JsonValue, StructureSubject, SubjectOutput } from './types.ts';

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
  const resource=fields.resourcePresent===false?undefined:Object.hasOwn(fields,'resource')?fields.resource:fields.tags;
  const tagDeclaration=declareResourceTags(resource);
  const categories = new Set<CanonicalTag>(tagDeclaration.types);
  const categoryTags = tags.filter(tag=>{const normalized=normalizeTag(tag);return normalized.canonical!==null;});
  const otherTags = tags.filter(tag=>normalizeTag(tag).canonical===null);
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
    resource: resource ?? null,
    resourcePresent: resource!==undefined,
    tagDeclaration,
    tagCount,
    categories: CANONICAL_TAGS.filter((tag) => categories.has(tag)),
    categoryTags,
    tagVariants: [],
    otherTags,
    expected,
    expectedCount: typeof count === 'number' && Number.isSafeInteger(count) && count >= expected.length ? count : expected.length,
    negative: tagDeclaration.negative,
  };
}

/** Subjects are checked against the declared closed field; document frequency cannot authorize a spelling. */
export function toStructureSubjects(items: readonly unknown[]): StructureSubject[] {
  return items.map(toStructureSubject);
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
