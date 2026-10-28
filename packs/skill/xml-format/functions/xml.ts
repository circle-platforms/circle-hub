// xml@1: a generic ordered element tree read with saxes. Entity-free DOCTYPE is data; entities are never expanded/fetched.
// UTF-8, BOM-marked UTF-16, GB18030, GBK, Big5, ISO-8859-1 and US-ASCII; nesting, element, attribute and selector limits. Irregular start tags (unescaped
// quotes or '<' inside attribute values, attributes without values, duplicates) are tolerated and flagged on the
// element; any other malformation is an error.
// Selectors: `x/<name>[/<name>[k]...]` by element names (XPath style, k counts same-name siblings from 1 and is written
// only when the name repeats), `i[/<k>...]` by element child positions (0-based); either may end in `/@<attribute>`.
// The canonical selector is the name path, or the position path when the name path is longer than MAX_SELECTOR_LENGTH.
import { SaxesParser } from 'saxes';
import {
  ParseEncodingError,
  ParseError,
  ParseForbiddenError,
  ParseSyntaxError,
  QUOTATION_UNITS,
  attributesError,
  checkSize,
  depthError,
  effectiveLimits,
  mediaTypeCharset,
  nodesError,
  selectorCharsError,
  type ByteRange,
  type Fragment,
  type JsonObject,
  type ParsedDocument,
  type Parser,
  type ParseLimits,
  type ParseOptions,
  type QuotationSource,
  type QuotationUnit,
} from './format.ts';
import { MAX_SELECTOR_LENGTH, ReferenceSyntaxError, selectorSegment, trySelectorSegments } from './selectors.ts';
import { bomCharset, decodeEncoding, isUtf8Label, legacyCharset, type DecodedText } from './text-decoding.ts';

const KEY = 'xml@1';
const LIMITS: Readonly<ParseLimits> = { maxBytes: 16 * 1024 * 1024, maxDepth: 100, maxNodes: 1_000_000, maxAttributes: 1024 };
const INDEX = /^(?:0|[1-9][0-9]{0,8})$/;
const STEP = /^(.+)\[([1-9][0-9]{0,8})\]$/s;
// Longest attribute value the repair pass looks into for the closing quote.
const REPAIR_WINDOW = 64 * 1024;
const LATIN1_LABELS = new Set(['iso-8859-1', 'iso8859-1', 'iso_8859-1', 'latin1', 'latin-1', 'l1', 'iso-ir-100', 'cp819', 'ibm819', 'csisolatin1']);
const ASCII_LABELS = new Set(['us-ascii', 'ascii', 'ansi_x3.4-1968', 'iso646-us', 'us', 'cp367', 'ibm367', 'csascii']);
// saxes messages about start-tag syntax that are tolerated (the element is kept and flagged).
const TOLERATED = new Set([
  'no whitespace between attributes.',
  'disallowed character in attribute name.',
  'attribute without value.',
  'unquoted attribute value.',
  'disallowed character.',
  'undefined entity.',
  'disallowed character in entity name.',
  'malformed character entity.',
  'empty entity name.',
  'forward-slash in opening tag not followed by >.',
]);

export type XmlElement = {
  name: string;
  attributes: { [name: string]: string };
  /** Child elements and text in document order. */
  children: Array<XmlElement | string>;
  /** Byte range of the element from its start tag to the end of its end tag. */
  range: ByteRange;
  /** Start-tag irregularities that were tolerated, or null. */
  irregular: string[] | null;
};

export type XmlModel = {
  charset: string;
  declaration: { version: string | null; encoding: string | null; standalone: string | null } | null;
  /** The parser records DTD presence/read policy; internal markup declarations are not interpreted. */
  doctype?: { internalSubset: boolean; externalSubsetDeclared: boolean; externalSubsetRead: false } | null;
  root: XmlElement;
  comments: number;
  processingInstructions: number;
  /** U+0000 removed from attribute names and values (a start tag tolerates them; text content refuses them); always set by the parser. */
  nulRemoved?: number;
};

/** Package wire optimization; the public parser's quotation contract is unchanged. */
export const XML_COMPACT_QUOTATION: unique symbol = Symbol('xml compact quotation');
type CompactQuotation = {
  [XML_COMPACT_QUOTATION](options: {properties:boolean}): {
    stream:string;
    units:Array<Record<string,unknown>>;
  };
};

type Flat = {
  name: string;
  attributes: { [name: string]: string };
  parent: number;
  position: number;
  children: Array<number | string>;
  elements: number[];
  start: number;
  tagEnd: number;
  end: number;
  problems: string[];
};

