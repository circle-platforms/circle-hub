// What the console's pack upload needs: a multipart/form-data body read into its fields and one file, and a .zip archive
// unpacked into a fresh private directory. The zip reader is written here over node:zlib: every entry is inflated with
// `maxOutputLength` set to the size the archive declares and checked against its CRC-32, so an archive that lies about
// its sizes (a zip bomb) fails instead of filling memory. Only stored and deflated regular files are accepted; names are
// relative paths without `..`, backslashes, NUL or a drive, and directories are made from the names. Symlinks, ZIP64,
// encryption and multi-disk archives are refused. macOS metadata (`__MACOSX/`, `._*`, `.DS_Store`) is skipped.
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface MultipartFile {
  field: string;
  filename: string;
  bytes: Buffer;
}

export interface MultipartBody {
  fields: Map<string, string>;
  files: MultipartFile[];
}

const MAX_PARTS = 16;
const MAX_FIELD_BYTES = 64 * 1024;

/** The boundary parameter of a multipart/form-data Content-Type, or null. */
export function boundaryOf(contentType: string | undefined): string | null {
  if (typeof contentType !== 'string') return null;
  const [type, ...params] = contentType.split(';');
  if (type.trim().toLowerCase() !== 'multipart/form-data') return null;
  for (const param of params) {
    const at = param.indexOf('=');
    if (at < 0 || param.slice(0, at).trim().toLowerCase() !== 'boundary') continue;
    const value = param.slice(at + 1).trim().replace(/^"(.*)"$/, '$1');
    return /^[0-9A-Za-z'()+_,./:=?-]{1,70}$/.test(value) ? value : null;
  }
  return null;
}

/** Splits a multipart/form-data body (RFC 7578) into its text fields and files. */
export function parseMultipart(body: Buffer, boundary: string): MultipartBody {
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = new Map<string, string>();
  const files: MultipartFile[] = [];
  let at = body.indexOf(delimiter);
  if (at < 0) throw new UploadError('上传的表单不完整');
  let parts = 0;
  for (;;) {
    at += delimiter.length;
    if (body.subarray(at, at + 2).toString('latin1') === '--') break;
    if (body.subarray(at, at + 2).toString('latin1') !== '\r\n') throw new UploadError('上传的表单格式不对');
    at += 2;
    const end = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), at);
    if (end < 0) throw new UploadError('上传的表单不完整');
    if (++parts > MAX_PARTS) throw new UploadError('上传的表单字段太多');
    const part = body.subarray(at, end);
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) throw new UploadError('上传的表单格式不对');
    const headers = part.subarray(0, split).toString('utf8').split('\r\n');
    const content = part.subarray(split + 4);
    const disposition = headers.find((line) => /^content-disposition:/i.test(line));
    const name = disposition ? /;\s*name="([^"]*)"/i.exec(disposition)?.[1] : undefined;
    const filename = disposition ? /;\s*filename="([^"]*)"/i.exec(disposition)?.[1] : undefined;
    if (name === undefined || !/^form-data\b/i.test(disposition!.slice(disposition!.indexOf(':') + 1).trim())) throw new UploadError('上传的表单格式不对');
    if (filename !== undefined) files.push({ field: name, filename, bytes: Buffer.from(content) });
    else {
      if (content.length > MAX_FIELD_BYTES) throw new UploadError(`字段 ${name} 太长`);
      if (fields.has(name)) throw new UploadError(`字段 ${name} 给了两次`);
      fields.set(name, content.toString('utf8'));
    }
    at = end + 2;
  }
  return { fields, files };
}

export interface ZipLimits {
  /** Largest number of files. */
  maxEntries: number;
  /** Largest total of the uncompressed sizes. */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 2000, maxTotalBytes: 128 * 1024 * 1024 };

interface Entry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  directory: boolean;
}

const SKIPPED = (name: string): boolean => name.startsWith('__MACOSX/') || name.split('/').some((part) => part.startsWith('._') || part === '.DS_Store');

