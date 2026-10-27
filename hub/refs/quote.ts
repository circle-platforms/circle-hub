// Verbatim quotation check (T04 R[1]): the quote must be an exact contiguous substring of decoded fragment text.
// Case, punctuation, character width, Unicode normalization form and every whitespace character stay significant.
// One KMP matcher serves every check, so a search is linear in the text and allocates nothing per candidate.
import type { Resolution, SourceRole } from '../../contracts/generated/vocabulary.ts';
import { QUOTATION_UNITS, type ByteRange, type ParsedDocument, type QuotationSource, type QuotationUnits } from './parser.ts';
import { ReferenceSyntaxError, parseReference, srcFragment, withRange } from './reference.ts';
import { isWhiteSpace, utf8Length } from './text-decoding.ts';
import { dropQuoteWhitespace } from './quote-whitespace.ts';

/** Contextual whitespace normalization for non-quotation callers; strict quotation matching does not use it. */
export function collapseWhitespace(text: string): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length;) {
    if (!isWhiteSpace(text.charCodeAt(i))) { i++; continue; }
    if (i > start) parts.push(text.slice(start, i));
    const runStart = i;
    while (i < text.length && isWhiteSpace(text.charCodeAt(i))) i++;
    if (!dropQuoteWhitespace(text, runStart, i)) parts.push(' ');
    start = i;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts.join('');
}

/** A non-empty quotation compiled for exact search. */
class Matcher {
  readonly #pattern: string;
  readonly #failure: Int32Array;

  constructor(pattern: string) {
    const m = pattern.length;
    const failure = new Int32Array(m);
    for (let q = 1, k = 0; q < m; q++) {
      while (k > 0 && pattern.charCodeAt(q) !== pattern.charCodeAt(k)) k = failure[k - 1];
      if (pattern.charCodeAt(q) === pattern.charCodeAt(k)) k++;
      failure[q] = k;
    }
    this.#pattern = pattern;
    this.#failure = failure;
  }

  /** Calls `visit(start, end)` with the UTF-16 bounds of every exact occurrence, including overlaps. */
  scan(text: string, from: number, to: number, visit: (start: number, end: number) => boolean): void {
    const pattern = this.#pattern;
    const failure = this.#failure;
    const m = pattern.length;
    let matched = 0;
    for (let i = from; i < to; i++) {
      const code = text.charCodeAt(i);
      while (matched > 0 && pattern.charCodeAt(matched) !== code) matched = failure[matched - 1];
      if (pattern.charCodeAt(matched) === code) matched++;
      if (matched === m) {
        if (!visit(i - m + 1, i + 1)) return;
        matched = failure[m - 1];
      }
    }
  }
}

/** The matcher for a quotation, or null for ill-formed UTF-16, an empty string, or only Unicode White_Space. */
function compile(quote: string): Matcher | null {
  if (typeof quote !== 'string' || !quote.isWellFormed()) return null;
  if (!/[^\p{White_Space}]/u.test(quote)) return null;
  return new Matcher(quote);
}

/**
 * True when the quote is an exact contiguous substring of the fragment text. Empty and whitespace-only quotes never
 * match, and neither does a quote with an unpaired surrogate (it could match half of a character).
 */
export function quoteMatches(fragmentText: string, quote: string): boolean {
  const matcher = compile(quote);
  if (matcher === null || typeof fragmentText !== 'string') return false;
  let found = false;
  matcher.scan(fragmentText, 0, fragmentText.length, () => {
    found = true;
    return false;
  });
  return found;
}

/** Where a quote sits in the fragment text: UTF-8 byte offsets [from, to) of the first occurrence, and how often it occurs. */
export interface QuoteLocation {
  from: number;
  to: number;
  occurrences: number;
}

/** Locates the quote in the original (uncollapsed) fragment text. */
export function locateQuote(fragmentText: string, quote: string): QuoteLocation | null {
  const matcher = compile(quote);
  if (matcher === null || typeof fragmentText !== 'string') return null;
  const first = { start: -1, end: -1, count: 0 };
  matcher.scan(fragmentText, 0, fragmentText.length, (start, end) => {
    if (first.count++ === 0) {
      first.start = start;
      first.end = end;
    }
    return true;
  });
  if (first.count === 0) return null;
  const from = utf8Length(fragmentText.slice(0, first.start));
  return { from, to: from + utf8Length(fragmentText.slice(first.start, first.end)), occurrences: first.count };
}