type XmlCharset = Exclude<DecodedText['charset'], 'windows-1252'>;

function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isNameStop(code: number): boolean {
  return isXmlSpace(code) || code === 0x2f || code === 0x3e || code === 0x3d || code === 0x22 || code === 0x27 || code === 0x3c;
}

function charsetOf(label: string, from: string): XmlCharset {
  if (isUtf8Label(label)) return 'utf-8';
  if (LATIN1_LABELS.has(label)) return 'iso-8859-1';
  if (ASCII_LABELS.has(label)) return 'us-ascii';
  const legacy = legacyCharset(label);
  if (legacy) return legacy as XmlCharset;
  throw new ParseEncodingError(KEY, `XML ${from} 使用了不支持的编码`, 0);
}

/** RFC 7303 section 3.2: a byte order mark, else the charset parameter of the media type, else the XML declaration. */
function detectCharset(bytes: Uint8Array, mediaType: string | undefined): XmlCharset {
  const marker = bomCharset(bytes);
  const bom = marker === 'utf-8' ? 3 : marker ? 2 : 0;
  const parameter = mediaTypeCharset(mediaType);
  const given = parameter === null ? null : charsetOf(parameter, '媒体类型的 charset 参数');
  const head = marker?.startsWith('utf-16') ? new TextDecoder(marker).decode(bytes.subarray(0, 1024)) : Buffer.from(bytes.buffer, bytes.byteOffset + bom, Math.min(1024, bytes.byteLength - bom)).toString('latin1');
  const declaration = /^<\?xml[ \t\r\n][^>]*?\?>/.exec(head);
  const declared = declaration ? /[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*(["'])([A-Za-z][A-Za-z0-9._-]*)\1/.exec(declaration[0]) : null;
  const label = declared ? declared[2].toLowerCase() : null;
  if (marker) {
    const agrees = (value: string): boolean => value.toLowerCase() === 'utf-16' && marker.startsWith('utf-16') || charsetOf(value.toLowerCase(), '编码声明') === marker;
    if (parameter !== null && !agrees(parameter)) throw new ParseEncodingError(KEY, 'XML 字节序标记与媒体类型编码不一致', 0);
    if (label !== null && !agrees(label)) throw new ParseEncodingError(KEY, 'XML 字节序标记与 XML 编码声明不一致', 0);
    return marker;
  }
  if (given !== null) return given;
  return label === null ? 'utf-8' : charsetOf(label, 'XML 声明');
}

/** The decoded text of XML bytes, by the same charset rules as xml@1 (the whole-file text of an XML source). */
export function decodeXmlText(bytes: Uint8Array, mediaType: string | undefined): string {
  const charset = detectCharset(bytes, mediaType);
  return decodeEncoding(KEY, bytes, charset).text;
}

/**
 * After a candidate closing quote at p-1: the tag ends; or white space and the next attribute (or a value-less name
 * ending the tag) follow; or, without white space, a complete `name="` follows (a missing separator, not a stray quote).
 */
function closesValue(text: string, p: number): boolean {
  const n = text.length;
  let k = p;
  while (k < n && k - p < 256 && isXmlSpace(text.charCodeAt(k))) k++;
  if (k >= n) return true;
  const c = text.charCodeAt(k);
  if (c === 0x3e) return true;
  if (c === 0x2f) return text.charCodeAt(k + 1) === 0x3e;
  let m = k;
  while (m < n && m - k < 256 && !isNameStop(text.charCodeAt(m))) m++;
  if (m === k || m - k >= 256) return false;
  while (m < n && m - k < 512 && isXmlSpace(text.charCodeAt(m))) m++;
  const d = text.charCodeAt(m);
  if (k === p) {
    if (d !== 0x3d) return false;
    m++;
    while (m < n && m - k < 768 && isXmlSpace(text.charCodeAt(m))) m++;
    const q = text.charCodeAt(m);
    return q === 0x22 || q === 0x27;
  }
  return d === 0x3d || d === 0x3e || (d === 0x2f && text.charCodeAt(m + 1) === 0x3e);
}

function placeholdersFor(text: string): [string, string, string] | null {
  const present = new Set<number>();
  for (const match of text.matchAll(/[-]/g)) present.add(match[0].charCodeAt(0));
  const free: string[] = [];
  for (let cp = 0xe000; cp <= 0xf8ff && free.length < 3; cp++) if (!present.has(cp)) free.push(String.fromCharCode(cp));
  return free.length === 3 ? [free[0], free[1], free[2]] : null;
}

/**
 * The first plausible closing quote at or after a position, for one quote character. Value starts only move forward
 * and whether a quote closes a value depends only on what follows it, so every quote is examined once: linear overall.
 */
function closingQuotes(text: string, quote: string): (from: number) => number {
  let next = 0;
  let found = -1;
  return (from) => {
    if (found >= from) return found;
    for (let k = text.indexOf(quote, Math.max(next, from)); k >= 0; k = text.indexOf(quote, k + 1)) {
      next = k + 1;
      if (closesValue(text, k + 1)) return (found = k);
    }
    next = text.length;
    return (found = -1);
  };
}

/**
 * Length-preserving repair of quoted attribute values that contain their own quote character or '<': those characters
 * are swapped for private-use placeholders that saxes accepts, and swapped back in the attribute values afterwards.
 * The closing quote of a value is the first one followed by the end of the tag or by white space and another attribute.
 */
function repairStartTags(text: string, marks: [string, string, string]): { text: string; notes: Map<number, string[]> } {
  const notes = new Map<number, string[]>();
  const swaps: Array<[number, string]> = [];
  const [doubleMark, singleMark, ltMark] = marks;
  const closeDouble = closingQuotes(text, '"');
  const closeSingle = closingQuotes(text, "'");
  const n = text.length;
  let i = 0;
  while (i < n) {
    const open = text.indexOf('<', i);
    if (open < 0) break;
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const end = text.indexOf(']]>', open + 9);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<?', open)) {
      const end = text.indexOf('?>', open + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    const next = text.charCodeAt(open + 1);
    if (next === 0x21 || next === 0x2f) {
      const end = text.indexOf('>', open + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    let j = open + 1;
    while (j < n && !isNameStop(text.charCodeAt(j))) j++;
    if (j === open + 1) {
      i = open + 1;
      continue;
    }
    const found: string[] = [];
    let resumeAt = -1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (isXmlSpace(c)) {
        j++;
        continue;
      }
      if (c === 0x3e) {
        j++;
        break;
      }
      if (c === 0x2f) {
        j++;
        if (text.charCodeAt(j) === 0x3e) {
          j++;
          break;
        }
        continue;
      }
      if (c === 0x3c) break;
      const nameStart = j;
      while (j < n && !isNameStop(text.charCodeAt(j))) j++;
      if (j === nameStart) {
        j++;
        continue;
      }
      while (j < n && isXmlSpace(text.charCodeAt(j))) j++;
      if (text.charCodeAt(j) !== 0x3d) continue;
      j++;
      while (j < n && isXmlSpace(text.charCodeAt(j))) j++;
      const quote = text.charCodeAt(j);
      if (quote !== 0x22 && quote !== 0x27) {
        while (j < n && !isXmlSpace(text.charCodeAt(j)) && text.charCodeAt(j) !== 0x3e) j++;
        continue;
      }
      const valueStart = j + 1;
      const close = (quote === 0x22 ? closeDouble : closeSingle)(valueStart);
      if (close < 0 || close >= valueStart + REPAIR_WINDOW) {
        // No plausible end of the value: leave the tag to saxes, which reports it.
        resumeAt = valueStart;
        break;
      }
      let inner = false;
      let lt = false;
      for (let k = valueStart; k < close; k++) {
        const ch = text.charCodeAt(k);
        if (ch === quote) {
          swaps.push([k, quote === 0x22 ? doubleMark : singleMark]);
          inner = true;
        } else if (ch === 0x3c) {
          swaps.push([k, ltMark]);
          lt = true;
        }
      }
      if (inner) found.push('属性值里有未转义的引号，已按原文恢复');
      if (lt) found.push('属性值里有未转义的 <，已按原文恢复');
      j = close + 1;
    }
    if (found.length > 0) notes.set(open, [...new Set(found)]);
    i = resumeAt >= 0 ? resumeAt : Math.max(j, open + 1);
  }
  if (swaps.length === 0) return { text, notes };
  swaps.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let at = 0;
  for (const [index, mark] of swaps) {
    parts.push(text.slice(at, index), mark);
    at = index + 1;
  }
  parts.push(text.slice(at));
  return { text: parts.join(''), notes };
}

function plainMessage(error: Error): string {
  return error.message.replace(/^(?:[^:\n]*:)?\d+:\d+: /, '');
}

function defineOwn<T>(target: { [key: string]: T }, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function digits(value: number): number {
  return String(value).length;
}

function parse(bytes: Uint8Array, options: ParseOptions = {}): ParsedDocument<XmlModel> {
  const limits = effectiveLimits(LIMITS, options);
  checkSize(KEY, bytes, limits);
  const charset = detectCharset(bytes, options.mediaType);
  const decoded = decodeEncoding(KEY, bytes, charset);
  const source = decoded.text;
  const { offsets } = decoded;
  const marks = placeholdersFor(source);
  const repaired = marks ? repairStartTags(source, marks) : { text: source, notes: new Map<number, string[]>() };
  let nulRemoved = 0;
  // Placeholders back to the characters they stand for; U+0000 is removed (PostgreSQL text refuses it) and counted.
  const restore = (value: string): string => {
    let out = value;
    if (marks) {
      if (out.includes(marks[0])) out = out.replaceAll(marks[0], '"');
      if (out.includes(marks[1])) out = out.replaceAll(marks[1], "'");
      if (out.includes(marks[2])) out = out.replaceAll(marks[2], '<');
    }
    if (out.includes('\u0000')) {
      const cleaned = out.replaceAll('\u0000', '');
      nulRemoved += out.length - cleaned.length;
      out = cleaned;
    }
    return out;
  };
  const text = repaired.text;

  const flats: Flat[] = [];
  const open: number[] = [];
  let pending: { name: string; start: number; problems: string[]; attributes: number } | null = null;
  let declaration: XmlModel['declaration'] = null;
  let doctype: NonNullable<XmlModel['doctype']> | null = null;
  let comments = 0;
  let processingInstructions = 0;
  let attributeTotal = 0;
  const parser = new SaxesParser({ xmlns: false, position: true });
  const here = (): number | null => offsets.at(Math.min(parser.position, source.length));

  parser.on('xmldecl', (decl) => {
    declaration = { version: decl.version ?? null, encoding: decl.encoding ?? null, standalone: decl.standalone ?? null };
  });
  parser.on('doctype', (value) => {
    let inside = false; let closed = false; let subsetAt = value.length;
    const headerValid = (header: string): void => {
      const literal = `(?:"[^"]*"|'[^']*')`;
      const space = '[ \t\r\n]';
      const match = new RegExp(String.raw`^${space}*([^ \t\r\n<>\[\]"'?]+)(?:${space}+(?:SYSTEM${space}+${literal}|PUBLIC${space}+${literal}${space}+${literal}))?${space}*$`).exec(header);
      if (!match) throw new ParseSyntaxError(KEY, 'DOCTYPE 头部语法不对', here());
      try { new SaxesParser().write(`<${match[1]}/>`).close(); }
      catch { throw new ParseSyntaxError(KEY, 'DOCTYPE 根名称语法不对', here()); }
    };
    for (let i = 0; i < value.length; i++) {
      if (closed && !isXmlSpace(value.charCodeAt(i))) throw new ParseSyntaxError(KEY, 'DOCTYPE 内部子集结束后只能有空白', here());
      if (inside && value.startsWith('<!--', i)) {
        const end = value.indexOf('-->', i + 4);
        if (end < 0) throw new ParseSyntaxError(KEY, 'DOCTYPE 注释没有结束', here());
        i = end + 2;
      } else if (inside && value.startsWith('<?', i)) {
        const end = value.indexOf('?>', i + 2);
        if (end < 0) throw new ParseSyntaxError(KEY, 'DOCTYPE 内部的处理指令没有结束', here());
        i = end + 1;
      } else if (!inside && (value[i] === '"' || value[i] === "'")) {
        const end = value.indexOf(value[i], i + 1);
        if (end < 0) throw new ParseSyntaxError(KEY, 'DOCTYPE 外部标识的引号没有结束', here());
        i = end;
      } else if (value[i] === '[' && !inside) { headerValid(value.slice(0, i)); inside = true; subsetAt = i; }
      else if (value[i] === ']' && inside) { inside = false; closed = true; }
      else if (inside && !isXmlSpace(value.charCodeAt(i))) {
        if (value.startsWith('<!ENTITY', i)) throw new ParseForbiddenError(KEY, '不接受 DOCTYPE 中的实体声明（防止实体扩展与外部实体）', here());
        if (/^<!(?:ELEMENT|NOTATION)[ \t\r\n]/.test(value.slice(i, i + 12))) {
          let quote = ''; let end = -1;
          for (let j = i + 2; j < value.length; j++) {
            const c = value[j]!;
            if (quote) { if (c === quote) quote = ''; }
            else if (c === '"' || c === "'") quote = c;
            else if (c === '%') throw new ParseForbiddenError(KEY, '不接受 DOCTYPE 参数实体引用', here(), null, '展开参数实体引用后重新上传不依赖实体的 XML');
            else if (c === '>') { end = j; break; }
          }
          if (end < 0) throw new ParseSyntaxError(KEY, 'DOCTYPE 内部声明没有结束', here());
          i = end;
          continue;
        }
        if (value.startsWith('<!ATTLIST', i)) throw new ParseForbiddenError(KEY, '当前解析器不处理 DOCTYPE 内部属性声明，不能核实默认属性', here(), null, '提供显式属性且不依赖内部属性声明的 XML 导出后重新上传');
        throw new ParseForbiddenError(KEY, 'DOCTYPE 内部子集含不支持的内部声明或参数引用', here(), null, '提供不依赖这些内部声明或参数引用的 XML 导出后重新上传');
      }
    }
    if (inside) throw new ParseSyntaxError(KEY, 'DOCTYPE 内部子集没有结束', here());
    const header = value.slice(0, subsetAt);
    headerValid(header);
    doctype = { internalSubset: subsetAt !== value.length, externalSubsetDeclared: /^[ \t\r\n]*[^ \t\r\n]+[ \t\r\n]+(?:SYSTEM|PUBLIC)[ \t\r\n]+["']/.test(header), externalSubsetRead: false };
  });
  parser.on('processinginstruction', () => {
    processingInstructions++;
  });
  parser.on('comment', () => {
    comments++;
  });
  parser.on('opentagstart', (tag) => {
    const end = parser.position;
    let start = end - tag.name.length - 2;
    if (text.charCodeAt(end - 1) === 0x0a && text.charCodeAt(end - 2) === 0x0d) start--;
    if (!text.startsWith(`<${tag.name}`, start)) start = text.lastIndexOf(`<${tag.name}`, end);
    if (open.length + 1 > limits.maxDepth) throw depthError(KEY, limits.maxDepth, offsets.at(start));
    if (flats.length + 1 > limits.maxNodes) throw nodesError(KEY, limits.maxNodes, offsets.at(start));
    pending = { name: tag.name, start, problems: [...(repaired.notes.get(start) ?? [])], attributes: 0 };
  });
  parser.on('attribute', () => {
    if (pending !== null && ++pending.attributes > limits.maxAttributes) throw attributesError(KEY, limits.maxAttributes, offsets.at(pending.start));
  });
  parser.on('opentag', (tag) => {
    const started = pending ?? { name: tag.name, start: parser.position, problems: [], attributes: 0 };
    pending = null;
    const attributes: { [name: string]: string } = {};
    let nulInTag = false;
    for (const [name, value] of Object.entries(tag.attributes)) {
      const before = nulRemoved;
      defineOwn(attributes, restore(name), restore(value));
      if (nulRemoved > before) nulInTag = true;
    }
    if (nulInTag) started.problems.push('起始标签里有 U+0000，已删除');
    attributeTotal += Object.keys(attributes).length;
    const parent = open.length > 0 ? open[open.length - 1] : -1;
    const index = flats.length;
    flats.push({
      name: tag.name,
      attributes,
      parent,
      position: parent >= 0 ? flats[parent].elements.length : 0,
      children: [],
      elements: [],
      start: started.start,
      tagEnd: parser.position,
      end: -1,
      problems: started.problems,
    });
    if (parent >= 0) {
      flats[parent].children.push(index);
      flats[parent].elements.push(index);
    }
    open.push(index);
  });
  const appendText = (value: string): void => {
    if (open.length === 0) return;
    const children = flats[open[open.length - 1]].children;
    const last = children.length - 1;
    if (last >= 0 && typeof children[last] === 'string') children[last] = (children[last] as string) + value;
    else children.push(value);
  };
  parser.on('text', appendText);
  parser.on('cdata', appendText);
  parser.on('closetag', () => {
    const index = open.pop();
    if (index !== undefined) flats[index].end = parser.position;
  });
  parser.on('error', (error) => {
    const message = plainMessage(error);
    if (pending !== null && (TOLERATED.has(message) || message.startsWith('duplicate attribute: '))) {
      pending.problems.push(`起始标签写法不规范（${message}）`);
      return;
    }
    // Saxes exposes no stable reason code: assign syntax at this adapter boundary, never infer a rule from prose.
    throw new ParseSyntaxError(KEY, 'XML 格式不对：不符合 XML 语法', here(), error.message);
  });
  try {
    parser.write(text).close();
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseSyntaxError(KEY, 'XML 格式不对', null, String(error));
  }
  if (flats.length === 0) throw new ParseSyntaxError(KEY, 'XML 没有根元素');
  const count = flats.length;

  // Nested model; built in two passes because children come after their parent in document order.
  const range = (flat: Flat): ByteRange => [offsets.at(flat.start), offsets.at(flat.end < 0 ? source.length : flat.end)];
  const nested: XmlElement[] = flats.map((flat) => ({
    name: flat.name,
    attributes: flat.attributes,
    children: [],
    range: range(flat),
    irregular: flat.problems.length > 0 ? flat.problems : null,
  }));
  flats.forEach((flat, index) => {
    for (const child of flat.children) nested[index].children.push(typeof child === 'string' ? child : nested[child]);
  });
  const model: XmlModel = { charset, declaration, doctype, root: nested[0], comments, processingInstructions, nulRemoved };

  // Selector lengths, without building any selector: the step of every element (`name` or `name[k]`), the length of
  // its name path and of its position path. The canonical selector is the name path when it fits, else the position
  // path; the sum over all elements and attributes is bounded by maxSelectorChars.
  const encoded = new Map<string, string | null>();
  const segmentOf = (raw: string): string | null => {
    let out = encoded.get(raw);
    if (out === undefined) {
      try {
        out = selectorSegment(raw);
      } catch (error) {
        if (!(error instanceof ReferenceSyntaxError)) throw error;
        out = null;
      }
      encoded.set(raw, out);
    }
    return out;
  };
  const steps = new Array<string | null>(count);
  const nameLength = new Float64Array(count);
  const indexLength = new Float64Array(count);
  {
    const seen = new Map<string, number>();
    const ordinal = new Map<string, number>();
    const stepOf = (child: number, k: number | null): void => {
      const name = segmentOf(flats[child].name);
      steps[child] = name === null ? null : k === null ? name : `${name}[${k}]`;
    };
    stepOf(0, null);
    for (const flat of flats) {
      if (flat.elements.length === 0) continue;
      seen.clear();
      ordinal.clear();
      for (const child of flat.elements) seen.set(flats[child].name, (seen.get(flats[child].name) ?? 0) + 1);
      for (const child of flat.elements) {
        const name = flats[child].name;
        const k = (ordinal.get(name) ?? 0) + 1;
        ordinal.set(name, k);
        stepOf(child, seen.get(name)! > 1 ? k : null);
      }
    }
  }
  let selectorChars = 0;
  const canonicalLength = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    const flat = flats[index];
    const step = steps[index];
    const parentName = flat.parent < 0 ? 1 : nameLength[flat.parent];
    nameLength[index] = step === null || parentName === Infinity ? Infinity : parentName + 1 + step.length;
    indexLength[index] = flat.parent < 0 ? 1 : indexLength[flat.parent] + 1 + digits(flat.position);
    const length = nameLength[index] <= MAX_SELECTOR_LENGTH ? nameLength[index] : indexLength[index] <= MAX_SELECTOR_LENGTH ? indexLength[index] : Infinity;
    canonicalLength[index] = length;
    if (length === Infinity) continue;
    selectorChars += length;
    for (const name of Object.keys(flat.attributes)) {
      const segment = segmentOf(`@${name}`);
      if (segment !== null && length + 1 + segment.length <= MAX_SELECTOR_LENGTH) selectorChars += length + 1 + segment.length;
    }
    if (selectorChars > limits.maxSelectorChars) throw selectorCharsError(KEY, limits.maxSelectorChars);
  }

  // Selectors, built on demand from the parent's (string concatenation keeps them cheap until they are read).
  const nameSelectors = new Array<string | undefined>(count);
  const indexSelectors = new Array<string | undefined>(count);
  /** Fills the cache from the nearest cached ancestor down to `index`; `make` builds one selector from its parent's. */
  const build = (cache: Array<string | undefined>, index: number, make: (node: number, parent: string | undefined) => string): string => {
    const chain: number[] = [];
    for (let at = index; at >= 0 && cache[at] === undefined; at = flats[at].parent) chain.push(at);
    for (let k = chain.length - 1; k >= 0; k--) {
      const node = chain[k];
      cache[node] = make(node, flats[node].parent < 0 ? undefined : cache[flats[node].parent]);
    }
    return cache[index]!;
  };
  const nameSelector = (index: number): string => build(nameSelectors, index, (node, parent) => (parent === undefined ? `x/${steps[node]}` : `${parent}/${steps[node]}`));
  const indexSelector = (index: number): string =>
    build(indexSelectors, index, (node, parent) => (parent === undefined ? 'i' : `${parent}/${flats[node].position}`));
  /** Canonical selector, or null when neither path fits MAX_SELECTOR_LENGTH (only with a raised maxDepth). */
  const canonical = (index: number): string | null => {
    if (nameLength[index] <= MAX_SELECTOR_LENGTH) return nameSelector(index);
    if (indexLength[index] <= MAX_SELECTOR_LENGTH) return indexSelector(index);
    return null;
  };
  const attributeSelector = (index: number, name: string): string | null => {
    const segment = segmentOf(`@${name}`);
    if (segment === null || canonicalLength[index] + 1 + segment.length > MAX_SELECTOR_LENGTH) return null;
    return `${canonical(index)}/${segment}`;
  };

  // The string values of all elements as slices of one text: the root's XPath string value.
  let shared: { text: string; start: Int32Array; end: Int32Array } | null = null;
  const stream = (): { text: string; start: Int32Array; end: Int32Array } => {
    if (shared) return shared;
    const start = new Int32Array(count);
    const end = new Int32Array(count);
    const parts: string[] = [];
    let length = 0;
    const stack: Array<[number, number]> = [[0, 0]];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const children = flats[top[0]].children;
      if (top[1] >= children.length) {
        end[top[0]] = length;
        stack.pop();
        continue;
      }
      const child = children[top[1]++];
      if (typeof child === 'string') {
        parts.push(child);
        length += child.length;
      } else {
        start[child] = length;
        stack.push([child, 0]);
      }
    }
    return (shared = { text: parts.join(''), start, end });
  };

  const elementFragment = (index: number, selector: string): Fragment => {
    const flat = flats[index];
    const { text: value, start, end } = stream();
    const data: JsonObject = {
      name: flat.name,
      attributes: flat.attributes,
      index: indexLength[index] <= MAX_SELECTOR_LENGTH ? indexSelector(index) : null,
      elements: flat.elements.length,
      irregular: flat.problems.length > 0 ? flat.problems : null,
    };
    // The start tag as written, so a consumer can judge a flagged element itself.
    if (flat.problems.length > 0) data.startTag = source.slice(flat.start, flat.tagEnd);
    return { selector, text: value.slice(start[index], end[index]), byteRange: range(flat), data };
  };
  const attributeFragment = (index: number, name: string): Fragment | null => {
    const flat = flats[index];
    if (!Object.hasOwn(flat.attributes, name)) return null;
    const selector = attributeSelector(index, name);
    if (selector === null) return null;
    return { selector, text: flat.attributes[name], byteRange: null, data: { element: canonical(index), name } };
  };
  // Children by name, per parent, built when a name path first passes through it.
  const byName = new Array<Map<string, number[]> | undefined>(count);
  const childrenNamed = (parent: number, name: string): number[] => {
    let map = byName[parent];
    if (map === undefined) {
      map = new Map();
      for (const child of flats[parent].elements) {
        const list = map.get(flats[child].name);
        if (list) list.push(child);
        else map.set(flats[child].name, [child]);
      }
      byName[parent] = map;
    }
    return map.get(name) ?? [];
  };
  const findByNames = (path: string[]): number | null => {
    let current = -1;
    for (const step of path) {
      const match = STEP.exec(step);
      const name = match ? match[1] : step;
      const ordinal = match ? Number(match[2]) : null;
      const same = current < 0 ? (flats[0].name === name ? [0] : []) : childrenNamed(current, name);
      if (ordinal === null) {
        if (same.length !== 1) return null;
        current = same[0];
      } else {
        if (ordinal > same.length) return null;
        current = same[ordinal - 1];
      }
    }
    return current < 0 ? null : current;
  };
  const findByPositions = (path: string[]): number | null => {
    let current = 0;
    for (const step of path) {
      if (!INDEX.test(step)) return null;
      const child = flats[current].elements[Number(step)];
      if (child === undefined) return null;
      current = child;
    }
    return current;
  };

  const document: ParsedDocument<XmlModel> & QuotationSource & CompactQuotation = {
    parser: KEY,
    model,
    locate(selector) {
      const segments = trySelectorSegments(selector);
      if (!segments || segments.length === 0) return null;
      const last = segments[segments.length - 1];
      const attribute = segments.length > 1 && last.startsWith('@') ? last.slice(1) : null;
      const path = attribute === null ? segments.slice(1) : segments.slice(1, -1);
      let index: number | null = null;
      if (segments[0] === 'x') index = path.length === 0 ? null : findByNames(path);
      else if (segments[0] === 'i') index = findByPositions(path);
      if (index === null) return null;
      if (attribute !== null) return attribute === '' ? null : attributeFragment(index, attribute);
      const canonicalSelector = canonical(index);
      return canonicalSelector === null ? null : elementFragment(index, canonicalSelector);
    },
    listSelectors(prefix = '', options = {}) {
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      const out: string[] = [];
      for (let index = 0; index < count && out.length < limit; index++) {
        const selector = canonical(index);
        if (selector === null) continue;
        if (prefix === '' || selector.startsWith(prefix)) out.push(selector);
        if (!options.properties) continue;
        for (const name of Object.keys(flats[index].attributes)) {
          if (out.length >= limit) break;
          const attribute = attributeSelector(index, name);
          if (attribute !== null && (prefix === '' || attribute.startsWith(prefix))) out.push(attribute);
        }
      }
      return out;
    },
    summary() {
      const counts = new Map<string, number>();
      let depth = 0;
      const levels = new Int32Array(count);
      flats.forEach((flat, index) => {
        counts.set(flat.name, (counts.get(flat.name) ?? 0) + 1);
        levels[index] = flat.parent < 0 ? 1 : levels[flat.parent] + 1;
        if (levels[index] > depth) depth = levels[index];
      });
      const names: JsonObject = {};
      for (const [name, total] of [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 64)) defineOwn(names, name, total);
      return {
        parser: KEY,
        charset,
        doctype: doctype !== null,
        internalSubset: doctype?.internalSubset ?? false,
        externalSubsetDeclared: doctype?.externalSubsetDeclared ?? false,
        externalSubsetRead: false,
        elements: count,
        attributes: attributeTotal,
        depth,
        irregular: flats.filter((flat) => flat.problems.length > 0).length,
        comments,
        processingInstructions,
        nulRemoved,
        names,
      };
    },
    [QUOTATION_UNITS]({ properties }) {
      const { text: value, start, end } = stream();
      const units: QuotationUnit[] = [];
      const unitOf = new Int32Array(count).fill(-1);
      for (let index = 0; index < count; index++) {
        const selector = canonical(index);
        if (selector === null) continue;
        const flat = flats[index];
        unitOf[index] = units.length;
        units.push({
          selector,
          text: value.slice(start[index], end[index]),
          byteRange: range(flat),
          parent: flat.parent < 0 ? -1 : unitOf[flat.parent],
          start: start[index],
          end: end[index],
        });
        if (!properties) continue;
        // An attribute value is not part of the element's text: a unit of its own.
        for (const name of Object.keys(flat.attributes)) {
          const attribute = attributeSelector(index, name);
          if (attribute !== null) units.push({ selector: attribute, text: flat.attributes[name], byteRange: null, parent: -1, start: -1, end: -1 });
        }
      }
      return { stream: value, units };
    },
    [XML_COMPACT_QUOTATION]({ properties }) {
      const { text: value, start, end } = stream();
      const units: Array<Record<string,unknown>> = [];
      const unitOf = new Int32Array(count).fill(-1);
      for (let index = 0; index < count; index++) {
        if (canonicalLength[index] > MAX_SELECTOR_LENGTH) continue;
        const flat = flats[index];
        unitOf[index] = units.length;
        units.push({selector_index: units.length, byteRange: range(flat),
          parent: flat.parent < 0 ? -1 : unitOf[flat.parent], start: start[index], end: end[index]});
        if (!properties) continue;
        for (const name of Object.keys(flat.attributes)) {
          const segment = segmentOf(`@${name}`);
          if (segment === null || canonicalLength[index] + 1 + segment.length > MAX_SELECTOR_LENGTH) continue;
          units.push({selector_index: units.length, text: flat.attributes[name], byteRange: null, parent: -1, start: -1, end: -1});
        }
      }
      return {stream: value, units};
    },
  };
  return document;
}

export const xmlParser: Parser<XmlModel> = { id: 'xml', version: 1, mediaTypes: ['application/xml', 'text/xml'], limits: LIMITS, parse };
