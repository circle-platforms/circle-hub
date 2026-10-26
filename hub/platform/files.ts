// File helpers: hashing copies, exclusive and atomic writes, symlink switching, guarded removal and a pid lock.
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PlatformError } from './errors.ts';

export interface FileDigest {
  sha256: string;
  size: number;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function sha256File(path: string): Promise<FileDigest> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha256: hash.digest('hex'), size };
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Copies one file, hashing the bytes written. The target must not exist: nothing is ever overwritten. */
export async function copyFileHashed(source: string, target: string, mode = 0o600): Promise<FileDigest> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(source), tap, createWriteStream(target, { flags: 'wx', mode, flush: true }));
  return { sha256: hash.digest('hex'), size };
}

/**
 * Copies one file if it still exists: a source that vanished since it was listed is skipped (undefined) and leaves no
 * target behind. The source is opened without following a symlink; `mode` maps the source's mode to the target's.
 */
export async function copyFileIfPresent(source: string, target: string, mode: (sourceMode: number) => number = () => 0o600): Promise<FileDigest | undefined> {
  let handle;
  try {
    handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new PlatformError(`不是普通文件，不复制：${source}`);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const hash = createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        size += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(handle.createReadStream({ autoClose: false }), tap, createWriteStream(target, { flags: 'wx', mode: mode(info.mode), flush: true }));
    return { sha256: hash.digest('hex'), size };
  } finally {
    await handle.close();
  }
}

export interface ListOptions {
  /** Leaves out an entry at any depth (and everything under it); `path` is relative to the listed directory. */
  exclude?: (name: string, path: string) => boolean;
}

/**
 * Regular files under `dir` as sorted POSIX relative paths. A missing directory has none. Symlinks and special files are
 * refused, because a copy could not reproduce them faithfully. `skip` names top-level entries to leave out.
 */
export async function listFiles(dir: string, skip: readonly string[] = [], options: ListOptions = {}): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && current === dir) return;
      throw error;
    }
    for (const entry of entries) {
      if (prefix === '' && skip.includes(entry.name)) continue;
      const path = join(current, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (options.exclude?.(entry.name, name)) continue;
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) out.push(name);
      else throw new PlatformError(`不支持复制符号链接或特殊文件：${path}`);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/** True when the directory is missing or has no entries at all. */
export async function isMissingOrEmpty(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

export async function writeFileExclusive(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, data, { flag: 'wx', mode, flush: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new PlatformError(`文件已存在，不覆盖：${path}`);
    throw error;
  }
}

/** Writes through a temporary sibling and a rename, so readers see the old or the new content, never a mix. */
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}`);
  await writeFile(temporary, data, { flag: 'wx', mode, flush: true });
  await rename(temporary, path);
}

export async function readSymlink(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isSymbolicLink()) throw new PlatformError(`${path} 应该是符号链接，现在不是`, '手动检查后再操作');
  return readlink(path);
}

/** Points `link` at `target` atomically (symlink beside it, then rename over it); undefined removes the link. */
export async function switchSymlink(link: string, target: string | undefined): Promise<void> {
  await readSymlink(link);
  if (target === undefined) {
    await rm(link, { force: true });
    return;
  }
  const temporary = join(dirname(link), `.${basename(link)}.${randomBytes(6).toString('hex')}`);
  await symlink(target, temporary);
  await rename(temporary, link);
}

/** 2026-10-21T23:05:01.123Z -> 20261021T230501Z */
export function timestampName(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** `base`, or `base-2`, `base-3`, ... whichever does not exist yet under `parent`. */
export async function uniqueChild(parent: string, base: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const candidate = join(parent, n === 1 ? base : `${base}-${n}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new PlatformError(`${parent} 下同名目录太多：${base}`);
}

/**
 * Gives every directory at and under `path` owner rwx again, so that its entries can be removed: a 0500 directory (an
 * extracted pack tree) keeps its entries even from its owner. Links are never followed; files keep their modes.
 */
export async function unlockTree(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isDirectory()) return;
  if ((info.mode & 0o700) !== 0o700) await chmod(path, (info.mode & 0o777) | 0o700);
  for (const name of await readdir(path)) await unlockTree(join(path, name));
}

/** Removes `path` and everything under it, read-only directories included (unlockTree first). */
export async function removeTree(path: string): Promise<void> {
  await unlockTree(path);
  await rm(path, { recursive: true, force: true });
}

/** Removes `path` only when it lies strictly inside `parent`. */
export async function removeWithin(parent: string, path: string): Promise<void> {
  const inner = relative(parent, path);
  if (inner === '' || inner.startsWith('..') || isAbsolute(inner) || inner.split(sep).includes('..')) {
    throw new PlatformError(`拒绝删除 ${parent} 之外的路径：${path}`);
  }
  await rm(path, { recursive: true, force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `<pid> <token>`; a bare pid is the format of earlier versions. */
function lockHolder(text: string): number | undefined {
  const match = /^([1-9][0-9]{0,9})(?: [0-9a-f]{32})?\n?$/.exec(text);
  return match ? Number(match[1]) : undefined;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Creates `path` with `content` atomically (written beside it, then hard-linked): never empty, never overwritten. */
async function linkExclusive(path: string, content: string): Promise<boolean> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600, flush: true });
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Removes a lock left by a dead process, but only while it still holds exactly `stale`. Takers serialise on a second
 * lock (`.break`), so two of them can never remove each other's fresh lock; a breaker left by a dead taker is cleared.
 */
async function breakStaleLock(path: string, stale: string): Promise<void> {
  const breaker = `${path}.break`;
  const mine = `${process.pid} ${randomBytes(16).toString('hex')}\n`;
  if (!(await linkExclusive(breaker, mine))) {
    const text = await readText(breaker);
    const holder = text === undefined ? undefined : lockHolder(text);
    if (text !== undefined && (holder === undefined || !alive(holder)) && (await readText(breaker)) === text) await rm(breaker, { force: true });
    return;
  }
  try {
    if ((await readText(path)) === stale) await rm(path, { force: true });
  } finally {
    if ((await readText(breaker)) === mine) await rm(breaker, { force: true });
  }
}

/**
 * Runs `fn` while holding an exclusive lock file `<pid> <token>`. A lock left by a dead process is taken over; one that
 * cannot be read is refused (a person decides); on release only our own lock is removed.
 */
export async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const content = `${process.pid} ${randomBytes(16).toString('hex')}\n`;
  let acquired = false;
  for (let attempt = 0; attempt < 4 && !acquired; attempt++) {
    if (await linkExclusive(path, content)) {
      acquired = true;
      break;
    }
    const text = await readText(path);
    if (text === undefined) continue;
    const holder = lockHolder(text);
    if (holder === undefined) throw new PlatformError(`锁文件的内容看不懂：${path}`, '确认没有 circle-hub 操作在进行后删除这个文件');
    if (alive(holder)) throw new PlatformError(`另一个 circle-hub 操作正在进行（PID ${holder}）`, `等它结束；锁文件是 ${path}`);
    await breakStaleLock(path, text);
  }
  if (!acquired) throw new PlatformError(`拿不到锁：${path}`, '稍后再试');
  try {
    return await fn();
  } finally {
    if ((await readText(path).catch(() => undefined)) === content) await rm(path, { force: true });
  }
}
