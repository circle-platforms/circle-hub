// Reference text (B03): strict canonical parse and format of src, tree, entry and rec references, and the codecs of
// selectors (src), paths (tree) and JSON Pointers (rec). The grammar follows REFERENCE_FORMS in contracts/generated/protocol.ts.
import { PROTOCOL_CODES, type ProtocolCode } from '../../contracts/generated/protocol.ts';
import { REFERENCE_SCHEME, axisLabel, isReferenceScheme, type ReferenceScheme } from '../../contracts/generated/vocabulary.ts';
import type { Reference } from '../../contracts/src/reference.ts';
import { isWhiteSpace } from './text-decoding.ts';

export type { Reference };
export type SrcReference = Extract<Reference, { scheme: 'src' }>;
export type TreeReference = Extract<Reference, { scheme: 'tree' }>;
export type EntryReference = Extract<Reference, { scheme: 'entry' }>;
export type RecReference = Extract<Reference, { scheme: 'rec' }>;

export const MAX_REFERENCE_LENGTH = 8192;
export const MAX_SEGMENTS = 256;
/**
 * Longest canonical selector a core parser lists or answers with, in UTF-16 code units. A src reference built from it,
 * with any parser name and a byte range, stays under MAX_REFERENCE_LENGTH. Longer name paths fall back to position
 * paths where the grammar has them; otherwise the fragment has no selector.
 */
export const MAX_SELECTOR_LENGTH = 4096;
// Loose input to normalizeReference may exceed the canonical limit by surrounding white space and redundant escapes.
const MAX_LOOSE_LENGTH = MAX_REFERENCE_LENGTH + 1024;

/** Malformed reference text. Carries the registered code a caller sees for a reference that cannot be resolved. */
export class ReferenceSyntaxError extends Error {
  readonly code: ProtocolCode = 'REFERENCE_UNRESOLVED';
  readonly fix: string = PROTOCOL_CODES.REFERENCE_UNRESOLVED.fix;
  readonly input: string;
  /** UTF-16 index in `input` where the problem starts. */
  readonly position: number;
  constructor(message: string, input: string, position: number) {
    super(message);
    this.name = 'ReferenceSyntaxError';
    this.input = input;
    this.position = position;
  }
}

// Characters that never appear raw in a selector segment, path segment or pointer: the escape character, controls,
// format characters (zero-width and bidi marks) and every separator or space character.
const ALWAYS_ENCODED = /^[%\p{Cc}\p{Cf}\p{Z}]$/u;
type Part = 'selector' | 'path' | 'pointer';
// Characters that are structural in a part and so must be escaped inside it.
const STRUCTURAL: Record<Part, string> = { selector: '/:', path: '/@', pointer: '#' };

const DIGEST = /^[0-9a-f]{64}$/;
const PARSER_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAJOR = /^(?:0|[1-9][0-9]{0,8})$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/;
const ENCODER = new TextEncoder();
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function mustEncode(ch: string, part: Part): boolean {
  return ALWAYS_ENCODED.test(ch) || STRUCTURAL[part].includes(ch);
}

function hex2(byte: number): string {
  return byte.toString(16).toUpperCase().padStart(2, '0');
}

function codePointLabel(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Percent-encodes exactly the characters that must be escaped in the part; everything else stays raw (IRI style). */
function encodePart(value: string, part: Part, input: string): string {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) throw new ReferenceSyntaxError(`含有不成对的代理字符 ${codePointLabel(cp)}，不能写进引用`, input, 0);
    if (mustEncode(ch, part)) {
      for (const byte of ENCODER.encode(ch)) out += `%${hex2(byte)}`;
    } else out += ch;
  }
  return out;
}

