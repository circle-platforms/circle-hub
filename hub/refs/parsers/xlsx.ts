// xlsx@1: bounded in-memory ZIP decoding and generic SpreadsheetML structure, with no workflow semantics.
import { crc32, inflateRawSync } from 'node:zlib';
import { ParseError, ParseForbiddenError, ParseLimitError, ParseSyntaxError } from '../parser.ts';

const KEY = 'xlsx@1';
/** Hard container caps. Parser options may lower input size, but cannot raise these security limits. */
export const XLSX_ZIP_LIMITS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxMembers: 256, maxMemberBytes: 16 * 1024 * 1024, maxExpandedBytes: 32 * 1024 * 1024, maxRatio: 100 });
const syntax = (message: string): never => { throw new ParseSyntaxError(KEY, message); };
const forbidden = (message: string): never => { throw new ParseForbiddenError(KEY, message); };
// ZIP legacy filename encoding (CP437); UTF-8 filenames use general-purpose flag 11.
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Internal ZIP decoder for this parser and its synthetic tests. Never extracts to disk or follows a path. */
export function readXlsxArchive(input: Uint8Array): Map<string, Buffer> {
  if (!(input instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
  const limits = XLSX_ZIP_LIMITS;
  if (input.length > limits.maxBytes) throw new ParseLimitError(KEY, 'maxBytes', limits.maxBytes, `ZIP 总字节数超过上限 ${limits.maxBytes}`);
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const fits = (at: number, size: number, end: number): void => { if (at < 0 || size < 0 || at + size > end) syntax('ZIP 记录越界或不完整'); };
  const u64 = (at: number, end: number): number => { fits(at, 8, end); const n = bytes.readBigUInt64LE(at); if (n > BigInt(Number.MAX_SAFE_INTEGER)) forbidden('ZIP 声明数值超过安全上限'); return Number(n); };
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  if (end < 0) syntax('ZIP 结束记录缺失或字节不是 ZIP');
  const disk = bytes.readUInt16LE(end + 4); const centralDisk = bytes.readUInt16LE(end + 6);
  if (disk !== 0 || centralDisk !== 0) forbidden('不接受分卷 ZIP');
  let count = bytes.readUInt16LE(end + 10); let directorySize = bytes.readUInt32LE(end + 12); let directoryAt = bytes.readUInt32LE(end + 16); let directoryEnd = end;
  if (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50) {
    if (bytes.readUInt32LE(end - 16) !== 0 || bytes.readUInt32LE(end - 4) !== 1) forbidden('不接受分卷 ZIP64');
    const at = u64(end - 12, end); fits(at, 56, end - 20);
    if (bytes.readUInt32LE(at) !== 0x06064b50 || at + 12 + u64(at + 4, end - 20) !== end - 20) syntax('ZIP64 目录记录不完整');
    if (bytes.readUInt32LE(at + 16) !== 0 || bytes.readUInt32LE(at + 20) !== 0) forbidden('不接受分卷 ZIP64');
    count = u64(at + 32, end - 20); if (u64(at + 24, end - 20) !== count) syntax('ZIP64 成员数不一致');
    directorySize = u64(at + 40, end - 20); directoryAt = u64(at + 48, end - 20); directoryEnd = at;
  } else if (count === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) syntax('ZIP64 目录记录缺失');
  if (bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) syntax('ZIP 分卷成员数不一致');
  if (count > limits.maxMembers) forbidden(`ZIP 成员数超过上限 ${limits.maxMembers}`);
  if (!count) syntax('ZIP 没有成员');
  if (directoryAt + directorySize !== directoryEnd) syntax('ZIP 中央目录位置或大小不一致');
  fits(directoryAt, directorySize, directoryEnd);
  type Entry = { name: string; nameBytes: Buffer; version: number; flags: number; method: number; crc: number; size: number; compressed: number; at: number };
  const entries: Entry[] = []; const seen = new Set<string>(); let position = directoryAt; let expanded = 0;
  const flagsOk = (flags: number): void => {
    if (flags & (1 | 0x40 | 0x2000)) forbidden('不接受加密 ZIP');
    if (flags & ~0x80e) syntax('ZIP 标志无效或不支持');
  };
  const extras = (at: number, size: number): Map<number, Buffer> => {
    const output = new Map<number, Buffer>(); const stop = at + size;
    while (at < stop) { fits(at, 4, stop); const id = bytes.readUInt16LE(at); const size = bytes.readUInt16LE(at + 2); fits(at + 4, size, stop); if (output.has(id)) syntax('ZIP 扩展字段重复'); output.set(id, bytes.subarray(at + 4, at + 4 + size)); at += 4 + size; }
    if (output.has(0x9901)) forbidden('不接受加密 ZIP'); return output;
  };
  for (let i = 0; i < count; i++) {
    fits(position, 46, directoryEnd);
    if (bytes.readUInt32LE(position) !== 0x02014b50) syntax('ZIP 中央目录签名不对');
    const nameLength = bytes.readUInt16LE(position + 28); const extra = bytes.readUInt16LE(position + 30); const comment = bytes.readUInt16LE(position + 32);
    fits(position, 46 + nameLength + extra + comment, directoryEnd);
    const entry: Entry = { name: '', nameBytes: bytes.subarray(position + 46, position + 46 + nameLength), version: bytes.readUInt16LE(position + 6), flags: bytes.readUInt16LE(position + 8), method: bytes.readUInt16LE(position + 10), crc: bytes.readUInt32LE(position + 16), compressed: bytes.readUInt32LE(position + 20), size: bytes.readUInt32LE(position + 24), at: bytes.readUInt32LE(position + 42) };
    flagsOk(entry.flags);
    if (entry.method !== 0 && entry.method !== 8) syntax('OOXML ZIP 压缩方法只支持存储和 Deflate');
    if (bytes.readUInt16LE(position + 34) !== 0) forbidden('不接受分卷 ZIP 成员');
    const fields = extras(position + 46 + nameLength, extra); let cursor = 0;
    for (const field of ['size', 'compressed', 'at'] as const) if (entry[field] === 0xffffffff) {
      const data = fields.get(1); if (!data || cursor + 8 > data.length) syntax('ZIP64 成员大小或偏移缺失');
      const n = data!.readBigUInt64LE(cursor); if (n > BigInt(Number.MAX_SAFE_INTEGER)) forbidden('ZIP 声明数值超过安全上限'); entry[field] = Number(n); cursor += 8;
    }
    const attributes = bytes.readUInt32LE(position + 38); const kind = (attributes >>> 16) & 0xf000;
    if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) forbidden('ZIP 成员路径不能是链接或特殊文件');
    try { entry.name = entry.flags & 0x800 ? new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(entry.nameBytes) : [...entry.nameBytes].map((byte) => byte < 128 ? String.fromCharCode(byte) : CP437[byte - 128]).join(''); }
    catch { syntax('ZIP 成员路径不是 UTF-8'); }
    const unicode = fields.get(0x7075);
    if (unicode && unicode.length >= 5 && unicode[0] === 1 && unicode.readUInt32LE(1) === crc32(entry.nameBytes)) {
      try { entry.name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(unicode.subarray(5)); } catch { syntax('ZIP Unicode 成员路径无效'); }
    }
    const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
    if (!path || entry.name.length > 512 || /[\\:\u0000-\u001f\u007f]/.test(entry.name) || path.split('/').some((part) => part === '' || part === '.' || part === '..')) forbidden('ZIP 成员路径不安全或过长');
    if (seen.has(entry.name)) syntax('ZIP 成员路径重复'); seen.add(entry.name);
    expanded += entry.size;
    if (expanded > limits.maxExpandedBytes) forbidden(`ZIP 解压后的总量超过上限 ${limits.maxExpandedBytes}`);
    if (entry.size > limits.maxMemberBytes) forbidden(`ZIP 单个成员解压量超过上限 ${limits.maxMemberBytes}`);
    if (entry.size > limits.maxRatio * entry.compressed) forbidden(`ZIP 成员解压比超过上限 ${limits.maxRatio}`);
    entries.push(entry); position += 46 + nameLength + extra + comment;
  }
  if (position !== directoryEnd) syntax('ZIP 中央目录大小或成员数不一致');
  const output = new Map<string, Buffer>(); const sorted = entries.sort((a, b) => a.at - b.at); let nextLocal = 0;
  for (const [i, entry] of sorted.entries()) {
    if (entry.at !== nextLocal) syntax('ZIP 本地成员不连续、重叠或有附加数据');
    fits(entry.at, 30, directoryAt); const at = entry.at;
    if (bytes.readUInt32LE(at) !== 0x04034b50) syntax('ZIP 本地头签名不对');
    const nameLength = bytes.readUInt16LE(at + 26); const extra = bytes.readUInt16LE(at + 28); flagsOk(bytes.readUInt16LE(at + 6));
    fits(at + 30, nameLength + extra + entry.compressed, directoryAt); extras(at + 30 + nameLength, extra);
    if (bytes.readUInt16LE(at + 4) !== entry.version || bytes.readUInt16LE(at + 6) !== entry.flags || bytes.readUInt16LE(at + 8) !== entry.method || !bytes.subarray(at + 30, at + 30 + nameLength).equals(entry.nameBytes)) syntax('ZIP 本地头与中央目录不一致');
    const descriptor = (entry.flags & 8) !== 0; let localSize = bytes.readUInt32LE(at + 22); let localCompressed = bytes.readUInt32LE(at + 18);
    if (localSize === 0xffffffff || localCompressed === 0xffffffff) {
      const data = extras(at + 30 + nameLength, extra).get(1); let p = 0;
      for (const field of ['size', 'compressed'] as const) if ((field === 'size' ? localSize : localCompressed) === 0xffffffff) { if (!data || p + 8 > data.length) syntax('ZIP64 本地头大小缺失'); const n = Number(data!.readBigUInt64LE(p)); if (field === 'size') localSize = n; else localCompressed = n; p += 8; }
    }
    if ((!descriptor || localSize !== 0) && localSize !== entry.size || (!descriptor || localCompressed !== 0) && localCompressed !== entry.compressed || (!descriptor || bytes.readUInt32LE(at + 14) !== 0) && bytes.readUInt32LE(at + 14) !== entry.crc) syntax('ZIP 本地头大小或 CRC 与中央目录不一致');
    const dataAt = at + 30 + nameLength + extra; const data = bytes.subarray(dataAt, dataAt + entry.compressed); const nextAt = sorted[i + 1]?.at ?? directoryAt; const dataEnd = dataAt + data.length;
    if (descriptor) {
      const length = nextAt - dataEnd; if (![12, 16, 20, 24].includes(length)) syntax('ZIP 数据描述符大小无效');
      let p = dataEnd; const wide = length >= 20;
      if (length === 16 || length === 24) { if (bytes.readUInt32LE(p) !== 0x08074b50) syntax('ZIP 数据描述符签名不对'); p += 4; }
      if (bytes.readUInt32LE(p) !== entry.crc || (wide ? u64(p + 4, nextAt) : bytes.readUInt32LE(p + 4)) !== entry.compressed || (wide ? u64(p + 12, nextAt) : bytes.readUInt32LE(p + 8)) !== entry.size) syntax('ZIP 数据描述符大小或 CRC 不一致');
    } else if (dataEnd !== nextAt) syntax('ZIP 本地成员之间有附加数据');
    let content: Buffer;
    if (entry.method === 0) content = Buffer.from(data);
    else {
      try {
        const result = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (result.engine.bytesWritten !== data.length) syntax('ZIP Deflate 数据后有未消费的字节'); content = result.buffer;
      } catch (error) { if (error instanceof ParseError) throw error; syntax('ZIP 解压失败、流不完整或实际解压大小超过声明上限'); }
    }
    if (content!.length !== entry.size) syntax('ZIP 实际解压大小与声明不一致');
    if (crc32(content!) !== entry.crc) syntax('ZIP CRC 校验不一致');
    output.set(entry.name, content!); nextLocal = nextAt;
  }
  return output;
}
