// Parse before writing. Never delegate an untrusted release archive to an external tar process.
import { gunzipSync } from 'node:zlib';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './operations.ts';
import type { Target } from './integrity.ts';

export const ARCHIVE_ROOT = 'circle-hub';
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_EXPANDED = 1024 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_ENTRIES = 100_000;
const utf8 = new TextDecoder('utf-8', { fatal: true });
type Entry = { path: string; kind: 'file' | 'directory' | 'link'; mode: number; body: Uint8Array; target?: string };

function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return utf8.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function octal(bytes: Uint8Array): number {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('归档数字字段不合法');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error('归档数字字段超限');
  return number;
}

function portable(path: string): string {
  if (!path || Buffer.byteLength(path) > 4096 || /[\\:\x00-\x1f\x7f]/.test(path) || path.startsWith('/')) throw new Error('归档路径不安全');
  const parts = path.replace(/\/$/, '').split('/');
  if (parts.length > 128 || parts.some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255) || parts[0] !== ARCHIVE_ROOT) throw new Error('归档路径越界');
  return parts.join('/');
}

function linkParts(target: string): string[] {
  if (!target || Buffer.byteLength(target) > 4096 || /[\\:\x00-\x1f\x7f]/.test(target) || target.startsWith('/')) throw new Error('归档链接目标不安全');
  const parts = target.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length > 128 || parts.some((part) => Buffer.byteLength(part) > 255)) throw new Error('归档链接目标超限');
  return parts;
}

function pax(body: Uint8Array): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < body.length) {
    let space = offset;
    while (space < body.length && body[space] !== 32 && space - offset < 12) space++;
    const prefix = utf8.decode(body.subarray(offset, space));
    if (body[space] !== 32 || !/^[1-9][0-9]*$/.test(prefix)) throw new Error('PAX 记录长度不合法');
    const size = Number(prefix), end = offset + size;
    if (!Number.isSafeInteger(size) || end > body.length || end <= space + 1 || body[end - 1] !== 10) throw new Error('PAX 记录被截断');
    const record = utf8.decode(body.subarray(space + 1, end - 1)), equal = record.indexOf('=');
    if (equal < 1 || Object.hasOwn(values, record.slice(0, equal))) throw new Error('PAX 记录重复或不合法');
    values[record.slice(0, equal)] = record.slice(equal + 1);
    offset = end;
  }
  return values;
}