/** Strict decoding of canonical text: escapes are upper-case, valid UTF-8 and only used where required. */
function decodePart(text: string, part: Part, input: string, offset: number): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x25) {
      const start = i;
      const bytes: number[] = [];
      while (i < text.length && text.charCodeAt(i) === 0x25) {
        const pair = text.slice(i + 1, i + 3);
        if (!/^[0-9A-F]{2}$/.test(pair)) {
          const message = /^[0-9a-fA-F]{2}$/.test(pair) ? '百分号转义要用大写十六进制' : '百分号转义不完整：% 后面要跟两位十六进制';
          throw new ReferenceSyntaxError(message, input, offset + i);
        }
        bytes.push(Number.parseInt(pair, 16));
        i += 3;
      }
      let decoded: string;
      try {
        decoded = STRICT_UTF8.decode(Uint8Array.from(bytes));
      } catch {
        throw new ReferenceSyntaxError('百分号转义不是有效的 UTF-8', input, offset + start);
      }
      for (const ch of decoded) {
        if (!mustEncode(ch, part)) {
          throw new ReferenceSyntaxError(`字符 ${codePointLabel(ch.codePointAt(0)!)} 不需要转义，规范写法里直接写出`, input, offset + start);
        }
      }
      out += decoded;
      continue;
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (cp >= 0xd800 && cp <= 0xdfff) throw new ReferenceSyntaxError(`含有不成对的代理字符 ${codePointLabel(cp)}`, input, offset + i);
    if (mustEncode(ch, part)) {
      throw new ReferenceSyntaxError(`字符 ${codePointLabel(cp)} 必须写成百分号转义（UTF-8，大写十六进制）`, input, offset + i);
    }
    out += ch;
    i += ch.length;
  }
  return out;
}

/** Decodes '/'-separated non-empty segments; throws on any non-canonical text. */
function decodeSegments(text: string, part: 'selector' | 'path', input: string, offset: number): string[] {
  const raw = text.split('/');
  if (raw.length > MAX_SEGMENTS) throw new ReferenceSyntaxError(`段数超过上限 ${MAX_SEGMENTS}`, input, offset);
  const out: string[] = [];
  let at = offset;
  for (const segment of raw) {
    if (segment === '') throw new ReferenceSyntaxError(part === 'selector' ? '片段定位里有空段' : '路径里有空段', input, at);
    out.push(decodePart(segment, part, input, at));
    at += segment.length + 1;
  }
  return out;
}

function encodeSegments(segments: readonly string[], part: 'selector' | 'path', input: string): string {
  if (segments.length > MAX_SEGMENTS) throw new ReferenceSyntaxError(`段数超过上限 ${MAX_SEGMENTS}`, input, 0);
  return segments
    .map((segment) => {
      if (typeof segment !== 'string' || segment === '') throw new ReferenceSyntaxError(part === 'selector' ? '片段定位里有空段' : '路径里有空段', input, 0);
      return encodePart(segment, part, input);
    })
    .join('/');
}

/** Selector text from decoded segments (each segment non-empty). */
export function selectorOf(segments: readonly string[]): string {
  if (segments.length === 0) throw new ReferenceSyntaxError('片段定位不能为空', '', 0);
  return encodeSegments(segments, 'selector', segments.join('/'));
}

/** Decoded segments of canonical selector text; throws ReferenceSyntaxError when the text is not canonical. */
export function selectorSegments(selector: string): string[] {
  if (selector === '') throw new ReferenceSyntaxError('片段定位不能为空', selector, 0);
  return decodeSegments(selector, 'selector', selector, 0);
}

/** Like selectorSegments but returns null instead of throwing; parsers use it inside locate(). */
export function trySelectorSegments(selector: string): string[] | null {
  if (typeof selector !== 'string' || selector === '' || selector.length > MAX_REFERENCE_LENGTH) return null;
  try {
    return decodeSegments(selector, 'selector', selector, 0);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return null;
    throw error;
  }
}

/** Like selectorOf but returns null for segments that cannot be written (empty, unpaired surrogates). */
export function trySelector(segments: readonly string[]): string | null {
  try {
    return selectorOf(segments);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return null;
    throw error;
  }
}

/** Canonical selector text of one segment, for parsers building selectors piece by piece. */
export function selectorSegment(segment: string): string {
  return encodeSegments([segment], 'selector', segment);
}

/** Tree path text from decoded segments; no segments is the root path `/`. */
export function pathOf(segments: readonly string[]): string {
  return segments.length === 0 ? '/' : `/${encodeSegments(segments, 'path', segments.join('/'))}`;
}

/** Decoded segments of a canonical tree path. */
export function pathSegments(path: string): string[] {
  return parsePath(path, path, 0);
}

function parsePath(path: string, input: string, offset: number): string[] {
  if (!path.startsWith('/')) throw new ReferenceSyntaxError('路径必须以 / 开头', input, offset);
  if (path === '/') return [];
  if (path.endsWith('/')) throw new ReferenceSyntaxError('路径末尾不能有 /（根路径只写 /）', input, offset + path.length - 1);
  return decodeSegments(path.slice(1), 'path', input, offset + 1);
}

