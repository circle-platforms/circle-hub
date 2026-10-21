// Tag normalization (pack function). Real documents write one category many ways: Function, function, Functional,
// [Function], [Functional (unclosed), 功能; Configure, [configuration], 配置; negative, [Negative], 负向; stress, 压力 ...
// Each spelling maps to one canonical category of the team template, or to null (release-specific tags stay as written).
import { failure, guarded, isRecord } from './common.ts';
import { collapseWhitespace, textOf } from './text.ts';
import type { CanonicalTag, NormalizedTag, TagsOutput } from './types.ts';

/** The canonical categories in their display order (tables/tags.json and tables/template-v3.json use the same set). */
export const CANONICAL_TAGS = ['Functional', 'Configuration', 'Integration', 'Compatibility', 'Negative', 'Stress'] as const satisfies readonly CanonicalTag[];

// Compile-time check that the list names every member of CanonicalTag.
type Missing = Exclude<CanonicalTag, (typeof CANONICAL_TAGS)[number]>;
const complete: [Missing] extends [never] ? true : never = true;
void complete;

/** Folded spellings (see tagKey) of each category. Author-written from the spellings seen in real documents. */
export const TAG_SPELLINGS: Readonly<Record<CanonicalTag, readonly string[]>> = {
  Functional: ['functional', 'function', 'functions', 'functionality', 'func', '功能', '功能性', '基本功能'],
  Configuration: ['configuration', 'configurations', 'config', 'configs', 'configure', 'cfg', '配置'],
  Integration: ['integration', 'integrations', 'integrated', 'integrate', '集成'],
  Compatibility: ['compatibility', 'compatible', 'compat', '兼容', '兼容性'],
  Negative: ['negative', 'neg', '负向', '负面', '反向', '逆向', '异常'],
  Stress: ['stress', 'pressure', '压力', '压测'],
};

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

/** The canonical category of one tag, and the tag as written. Unknown, empty and non-text tags have canonical null. */
export function normalizeTag(tag: unknown): NormalizedTag {
  const raw = textOf(tag) ?? '';
  if (raw === '' || raw.length > MAX_TAG_LENGTH) return { canonical: null, raw };
  const key = tagKey(raw);
  const direct = BY_KEY.get(key);
  if (direct !== undefined) return { canonical: direct, raw };
  for (const suffix of SUFFIXES) {
    if (key.length > suffix.length && key.endsWith(suffix)) {
      const stripped = BY_KEY.get(key.slice(0, -suffix.length));
      if (stripped !== undefined) return { canonical: stripped, raw };
    }
  }
  return { canonical: null, raw };
}

/** Canonical categories of a tag list, in canonical order, without repetition. */
export function canonicalTags(tags: readonly unknown[]): CanonicalTag[] {
  const found = new Set<CanonicalTag>();
  for (const tag of tags) {
    const { canonical } = normalizeTag(tag);
    if (canonical !== null) found.add(canonical);
  }
  return CANONICAL_TAGS.filter((tag) => found.has(tag));
}

/** A case is negative exactly when one of its tags maps to the canonical category Negative. */
export function isNegative(tags: readonly unknown[]): boolean {
  return tags.some((tag) => normalizeTag(tag).canonical === 'Negative');
}

export function normalizeTags(input: unknown): TagsOutput {
  if (!isRecord(input) || !Array.isArray(input.tags)) return failure('invalid_input', '输入里没有 tags 数组', '按 { tags: [...] } 传入标签');
  const tags = input.tags.map(normalizeTag);
  return { tags, canonical: canonicalTags(input.tags), negative: isNegative(input.tags) };
}

export default function (input: unknown): unknown {
  return guarded(() => normalizeTags(input));
}
