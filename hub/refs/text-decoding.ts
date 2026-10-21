// Text decoding with exact byte offsets: strict UTF-8 or single-byte charsets, BOM handling and NUL removal.
import { isUtf8 } from 'node:buffer';
import { ParseEncodingError, mediaTypeCharset } from './parser.ts';

/** Charsets the text parsers decode with exact byte offsets. */
export type TextCharset = 'utf-8' | 'iso-8859-1' | 'windows-1252' | 'us-ascii';

export interface DecodedText {
  text: string;
  charset: TextCharset;
  /** Bytes of a stripped byte order mark. */
  bom: number;
  offsets: ByteOffsets;
}

// WHATWG Encoding Standard labels of windows-1252 (browsers decode ISO-8859-1 and ASCII labels this way).
const WINDOWS_1252_LABELS = new Set([
  'ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591',
  'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252',
]);
const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8']);

export function isUtf8Label(label: string): boolean {
  return UTF8_LABELS.has(label.toLowerCase());
}

export function isWindows1252Label(label: string): boolean {
  return WINDOWS_1252_LABELS.has(label.toLowerCase());
}

/** Byte offset of the first invalid UTF-8 sequence (RFC 3629), or -1 when the bytes are valid. */
export function firstInvalidUtf8(bytes: Uint8Array): number {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min: number;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      min = 0x80;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      min = 0x800;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      min = 0x10000;
    } else return i;
    let cp = b & (0x3f >> need);
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return -1;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strict UTF-8: a leading BOM is stripped, any invalid sequence is a typed error carrying its byte offset. */
export function decodeUtf8(parser: string, bytes: Uint8Array): DecodedText {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const body = bom ? bytes.subarray(bom) : bytes;
  if (!isUtf8(body)) {
    const at = Math.max(0, firstInvalidUtf8(body)) + bom;
    throw new ParseEncodingError(parser, `不是有效的 UTF-8（第 ${at} 字节起）`, at);
  }
  const text = UTF8_DECODER.decode(body);
  return { text, charset: 'utf-8', bom, offsets: new ByteOffsets(text, true, bom) };
}

/** One byte per character: true ISO-8859-1, WHATWG windows-1252, or US-ASCII (bytes above 0x7F rejected). */
export function decodeSingleByte(parser: string, bytes: Uint8Array, charset: Exclude<TextCharset, 'utf-8'>): DecodedText {
  let text: string;
  if (charset === 'windows-1252') {
    text = new TextDecoder('windows-1252').decode(bytes);
  } else {
    if (charset === 'us-ascii') {
      const at = bytes.findIndex((b) => b > 0x7f);
      if (at >= 0) throw new ParseEncodingError(parser, `声明为 US-ASCII，但第 ${at} 字节不是 ASCII`, at);
    }
    text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
  }
  return { text, charset, bom: 0, offsets: new ByteOffsets(text, false, 0) };
}

/**
 * Decodes text for the text-like parsers: the charset parameter of the media type decides (UTF-8 by default, WHATWG
 * windows-1252 for ISO-8859-1 and ASCII labels); any other declared charset is refused.
 */
export function decodeDeclared(parser: string, bytes: Uint8Array, mediaType: string | undefined): DecodedText {
  const label = mediaTypeCharset(mediaType);
  if (label === null || isUtf8Label(label)) return decodeUtf8(parser, bytes);
  if (isWindows1252Label(label)) return decodeSingleByte(parser, bytes, 'windows-1252');
  throw new ParseEncodingError(parser, `不支持的字符编码：${label}`);
}

/** Maps UTF-16 indices of a decoded string to byte offsets in the original bytes. */
export class ByteOffsets {
  readonly #text: string;
  readonly #utf8: boolean;
  readonly #base: number;
  #checkpoints: Float64Array | null = null;

  constructor(text: string, utf8: boolean, base: number) {
    this.#text = text;
    this.#utf8 = utf8;
    this.#base = base;
  }

  /** Byte offset of the character at `index` (or of the end when index equals the length). */
  at(index: number): number {
    if (!this.#utf8) return this.#base + index;
    const text = this.#text;
    const checkpoints = (this.#checkpoints ??= buildCheckpoints(text));
    const block = index >> 10;
    let offset = checkpoints[block];
    for (let i = block << 10; i < index; i++) offset += unitBytes(text.charCodeAt(i));
    return this.#base + offset;
  }
}

function unitBytes(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 2;
  return 3;
}

function buildCheckpoints(text: string): Float64Array {
  const blocks = (text.length >> 10) + 1;
  const out = new Float64Array(blocks + 1);
  let offset = 0;
  for (let i = 0; i < text.length; i++) {
    if ((i & 1023) === 0) out[i >> 10] = offset;
    offset += unitBytes(text.charCodeAt(i));
  }
  if ((text.length & 1023) === 0) out[text.length >> 10] = offset;
  return out;
}

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

/** Removes U+0000 (PostgreSQL text and jsonb refuse it); the original bytes stay intact in the object store. */
export function removeNul(text: string): string {
  return text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
}

export function countNul(text: string): number {
  let count = 0;
  for (let i = text.indexOf('\u0000'); i >= 0; i = text.indexOf('\u0000', i + 1)) count++;
  return count;
}

/** UTF-8 length of a string as TextEncoder would encode it. */
export function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Line structure of a decoded text: content start and end of each line, terminators CRLF, LF or CR. */
export interface Lines {
  starts: number[];
  ends: number[];
}

/** Splits into lines; a terminator at the very end does not open an extra empty line. Returns null when `max` is exceeded. */
export function splitLines(text: string, max: number): Lines | null {
  const starts: number[] = [];
  const ends: number[] = [];
  if (text.length === 0) return { starts, ends };
  const breaks = /\r\n|\r|\n/g;
  let start = 0;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    starts.push(start);
    ends.push(match.index);
    if (starts.length > max) return null;
    start = match.index + match[0].length;
  }
  if (start < text.length) {
    starts.push(start);
    ends.push(text.length);
    if (starts.length > max) return null;
  }
  return { starts, ends };
}