/** JSON Pointer text (RFC 6901, `~0` and `~1` escapes) from tokens, with the characters that must be escaped percent-encoded. */
export function pointerOf(tokens: readonly string[]): string {
  if (tokens.length === 0) throw new ReferenceSyntaxError('JSON Pointer 至少要有一段；指整条记录时不写 #', '', 0);
  if (tokens.length > MAX_SEGMENTS) throw new ReferenceSyntaxError(`段数超过上限 ${MAX_SEGMENTS}`, '', 0);
  return tokens.map((token) => `/${encodePart(token.replaceAll('~', '~0').replaceAll('/', '~1'), 'pointer', token)}`).join('');
}

/** Tokens of canonical JSON Pointer text. */
export function pointerTokens(pointer: string): string[] {
  return parsePointer(pointer, pointer, 0);
}

function parsePointer(pointer: string, input: string, offset: number): string[] {
  if (!pointer.startsWith('/')) throw new ReferenceSyntaxError('JSON Pointer 必须以 / 开头', input, offset);
  const raw = pointer.slice(1).split('/');
  if (raw.length > MAX_SEGMENTS) throw new ReferenceSyntaxError(`段数超过上限 ${MAX_SEGMENTS}`, input, offset);
  const out: string[] = [];
  let at = offset + 1;
  for (const token of raw) {
    for (let i = token.indexOf('~'); i >= 0; i = token.indexOf('~', i + 1)) {
      const next = token[i + 1];
      if (next !== '0' && next !== '1') throw new ReferenceSyntaxError('JSON Pointer 里的 ~ 只能写成 ~0 或 ~1', input, at + i);
    }
    out.push(decodePart(token, 'pointer', input, at).replaceAll('~1', '/').replaceAll('~0', '~'));
    at += token.length + 1;
  }
  return out;
}

function fail(message: string, input: string, position: number): never {
  throw new ReferenceSyntaxError(message, input, position);
}