/** A relative path of the archive that stays inside the target: no `..`, absolute path, drive, backslash or control. */
function safeName(name: string): boolean {
  if (name.length === 0 || name.length > 512 || name.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.replace(/\/$/, '').split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function entriesOf(zip: Buffer, limits: ZipLimits): Entry[] {
  // End of central directory: the last 22 + comment bytes; signature 0x06054b50.
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new UploadError('不是 zip 文件');
  const disk = zip.readUInt16LE(eocd + 4);
  const count = zip.readUInt16LE(eocd + 10);
  const size = zip.readUInt32LE(eocd + 12);
  const offset = zip.readUInt32LE(eocd + 16);
  if (disk !== 0 || zip.readUInt16LE(eocd + 6) !== 0 || count === 0xffff || offset === 0xffffffff) throw new UploadError('不支持分卷或 ZIP64 格式的 zip 文件');
  if (count > limits.maxEntries) throw new UploadError(`zip 里的文件太多（${count} 个，上限 ${limits.maxEntries}）`);
  if (offset + size > eocd) throw new UploadError('zip 文件的目录损坏');
  const entries: Entry[] = [];
  let at = offset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || zip.readUInt32LE(at) !== 0x02014b50) throw new UploadError('zip 文件的目录损坏');
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressedSize = zip.readUInt32LE(at + 20);
    const uncompressed = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const madeBy = zip.readUInt16LE(at + 4) >> 8;
    const external = zip.readUInt32LE(at + 38);
    const localOffset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 0x1) throw new UploadError('不接受加密的 zip 文件');
    if (compressedSize === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new UploadError('不支持 ZIP64 格式的 zip 文件');
    if (!safeName(name)) throw new UploadError(`zip 里有不安全的路径：${name.slice(0, 120)}`);
    // Unix mode in the high half of the external attributes: only regular files and directories.
    const unixType = madeBy === 3 ? (external >>> 16) & 0o170000 : 0;
    const directory = name.endsWith('/') || unixType === 0o040000;
    if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) throw new UploadError(`zip 里有符号链接或特殊文件：${name.slice(0, 120)}`);
    if (method !== 0 && method !== 8) throw new UploadError(`zip 里的 ${name.slice(0, 120)} 用了不支持的压缩方法`);
    total += uncompressed;
    if (total > limits.maxTotalBytes) throw new UploadError(`zip 解开后太大（上限 ${limits.maxTotalBytes} 字节）`);
    entries.push({ name, method, crc, compressedSize, size: uncompressed, localOffset, directory });
  }
  return entries;
}

function contentOf(zip: Buffer, entry: Entry): Buffer {
  const at = entry.localOffset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== 0x04034b50) throw new UploadError(`zip 文件里 ${entry.name} 的记录损坏`);
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new UploadError(`zip 文件里 ${entry.name} 不完整`);
  const raw = zip.subarray(start, end);
  let data: Buffer;
  if (entry.method === 0) data = Buffer.from(raw);
  else {
    try {
      // Never more than the declared size: an archive that hides a larger stream fails here.
      data = entry.size === 0 ? Buffer.alloc(0) : inflateRawSync(raw, { maxOutputLength: entry.size });
    } catch {
      throw new UploadError(`zip 文件里 ${entry.name} 解压失败或比声明的大`);
    }
  }
  if (data.length !== entry.size || (crc32(data) >>> 0) !== entry.crc) throw new UploadError(`zip 文件里 ${entry.name} 的内容与校验值不符`);
  return data;
}

/**
 * Unpacks `zip` into a new private directory under the system temporary directory and returns the directory that holds
 * the archive's files: the archive root, or its only top-level folder when everything is inside one (what Finder's
 * "Compress" and `zip -r name.zip folder` make). The caller removes `root` when done.
 */
export async function unpackZip(zip: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<{ root: string; dir: string }> {
  const entries = entriesOf(zip, limits).filter((entry) => !SKIPPED(entry.name));
  const files = entries.filter((entry) => !entry.directory);
  if (files.length === 0) throw new UploadError('zip 里没有文件');
  const contents = files.map((entry) => ({ name: entry.name, data: contentOf(zip, entry) }));
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-upload-'));
  const tree = join(root, 'tree');
  await mkdir(tree, { mode: 0o700 });
  const seen = new Set<string>();
  for (const { name, data } of contents) {
    if (seen.has(name)) throw new UploadError(`zip 里有重名文件：${name.slice(0, 120)}`);
    seen.add(name);
    const target = join(tree, name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, data, { flag: 'wx', mode: 0o600 });
  }
  const top = await readdir(tree, { withFileTypes: true });
  const dir = top.length === 1 && top[0].isDirectory() ? join(tree, top[0].name) : tree;
  return { root, dir };
}
