// Parser interface, typed parse errors and the parser registry (B03 F[0]: a parser@version declares the selector grammar).
import { PROTOCOL_CODES, type ProtocolCode } from './generated/protocol.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Half-open byte range [from, to) in the source bytes. */
export type ByteRange = [number, number];

/** A located fragment. `text` is what quotations are checked against; `byteRange` is its span in the source bytes when known. */
export type Fragment = {
  selector: string;
  text: string;
  byteRange: ByteRange | null;
  data?: JsonValue;
};

export interface ParseLimits {
  /** Largest accepted input in bytes. */
  maxBytes: number;
  /** Deepest accepted nesting (elements, mind-map levels, JSON levels or heading levels). */
  maxDepth: number;
  /** Most accepted units (elements, nodes, values or lines). */
  maxNodes: number;
  /** Most attributes in one tag (XML and HTML only). */
  maxAttributes?: number;
  /**
   * Most characters of canonical selector text in one document: the sum over every selector `listSelectors` can
   * return, properties included. Name paths repeat their ancestors, so long names over many nodes are refused here.
   */
  maxSelectorChars?: number;
}

export interface ParseOptions {
  /** Media type of the bytes, possibly with a charset parameter, e.g. `text/html; charset=ISO-8859-1`. */
  mediaType?: string;
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxAttributes?: number;
  maxSelectorChars?: number;
}

/** Default of `maxSelectorChars`: room for a million selectors of 64 characters. */
export const DEFAULT_MAX_SELECTOR_CHARS = 64 * 1024 * 1024;

export interface ListOptions {
  /** Return at most this many selectors. */
  limit?: number;
  /** Also list property selectors (XML attributes, mind-map data fields). */
  properties?: boolean;
}

export interface ParsedDocument<M extends JsonValue = JsonValue> {
  /** `id@version` of the parser that produced it. */
  readonly parser: string;
  /** JSON-serializable structure of the document. */
  readonly model: M;
  /** The fragment a selector points at, or null when the selector does not locate anything. Never throws for bad selectors. */
  locate(selector: string): Fragment | null;
  /** Canonical selectors in document order whose text starts with `prefix`. */
  listSelectors(prefix?: string, options?: ListOptions): string[];
  /** Structure-only summary (counts and shape, no document text), safe to show for unreadable sources. */
  summary(): JsonObject;
}

export interface Parser<M extends JsonValue = JsonValue> {
  readonly id: string;
  readonly version: number;
  /** Media types the parser accepts; `type/*` is a wildcard that matches after exact matches. */
  readonly mediaTypes: readonly string[];
  readonly limits: Readonly<ParseLimits>;
  /** Parses bytes. Throws a ParseError subclass for any input it does not accept; never executes anything. */
  parse(bytes: Uint8Array, options?: ParseOptions): ParsedDocument<M>;
}

export interface ParserRegistry {
  register(parser: Parser): void;
  /** Lookup by `id@version`, e.g. `xlsx@1`. */
  get(key: string): Parser | undefined;
  /** Parsers declaring the media type: exact matches first, then `type/*` wildcards, each in registration order. */
  forMediaType(mediaType: string): Parser[];
  list(): Parser[];
}

/** A parse failure the caller can show. The registered code is the one start_run uses when an input does not parse. */
export class ParseError extends Error {
  readonly code: ProtocolCode = 'SOURCE_UNPARSEABLE';
  readonly parser: string;
  /** Byte offset of the problem when known. */
  readonly offset: number | null;
  /** Untranslated detail from the underlying library, for the admin log. */
  readonly detail: string | null;
  /** Recovery is defined where the failure is constructed, not inferred from translated prose. */
  readonly fix: string;
  constructor(parser: string, message: string, offset: number | null = null, detail: string | null = null, fix: string = PROTOCOL_CODES.SOURCE_UNPARSEABLE.fix) {
    super(message);
    this.name = 'ParseError';
    this.parser = parser;
    this.offset = offset;
    this.detail = detail;
    this.fix = fix;
  }
}

/** A size, depth, node or attribute limit was exceeded. */
export class ParseLimitError extends ParseError {
  readonly limit: keyof ParseLimits;
  readonly max: number;
  constructor(parser: string, limit: keyof ParseLimits, max: number, message: string, offset: number | null = null, fix?: string) {
    const fixes: Record<keyof ParseLimits, string> = {
      maxBytes: `拆分文件，或上传不超过 ${max} 字节的较小文件`,
      maxDepth: `减少嵌套至 ${max} 层以内，或拆分文件后重新上传`,
      maxNodes: `拆分文件或减少节点/值数量至 ${max} 以内后重新上传`,
      maxAttributes: `减少单个标签的属性数至 ${max} 以内后重新上传`,
      maxSelectorChars: `缩短定位路径或拆分文件，使定位字符数不超过 ${max} 后重新上传`,
    };
    super(parser, message, offset, null, fix ?? fixes[limit]);
    this.name = 'ParseLimitError';
    this.limit = limit;
    this.max = max;
  }
}