function checkDigest(value: unknown, input: string, position: number, what: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${what}必须是 64 位小写十六进制`, input, position);
  return value;
}

function checkParser(value: string, input: string, position: number): void {
  const at = value.indexOf('@');
  const name = at < 0 ? value : value.slice(0, at);
  if (!PARSER_NAME.test(name)) fail('解析器名称不对：小写字母开头，只含小写字母、数字和 _ . -，最长 64 个字符', input, position);
  if (at < 0) fail('缺少解析器主版本：应写成 解析器@主版本', input, position + value.length);
  if (!MAJOR.test(value.slice(at + 1))) fail('解析器主版本必须是不带前导零的整数', input, position + at + 1);
}

function checkRange(range: unknown, input: string, position: number): [number, number] {
  if (!Array.isArray(range) || range.length !== 2) fail('字节范围必须是 [起, 止] 两个整数', input, position);
  const [from, to] = range as unknown[];
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0) {
    fail('字节范围的起止必须是非负整数', input, position);
  }
  if (from >= to) fail('字节范围的起必须小于止', input, position);
  return [from, to];
}

function parseRange(text: string, input: string, position: number): [number, number] {
  const dash = text.indexOf('-');
  const from = dash < 0 ? text : text.slice(0, dash);
  const to = dash < 0 ? '' : text.slice(dash + 1);
  if (!DECIMAL.test(from)) fail('字节范围的起必须是不带前导零的十进制整数', input, position);
  if (dash < 0) fail('字节范围应写成 :起-止', input, position + text.length);
  if (!DECIMAL.test(to)) fail('字节范围的止必须是不带前导零的十进制整数', input, position + dash + 1);
  return checkRange([Number(from), Number(to)], input, position);
}

/** Parses canonical reference text. Anything else, including non-canonical spellings, raises ReferenceSyntaxError. */
export function parseReference(input: string): Reference {
  if (typeof input !== 'string') throw new ReferenceSyntaxError('引用必须是字符串', String(input), 0);
  if (input === '') fail('引用为空', input, 0);
  if (input.length > MAX_REFERENCE_LENGTH) fail(`引用超过 ${MAX_REFERENCE_LENGTH} 个字符的上限`, input, MAX_REFERENCE_LENGTH);
  const colon = input.indexOf(':');
  const scheme = colon < 0 ? '' : input.slice(0, colon);
  if (!isReferenceScheme(scheme)) {
    fail(`不认识的${axisLabel('reference_scheme')}：只支持 ${REFERENCE_SCHEME.map((s) => `${s}:`).join('、')}`, input, 0);
  }
  const at = colon + 1;
  const digest = checkDigest(input.slice(at, at + 64), input, at, '摘要');
  const tailAt = at + 64;
  const tail = input.slice(tailAt);
  switch (scheme) {
    case 'entry':
      if (tail !== '') fail('知识条目引用只有条目摘要，后面不能再接内容', input, tailAt);
      return { scheme, entry: digest };
    case 'src': {
      if (tail === '') return { scheme, sha256: digest };
      if (!tail.startsWith('/')) fail('摘要后面只能接 /解析器@主版本/片段定位', input, tailAt);
      const parserAt = tailAt + 1;
      const slash = input.indexOf('/', parserAt);
      if (slash < 0) {
        checkParser(input.slice(parserAt), input, parserAt);
        fail('解析器后面缺少片段定位', input, input.length);
      }
      const parser = input.slice(parserAt, slash);
      checkParser(parser, input, parserAt);
      const restAt = slash + 1;
      const rest = input.slice(restAt);
      const rangeColon = rest.indexOf(':');
      const selector = rangeColon < 0 ? rest : rest.slice(0, rangeColon);
      if (selector === '') fail('片段定位不能为空', input, restAt);
      decodeSegments(selector, 'selector', input, restAt);
      if (rangeColon < 0) return { scheme, sha256: digest, parser, selector };
      const range = parseRange(rest.slice(rangeColon + 1), input, restAt + rangeColon + 1);
      return { scheme, sha256: digest, parser, selector, range };
    }
    case 'tree': {
      if (!tail.startsWith('/')) fail('知识树引用的根摘要后面必须是以 / 开头的路径', input, tailAt);
      const entryAt = tail.indexOf('@');
      const path = entryAt < 0 ? tail : tail.slice(0, entryAt);
      parsePath(path, input, tailAt);
      if (entryAt < 0) return { scheme, root: digest, path };
      const entry = checkDigest(tail.slice(entryAt + 1), input, tailAt + entryAt + 1, '条目摘要');
      return { scheme, root: digest, path, entry };
    }
    case 'rec': {
      if (tail === '') return { scheme, record: digest };
      if (!tail.startsWith('#')) fail('记录摘要后面只能接 #JSON Pointer', input, tailAt);
      const pointer = tail.slice(1);
      if (pointer === '') fail('# 后面的 JSON Pointer 为空；指整条记录时不写 #', input, tailAt + 1);
      parsePointer(pointer, input, tailAt + 1);
      return { scheme, record: digest, pointer };
    }
  }
}

/** Canonical text of a reference object. Fields hold canonical text (selector, path, pointer); invalid objects raise. */
export function formatReference(reference: Reference): string {
  if (reference === null || typeof reference !== 'object') throw new ReferenceSyntaxError('引用对象缺失', String(reference), 0);
  const scheme = (reference as { scheme?: unknown }).scheme;
  if (!isReferenceScheme(scheme)) {
    throw new ReferenceSyntaxError(`不认识的${axisLabel('reference_scheme')}：只支持 ${REFERENCE_SCHEME.join('、')}`, String(scheme), 0);
  }
  let out: string;
  switch (reference.scheme) {
    case 'entry':
      out = `entry:${checkDigest(reference.entry, '', 0, '条目摘要')}`;
      break;
    case 'src': {
      const sha = checkDigest(reference.sha256, '', 0, '摘要');
      const { parser, selector, range } = reference;
      if (parser === undefined && selector === undefined) {
        if (range !== undefined) fail('只有带片段定位的 src 引用才能带字节范围', '', 0);
        out = `src:${sha}`;
        break;
      }
      if (typeof parser !== 'string' || typeof selector !== 'string') fail('解析器和片段定位必须同时给出', '', 0);
      checkParser(parser, parser, 0);
      if (selector === '') fail('片段定位不能为空', selector, 0);
      decodeSegments(selector, 'selector', selector, 0);
      out = `src:${sha}/${parser}/${selector}`;
      if (range !== undefined) {
        const [from, to] = checkRange(range, out, out.length);
        out += `:${from}-${to}`;
      }
      break;
    }
    case 'tree': {
      const root = checkDigest(reference.root, '', 0, '根摘要');
      if (typeof reference.path !== 'string') fail('知识树引用缺少路径', '', 0);
      parsePath(reference.path, reference.path, 0);
      out = `tree:${root}${reference.path}`;
      if (reference.entry !== undefined) out += `@${checkDigest(reference.entry, '', 0, '条目摘要')}`;
      break;
    }
    case 'rec': {
      out = `rec:${checkDigest(reference.record, '', 0, '记录摘要')}`;
      if (reference.pointer !== undefined) {
        if (typeof reference.pointer !== 'string' || reference.pointer === '') fail('JSON Pointer 为空；指整条记录时不写 pointer', '', 0);
        parsePointer(reference.pointer, reference.pointer, 0);
        out += `#${reference.pointer}`;
      }
      break;
    }
  }
  if (out.length > MAX_REFERENCE_LENGTH) fail(`引用超过 ${MAX_REFERENCE_LENGTH} 个字符的上限`, out, MAX_REFERENCE_LENGTH);
  return out;
}

