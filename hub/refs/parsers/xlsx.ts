// xlsx@1: bounded in-memory ZIP decoding and generic SpreadsheetML structure, with no workflow semantics.
import { crc32, inflateRawSync } from 'node:zlib';
import { ParseError, ParseEncodingError, ParseForbiddenError, ParseLimitError, ParseSyntaxError } from '../parser.ts';
import { checkSize, effectiveLimits, mediaTypeEssence, nodesError, selectorCharsError, type Fragment, type ParsedDocument, type Parser, type ParseLimits, type ParseOptions } from '../parser.ts';
import { MAX_SELECTOR_LENGTH, selectorOf, trySelectorSegments } from '../reference.ts';
import { xmlParser, type XmlElement } from './xml.ts';
const KEY = 'xlsx@1';
/** Hard container caps. Parser options may lower input size, but cannot raise these security limits. */
export const XLSX_ZIP_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxMembers: 256, maxMemberBytes: 16 * 1024 * 1024, maxExpandedBytes: 32 * 1024 * 1024, maxRatio: 100 });
const syntax = (message: string): never => { throw new ParseSyntaxError(KEY, message); };
const forbidden = (message: string): never => { throw new ParseForbiddenError(KEY, message); };
// ZIP legacy filename encoding (CP437); UTF-8 filenames use general-purpose flag 11.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
/** Internal ZIP decoder for this parser and its synthetic tests. Never extracts to disk or follows a path. */
export function readXlsxArchive(input: Uint8Array): Map<string, Buffer> {
  if (!(input instanceof Uint8Array))
    throw new TypeError('bytes must be a Uint8Array');
  const limits = XLSX_ZIP_LIMITS;
  if (input.length > limits.maxBytes)
    throw new ParseLimitError(KEY, 'maxBytes', limits.maxBytes, `ZIP 总字节数超过上限 ${limits.maxBytes}`);
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const fits = (at: number, size: number, end: number): void => { if (at < 0 || size < 0 || at + size > end)
    syntax('ZIP 记录越界或不完整'); };
  const u64 = (at: number, end: number): number => { fits(at, 8, end); const n = bytes.readBigUInt64LE(at); if (n > BigInt(Number.MAX_SAFE_INTEGER))
    forbidden('ZIP 声明数值超过安全上限'); return Number(n); };
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--)
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) {
      end = at;
      break;
    }
  if (end < 0)
    syntax('ZIP 结束记录缺失或字节不是 ZIP');
  const disk = bytes.readUInt16LE(end + 4);
  const centralDisk = bytes.readUInt16LE(end + 6);
  if (disk !== 0 || centralDisk !== 0)
    forbidden('不接受分卷 ZIP');
  let count = bytes.readUInt16LE(end + 10);
  let directorySize = bytes.readUInt32LE(end + 12);
  let directoryAt = bytes.readUInt32LE(end + 16);
  let directoryEnd = end;
  if (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50) {
    if (bytes.readUInt32LE(end - 16) !== 0 || bytes.readUInt32LE(end - 4) !== 1)
      forbidden('不接受分卷 ZIP64');
    const at = u64(end - 12, end);
    fits(at, 56, end - 20);
    if (bytes.readUInt32LE(at) !== 0x06064b50 || at + 12 + u64(at + 4, end - 20) !== end - 20)
      syntax('ZIP64 目录记录不完整');
    if (bytes.readUInt32LE(at + 16) !== 0 || bytes.readUInt32LE(at + 20) !== 0)
      forbidden('不接受分卷 ZIP64');
    count = u64(at + 32, end - 20);
    if (u64(at + 24, end - 20) !== count)
      syntax('ZIP64 成员数不一致');
    directorySize = u64(at + 40, end - 20);
    directoryAt = u64(at + 48, end - 20);
    directoryEnd = at;
  }
  else if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff)
    syntax('ZIP64 目录记录缺失');
  if (bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10))
    syntax('ZIP 分卷成员数不一致');
  if (count > limits.maxMembers)
    forbidden(`ZIP 成员数超过上限 ${limits.maxMembers}`);
  if (!count)
    syntax('ZIP 没有成员');
  if (directoryAt + directorySize !== directoryEnd)
    syntax('ZIP 中央目录位置或大小不一致');
  fits(directoryAt, directorySize, directoryEnd);
  type Entry = {
    name: string;
    nameBytes: Buffer;
    version: number;
    flags: number;
    method: number;
    crc: number;
    size: number;
    compressed: number;
    at: number;
  };
  const entries: Entry[] = [];
  const seen = new Set<string>();
  let position = directoryAt;
  let expanded = 0;
  const flagsOk = (flags: number): void => {
    if (flags & (1 | 0x40 | 0x2000))
      forbidden('不接受加密 ZIP');
    if (flags & ~0x80e)
      syntax('ZIP 标志无效或不支持');
  };
  const extras = (at: number, size: number): Map<number, Buffer> => {
    const output = new Map<number, Buffer>();
    const stop = at + size;
    while (at < stop) {
      fits(at, 4, stop);
      const id = bytes.readUInt16LE(at);
      const size = bytes.readUInt16LE(at + 2);
      fits(at + 4, size, stop);
      if (output.has(id))
        syntax('ZIP 扩展字段重复');
      output.set(id, bytes.subarray(at + 4, at + 4 + size));
      at += 4 + size;
    }
    if (output.has(0x9901))
      forbidden('不接受加密 ZIP');
    return output;
  };
  for (let i = 0; i < count; i++) {
    fits(position, 46, directoryEnd);
    if (bytes.readUInt32LE(position) !== 0x02014b50)
      syntax('ZIP 中央目录签名不对');
    const nameLength = bytes.readUInt16LE(position + 28);
    const extra = bytes.readUInt16LE(position + 30);
    const comment = bytes.readUInt16LE(position + 32);
    fits(position, 46 + nameLength + extra + comment, directoryEnd);
    const entry: Entry = { name: '', nameBytes: bytes.subarray(position + 46, position + 46 + nameLength), version: bytes.readUInt16LE(position + 6), flags: bytes.readUInt16LE(position + 8), method: bytes.readUInt16LE(position + 10), crc: bytes.readUInt32LE(position + 16), compressed: bytes.readUInt32LE(position + 20), size: bytes.readUInt32LE(position + 24), at: bytes.readUInt32LE(position + 42) };
    flagsOk(entry.flags);
    if (entry.method !== 0 && entry.method !== 8)
      syntax('OOXML ZIP 压缩方法只支持存储和 Deflate');
    if (bytes.readUInt16LE(position + 34) !== 0)
      forbidden('不接受分卷 ZIP 成员');
    const fields = extras(position + 46 + nameLength, extra);
    let cursor = 0;
    for (const field of ['size', 'compressed', 'at'] as const)
      if (entry[field] === 0xffffffff) {
        const data = fields.get(1);
        if (!data || cursor + 8 > data.length)
          syntax('ZIP64 成员大小或偏移缺失');
        const n = data!.readBigUInt64LE(cursor);
        if (n > BigInt(Number.MAX_SAFE_INTEGER))
          forbidden('ZIP 声明数值超过安全上限');
        entry[field] = Number(n);
        cursor += 8;
      }
    const attributes = bytes.readUInt32LE(position + 38);
    const kind = (attributes >>> 16) & 0xf000;
    if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000)
      forbidden('ZIP 成员路径不能是链接或特殊文件');
    try {
      entry.name = entry.flags & 0x800 ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.nameBytes) : [...entry.nameBytes].map((byte) => byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128]).join('');
    }
    catch {
      syntax('ZIP 成员路径不是 UTF-8');
    }
    const unicode = fields.get(0x7075);
    if (unicode && unicode.length >= 5 && unicode[0] === 1 && unicode.readUInt32LE(1) === crc32(entry.nameBytes)) {
      try {
        entry.name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(unicode.subarray(5));
      }
      catch {
        syntax('ZIP Unicode 成员路径无效');
      }
    }
    const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
    if (!path || entry.name.length > 512 || /[\\:\u0000-\u001f\u007f]/.test(entry.name) || path.split('/').some((part) => part === '' || part === '.' || part === '..'))
      forbidden('ZIP 成员路径不安全或过长');
    if (seen.has(entry.name))
      syntax('ZIP 成员路径重复');
    seen.add(entry.name);
    expanded += entry.size;
    if (expanded > limits.maxExpandedBytes)
      forbidden(`ZIP 解压后的总量超过上限 ${limits.maxExpandedBytes}`);
    if (entry.size > limits.maxMemberBytes)
      forbidden(`ZIP 单个成员解压量超过上限 ${limits.maxMemberBytes}`);
    if (entry.size > limits.maxRatio * entry.compressed)
      forbidden(`ZIP 成员解压比超过上限 ${limits.maxRatio}`);
    entries.push(entry);
    position += 46 + nameLength + extra + comment;
  }
  if (position !== directoryEnd)
    syntax('ZIP 中央目录大小或成员数不一致');
  const output = new Map<string, Buffer>();
  const sorted = entries.sort((a, b) => a.at - b.at);
  let nextLocal = 0;
  for (const [i, entry] of sorted.entries()) {
    if (entry.at !== nextLocal)
      syntax('ZIP 本地成员不连续、重叠或有附加数据');
    fits(entry.at, 30, directoryAt);
    const at = entry.at;
    if (bytes.readUInt32LE(at) !== 0x04034b50)
      syntax('ZIP 本地头签名不对');
    const nameLength = bytes.readUInt16LE(at + 26);
    const extra = bytes.readUInt16LE(at + 28);
    flagsOk(bytes.readUInt16LE(at + 6));
    fits(at + 30, nameLength + extra + entry.compressed, directoryAt);
    extras(at + 30 + nameLength, extra);
    if (bytes.readUInt16LE(at + 4) !== entry.version || bytes.readUInt16LE(at + 6) !== entry.flags || bytes.readUInt16LE(at + 8) !== entry.method || !bytes.subarray(at + 30, at + 30 + nameLength).equals(entry.nameBytes))
      syntax('ZIP 本地头与中央目录不一致');
    const descriptor = (entry.flags & 8) !== 0;
    let localSize = bytes.readUInt32LE(at + 22);
    let localCompressed = bytes.readUInt32LE(at + 18);
    if (localSize === 0xffffffff || localCompressed === 0xffffffff) {
      const data = extras(at + 30 + nameLength, extra).get(1);
      let p = 0;
      for (const field of ['size', 'compressed'] as const)
        if ((field === 'size' ? localSize : localCompressed) === 0xffffffff) {
          if (!data || p + 8 > data.length)
            syntax('ZIP64 本地头大小缺失');
          const n = Number(data!.readBigUInt64LE(p));
          if (field === 'size')
            localSize = n;
          else
            localCompressed = n;
          p += 8;
        }
    }
    if ((!descriptor || localSize !== 0) && localSize !== entry.size || (!descriptor || localCompressed !== 0) && localCompressed !== entry.compressed || (!descriptor || bytes.readUInt32LE(at + 14) !== 0) && bytes.readUInt32LE(at + 14) !== entry.crc)
      syntax('ZIP 本地头大小或 CRC 与中央目录不一致');
    const dataAt = at + 30 + nameLength + extra;
    const data = bytes.subarray(dataAt, dataAt + entry.compressed);
    const nextAt = sorted[i + 1]?.at ?? directoryAt;
    const dataEnd = dataAt + data.length;
    if (descriptor) {
      const length = nextAt - dataEnd;
      if (![12, 16, 20, 24].includes(length))
        syntax('ZIP 数据描述符大小无效');
      let p = dataEnd;
      const wide = length >= 20;
      if (length === 16 || length === 24) {
        if (bytes.readUInt32LE(p) !== 0x08074b50)
          syntax('ZIP 数据描述符签名不对');
        p += 4;
      }
      if (bytes.readUInt32LE(p) !== entry.crc || (wide ? u64(p + 4, nextAt) : bytes.readUInt32LE(p + 4)) !== entry.compressed || (wide ? u64(p + 12, nextAt) : bytes.readUInt32LE(p + 8)) !== entry.size)
        syntax('ZIP 数据描述符大小或 CRC 不一致');
    }
    else if (dataEnd !== nextAt)
      syntax('ZIP 本地成员之间有附加数据');
    let content: Buffer;
    if (entry.method === 0)
      content = Buffer.from(data);
    else {
      try {
        const result = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size), info: true }) as unknown as {
          buffer: Buffer;
          engine: {
            bytesWritten: number;
          };
        };
        if (result.engine.bytesWritten !== data.length)
          syntax('ZIP Deflate 数据后有未消费的字节');
        content = result.buffer;
      }
      catch (error) {
        if (error instanceof ParseError)
          throw error;
        syntax('ZIP 解压失败、流不完整或实际解压大小超过声明上限');
      }
    }
    if (content!.length !== entry.size)
      syntax('ZIP 实际解压大小与声明不一致');
    if (crc32(content!) !== entry.crc)
      syntax('ZIP CRC 校验不一致');
    output.set(entry.name, content!);
    nextLocal = nextAt;
  }
  return output;
}
const LIMITS: Readonly<ParseLimits> = { maxBytes: XLSX_ZIP_LIMITS.maxBytes, maxDepth: 100, maxNodes: 1000000, maxAttributes: 1024 };
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOCUMENT_REL = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'];
const MAIN = ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'];
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
export type XlsxCell = {
  reference: string;
  type: string;
  text: string;
  formula: boolean;
  style: number | null;
};
export type XlsxRow = {
  number: number;
  hidden: boolean;
  cells: XlsxCell[];
};
export type XlsxSheet = {
  name: string;
  state: string;
  part: string;
  rows: XlsxRow[];
  lastRow: number;
};
export type XlsxModel = {
  members: {
    name: string;
    size: number;
    contentType: string | null;
  }[];
  relationships: {
    source: string;
    id: string;
    type: string;
    target: string;
    external: boolean;
  }[];
  sheets: XlsxSheet[];
  sharedStrings: string[];
  definedNames: {
    name: string;
    scope: number | null;
    reference: string;
  }[];
};
type Element = {
  name: string;
  uri: string;
  attributes: Map<string, string>;
  children: Array<Element | string>;
};
type NamespaceScope = {
  parent: NamespaceScope | null;
  bindings: Map<string, string>;
};
const children = (element: Element, name: string, uri = element.uri): Element[] => element.children.filter((child): child is Element => typeof child !== 'string' && child.name === name && child.uri === uri);
const attribute = (element: Element, name: string, uri = ''): string | undefined => element.attributes.get(`${uri}\0${name}`);
function textOf(element: Element): string {
  const parts: string[] = [];
  const stack: Array<Element | string> = [element];
  while (stack.length) {
    const next = stack.pop()!;
    if (typeof next === 'string')
      parts.push(next);
    else
      for (let i = next.children.length - 1; i >= 0; i--)
        stack.push(next.children[i]);
  }
  return parts.join('');
}
function required(element: Element, name: string): string {
  const value = attribute(element, name);
  if (value === undefined)
    syntax(`XLSX 部件缺少属性 ${name}`);
  return value!;
}
/** SpreadsheetML escaped strings, decoded once so an escaped underscore remains literal. */
function xstring(value: string): string {
  const text = value.replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  if (!text.isWellFormed())
    throw new ParseEncodingError(KEY, 'XLSX 转义字符串含不成对的代理字符');
  return text;
}
function integer(value: string, what: string, minimum = 0): number {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum)
    syntax(`XLSX ${what}不是有效整数`);
  return Number(value);
}
function bool(value: string | undefined): boolean {
  if (value === undefined || value === 'false' || value === '0')
    return false;
  if (value === 'true' || value === '1')
    return true;
  return syntax('XLSX 行隐藏标记不是有效布尔值');
}
function coordinate(reference: string): {
  row: number;
  column: number;
} {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(reference);
  if (!match)
    syntax('XLSX 单元格引用不是有效 A1 坐标');
  let column = 0;
  for (const letter of match![1])
    column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match![2]);
  if (column > 16384 || row > 1048576)
    syntax('XLSX 单元格坐标超出格式范围');
  return { row, column };
}
function columnName(column: number): string {
  let name = '';
  while (column > 0) {
    column--;
    name = String.fromCharCode(65 + column % 26) + name;
    column = Math.floor(column / 26);
  }
  return name;
}
/** Resolve only a package URI. This function never fetches an external relationship. */
function partTarget(source: string, target: string): string {
  const path = target.split('#')[0];
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  }
  catch {
    return syntax('XLSX 关系部件路径无效');
  }
  if (/[\\:\u0000-\u001f\u007f?]/.test(decoded!))
    syntax('XLSX 关系部件路径无效');
  if (!decoded!)
    return source || syntax('XLSX 关系目标缺失');
  const parts = decoded!.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const part of decoded!.split('/')) {
    if (part === '' || part === '.')
      continue;
    if (part === '..') {
      if (!parts.length)
        syntax('XLSX 关系目标越出包边界');
      parts.pop();
    }
    else
      parts.push(part);
  }
  return parts.join('/');
}
function parse(bytes: Uint8Array, options: ParseOptions = {}): ParsedDocument<XlsxModel> {
  const limits = effectiveLimits(LIMITS, options);
  checkSize(KEY, bytes, limits);
  const archive = readXlsxArchive(bytes);
  if (!archive.has('[Content_Types].xml') || !archive.has('_rels/.rels'))
    syntax('XLSX 缺少工作簿必需部件');
  const cache = new Map<string, Element>();
  let nodeCount = 0;
  const part = (name: string): Element => {
    const cached = cache.get(name);
    if (cached)
      return cached;
    const source = archive.get(name);
    if (!source)
      return syntax('XLSX 关系指向不存在的部件');
    if (nodeCount >= limits.maxNodes)
      throw nodesError(KEY, limits.maxNodes);
    let root: XmlElement;
    try {
      const xml = xmlParser.parse(source, { maxBytes: XLSX_ZIP_LIMITS.maxMemberBytes, maxDepth: limits.maxDepth, maxNodes: limits.maxNodes - nodeCount, maxAttributes: limits.maxAttributes, maxSelectorChars: limits.maxSelectorChars });
      if (xml.model.nulRemoved)
        forbidden('XLSX 部件 XML 被修复过，不能作为原样结构读取');
      root = xml.model.root;
    }
    catch (error) {
      if (error instanceof ParseLimitError)
        throw new ParseLimitError(KEY, error.limit, error.max, error.message);
      if (error instanceof ParseError && error.parser === KEY)
        throw error;
      if (error instanceof ParseError)
        throw new ParseSyntaxError(KEY, `XLSX 部件 XML 无法解析：${error.message}`);
      throw error;
    }
    let output: Element | undefined;
    const stack: {
      raw: XmlElement;
      scope: NamespaceScope | null;
      parent: Element | null;
      index: number;
    }[] = [{ raw: root, scope: { parent: null, bindings: new Map([['xml', XML_NS]]) }, parent: null, index: 0 }];
    while (stack.length) {
      const { raw, scope, parent, index } = stack.pop()!;
      if (++nodeCount > limits.maxNodes)
        throw nodesError(KEY, limits.maxNodes);
      if (raw.irregular !== null)
        forbidden('XLSX 部件 XML 被修复过或起始标签不规范');
      const own: NamespaceScope = { parent: scope, bindings: new Map() };
      for (const [name, value] of Object.entries(raw.attributes))
        if (name === 'xmlns')
          own.bindings.set('', value);
        else if (name.startsWith('xmlns:'))
          own.bindings.set(name.slice(6), value);
      if (own.bindings.has('xml') && own.bindings.get('xml') !== XML_NS || own.bindings.has('xmlns'))
        syntax('XLSX XML 命名空间声明无效');
      const expanded = (name: string, attr: boolean): [
        string,
        string
      ] => {
        const split = name.split(':');
        if (split.length > 2)
          return syntax('XLSX XML 名字含多个前缀分隔符');
        const prefix = split.length === 2 ? split[0] : '';
        let uri = '';
        if (!attr || prefix) {
          let current: NamespaceScope | null = own;
          while (current) {
            if (current.bindings.has(prefix)) {
              uri = current.bindings.get(prefix)!;
              break;
            }
            current = current.parent;
          }
          if (prefix && !uri)
            syntax('XLSX XML 使用未声明的命名空间前缀');
        }
        return [uri, split.at(-1)!];
      };
      const [uri, name] = expanded(raw.name, false);
      const element: Element = { name, uri, attributes: new Map(), children: [] };
      for (const [key, value] of Object.entries(raw.attributes)) {
        if (key === 'xmlns' || key.startsWith('xmlns:'))
          continue;
        const [uri, name] = expanded(key, true);
        const expandedKey = `${uri}\0${name}`;
        if (element.attributes.has(expandedKey))
          syntax('XLSX XML 展开后的属性重复');
        element.attributes.set(expandedKey, value);
      }
      if (parent)
        parent.children[index] = element;
      else
        output = element;
      element.children = raw.children.map((child) => typeof child === 'string' ? child : '');
      for (let i = raw.children.length - 1; i >= 0; i--) {
        const child = raw.children[i];
        if (typeof child !== 'string')
          stack.push({ raw: child, scope: own, parent: element, index: i });
      }
    }
    cache.set(name, output!);
    return output!;
  };
  const types = part('[Content_Types].xml');
  if (types.name !== 'Types' || types.uri !== CONTENT_TYPES)
    syntax('XLSX 内容类型部件无效');
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const element of children(types, 'Default'))
    defaults.set(required(element, 'Extension').toLowerCase(), required(element, 'ContentType'));
  for (const element of children(types, 'Override'))
    overrides.set(partTarget('', required(element, 'PartName')), required(element, 'ContentType'));
  const members = [...archive].map(([name, value]) => ({ name, size: value.length, contentType: name === '[Content_Types].xml' ? 'application/xml' : overrides.get(name) ?? defaults.get(name.split('.').at(-1)!.toLowerCase()) ?? null }));
  // Opaque XML parts are checked for syntax/repairs only; no style, theme, property, macro or link is interpreted.
  for (const member of members)
    if (/\.(?:xml|rels)$/i.test(member.name) || /(?:\+xml|\/xml)$/.test(mediaTypeEssence(member.contentType ?? '')))
      part(member.name);
  const relationships: XlsxModel['relationships'] = [];
  const related = new Map<string, {
    id: string;
    type: string;
    target: string;
    external: boolean;
    resolved: string | null;
  }[]>();
  for (const member of members.filter((member) => member.name.endsWith('.rels'))) {
    const path = member.name;
    let source = '';
    if (path !== '_rels/.rels') {
      const match = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/.exec(path);
      if (!match)
        syntax('XLSX 关系部件路径无效');
      source = [match![1], match![2]].filter(Boolean).join('/');
      if (!archive.has(source))
        syntax('XLSX 关系部件的源部件不存在');
    }
    const root = part(path);
    if (root.name !== 'Relationships' || root.uri !== PACKAGE_REL)
      syntax('XLSX 关系部件 XML 无效');
    const list: NonNullable<ReturnType<typeof related.get>> = [];
    const ids = new Set<string>();
    for (const element of children(root, 'Relationship')) {
      const id = required(element, 'Id');
      const type = required(element, 'Type');
      const target = required(element, 'Target');
      const external = attribute(element, 'TargetMode') === 'External';
      if (ids.has(id))
        syntax('XLSX 关系标识重复');
      ids.add(id);
      const resolved = external ? null : partTarget(source, target);
      if (resolved !== null && !archive.has(resolved))
        syntax('XLSX 关系指向不存在的部件（关系断链）');
      relationships.push({ source, id, type, target, external });
      list.push({ id, type, target, external, resolved });
    }
    related.set(source, list);
  }
  const ofType = (type: string, value: string): boolean => DOCUMENT_REL.some((prefix) => type === `${prefix}/${value}`);
  const books = (related.get('') ?? []).filter((r) => !r.external && ofType(r.type, 'officeDocument'));
  if (books.length !== 1)
    syntax('XLSX 缺少唯一的工作簿部件关系');
  const bookPart = books[0].resolved!;
  const book = part(bookPart);
  if (book.name !== 'workbook' || !MAIN.includes(book.uri))
    syntax('XLSX 工作簿部件 XML 无效');
  const bookRelations = related.get(bookPart) ?? [];
  const strings = bookRelations.filter((r) => !r.external && ofType(r.type, 'sharedStrings'));
  if (strings.length > 1)
    syntax('XLSX 共享字符串部件关系不唯一');
  const richText = (element: Element): string => element.children.map((child) => typeof child === 'string' ? '' : child.uri !== element.uri ? '' : child.name === 't' ? xstring(textOf(child)) : child.name === 'r' ? children(child, 't').map((text) => xstring(textOf(text))).join('') : '').join('');
  let sharedStrings: string[] = [];
  if (strings.length) {
    const root = part(strings[0].resolved!);
    if (root.name !== 'sst' || !MAIN.includes(root.uri))
      syntax('XLSX 共享字符串部件无效');
    sharedStrings = children(root, 'si').map(richText);
  }
  const definedNames = children(book, 'definedNames').flatMap((root) => children(root, 'definedName')).map((element) => ({ name: xstring(required(element, 'name')), scope: attribute(element, 'localSheetId') === undefined ? null : integer(attribute(element, 'localSheetId')!, '定义名作用域'), reference: textOf(element) }));
  const sheets: XlsxSheet[] = [];
  const sheetRelations = new Map(bookRelations.map((relationship) => [relationship.id, relationship]));
  const usedSheetParts = new Set<string>();
  // Validate all sheet identities before creating any rows or cells; a cached XML part must not amplify the model.
  const sheetTargets = children(book, 'sheets').flatMap((root) => children(root, 'sheet')).map((sheet) => {
    const id = DOCUMENT_REL.map((uri) => attribute(sheet, 'id', uri)).find((id) => id !== undefined);
    const relationship = id === undefined ? undefined : sheetRelations.get(id);
    if (!relationship || relationship.external || !relationship.resolved)
      syntax('XLSX 工作表关系缺失或不是包内部件');
    const sheetPart = relationship!.resolved!;
    if (usedSheetParts.has(sheetPart)) syntax('XLSX 多张工作表指向同一个部件');
    usedSheetParts.add(sheetPart);
    return { sheet, relationship: relationship!, sheetPart };
  });
  for (const { sheet, relationship, sheetPart } of sheetTargets) {
    const root = part(sheetPart);
    const rows: XlsxRow[] = [];
    let lastRow = 0;
    let previousRow = 0;
    if (ofType(relationship!.type, 'worksheet') && (root.name !== 'worksheet' || !MAIN.includes(root.uri)))
      syntax('XLSX 工作表部件 XML 无效');
    for (const row of children(root, 'sheetData').flatMap((root) => children(root, 'row'))) {
      const number = attribute(row, 'r') === undefined ? previousRow + 1 : integer(attribute(row, 'r')!, '行号', 1);
      previousRow = number;
      const cells: XlsxCell[] = [];
      let column = 0;
      for (const cell of children(row, 'c')) {
        const reference = attribute(cell, 'r') ?? `${columnName(column + 1)}${number}`;
        const position = coordinate(reference);
        column = position.column;
        lastRow = Math.max(lastRow, position.row);
        const type = attribute(cell, 't') ?? 'n';
        const values = children(cell, 'v');
        let text = values.length ? textOf(values[0]) : '';
        if (type === 'str')
          text = xstring(text);
        if (type === 'inlineStr')
          text = children(cell, 'is').map(richText).join('');
        if (type === 's' && text !== '') {
          const index = integer(text, '共享字符串索引');
          if (!strings.length || index >= sharedStrings.length)
            syntax('XLSX 共享字符串部件或索引缺失');
          text = sharedStrings[index];
        }
        cells.push({ reference, type, text, formula: children(cell, 'f').length > 0, style: attribute(cell, 's') === undefined ? null : integer(attribute(cell, 's')!, '样式号') });
      }
      rows.push({ number, hidden: bool(attribute(row, 'hidden')), cells });
    }
    sheets.push({ name: xstring(required(sheet, 'name')), state: attribute(sheet, 'state') ?? 'visible', part: sheetPart, rows, lastRow });
  }
  const model: XlsxModel = { members, relationships, sheets, sharedStrings, definedNames };
  const fragments = new Map<string, Fragment>();
  let selectorChars = 0;
  const add = (segments: string[], text: string, data: XlsxCell | XlsxModel['definedNames'][number]): void => {
    const selector = selectorOf(segments);
    selectorChars += selector.length;
    if (selector.length > MAX_SELECTOR_LENGTH || selectorChars > limits.maxSelectorChars)
      throw selectorCharsError(KEY, Math.min(limits.maxSelectorChars, selector.length > MAX_SELECTOR_LENGTH ? MAX_SELECTOR_LENGTH : limits.maxSelectorChars));
    fragments.set(selector, { selector, text, byteRange: null, data });
  };
  for (const [s, sheet] of sheets.entries()) {
    const counts = new Map<string, number>();
    for (const row of sheet.rows)
      for (const cell of row.cells)
        counts.set(cell.reference, (counts.get(cell.reference) ?? 0) + 1);
    for (const [r, row] of sheet.rows.entries())
      for (const [c, cell] of row.cells.entries())
        add(counts.get(cell.reference) === 1 ? ['c', String(s), cell.reference] : ['i', String(s), String(r), String(c)], cell.text, cell);
  }
  definedNames.forEach((name, i) => add(['n', String(i)], name.reference, name));
  cache.clear();
  archive.clear();
  return {
    parser: KEY, model,
    locate(selector) { const segments = trySelectorSegments(selector); if (!segments)
      return null; return fragments.get(selectorOf(segments)) ?? null; },
    listSelectors(prefix = '', options = {}) { const output: string[] = []; const limit = options.limit ?? Infinity; for (const selector of fragments.keys()) {
      if (output.length >= limit)
        break;
      if (selector.startsWith(prefix))
        output.push(selector);
    } return output; },
    summary() { const cells = sheets.flatMap((sheet) => sheet.rows.flatMap((row) => row.cells)); return { parser: KEY, members: members.length, sheets: sheets.length, rows: sheets.reduce((n, sheet) => n + sheet.rows.length, 0), cells: cells.length, sharedStrings: sharedStrings.length, definedNames: definedNames.length, hiddenSheets: sheets.filter((sheet) => sheet.state === 'hidden' || sheet.state === 'veryHidden').length, hiddenRows: sheets.reduce((n, sheet) => n + sheet.rows.filter((row) => row.hidden).length, 0), formulas: cells.filter((cell) => cell.formula).length, externalRelationships: relationships.filter((relationship) => relationship.external).length }; },
  };
}
export const xlsxParser: Parser<XlsxModel> = { id: 'xlsx', version: 1, mediaTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel.sheet.macroEnabled.12'], limits: LIMITS, parse };