/** The bytes are not in a supported character encoding. */
export class ParseEncodingError extends ParseError {
  constructor(parser: string, message: string, offset: number | null = null, detail: string | null = null) {
    super(parser, message, offset, detail);
    this.name = 'ParseEncodingError';
  }
}

/** The bytes are not well-formed for the format. */
export class ParseSyntaxError extends ParseError {
  constructor(parser: string, message: string, offset: number | null = null, detail: string | null = null) {
    super(parser, message, offset, detail);
    this.name = 'ParseSyntaxError';
  }
}

/** The input uses a construct the Hub refuses on principle (DOCTYPE, entity declarations). */
export class ParseForbiddenError extends ParseError {
  constructor(parser: string, message: string, offset: number | null = null, detail: string | null = null, fix: string = PROTOCOL_CODES.SOURCE_UNPARSEABLE.fix) {
    super(parser, message, offset, detail, fix);
    this.name = 'ParseForbiddenError';
  }
}

export function parserKey(parser: Pick<Parser, 'id' | 'version'>): string {
  return `${parser.id}@${parser.version}`;
}

const LIMIT_NAMES = ['maxBytes', 'maxDepth', 'maxNodes', 'maxAttributes', 'maxSelectorChars'] as const satisfies readonly (keyof ParseLimits)[];

/** Effective limits: the parser defaults overridden by positive integer options. */
export function effectiveLimits(defaults: Readonly<ParseLimits>, options: ParseOptions = {}): Required<ParseLimits> {
  const out: Required<ParseLimits> = {
    maxBytes: defaults.maxBytes,
    maxDepth: defaults.maxDepth,
    maxNodes: defaults.maxNodes,
    maxAttributes: defaults.maxAttributes ?? Number.MAX_SAFE_INTEGER,
    maxSelectorChars: defaults.maxSelectorChars ?? DEFAULT_MAX_SELECTOR_CHARS,
  };
  for (const name of LIMIT_NAMES) {
    const value = options[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
    out[name] = value;
  }
  return out;
}

export function checkSize(parser: string, bytes: Uint8Array, limits: Required<ParseLimits>): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
  if (bytes.length > limits.maxBytes) {
    throw new ParseLimitError(parser, 'maxBytes', limits.maxBytes, `源文件超过 ${limits.maxBytes} 字节的上限（实际 ${bytes.length} 字节）`);
  }
}

export function depthError(parser: string, max: number, offset: number | null = null): ParseLimitError {
  return new ParseLimitError(parser, 'maxDepth', max, `嵌套层数超过上限 ${max}`, offset);
}

export function nodesError(parser: string, max: number, offset: number | null = null): ParseLimitError {
  return new ParseLimitError(parser, 'maxNodes', max, `节点数超过上限 ${max}`, offset);
}

export function attributesError(parser: string, max: number, offset: number | null = null): ParseLimitError {
  return new ParseLimitError(parser, 'maxAttributes', max, `单个标签的属性数超过上限 ${max}`, offset);
}

export function selectorCharsError(parser: string, max: number): ParseLimitError {
  return new ParseLimitError(parser, 'maxSelectorChars', max, `片段定位的总长度超过上限 ${max} 个字符（名称或标题很长，且其下的节点很多）`);
}

export const QUOTATION_UNITS: unique symbol = Symbol('hub/refs quotation units');

export interface QuotationUnit {
  selector: string;
  text: string;
  byteRange: ByteRange | null;
  parent: number;
  start: number;
  end: number;
}

export interface QuotationUnits {
  stream: string;
  units: QuotationUnit[];
}

export interface QuotationSource {
  [QUOTATION_UNITS](options: { properties: boolean }): QuotationUnits;
}

export function mediaTypeEssence(mediaType: string): string {
  return mediaType.split(';')[0].trim().toLowerCase();
}

export function mediaTypeCharset(mediaType: string | undefined): string | null {
  if (!mediaType) return null;
  for (const part of mediaType.split(';').slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    const value = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
    return value || null;
  }
  return null;
}