/** A text shared by nested candidates of one source (one object per parsed document). */
export interface QuoteStream {
  readonly text: string;
}

/** Where a candidate's text sits in a shared text: `text === stream.text.slice(start, end)`. */
export interface QuoteSpan {
  readonly stream: QuoteStream;
  readonly start: number;
  readonly end: number;
}

/** A place an exact value or quotation may come from: a located fragment and the reference that addresses it. */
export interface QuoteCandidate {
  reference: string;
  text: string;
  role?: SourceRole;
  /** Digest of the source bytes, used with `byteRange` to prefer the innermost of nested fragments. */
  source?: string;
  byteRange?: ByteRange | null;
  /**
   * The candidate whose text encloses this one's (set by candidatesFrom). An occurrence counts once, at the innermost
   * candidate; the enclosing one is a place of its own only when it holds occurrences outside the ones inside.
   */
  within?: QuoteCandidate;
  /**
   * Set by candidatesFrom for the core parsers: the search reads the shared text once and gives every occurrence to the
   * innermost candidate whose span contains it, so nested fragments cost nothing extra and each place is pinned exactly.
   */
  span?: QuoteSpan;
}

export interface QuoteMatch {
  reference: string;
  /** The reference narrowed to the quote with a `:from-to` byte range when the reference is a src fragment, else the reference. */
  ranged: string;
  text: string;
  role: SourceRole | null;
  /** The occurrence `ranged` pins, and how many occurrences belong to this place (not to a place nested inside it). */
  location: QuoteLocation;
}

export interface QuoteSearch {
  resolution: Resolution;
  matches: QuoteMatch[];
  /** All matching places, including those beyond the returned limit. */
  total: number;
  diagnostics: string[];
}

const EMPTY_QUOTE = '原文为空，没有可核对的内容';
const ILL_FORMED_QUOTE = '原文里有不成对的 UTF-16 代理字符，不是完整的文字，无法核对';
const NOT_FOUND = '在已绑定的来源里找不到这段原文。请逐字引用：大小写、标点、字符宽度、Unicode 规范化形式和全部空白（包括空格、制表符与换行）均须完全相同';

type Place = {
  candidate: QuoteCandidate;
  /** Position in the candidate list: document order of the places. */
  order: number;
  /** First occurrence that belongs here: stream bounds for stream places, bounds in the candidate's text otherwise. */
  start: number;
  end: number;
  stream: boolean;
  own: number;
  /** Occurrences of candidates nested inside (by `within` or byte range) that this place's own count includes. */
  inner: number;
};

function spanOf(candidate: QuoteCandidate): QuoteSpan | null {
  const span = candidate.span;
  if (span === undefined || span === null || typeof span.stream?.text !== 'string' || typeof candidate.text !== 'string') return null;
  const { start, end } = span;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > span.stream.text.length || end - start !== candidate.text.length) return null;
  return span;
}

/**
 * Resolves a quotation against candidate fragments (T04 R[2]): no match is unresolved, one place is resolved, several
 * places are ambiguous. Every occurrence belongs to the innermost candidate around it, so a sentence found in a block
 * and in the section around it is one place, while a section that also holds the sentence in its heading is a second.
 * The cost is linear in the candidate text (shared text is read once).
 */