/** Text without leading and trailing Unicode White_Space (a loop: a regular expression would backtrack on long runs). */
function trimWhiteSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isWhiteSpace(text.charCodeAt(start))) start++;
  while (end > start && isWhiteSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

function isDigits(text: string): boolean {
  if (text === '') return false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

function isHexDigits(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) | 0x20;
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66))) return false;
  }
  return true;
}

/** Decimal digits without leading zeros, keeping one digit. */
function withoutLeadingZeros(digits: string): string {
  let i = 0;
  while (i < digits.length - 1 && digits.charCodeAt(i) === 0x30) i++;
  return digits.slice(i);
}

/** `name` of a loose parser key: an ASCII letter, then letters, digits and `_ . -`. */
function isLooseParserName(name: string): boolean {
  if (name === '') return false;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const letter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
    if (i === 0 ? !letter : !(letter || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2e || c === 0x2d)) return false;
  }
  return true;
}

/** Lenient re-encoding of one part: escapes in any case are decoded, a stray `%` is literal, then canonical encoding. */
function reencode(text: string, part: Part, input: string): string {
  let decoded = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '%') {
      const bytes: number[] = [];
      while (text[i] === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
        i += 3;
      }
      if (bytes.length === 0) {
        decoded += '%';
        i++;
        continue;
      }
      try {
        decoded += STRICT_UTF8.decode(Uint8Array.from(bytes));
      } catch {
        throw new ReferenceSyntaxError('百分号转义不是有效的 UTF-8', input, 0);
      }
      continue;
    }
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    decoded += ch;
    i += ch.length;
  }
  return encodePart(decoded, part, input);
}

/**
 * Canonical text for a reference written loosely: surrounding white space, upper-case scheme or digests, escapes in
 * lower case or where none is needed, raw spaces, a trailing `/` on a tree path, leading zeros in numbers. The result
 * is parsed strictly, so anything still malformed raises ReferenceSyntaxError.
 */
export function normalizeReference(input: string | Reference): string {
  if (typeof input !== 'string') return formatReference(input);
  // Every step below is a linear scan; the length check bounds the work before any of it.
  if (input.length > MAX_LOOSE_LENGTH) fail(`引用超过 ${MAX_REFERENCE_LENGTH} 个字符的上限`, input, MAX_REFERENCE_LENGTH);
  let text = trimWhiteSpace(input);
  const colon = text.indexOf(':');
  if (colon > 0) {
    const scheme = text.slice(0, colon).toLowerCase();
    if (isReferenceScheme(scheme)) text = scheme + text.slice(colon);
  }
  const schemeEnd = text.indexOf(':');
  const scheme = schemeEnd < 0 ? '' : text.slice(0, schemeEnd);
  const hex = text.slice(schemeEnd + 1, schemeEnd + 65);
  if (!isReferenceScheme(scheme) || hex.length !== 64 || !isHexDigits(hex)) return formatReference(parseReference(text));
  const digest = hex.toLowerCase();
  let tail = text.slice(schemeEnd + 65);
  if (scheme === 'src' && tail.startsWith('/')) {
    // `/<name>@<digits>/`: the name holds no `@` or `/`, so the first `@` and the next `/` delimit it.
    const at = tail.indexOf('@', 1);
    const slash = at < 0 ? -1 : tail.indexOf('/', at + 1);
    const name = at < 0 ? '' : tail.slice(1, at);
    const major = slash < 0 ? '' : tail.slice(at + 1, slash);
    if (slash > 0 && isLooseParserName(name) && isDigits(major)) {
      let rest = tail.slice(slash + 1);
      let range = '';
      // `:<digits>-<digits>` at the very end; a range holds no `:`, so only the last one can start it.
      const rangeColon = rest.lastIndexOf(':');
      const dash = rangeColon < 0 ? -1 : rest.indexOf('-', rangeColon + 1);
      if (dash > 0 && isDigits(rest.slice(rangeColon + 1, dash)) && isDigits(rest.slice(dash + 1))) {
        range = `:${withoutLeadingZeros(rest.slice(rangeColon + 1, dash))}-${withoutLeadingZeros(rest.slice(dash + 1))}`;
        rest = rest.slice(0, rangeColon);
      }
      const selector = rest.split('/').map((segment) => reencode(segment, 'selector', input)).join('/');
      tail = `/${name.toLowerCase()}@${withoutLeadingZeros(major)}/${selector}${range}`;
    }
  } else if (scheme === 'tree' && tail.startsWith('/')) {
    let entry = '';
    const entryHex = tail.slice(-64);
    if (tail.length >= 66 && tail.charCodeAt(tail.length - 65) === 0x40 && isHexDigits(entryHex)) {
      entry = `@${entryHex.toLowerCase()}`;
      tail = tail.slice(0, -65);
    }
    if (tail.length > 1 && tail.endsWith('/')) tail = tail.slice(0, -1);
    tail = tail === '/' ? '/' : `/${tail.slice(1).split('/').map((segment) => reencode(segment, 'path', input)).join('/')}`;
    tail += entry;
  } else if (scheme === 'rec' && tail.startsWith('#')) {
    const pointer = tail.slice(1);
    tail = pointer.startsWith('/') ? `#/${pointer.slice(1).split('/').map((token) => reencode(token, 'pointer', input)).join('/')}` : tail;
  }
  return formatReference(parseReference(`${scheme}:${digest}${tail}`));
}

