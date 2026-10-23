// Text normalization shared by the interpreters: the match representation a table declares (C04 R[2]) and the white space
// rule of verbatim quotation, implemented independently here and in refs, with shared conformance vectors. Ordinary table normalization is separate.
import { isQuotationWide } from './quote-width.ts';
import type { MatchRepresentation } from '../../contracts/src/tables.ts';

/** Unicode White_Space: tabs and line breaks (U+0009-U+000D, NEL, LS, PS), spaces, NBSP and the ideographic space U+3000. */
export function isWhiteSpace(code: number): boolean {
  if (code <= 0x20) return code === 0x20 || (code >= 0x09 && code <= 0x0d);
  if (code < 0x85) return false;
  return (
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

/** Every run of white space becomes one space; leading and trailing white space is removed. */
export function collapseWhitespace(text: string): string {
  let out = '';
  let word = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isWhiteSpace(text.charCodeAt(i))) {
      if (word !== '') {
        out = out === '' ? word : `${out} ${word}`;
        word = '';
      }
    } else {
      word += ch;
    }
  }
  if (word !== '') out = out === '' ? word : `${out} ${word}`;
  return out;
}

export function trimWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhiteSpace(text.charCodeAt(start))) start++;
  while (end > start && isWhiteSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

/** Applies a table's match representation. Defaults: Unicode NFC, case sensitive, trimmed. */
export function normalizeText(value: string, match: MatchRepresentation | undefined): string {
  let text = value;
  const unicode = match?.unicode ?? 'nfc';
  if (unicode === 'nfc') text = text.normalize('NFC');
  else if (unicode === 'nfkc') text = text.normalize('NFKC');
  const whitespace = match?.whitespace ?? 'trim';
  if (whitespace === 'trim') text = trimWhitespace(text);
  else if (whitespace === 'collapse') text = collapseWhitespace(text);
  if (match?.case === 'insensitive') text = text.toLowerCase();
  return text;
}

/** Number of Unicode code points. */
export function codePoints(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Rules-local quote form; the ordinary table collapseWhitespace function above is unchanged. */
export function quotationForm(text: string): string {
  return text.replace(/\p{White_Space}+/gu, (run: string, at: number) => {
    const end = at + run.length;
    if (at === 0 || end === text.length) return '';
    const left = Array.from(text.slice(Math.max(0, at - 2), at)).at(-1)!;
    const right = String.fromCodePoint(text.codePointAt(end)!);
    return isQuotationWide(left) || isQuotationWide(right) ? '' : ' ';
  });
}

/** Verbatim quotation uses the shared contextual whitespace rule. Empty never matches. */
export function quoteMatches(fragmentText: string, quote: string): boolean {
  if (typeof fragmentText !== 'string' || typeof quote !== 'string' || !quote.isWellFormed()) return false;
  const pattern = quotationForm(quote);
  return pattern.length > 0 && quotationForm(fragmentText).includes(pattern);
}

/** A fragment already collapsed by the table cache retains the information needed for contextual quotation matching. */
export function quoteInCollapsed(collapsedFragment: string, quote: string): boolean {
  if (typeof quote !== 'string' || !quote.isWellFormed()) return false;
  const pattern = quotationForm(quote);
  return pattern.length > 0 && collapsedFragment.includes(pattern);
}