export function parseTar(bytes: Uint8Array): Entry[] {
  if (bytes.length > MAX_EXPANDED || bytes.length % 512 !== 0) throw new Error('归档大小或块长度不合法');
  const entries: Entry[] = [], names = new Set<string>();
  let offset = 0, headers = 0, pending: Record<string, string> = Object.create(null), ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > bytes.length || !bytes.subarray(offset).every((byte) => byte === 0)) throw new Error('归档尾部不合法');
      ended = true; break;
    }
    if (++headers > MAX_ENTRIES * 2) throw new Error('归档头数量超限');
    let checksum = 0;
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]!;
    if (checksum !== octal(header.subarray(148, 156))) throw new Error('归档头校验失败');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
    const storedSize = octal(header.subarray(124, 136));
    if (['x', 'g', 'L', 'K'].includes(type) && storedSize > 1024 * 1024) throw new Error('归档扩展头超限');
    let size = storedSize;
    if (!['x', 'g', 'L', 'K'].includes(type) && pending.size !== undefined) {
      if (!/^(0|[1-9][0-9]*)$/.test(pending.size)) throw new Error('PAX 文件大小不合法');
      size = Number(pending.size);
    }
    if (!Number.isSafeInteger(size) || size > MAX_FILE || offset + 512 + size > bytes.length) throw new Error('归档成员大小超限或被截断');
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') {
      const values = pax(body);
      if (type === 'g') {
        if (['path', 'linkpath', 'size'].some((key) => Object.hasOwn(values, key))) throw new Error('不允许全局 PAX 路径覆盖');
      } else {
        for (const key of ['path', 'linkpath', 'size']) if (values[key] !== undefined) {
          if (pending[key] !== undefined) throw new Error('归档成员有重复覆盖');
          pending[key] = values[key]!;
        }
      }
      continue;
    }
    if (type === 'L' || type === 'K') {
      const key = type === 'L' ? 'path' : 'linkpath';
      if (pending[key] !== undefined) throw new Error('归档成员有重复长名称');
      pending[key] = text(body).replace(/\n$/, '');
      continue;
    }
    const prefix = text(header.subarray(257, 263)).startsWith('ustar') ? text(header.subarray(345, 500)) : '';
    const path = portable(pending.path ?? `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`);
    if (names.has(path)) throw new Error('归档成员路径重复');
    names.add(path);
    if (entries.length >= MAX_ENTRIES) throw new Error('归档成员数超限');
    const mode = octal(header.subarray(100, 108));
    if (type === '0') entries.push({ path, kind: 'file', mode, body });
    else if (type === '5' && size === 0) entries.push({ path, kind: 'directory', mode, body });
    else if (type === '2' && size === 0) {
      const target = pending.linkpath ?? text(header.subarray(157, 257));
      linkParts(target);
      entries.push({ path, kind: 'link', mode, body, target });
    } else throw new Error('归档包含硬链接或特殊文件');
    pending = Object.create(null);
  }
  if (!ended || Object.keys(pending).length !== 0 || entries.length === 0) throw new Error('归档未完整结束');
  const tree = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join('/'), existing = tree.get(parent);
      if (existing && existing.kind !== 'directory') throw new Error('归档成员穿过文件或链接');
      if (!existing) tree.set(parent, { path: parent, kind: 'directory', mode: 0o700, body: new Uint8Array() });
    }
  }
  if (tree.get(ARCHIVE_ROOT)?.kind !== 'directory') throw new Error('归档根必须是目录');
  for (const entry of entries.filter((item) => item.kind === 'link')) {
    let current = entry.path.split('/').slice(0, -1), queue = linkParts(entry.target!), expansions = 0;
    while (queue.length) {
      const part = queue.shift()!;
      if (part === '..') { if (current.length <= 1) throw new Error('归档链接越界'); current.pop(); continue; }
      current.push(part);
      const target = tree.get(current.join('/'));
      if (!target) throw new Error('归档包含悬空链接');
      if (target.kind === 'link') {
        if (++expansions > 40) throw new Error('归档包含循环链接');
        current.pop(); queue = [...linkParts(target.target!), ...queue];
      } else if (target.kind === 'file' && queue.length) throw new Error('归档链接穿过普通文件');
    }
  }
  return [...tree.values()];
}

/** Verifies the caller's trusted archive digest before decompression. The destination must not exist. */
export function extractArchive(bytes: Uint8Array, expectedSha256: string, destination: string, target: Target): string {
  if (target.startsWith('windows-')) throw new Error('Windows ZIP 安全安装尚未实现，拒绝解包');
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || bytes.length > MAX_ARCHIVE || sha256(bytes) !== expectedSha256) throw new Error('发行归档摘要不一致');
  const entries = parseTar(gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED }));
  destination = resolve(destination);
  if (existsSync(destination)) throw new Error('归档解包目录必须不存在');
  mkdirSync(destination, { mode: 0o700 });
  try {
    for (const entry of entries.filter((item) => item.kind === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length)) mkdirSync(join(destination, entry.path), { mode: 0o700 });
    for (const entry of entries.filter((item) => item.kind === 'file')) {
      const executable = (entry.mode & 0o111) !== 0, ownerOnly = (entry.mode & 0o077) === 0;
      const mode = ownerOnly ? executable ? 0o700 : 0o600 : executable ? 0o755 : 0o644;
      writeFileSync(join(destination, entry.path), entry.body, { flag: 'wx', mode });
      chmodSync(join(destination, entry.path), mode);
    }
    // Links appear only after every regular write; validated paths never traverse a link.
    for (const entry of entries.filter((item) => item.kind === 'link')) symlinkSync(entry.target!, join(destination, entry.path));
    return join(destination, ARCHIVE_ROOT);
  } catch (error) { rmSync(destination, { recursive: true, force: true }); throw error; }
}
