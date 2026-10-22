// Text helpers of the template-gap functions (copied from the case-review pack). White space is Unicode White_Space, the
// set the Hub's interpreters use, so "blank" means the same here and in the core checks. Code points are compared as numbers
// on purpose: no literal separator characters or their escapes appear in this source.

/** Unicode White_Space: U+0009-U+000D, space, NEL, NBSP, U+1680, U+2000-U+200A, LS, PS, U+202F, U+205F, U+3000. */
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

export function trimWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhiteSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isWhiteSpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Every run of white space becomes one space; the ends are kept (see collapseWhitespace for trimming). */
export function collapseRuns(text: string): string {
  const parts: string[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (!isWhiteSpace(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && isWhiteSpace(text.charCodeAt(end))) end += 1;
    parts.push(text.slice(from, i), ' ');
    from = end;
    i = end;
  }
  if (from === 0) return text;
  parts.push(text.slice(from));
  return parts.join('');
}

/** Every run of white space becomes one space; both ends are trimmed. */
export function collapseWhitespace(text: string): string {
  return trimWhitespace(collapseRuns(text));
}

export function isBlank(text: string): boolean {
  return trimWhitespace(text) === '';
}

/** Bytes of the text in UTF-8, as Buffer.byteLength counts them (a lone surrogate is three bytes, like U+FFFD). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** At most `max` code points; a clipped text ends with an ellipsis (within the limit). */
export function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  let count = 0;
  let end = 0;
  let cut = 0;
  while (end < text.length && count < max) {
    const code = text.charCodeAt(end);
    end += code >= 0xd800 && code <= 0xdbff && end + 1 < text.length ? 2 : 1;
    count += 1;
    if (count === max - 1) cut = end;
  }
  if (end >= text.length) return { text, clipped: false };
  return { text: `${text.slice(0, cut)}…`, clipped: true };
}

/** Text of a JSON scalar the way the kityminder@1 parser reads node text: strings as they are, numbers and booleans written out. */
export function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') return String(value);
  return null;
}

/** The representation used for matching: NFKC, white space collapsed, lower case. */
export function fold(text: string): string {
  return collapseWhitespace(text.normalize('NFKC')).toLowerCase();
}

export function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** UTF-8 percent-encoding of one code point, upper-case hex. */
export function percentEncode(codePoint: number): string {
  const bytes: number[] = [];
  if (codePoint < 0x80) bytes.push(codePoint);
  else if (codePoint < 0x800) bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
  else if (codePoint < 0x10000) bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  else bytes.push(0xf0 | (codePoint >> 18), 0x80 | ((codePoint >> 12) & 0x3f), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
  return bytes.map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

// The canonical selector rule of the Hub's references: '%', controls, format characters, separators and spaces, and the
// structural characters '/' and ':' are percent-encoded; everything else stays as it is.
const SELECTOR_ENCODED = /^[%/:\p{Cc}\p{Cf}\p{Z}]$/u;

/** One canonical kityminder@1 selector segment, or null when the text cannot be written (empty, lone surrogates). */
export function selectorSegment(segment: string): string | null {
  if (segment === '' || hasLoneSurrogate(segment)) return null;
  let out = '';
  for (const ch of segment) out += SELECTOR_ENCODED.test(ch) ? percentEncode(ch.codePointAt(0) as number) : ch;
  return out;
}