export function findQuote(candidates: readonly QuoteCandidate[], quote: string, options: { limit?: number } = {}): QuoteSearch {
  const limit = options.limit ?? 20;
  if (typeof quote !== 'string' || !quote.isWellFormed()) return { resolution: 'unresolved', matches: [], total: 0, diagnostics: [ILL_FORMED_QUOTE] };
  const matcher = compile(quote);
  if (matcher === null) return { resolution: 'unresolved', matches: [], total: 0, diagnostics: [EMPTY_QUOTE] };

  const places = new Map<QuoteCandidate, Place>();
  const record = (candidate: QuoteCandidate, order: number, start: number, end: number, stream: boolean): void => {
    const place = places.get(candidate);
    if (place) place.own++;
    else places.set(candidate, { candidate, order, start, end, stream, own: 1, inner: 0 });
  };

  // Candidates on a shared text, grouped by that text; the rest are searched one by one.
  const groups = new Map<QuoteStream, Array<{ order: number; span: QuoteSpan }>>();
  candidates.forEach((candidate, order) => {
    const span = candidate === null || typeof candidate !== 'object' ? null : spanOf(candidate);
    if (span === null) {
      if (candidate === null || typeof candidate !== 'object' || typeof candidate.text !== 'string') return;
      matcher.scan(candidate.text, 0, candidate.text.length, (start, end) => {
        record(candidate, order, start, end, false);
        return true;
      });
      return;
    }
    let members = groups.get(span.stream);
    if (!members) groups.set(span.stream, (members = []));
    members.push({ order, span });
  });

  for (const [stream, members] of groups) {
    // Sorted by start, enclosing spans first; candidatesFrom delivers them that way.
    const before = (a: { order: number; span: QuoteSpan }, b: { order: number; span: QuoteSpan }): number =>
      a.span.start - b.span.start || b.span.end - a.span.end || a.order - b.order;
    for (let k = 1; k < members.length; k++) {
      if (before(members[k - 1], members[k]) > 0) {
        members.sort(before);
        break;
      }
    }
    const open: Array<{ order: number; span: QuoteSpan }> = [];
    let next = 0;
    matcher.scan(stream.text, 0, stream.text.length, (start, end) => {
      while (next < members.length && members[next].span.start <= start) {
        const member = members[next++];
        while (open.length > 0 && open[open.length - 1].span.end <= member.span.start) open.pop();
        open.push(member);
      }
      // Occurrences end later and later, so a span that ends too early can be dropped for good.
      while (open.length > 0 && open[open.length - 1].span.end < end) open.pop();
      if (open.length > 0) {
        const owner = open[open.length - 1];
        record(candidates[owner.order], owner.order, start, end, true);
      }
      return true;
    });
  }

  // Candidates searched one by one count as nested by `within`, or else by byte range in the same source.
  const ranged: Place[] = [];
  for (const place of places.values()) {
    if (place.stream) continue;
    const within = place.candidate.within;
    if (within !== undefined && within !== null) {
      let steps = 0;
      for (let at: QuoteCandidate | undefined = within; at !== undefined && at !== null && steps <= candidates.length; at = at.within, steps++) {
        const outer = places.get(at);
        if (outer) {
          outer.inner += place.own;
          break;
        }
      }
    } else if (typeof place.candidate.source === 'string' && Array.isArray(place.candidate.byteRange)) ranged.push(place);
  }
  ranged.sort((a, b) => {
    const [as, ae] = a.candidate.byteRange!;
    const [bs, be] = b.candidate.byteRange!;
    const sa = a.candidate.source!;
    const sb = b.candidate.source!;
    return (sa < sb ? -1 : sa > sb ? 1 : 0) || as - bs || be - ae || a.order - b.order;
  });
  const enclosing: Place[] = [];
  for (const place of ranged) {
    const [start, end] = place.candidate.byteRange!;
    const contains = (outer: Place): boolean => {
      const [os, oe] = outer.candidate.byteRange!;
      return outer.candidate.source === place.candidate.source && os <= start && end <= oe && (os !== start || oe !== end);
    };
    while (enclosing.length > 0 && !contains(enclosing[enclosing.length - 1])) enclosing.pop();
    if (enclosing.length > 0) enclosing[enclosing.length - 1].inner += place.own;
    enclosing.push(place);
  }

  const seen = new Set<string>();
  const found: Place[] = [];
  for (const place of [...places.values()].sort((a, b) => a.order - b.order)) {
    if (place.own <= place.inner || seen.has(place.candidate.reference)) continue;
    seen.add(place.candidate.reference);
    found.push(place);
  }
  const matches = found.slice(0, limit).map((place): QuoteMatch => {
    const candidate = place.candidate;
    let from: number;
    let to: number;
    if (place.stream) {
      const span = candidate.span!;
      from = utf8Length(span.stream.text.slice(span.start, place.start));
      to = from + utf8Length(span.stream.text.slice(place.start, place.end));
    } else {
      from = utf8Length(candidate.text.slice(0, place.start));
      to = from + utf8Length(candidate.text.slice(place.start, place.end));
    }
    const location: QuoteLocation = { from, to, occurrences: place.own - place.inner };
    return { reference: candidate.reference, ranged: rangedReference(candidate.reference, location), text: candidate.text, role: candidate.role ?? null, location };
  });
  const total = found.length;
  if (total === 0) return { resolution: 'unresolved', matches, total, diagnostics: [NOT_FOUND] };
  if (total === 1) return { resolution: 'resolved', matches, total, diagnostics: [] };
  const shown = total > matches.length ? `，下面列出前 ${matches.length} 处` : '';
  return { resolution: 'ambiguous', matches, total, diagnostics: [`这段原文出现在 ${total} 处${shown}；请从中选一个引用`] };
}

