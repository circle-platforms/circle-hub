// The CRC-checked bounded ZIP decoder used for safe outbound container reads; outbound reads reject unscanned metadata regions.
import { crc32, inflateRawSync } from 'node:zlib';
import { ParseError, ParseForbiddenError, ParseLimitError, ParseSyntaxError } from './parser.ts';

const KEY = 'container@1';
const asciiFold = (value: string): string => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
export const CONTAINER_ZIP_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxMembers: 256, maxMemberBytes: 16 * 1024 * 1024, maxExpandedBytes: 32 * 1024 * 1024, maxRatio: 100 });
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

export function readContainerArchive(input: Uint8Array, options: {rejectOpaqueMetadata?:boolean} = {}): Map<string, Buffer> {
  if (!(input instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
  let memberOffset: number | null = null;
  let memberOrdinal: number | null = null;
  const located = (message: string): string => memberOrdinal === null ? message : `ZIP 成员 ${memberOrdinal}：${message}`;
  const syntax = (message: string): never => { throw new ParseSyntaxError(KEY, located(message), memberOffset); };
  const forbidden = (message: string): never => { throw new ParseForbiddenError(KEY, located(message), memberOffset); };
  const limits = CONTAINER_ZIP_LIMITS;
  if (input.length > limits.maxBytes) throw new ParseLimitError(KEY, 'maxBytes', limits.maxBytes, `ZIP 总字节数超过上限 ${limits.maxBytes}`);
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const fits = (at: number, size: number, end: number): void => { if (at < 0 || size < 0 || at + size > end) syntax('ZIP 记录越界或不完整'); };
  const u64 = (at: number, end: number): number => { fits(at, 8, end); const n = bytes.readBigUInt64LE(at); if (n > BigInt(Number.MAX_SAFE_INTEGER)) forbidden('ZIP 声明数值超过安全上限'); return Number(n); };
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) {
      end = at;
      break;
    }
  }
  if (end < 0) syntax('ZIP 结束记录缺失或字节不是 ZIP');
  if (options.rejectOpaqueMetadata && bytes.readUInt16LE(end + 20) !== 0) forbidden('外发容器不接受 ZIP 归档注释；移除非成员内容后重新核验');
  const disk = bytes.readUInt16LE(end + 4);
  const centralDisk = bytes.readUInt16LE(end + 6);
  if (disk !== 0 || centralDisk !== 0) forbidden('不接受分卷 ZIP');
  let count = bytes.readUInt16LE(end + 10);
  let directorySize = bytes.readUInt32LE(end + 12);
  let directoryAt = bytes.readUInt32LE(end + 16);
  let directoryEnd = end;
  const hasZip64 = end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50;
  if (options.rejectOpaqueMetadata && hasZip64) forbidden('外发容器不接受 ZIP64 扩展区域；转换为无扩展容器后重新核验');
  if (hasZip64) {
    if (bytes.readUInt32LE(end - 16) !== 0 || bytes.readUInt32LE(end - 4) !== 1) forbidden('不接受分卷 ZIP64');
    const at = u64(end - 12, end);
    fits(at, 56, end - 20);
    if (bytes.readUInt32LE(at) !== 0x06064b50 || at + 12 + u64(at + 4, end - 20) !== end - 20) syntax('ZIP64 目录记录不完整');
    if (bytes.readUInt32LE(at + 16) !== 0 || bytes.readUInt32LE(at + 20) !== 0) forbidden('不接受分卷 ZIP64');
    count = u64(at + 32, end - 20);
    if (u64(at + 24, end - 20) !== count) syntax('ZIP64 成员数不一致');
    directorySize = u64(at + 40, end - 20);
    directoryAt = u64(at + 48, end - 20);
    for (const [offset, sentinel, actual] of [[8, 0xffff, count], [10, 0xffff, count], [12, 0xffffffff, directorySize], [16, 0xffffffff, directoryAt]]) {
      const declared = offset < 12 ? bytes.readUInt16LE(end + offset) : bytes.readUInt32LE(end + offset);
      if (declared !== sentinel && declared !== actual) syntax('ZIP64 与 ZIP 结束记录的声明不一致');
    }
    let extensionAt = at + 56;
    while (extensionAt < end - 20) {
      fits(extensionAt, 6, end - 20);
      const size = bytes.readUInt32LE(extensionAt + 2);
      fits(extensionAt + 6, size, end - 20);
      extensionAt += 6 + size;
    }
    directoryEnd = at;
  } else if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) syntax('ZIP64 目录记录缺失');
  if (!hasZip64 && bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) syntax('ZIP 分卷成员数不一致');
  if (count > limits.maxMembers) forbidden(`ZIP 成员数超过上限 ${limits.maxMembers}`);
  if (!count) syntax('ZIP 没有成员');
  if (directoryAt + directorySize !== directoryEnd) syntax('ZIP 中央目录位置或大小不一致');
  fits(directoryAt, directorySize, directoryEnd);
  type Entry = {
    ordinal: number;
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
    if (flags & (1 | 0x40 | 0x2000)) forbidden('不接受加密 ZIP');
    if (flags & ~0x80e) syntax('ZIP 标志无效或不支持');
  };
  const extras = (at: number, size: number): Map<number, Buffer> => {
    const output = new Map<number, Buffer>();
    const stop = at + size;
    while (at < stop) {
      fits(at, 4, stop);
      const id = bytes.readUInt16LE(at);
      const size = bytes.readUInt16LE(at + 2);
      fits(at + 4, size, stop);
      if (output.has(id)) syntax('ZIP 扩展字段重复');
      output.set(id, bytes.subarray(at + 4, at + 4 + size));
      at += 4 + size;
    }
    if (output.has(0x9901)) forbidden('不接受加密 ZIP');
    return output;
  };
  const verifyUnicodePath = (fields: Map<number, Buffer>, entry: Entry): void => {
    const unicode = fields.get(0x7075);
    if (!unicode) return;
    if (unicode.length < 5 || unicode[0] !== 1) syntax('ZIP Unicode 路径扩展字段格式或版本无效');
    if (unicode.readUInt32LE(1) !== crc32(entry.nameBytes)) syntax('ZIP Unicode 路径扩展 CRC 与原始成员名不一致');
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(unicode.subarray(5)); }
    catch { return syntax('ZIP Unicode 路径扩展不是 UTF-8'); }
    if (name !== entry.name) syntax('ZIP Unicode 路径扩展与原始成员名不一致');
  };
  for (let i = 0; i < count; i++) {
    memberOrdinal = i + 1; memberOffset = position;
    fits(position, 46, directoryEnd);
    if (bytes.readUInt32LE(position) !== 0x02014b50) syntax('ZIP 中央目录签名不对');
    const nameLength = bytes.readUInt16LE(position + 28);
    const extra = bytes.readUInt16LE(position + 30);
    const comment = bytes.readUInt16LE(position + 32);
    if (options.rejectOpaqueMetadata && (extra !== 0 || comment !== 0)) forbidden('外发容器不接受 ZIP 成员扩展字段或注释；移除非成员内容后重新核验');
    fits(position, 46 + nameLength + extra + comment, directoryEnd);
    const entry: Entry = { ordinal: i + 1, name: '', nameBytes: bytes.subarray(position + 46, position + 46 + nameLength), version: bytes.readUInt16LE(position + 6), flags: bytes.readUInt16LE(position + 8), method: bytes.readUInt16LE(position + 10), crc: bytes.readUInt32LE(position + 16), compressed: bytes.readUInt32LE(position + 20), size: bytes.readUInt32LE(position + 24), at: bytes.readUInt32LE(position + 42) };
    flagsOk(entry.flags);
    if (entry.method !== 0 && entry.method !== 8) syntax('OOXML ZIP 压缩方法只支持存储和 Deflate');
    if (bytes.readUInt16LE(position + 34) !== 0) forbidden('不接受分卷 ZIP 成员');
    const fields = extras(position + 46 + nameLength, extra);
    let cursor = 0;
    for (const field of ['size', 'compressed', 'at'] as const) {
      if (entry[field] === 0xffffffff) {
        const data = fields.get(1);
        if (!data || cursor + 8 > data.length) syntax('ZIP64 成员大小或偏移缺失');
        const n = data!.readBigUInt64LE(cursor);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) forbidden('ZIP 声明数值超过安全上限');
        entry[field] = Number(n);
        cursor += 8;
      }
    }
    if (entry.at < 0 || entry.at + 30 > directoryAt) syntax('ZIP 本地头偏移越出数据段');
    memberOffset = entry.at;
    const attributes = bytes.readUInt32LE(position + 38);
    const kind = (attributes >>> 16) & 0xf000;
    if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) forbidden('ZIP 成员路径不能是链接或特殊文件');
    try {
      entry.name = entry.flags & 0x800 ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.nameBytes) : [...entry.nameBytes].map((byte) => byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128]).join('');
    } catch {
      syntax('ZIP 成员路径不是 UTF-8');
    }
    const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
    if (entry.name.startsWith('/')) forbidden('ZIP 成员路径是绝对路径');
    if (!path) forbidden('ZIP 成员路径为空');
    if (entry.name.length > 512) forbidden('ZIP 成员路径长度超过上限 512');
    if (entry.name.includes('\\')) forbidden('ZIP 成员路径含反斜杠');
    if (entry.name.includes(':')) forbidden('ZIP 成员路径含冒号');
    if (/[\u0000-\u001f\u007f]/.test(entry.name)) forbidden('ZIP 成员路径含控制字符');
    const segments = path.split('/');
    if (segments.includes('')) forbidden('ZIP 成员路径段为空');
    if (segments.includes('.')) forbidden('ZIP 成员路径段为点');
    if (segments.includes('..')) forbidden('ZIP 成员路径段为父级段');
    if (seen.has(asciiFold(entry.name))) syntax('ZIP 成员路径重复');
    seen.add(asciiFold(entry.name));
    verifyUnicodePath(fields, entry);
    expanded += entry.size;
    if (expanded > limits.maxExpandedBytes) forbidden(`ZIP 解压后的总量超过上限 ${limits.maxExpandedBytes}`);
    if (entry.size > limits.maxMemberBytes) forbidden(`ZIP 单个成员解压量超过上限 ${limits.maxMemberBytes}`);
    if (entry.size > limits.maxRatio * entry.compressed) forbidden(`ZIP 成员解压比超过上限 ${limits.maxRatio}`);
    entries.push(entry);
    position += 46 + nameLength + extra + comment;
  }
  memberOrdinal = null; memberOffset = null;
  if (position !== directoryEnd) syntax('ZIP 中央目录大小或成员数不一致');
  const output = new Map<string, Buffer>();
  const sorted = entries.sort((a, b) => a.at - b.at);
  let nextLocal = 0;
  for (const [i, entry] of sorted.entries()) {
    memberOrdinal = entry.ordinal; memberOffset = entry.at;
    if (entry.at !== nextLocal) syntax('ZIP 本地成员不连续、重叠或有附加数据');
    fits(entry.at, 30, directoryAt);
    const at = entry.at;
    memberOrdinal = entry.ordinal;
    memberOffset = at;
    if (bytes.readUInt32LE(at) !== 0x04034b50) syntax('ZIP 本地头签名不对');
    const nameLength = bytes.readUInt16LE(at + 26);
    const extra = bytes.readUInt16LE(at + 28);
    if (options.rejectOpaqueMetadata && extra !== 0) forbidden('外发容器不接受 ZIP 本地扩展字段；移除非成员内容后重新核验');
    flagsOk(bytes.readUInt16LE(at + 6));
    fits(at + 30, nameLength + extra + entry.compressed, directoryAt);
    const localFields = extras(at + 30 + nameLength, extra);
    if (bytes.readUInt16LE(at + 4) !== entry.version || bytes.readUInt16LE(at + 6) !== entry.flags || bytes.readUInt16LE(at + 8) !== entry.method || !bytes.subarray(at + 30, at + 30 + nameLength).equals(entry.nameBytes)) {
      syntax('ZIP 本地头与中央目录不一致');
    }
    verifyUnicodePath(localFields, entry);
    const descriptor = (entry.flags & 8) !== 0;
    let localSize = bytes.readUInt32LE(at + 22);
    let localCompressed = bytes.readUInt32LE(at + 18);
    if (localSize === 0xffffffff || localCompressed === 0xffffffff) {
      const data = localFields.get(1);
      let p = 0;
      for (const field of ['size', 'compressed'] as const) {
        if ((field === 'size' ? localSize : localCompressed) === 0xffffffff) {
          if (!data || p + 8 > data.length) syntax('ZIP64 本地头大小缺失');
          const n = Number(data!.readBigUInt64LE(p));
          if (field === 'size') localSize = n;
          else localCompressed = n;
          p += 8;
        }
      }
    }
    if ((!descriptor || localSize !== 0) && localSize !== entry.size || (!descriptor || localCompressed !== 0) && localCompressed !== entry.compressed || (!descriptor || bytes.readUInt32LE(at + 14) !== 0) && bytes.readUInt32LE(at + 14) !== entry.crc) {
      syntax('ZIP 本地头大小或 CRC 与中央目录不一致');
    }
    const dataAt = at + 30 + nameLength + extra;
    const data = bytes.subarray(dataAt, dataAt + entry.compressed);
    const nextAt = sorted[i + 1]?.at ?? directoryAt;
    const dataEnd = dataAt + data.length;
    if (descriptor) {
      const length = nextAt - dataEnd;
      if (![12, 16, 20, 24].includes(length)) syntax('ZIP 数据描述符大小无效');
      let p = dataEnd;
      const wide = length >= 20;
      if (length === 16 || length === 24) {
        if (bytes.readUInt32LE(p) !== 0x08074b50) syntax('ZIP 数据描述符签名不对');
        p += 4;
      }
      if (bytes.readUInt32LE(p) !== entry.crc || (wide ? u64(p + 4, nextAt) : bytes.readUInt32LE(p + 4)) !== entry.compressed || (wide ? u64(p + 12, nextAt) : bytes.readUInt32LE(p + 8)) !== entry.size) {
        syntax('ZIP 数据描述符大小或 CRC 不一致');
      }
    } else if (dataEnd !== nextAt) syntax('ZIP 本地成员之间有附加数据');
    let content: Buffer;
    if (entry.method === 0) content = Buffer.from(data);
    else {
      try {
        const result = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size), info: true }) as unknown as {
          buffer: Buffer;
          engine: { bytesWritten: number };
        };
        if (result.engine.bytesWritten !== data.length) syntax('ZIP Deflate 数据后有未消费的字节');
        content = result.buffer;
      } catch (error) {
        if (error instanceof ParseError) throw error;
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ERR_BUFFER_TOO_LARGE') syntax('ZIP 实际解压大小超过声明上限');
        if (code === 'Z_BUF_ERROR') syntax('ZIP Deflate 流不完整');
        if (code === 'Z_DATA_ERROR') syntax('ZIP Deflate 数据损坏');
        syntax('ZIP Deflate 解压器失败');
      }
    }
    if (content!.length !== entry.size) syntax('ZIP 实际解压大小与声明不一致');
    if (crc32(content!) !== entry.crc) syntax('ZIP CRC 校验不一致');
    output.set(entry.name, content!);
    nextLocal = nextAt;
  }
  return output;
}

export function readContainerMembers(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  return new Map([...readContainerArchive(bytes, { rejectOpaqueMetadata: true })].map(([name, value]) => [name, new Uint8Array(value)]));
}
