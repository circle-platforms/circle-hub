// Tag normalization (copied from the case-review pack). Real documents write one category many ways: Function, function,
// Functional, [Function], [Functional (unclosed), 功能; Configure, [configuration], 配置; negative, [Negative], 负向; stress,
// 压力 ... Each spelling maps to one canonical test type of the team template, or to null (release-specific tags stay as written).
import { TAG_SPELLINGS, TYPE_LABELS } from './tag-table.ts';
export { TAG_SPELLINGS, TYPE_LABELS };

const collapseWhitespace = (text: string): string => text.replace(/\p{White_Space}+/gu, ' ').replace(/^ | $/g, '');
const textOf = (value: unknown): string | null => typeof value === 'string' ? value : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
export type CanonicalTag = keyof typeof TAG_SPELLINGS;

/** The canonical test types in their display order (tables/template-v3.json uses the same set). */
export const CANONICAL_TAGS = ['Functional', 'Configuration', 'Integration', 'Compatibility', 'Negative', 'Stress'] as const satisfies readonly CanonicalTag[];

// Compile-time check that the list names every member of CanonicalTag.
type Missing = Exclude<CanonicalTag, (typeof CANONICAL_TAGS)[number]>;
const complete: [Missing] extends [never] ? true : never = true;
void complete;

const BY_KEY = new Map<string, CanonicalTag>();
for (const tag of CANONICAL_TAGS) for (const key of TAG_SPELLINGS[tag]) BY_KEY.set(key, tag);

// Characters removed from both ends: brackets and quotes (also unbalanced ones) and trailing punctuation.
const EDGE = new Set([...'[]【】()（）{}<>《》「」『』"\'“”‘’`#*.,;:!?。，；：！？、']);
const INNER = /[\s\-_]+/g;
const SUFFIXES = ['测试用例', 'testing', 'tests', 'cases', '测试', '用例', 'test', 'case'];
const MAX_TAG_LENGTH = 200;

/** Folded form used for matching: NFKC, lower case, edge brackets and punctuation removed, inner spaces, - and _ removed. */
export function tagKey(raw: string): string {
  const text = collapseWhitespace(raw.normalize('NFKC')).toLowerCase();
  const chars = [...text];
  let start = 0;
  let end = chars.length;
  while (start < end && (EDGE.has(chars[start]) || chars[start] === ' ')) start += 1;
  while (end > start && (EDGE.has(chars[end - 1]) || chars[end - 1] === ' ')) end -= 1;
  return chars.slice(start, end).join('').replace(INNER, '');
}

/** The canonical test type of one tag; unknown, empty and non-text tags give null. */
export function canonicalTag(tag: unknown): CanonicalTag | null {
  const raw = textOf(tag) ?? '';
  if (raw === '' || raw.length > MAX_TAG_LENGTH) return null;
  const key = tagKey(raw);
  const direct = BY_KEY.get(key);
  if (direct !== undefined) return direct;
  for (const suffix of SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const stripped = BY_KEY.get(key.slice(0, -suffix.length));
      if (stripped !== undefined) return stripped;
    }
  }
  return null;
}

/** Canonical test types of a tag list, in canonical order, without repetition. */
export function canonicalTags(tags: readonly unknown[]): CanonicalTag[] {
  const found = new Set<CanonicalTag>();
  for (const tag of tags) {
    const canonical = canonicalTag(tag);
    if (canonical !== null) found.add(canonical);
  }
  return CANONICAL_TAGS.filter((tag) => found.has(tag));
}
