// Read-only file trees: written once (files 0400, directories 0500), verified file by file against expected digests, and
// removed (directories made writable first, since a 0500 directory keeps its entries).
import { chmod, lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../../records/api.ts';

export const FILE_MODE = 0o400;
export const DIRECTORY_MODE = 0o500;

export interface TreeFile {
  path: string;
  bytes: Uint8Array;
}

export interface ExpectedFile {
  path: string;
  sha256: string;
  size: number;
}

const ancestors = (path: string): string[] => {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
};

/** Writes the files into `target` (which must not exist), then takes away every write permission. */
export async function writeReadOnlyTree(target: string, files: readonly TreeFile[]): Promise<void> {
  await mkdir(target, { mode: 0o700 });
  const directories = new Set<string>();
  for (const file of files) {
    for (const directory of ancestors(file.path)) {
      if (directories.has(directory)) continue;
      directories.add(directory);
      await mkdir(join(target, ...directory.split('/')), { mode: 0o700 });
    }
    const handle = await open(join(target, ...file.path.split('/')), 'wx', FILE_MODE);
    try {
      await handle.writeFile(file.bytes);
    } finally {
      await handle.close();
    }
  }
  // Deepest first, the root last: a parent made read-only first would still allow it, but the order keeps it obvious.
  for (const directory of [...directories].sort((a, b) => b.split('/').length - a.split('/').length)) await chmod(join(target, ...directory.split('/')), DIRECTORY_MODE);
  await chmod(target, DIRECTORY_MODE);
}

export interface TreeCheck {
  /** Chinese descriptions of every difference; empty when the tree is exactly the expected files. */
  problems: string[];
  /** The verified bytes by path. */
  bytes: Map<string, Uint8Array>;
}

const octal = (mode: number | bigint): string => `0${(Number(mode) & 0o777).toString(8)}`;

/**
 * Compares a tree with the expected files: nothing missing, nothing extra, no links or special files, read-only modes, one
 * link per file, and every file's size and SHA-256.
 */
export async function verifyTree(root: string, expected: readonly ExpectedFile[]): Promise<TreeCheck> {
  const problems: string[] = [];
  const bytes = new Map<string, Uint8Array>();
  const seen = new Set<string>();
  const files = new Map(expected.map((e) => [e.path, e]));
  const directories = new Set(expected.flatMap((e) => ancestors(e.path)));
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const info = await lstat(absolute);
    if (!info.isDirectory()) {
      problems.push(`${relative || '包目录'} 不是目录`);
      return;
    }
    if ((info.mode & 0o777) !== DIRECTORY_MODE) problems.push(`目录 ${relative || '（包根）'} 的权限是 ${octal(info.mode)}，应为 0500`);
    for (const name of (await readdir(absolute)).sort()) {
      const path = relative === '' ? name : `${relative}/${name}`;
      const child = join(absolute, name);
      const entry = await lstat(child);
      if (entry.isSymbolicLink()) {
        problems.push(`${path} 是符号链接`);
        continue;
      }
      if (entry.isDirectory()) {
        if (directories.has(path)) await visit(child, path);
        else problems.push(`多出了目录 ${path}`);
        continue;
      }
      if (!entry.isFile()) {
        problems.push(`${path} 不是普通文件`);
        continue;
      }
      const want = files.get(path);
      if (want === undefined) {
        problems.push(`多出了文件 ${path}`);
        continue;
      }
      seen.add(path);
      if ((entry.mode & 0o777) !== FILE_MODE) problems.push(`${path} 的权限是 ${octal(entry.mode)}，应为 0400`);
      if (entry.nlink !== 1) problems.push(`${path} 有 ${entry.nlink} 个硬链接`);
      if (entry.size !== want.size) {
        problems.push(`${path} 有 ${entry.size} 字节，应为 ${want.size} 字节`);
        continue;
      }
      const content = await readFile(child);
      if (sha256Hex(content) !== want.sha256) {
        problems.push(`${path} 的 SHA-256 与清单不符`);
        continue;
      }
      bytes.set(path, new Uint8Array(content.buffer, content.byteOffset, content.byteLength));
    }
  };
  try {
    await visit(root, '');
  } catch (error) {
    problems.push(`包目录读不出来（${(error as NodeJS.ErrnoException).code ?? '未知错误'}）`);
  }
  for (const path of files.keys()) if (!seen.has(path)) problems.push(`缺少文件 ${path}`);
  return { problems, bytes };
}

/** Removes a tree, read-only or not. A missing tree is not an error. */
export async function removeTree(root: string): Promise<void> {
  const unlock = async (absolute: string): Promise<void> => {
    let info;
    try {
      info = await lstat(absolute);
    } catch {
      return;
    }
    if (!info.isDirectory()) return;
    await chmod(absolute, 0o700).catch(() => {});
    for (const name of await readdir(absolute).catch(() => [] as string[])) await unlock(join(absolute, name));
  };
  await unlock(root);
  await rm(root, { recursive: true, force: true, maxRetries: 2 });
}