/** True when both references normalize to the same canonical text (same source, parser, selector and range). */
export function sameTarget(a: string | Reference, b: string | Reference): boolean {
  try {
    return normalizeReference(a) === normalizeReference(b);
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return false;
    throw error;
  }
}

/** The scheme and primary digest: the source bytes, tree root, entry or record a reference is rooted in. */
export function sourceOf(reference: string | Reference): { scheme: ReferenceScheme; digest: string } {
  const ref = typeof reference === 'string' ? parseReference(normalizeReference(reference)) : parseReference(formatReference(reference));
  switch (ref.scheme) {
    case 'src':
      return { scheme: ref.scheme, digest: ref.sha256 };
    case 'tree':
      return { scheme: ref.scheme, digest: ref.root };
    case 'entry':
      return { scheme: ref.scheme, digest: ref.entry };
    case 'rec':
      return { scheme: ref.scheme, digest: ref.record };
  }
}

/** True when both references are rooted in the same source bytes, tree root, entry or record. */
export function sameSource(a: string | Reference, b: string | Reference): boolean {
  try {
    const x = sourceOf(a);
    const y = sourceOf(b);
    return x.scheme === y.scheme && x.digest === y.digest;
  } catch (error) {
    if (error instanceof ReferenceSyntaxError) return false;
    throw error;
  }
}

/** Canonical `src:` reference to a fragment. `selector` is canonical selector text or decoded segments. */
export function srcFragment(sha256: string, parser: string, selector: string | readonly string[], range?: readonly [number, number]): string {
  const text = typeof selector === 'string' ? selector : selectorOf(selector);
  return formatReference({ scheme: 'src', sha256, parser, selector: text, ...(range ? { range: [range[0], range[1]] as [number, number] } : {}) });
}

/** Canonical `tree:` reference. `path` is canonical path text or decoded segments. */
export function treeReference(root: string, path: string | readonly string[], entry?: string): string {
  const text = typeof path === 'string' ? path : pathOf(path);
  return formatReference({ scheme: 'tree', root, path: text, ...(entry ? { entry } : {}) });
}

/** Canonical `rec:` reference. `pointer` is canonical pointer text or tokens. */
export function recReference(record: string, pointer?: string | readonly string[]): string {
  const text = pointer === undefined ? undefined : typeof pointer === 'string' ? pointer : pointerOf(pointer);
  return formatReference({ scheme: 'rec', record, ...(text === undefined ? {} : { pointer: text }) });
}

/** The same src reference with a byte range inside its fragment (replacing any range it had). */
export function withRange(reference: string, range: readonly [number, number]): string {
  const ref = parseReference(reference);
  if (ref.scheme !== 'src' || ref.selector === undefined) fail('只有带片段定位的 src 引用才能带字节范围', reference, 0);
  return formatReference({ ...ref, range: [range[0], range[1]] });
}

/** The same reference without a byte range. */
export function withoutRange(reference: string): string {
  const ref = parseReference(reference);
  if (ref.scheme !== 'src' || ref.range === undefined) return reference;
  const { range: _range, ...rest } = ref;
  return formatReference(rest);
}
