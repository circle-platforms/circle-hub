// Exact declared test-type values only. Raw tags remain available for structural correction.
import { failure, guarded, isRecord } from './common.ts';
import type { CanonicalTag, NormalizedTag, TagsOutput } from './types.ts';
import {TEST_TYPE_IDS,declaredResourceTag,declareResourceTags} from './generated/vocabulary.ts';
export {RESOURCE_TAGS,RESOURCE_TAG_TEXTS,RESOURCE_TAG_TABLE,declareResourceTags} from './generated/vocabulary.ts';

export const CANONICAL_TAGS = TEST_TYPE_IDS;

/** Exact author-declared field comparison; never repairs, folds or guesses a tag. */
export function tagKey(raw: string): string { return raw; }
export function normalizeTag(tag: unknown): NormalizedTag {
  const raw = tag;
  const declaration=declaredResourceTag(tag);
  const canonical=declaration?.test_type===true?declaration.id:null;
  return { canonical, raw };
}

/** Canonical categories of a tag list, in canonical order, without repetition. */
export function canonicalTags(tags: readonly unknown[]): CanonicalTag[] { return declareResourceTags(tags).types; }
export function isNegative(tags: readonly unknown[]): boolean | null { return declareResourceTags(tags).negative; }

export function normalizeTags(input: unknown): TagsOutput {
  if (!isRecord(input)) return failure('invalid_input','输入不是作者标签声明对象','传入 { resource: [...] }');
  const declaration=declareResourceTags(input.resource);
  const tags=Array.isArray(input.resource)?input.resource.map(normalizeTag):[];
  return {tags,canonical:declaration.types,negative:declaration.negative,declaration};
}

export default function (input: unknown): unknown {
  return guarded(() => normalizeTags(input));
}
