// Small pure helpers shared by the pack functions: input guards, text normalization, the canonical selector and path
// codecs of hub/refs (re-implemented, because pack code may not import the Hub), ordering and glob matching.

export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asStrings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === 'string');
}

/** Removes U+0000, which stored text cannot hold. */
export function stripNul(text: string): string {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
}

/** Every run of white space (Unicode, NBSP included) becomes one space; both ends are trimmed. */
export function squeeze(text: string): string {
  return stripNul(text).replace(/\s+/g, ' ').trim();
}

const NAMED_ENTITIES: { [name: string]: string } = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: '\u00a0' };

/** Decodes the character references a source escaped twice (`&amp;quot;` reaches us as `&quot;`). Unknown ones stay. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
  });
}

/** Code-unit order, independent of locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares decimal digit strings by value, without converting them to numbers. */
export function compareDigits(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return x.length < y.length ? -1 : 1;
  return compareText(x, y);
}

/** Compares dotted numbers (3.1.29) part by part; a longer number with an equal prefix is greater; null is least. */
export function compareDotted(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const order = /^\d+$/.test(x[i]) && /^\d+$/.test(y[i]) ? compareDigits(x[i], y[i]) : compareText(x[i], y[i]);
    if (order !== 0) return order;
  }
  return x.length - y.length;
}

/** Orders nullable ISO texts; null is least. */
export function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareText(a, b);
}

// Canonical selector and path text (B03), following hub/refs/reference.ts: the escape character, controls, format
// characters and separators are always percent-encoded (UTF-8, upper-case hex); '/' and ':' in selector segments, '/'
// and '@' in path segments.
const ALWAYS_ENCODED = /^[%\p{Cc}\p{Cf}\p{Z}]$/u;
const MAX_SEGMENTS = 256;

function utf8Bytes(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

function encodePart(value: string, structural: string): string | null {
  if (value === '') return null;
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    if (ALWAYS_ENCODED.test(ch) || structural.includes(ch)) {
      for (const byte of utf8Bytes(cp)) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    } else out += ch;
  }
  return out;
}

/** Canonical selector text from decoded segments, or null when a segment cannot be written (empty, unpaired surrogate). */
export function selectorText(segments: readonly string[]): string | null {
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  const parts: string[] = [];
  for (const segment of segments) {
    const part = encodePart(segment, '/:');
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join('/');
}

/** Canonical tree path from decoded segments (`/` for none), or null when a segment cannot be written. */
export function pathText(segments: readonly string[]): string | null {
  if (segments.length === 0) return '/';
  if (segments.length > MAX_SEGMENTS) return null;
  const parts: string[] = [];
  for (const segment of segments) {
    const part = encodePart(segment, '/@');
    if (part === null) return null;
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** Decoded segments of a canonical path written by pathText, or null for anything else. */
export function pathSegments(path: string): string[] | null {
  if (path === '/') return [];
  if (!path.startsWith('/') || path.endsWith('/')) return null;
  const out: string[] = [];
  for (const part of path.slice(1).split('/')) {
    if (part === '') return null;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return out;
}

/** UTF-8 byte offset of every UTF-16 index of a text (length + 1 entries), in one pass; a surrogate pair takes 4 bytes. */
export function utf8Offsets(text: string): Uint32Array {
  const offsets = new Uint32Array(text.length + 1);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    offsets[i] = bytes;
    const code = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      offsets[i + 1] = bytes;
      bytes += 4;
      i++;
      continue;
    }
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  offsets[text.length] = bytes;
  return offsets;
}

/** Case-insensitive glob over a whole name: `*` is any run, `?` one character. Linear in practice, no regular expressions. */
export function globMatch(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const s = name.toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < s.length) {
    if (i < p.length && p[i] === '*') {
      star = i++;
      mark = j;
    } else if (i < p.length && (p[i] === '?' || p[i] === s[j])) {
      i++;
      j++;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}

/**
 * JSON text with object keys sorted (code-unit order) at every level; undefined members are left out as JSON.stringify
 * does. A cycle is written as "[cycle]" so the function stays total on direct calls.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const write = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item) ?? 'null';
    if (seen.has(item)) return '"[cycle]"';
    seen.add(item);
    let out: string;
    if (Array.isArray(item)) out = `[${item.map((member) => (member === undefined ? 'null' : write(member))).join(',')}]`;
    else {
      const record = item as { [key: string]: unknown };
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(compareText);
      out = `{${keys.map((key) => `${JSON.stringify(key)}:${write(record[key])}`).join(',')}}`;
    }
    seen.delete(item);
    return out;
  };
  return write(value);
}

/** Order-preserving de-duplication. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

/** Warning text for an unexpected failure inside a function; the result stays well-formed. */
export function internalError(error: unknown): string {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return `内部错误，结果不完整：${detail.slice(0, 200)}`;
}

/** Runs a pack function entry so that it never throws: an unexpected failure becomes `fallback(warning)`. */
export function guarded<T>(run: () => T, fallback: (warning: string) => T): T {
  try {
    return run();
  } catch (error) {
    return fallback(internalError(error));
  }
}

/** Valid calendar date (proleptic Gregorian). */
export function validDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1900 || year > 2999 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
