// The run parameters of the pack (workflow.json declares them): the product name and the version line the caller declares,
// the granularity of the items and the id ranges of the defect system. The engine checks them against their schemas; this
// reader is defensive anyway (a direct call, a sample) and reports what it ignores.
import { fold, isRecord, squeeze } from './text.ts';
import type { Declared, Granularity, IdRange, IdRanges } from './types.ts';

export type Parameters = { declared: Declared; granularity: Granularity; idRanges: IdRanges | null; ignored: string[] };

const GRANULARITIES = ['document', 'case'] as const satisfies readonly Granularity[];

function declaredText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = squeeze(value.toWellFormed());
  return text === '' || [...text].length > max ? null : text;
}

const ID_RANGE_FIELDS = {min:true,max:true} satisfies Record<keyof IdRange,boolean>;

function rangeOf(value: unknown): IdRange | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value) || Object.keys(value).some(key=>!Object.hasOwn(ID_RANGE_FIELDS,key))) return undefined;
  const range: IdRange = {};
  for (const [key, bound] of Object.entries(value)) {
    if (bound === undefined) continue;
    if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0) return undefined;
    if (key === 'min') range.min = bound;
    else range.max = bound;
  }
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) return undefined;
  return range;
}

export function readParameters(raw: unknown): Parameters {
  const out: Parameters = { declared: { product: null, line: null }, granularity: 'document', idRanges: null, ignored: [] };
  if (!isRecord(raw)) return out;
  if (raw.product !== undefined) {
    out.declared.product = declaredText(raw.product, 100);
    if (out.declared.product === null) out.ignored.push('product');
  }
  if (raw.line !== undefined) {
    const line = declaredText(raw.line, 40);
    out.declared.line = line !== null && /^v?[0-9]{1,3}(?:\.[0-9]{1,3}){1,3}$/i.test(fold(line)) ? fold(line).replace(/^v/, '') : null;
    if (out.declared.line === null) out.ignored.push('line');
  }
  if (raw.granularity !== undefined) {
    const granularity = GRANULARITIES.find((g) => g === raw.granularity);
    if (granularity !== undefined) out.granularity = granularity;
    else out.ignored.push('granularity');
  }
  if (raw.id_ranges !== undefined) {
    const ranges = isRecord(raw.id_ranges) && Object.keys(raw.id_ranges).every((key) => key === 'story' || key === 'bug') ? raw.id_ranges : null;
    const story = ranges === null ? undefined : rangeOf(ranges.story);
    const bug = ranges === null ? undefined : rangeOf(ranges.bug);
    if (story === undefined || bug === undefined) out.ignored.push('id_ranges');
    else if (story !== null || bug !== null) out.idRanges = { ...(story !== null ? { story } : {}), ...(bug !== null ? { bug } : {}) };
  }
  return out;
}

/** Whether a declared range contains an id; a kind without a declared range contains none. */
const inRange = (id: string, range: IdRange | undefined): boolean => {
  if (range === undefined) return false;
  const value = Number(id);
  return (range.min === undefined || value >= range.min) && (range.max === undefined || value <= range.max);
};

/**
 * The kind the caller's id ranges give an unmarked id (a declaration, never read from the tree): the one kind whose declared
 * range contains it. An id in both ranges, or in none, stays unclassified, so a range given alone classifies its own ids.
 */
export function kindByRange(id: string, ranges: IdRanges | null | undefined): 'story' | 'bug' | null {
  if (ranges === null || ranges === undefined) return null;
  const story = inRange(id, ranges.story);
  const bug = inRange(id, ranges.bug);
  return story === bug ? null : story ? 'story' : 'bug';
}
