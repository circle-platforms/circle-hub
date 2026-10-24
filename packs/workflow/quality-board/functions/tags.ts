// Only exact text from the authored resource closed set can name a test type.
import {TEST_TYPE_IDS,declaredResourceTag,declareResourceTags,TEST_TYPE_LABELS} from './generated/vocabulary.ts';
import type {TestTypeId} from './generated/vocabulary.ts';
export {RESOURCE_TAGS,RESOURCE_TAG_TEXTS,RESOURCE_TAG_TABLE,declareResourceTags} from './generated/vocabulary.ts';
export type CanonicalTag = TestTypeId;
export const CANONICAL_TAGS = TEST_TYPE_IDS;
export const TYPE_LABELS = TEST_TYPE_LABELS;
export function tagKey(raw:string):string {return raw;}
export function canonicalTag(raw:unknown):CanonicalTag|null {const declaration=declaredResourceTag(raw);return declaration?.test_type===true?declaration.id:null;}
export function canonicalTags(tags:readonly unknown[]):CanonicalTag[]{return declareResourceTags(tags).types;}