function rangedReference(reference: string, location: QuoteLocation): string {
  try {
    const ref = parseReference(reference);
    if (ref.scheme === 'src' && ref.selector !== undefined && ref.range === undefined) return withRange(reference, [location.from, location.to]);
  } catch {
    // Candidates normally carry canonical references; anything else is returned as given.
  }
  return reference;
}

function candidatesFromUnits(index: QuotationUnits, parser: string, sha256: string, options: { role?: SourceRole; prefix?: string; limit?: number }): QuoteCandidate[] {
  const stream: QuoteStream = { text: index.stream };
  const head = `src:${sha256}/${parser}/`;
  const prefix = options.prefix ?? '';
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const units = index.units;
  // The nearest listed candidate at or above each unit, so a unit left out by the prefix passes its parent on.
  const nearest: Array<QuoteCandidate | undefined> = new Array(units.length);
  const out: QuoteCandidate[] = [];
  for (let i = 0; i < units.length && out.length < limit; i++) {
    const unit = units[i];
    const parent = unit.parent >= 0 && unit.parent < i ? nearest[unit.parent] : undefined;
    if (prefix !== '' && !unit.selector.startsWith(prefix)) {
      nearest[i] = parent;
      continue;
    }
    const candidate: QuoteCandidate = { reference: head + unit.selector, text: unit.text, source: sha256, byteRange: unit.byteRange };
    if (options.role) candidate.role = options.role;
    if (parent) candidate.within = parent;
    if (unit.start >= 0) candidate.span = { stream, start: unit.start, end: unit.end };
    nearest[i] = candidate;
    out.push(candidate);
  }
  return out;
}

/**
 * Quotation candidates from a parsed source: every listed fragment with its canonical src reference. With
 * `properties`, XML attributes and mind-map data fields are included as well. For the core parsers the candidates are
 * the fragments quotations are checked against: json@1 lists values but not the JSON text of objects and arrays, a
 * mind-map node stands for its own `text` field, and text@1 and html@1 add the whole document (`l/1-<n>`, `b/0-<n>`)
 * so that a quotation across lines or blocks resolves.
 */
export async function candidatesFrom(
  document: ParsedDocument,
  sha256: string,
  options: { role?: SourceRole; prefix?: string; properties?: boolean; limit?: number } = {},
): Promise<QuoteCandidate[]> {
  // An invalid digest is the caller's mistake, never a quotation that is not there.
  srcFragment(sha256, document.parser, ['x']);
  const units = (document as Partial<QuotationSource>)[QUOTATION_UNITS];
  if (typeof units === 'function') return candidatesFromUnits(units.call(document, { properties: options.properties ?? false }), document.parser, sha256, options);
  const out: QuoteCandidate[] = [];
  const selectors = document.listSelectors(options.prefix, { properties: options.properties, limit: options.limit });
  await document.prefetch?.(selectors);
  for (const selector of selectors) {
    const fragment = await document.locate(selector);
    if (!fragment) continue;
    let reference: string;
    try {
      reference = srcFragment(sha256, document.parser, fragment.selector);
    } catch (error) {
      // A selector longer than a reference may be cannot be cited.
      if (error instanceof ReferenceSyntaxError) continue;
      throw error;
    }
    out.push({
      reference,
      text: fragment.text,
      source: sha256,
      byteRange: fragment.byteRange,
      ...(options.role ? { role: options.role } : {}),
    });
  }
  return out;
}
