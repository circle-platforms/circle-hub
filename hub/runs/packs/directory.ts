// Reading a pack directory (T01 F[0]): every file with its SHA-256, checked against the manifest (pack.json) exactly. Every
// listed file appears once with its digest and size, nothing is unlisted, paths are legal pack paths, and there are no links
// (symbolic or hard) or special files. The bytes returned are the bytes that were hashed, so what is stored is what was
// checked. Messages never state the digest or size of what was found on disk: only what the manifest says.
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PACK_FILE_PATHS } from '../../../contracts/generated/protocol.ts';
import { PackManifest, packPathProblem } from '../../../contracts/src/pack.ts';
import { canonicalBytes, CanonicalizationError, sha256Hex } from '../../records/api.ts';
import { pointerOf, problem, readJsonFile, shapeProblems } from './problems.ts';
import { DEFAULT_PACK_LIMITS, type PackDirectory, type PackFile, type PackLimits, type PackProblem, type PackRead } from './types.ts';

export const MANIFEST_FILE = 'pack.json';

/** Where packs keep files, for the fixes: the top-level names of the generated file list. */
const PLACES = PACK_FILE_PATHS.join('、');

/** A regular file as the walk saw it (exported for tests). */
export interface DiskFile {
  path: string;
  absolute: string;
  size: number;
  dev: bigint;
  ino: bigint;
}

class WalkStopped extends Error {}

export function packLimits(limits: Partial<PackLimits> = {}): PackLimits {
  const out = { ...DEFAULT_PACK_LIMITS };
  for (const key of Object.keys(DEFAULT_PACK_LIMITS) as (keyof PackLimits)[]) {
    const value = limits[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`包的上限 ${key} 必须是正整数`);
    out[key] = value;
  }
  return out;
}

/** Lists the directory without following links: files by pack path, and a problem for everything a pack cannot contain. */
async function walk(root: string, limits: PackLimits): Promise<{ files: Map<string, DiskFile>; problems: PackProblem[] }> {
  const files = new Map<string, DiskFile>();
  const problems: PackProblem[] = [];
  let entries = 0;
  const visit = async (absolute: string, relative: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(absolute)).sort();
    } catch {
      problems.push(problem('directory.unreadable', relative === '' ? '.' : relative, `目录 ${relative === '' ? '（包根）' : relative} 读不出来`, '检查目录权限'));
      return;
    }
    for (const name of names) {
      entries += 1;
      if (entries > limits.maxFiles * 2 + 64) {
        problems.push(problem('directory.too_many_files', '.', `包目录里的条目超过 ${limits.maxFiles * 2 + 64} 个（文件上限 ${limits.maxFiles}）`, '删掉不需要的文件和目录'));
        throw new WalkStopped();
      }
      const path = relative === '' ? name : `${relative}/${name}`;
      const child = join(absolute, name);
      let info;
      try {
        info = await lstat(child, { bigint: true });
      } catch {
        problems.push(problem('directory.changed', path, `${path} 在读取期间不见了`, '等目录不再变化后重新发布'));
        continue;
      }
      if (info.isSymbolicLink()) {
        problems.push(problem('directory.symlink', path, `${path} 是符号链接；包里不能有链接（沙箱会顺着链接读到包外）`, '把它换成真实的文件或目录，或者删除它'));
        continue;
      }
      if (info.isDirectory()) {
        // A directory is legal when a file inside it could be a pack file.
        const reason = packPathProblem(`${path}/x`);
        if (reason !== null) {
          problems.push(problem('directory.illegal_dir', path, `目录 ${path} 不能放包文件（${reason}）`, `把需要的文件移到包放文件的地方（${PLACES}），删除这个目录`));
          continue;
        }
        if (depth + 1 > limits.maxDepth) {
          problems.push(problem('directory.too_deep', path, `目录 ${path} 超过 ${limits.maxDepth} 层`, '把目录结构改浅'));
          continue;
        }
        await visit(child, path, depth + 1);
        continue;
      }
      if (!info.isFile()) {
        problems.push(problem('directory.special_file', path, `${path} 不是普通文件或目录（管道、套接字或设备）`, '删除它'));
        continue;
      }
      if (info.nlink > 1n) {
        problems.push(problem('directory.hardlink', path, `${path} 有 ${info.nlink} 个硬链接；包里不能有链接（链接的另一端可能在包外）`, '复制这个文件，不要链接它'));
        continue;
      }
      if (path !== MANIFEST_FILE) {
        const reason = packPathProblem(path);
        if (reason !== null) {
          problems.push(problem('directory.illegal_path', path, `${path} 不是合法的包文件路径（${reason}）`, `改名或移到包放文件的地方（${PLACES}），或者删除它`));
          continue;
        }
      }
      files.set(path, { path, absolute: child, size: Number(info.size), dev: info.dev, ino: info.ino });
      if (files.size > limits.maxFiles + 1) {
        problems.push(problem('directory.too_many_files', '.', `包里的文件超过 ${limits.maxFiles} 个`, '删掉不需要的文件'));
        throw new WalkStopped();
      }
    }
  };
  try {
    await visit(root, '', 0);
  } catch (error) {
    if (!(error instanceof WalkStopped)) throw error;
  }
  return { files, problems };
}

/**
 * Reads the file the walk saw: refuses a link in its place (O_NOFOLLOW), a pipe or device swapped in (O_NONBLOCK, so the
 * open never waits, then the handle must be a regular file), a second hard link, and a different file swapped in (device and
 * inode compared). O_NOFOLLOW guards the last name only, so after the read the path must still be its own real path: a
 * directory on the way swapped for a link is refused too. A path that changes between the walk and the read is never
 * followed out of the pack. Exported for tests.
 */
export async function readSeen(file: DiskFile, cap: number): Promise<Uint8Array | 'changed' | 'too_large'> {
  let handle;
  try {
    handle = await open(file.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return 'changed';
  }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.dev !== file.dev || info.ino !== file.ino) return 'changed';
    if (Number(info.size) > cap) return 'too_large';
    const bytes = await handle.readFile();
    if (bytes.byteLength !== Number(info.size)) return 'changed';
    if ((await realpath(file.absolute)) !== file.absolute) return 'changed';
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch {
    return 'changed';
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Paths that differ only in case at some level (a directory or the file itself): on a case-insensitive volume, the default
 * on macOS, they are one name and the pack cannot be extracted. Whole paths are compared by PackManifest already.
 */
export function caseCollisions(paths: readonly string[]): PackProblem[] {
  const spelled = new Map<string, string>();
  const out: PackProblem[] = [];
  paths.forEach((path, i) => {
    const parts = path.split('/');
    for (let k = 1; k <= parts.length; k++) {
      const name = parts.slice(0, k).join('/');
      const seen = spelled.get(name.toLowerCase());
      if (seen === undefined) spelled.set(name.toLowerCase(), name);
      else if (seen !== name) {
        out.push(
          problem('manifest.case_collision', MANIFEST_FILE, `${path} 里的 ${name} 与 ${seen} 只差大小写；不分大小写的磁盘（macOS 默认）上它们是同一个名字，包无法解包`, `统一写成 ${seen}，或者换一个名字，再重新签名`, {
            field: pointerOf(['files', i, 'path']),
          }),
        );
        break;
      }
    }
  });
  return out;
}

const changed = (path: string): PackProblem =>
  problem('directory.changed', path, `${path} 在读取期间变了（被替换、改名或换成了链接）`, '等文件不再变化后重新发布');

/**
 * Reads a pack directory and checks it against its manifest. The pack digest is the SHA-256 of the RFC 8785 canonical JSON
 * of the manifest, so the formatting of pack.json does not matter and any changed file changes the digest (through its
 * SHA-256 in the manifest). Returns every problem found, never a partial pack.
 */
export async function readPackDirectory(directory: string, options: { limits?: Partial<PackLimits> } = {}): Promise<PackRead> {
  const limits = packLimits(options.limits);
  let root: string;
  try {
    root = await realpath(directory);
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, problems: [problem('directory.missing', '.', '找不到包目录，或者给出的路径不是目录', '给出包所在的目录')] };
  }
  const { files, problems } = await walk(root, limits);

  const manifestFile = files.get(MANIFEST_FILE);
  files.delete(MANIFEST_FILE);
  if (manifestFile === undefined) {
    problems.push(problem('manifest.missing', MANIFEST_FILE, '包目录根下没有 pack.json', '写一个 pack.json：包号、版本、种类、标题、说明，以及每个文件的路径、SHA-256 和字节数'));
    return { ok: false, problems };
  }
  if (manifestFile.size > limits.maxManifestBytes) {
    problems.push(problem('manifest.too_large', MANIFEST_FILE, `pack.json 有 ${manifestFile.size} 字节，超过上限 ${limits.maxManifestBytes} 字节`, '精简 pack.json，或者减少包里的文件'));
    return { ok: false, problems };
  }
  const manifestBytes = await readSeen(manifestFile, limits.maxManifestBytes);
  if (typeof manifestBytes === 'string') {
    problems.push(changed(MANIFEST_FILE));
    return { ok: false, problems };
  }
  const parsedJson = readJsonFile(MANIFEST_FILE, manifestBytes, 'manifest.json');
  if (!parsedJson.ok) {
    problems.push(parsedJson.problem);
    return { ok: false, problems };
  }
  const parsed = PackManifest.safeParse(parsedJson.value);
  if (!parsed.success) {
    problems.push(...shapeProblems('manifest.shape', MANIFEST_FILE, 'pack@1', parsed.error.issues));
    return { ok: false, problems };
  }
  const manifest = parsed.data;
  problems.push(...caseCollisions(manifest.files.map((f) => f.path)));

  const listed = new Set(manifest.files.map((f) => f.path));
  for (const path of [...files.keys()].sort()) {
    if (!listed.has(path)) {
      problems.push(problem('manifest.unlisted_file', path, `${path} 在包目录里，但 pack.json 没有列出`, '把它写进 pack.json 的 files（带 SHA-256 和字节数），或者删除它'));
    }
  }
  // A pack over a cap is refused whole: nothing is read, so the caps bound what a refused pack costs.
  const total = manifest.files.reduce((sum, f) => sum + f.size, 0);
  const capped: PackProblem[] = [];
  if (total > limits.maxTotalBytes) {
    capped.push(problem('directory.too_large', MANIFEST_FILE, `pack.json 列出的文件共 ${total} 字节，超过上限 ${limits.maxTotalBytes} 字节`, '删掉不需要的文件，或者把大文件拆出包外'));
  }
  if (manifest.files.length > limits.maxFiles) {
    capped.push(problem('directory.too_many_files', MANIFEST_FILE, `pack.json 列出了 ${manifest.files.length} 个文件，超过上限 ${limits.maxFiles} 个`, '删掉不需要的文件'));
  }
  if (capped.length > 0 || problems.some((p) => p.rule === 'directory.too_many_files')) return { ok: false, problems: [...problems, ...capped] };

  const read: PackFile[] = [];
  let readBytes = 0;
  for (const [i, entry] of manifest.files.entries()) {
    const disk = files.get(entry.path);
    if (disk === undefined) {
      problems.push(problem('manifest.missing_file', MANIFEST_FILE, `pack.json 列出的 ${entry.path} 在包目录里没有`, '补上这个文件，或者从 pack.json 的 files 里删掉它', { field: `/files/${i}/path` }));
      continue;
    }
    if (disk.size > limits.maxFileBytes) {
      problems.push(problem('directory.file_too_large', entry.path, `${entry.path} 超过单个文件的上限 ${limits.maxFileBytes} 字节`, '把文件拆小，或者删掉它；超限的文件不会被截断保存'));
      continue;
    }
    if (disk.size !== entry.size) {
      problems.push(
        problem('manifest.size_mismatch', MANIFEST_FILE, `pack.json 写 ${entry.path} 有 ${entry.size} 字节，包目录里的文件不是这个大小`, '文件变了：确认改动后重新计算 pack.json 里这个文件的字节数和 SHA-256（重新签名）', {
          field: `/files/${i}/size`,
        }),
      );
      continue;
    }
    // Sizes agree with the manifest, whose total is within the cap; what is left of it also caps a file that grew meanwhile.
    const bytes = await readSeen(disk, Math.min(limits.maxFileBytes, limits.maxTotalBytes - readBytes));
    if (typeof bytes === 'string') {
      problems.push(changed(entry.path));
      continue;
    }
    readBytes += bytes.byteLength;
    const sha256 = sha256Hex(bytes);
    if (sha256 !== entry.sha256) {
      problems.push(
        problem('manifest.digest_mismatch', MANIFEST_FILE, `${entry.path} 的内容与 pack.json 写的 SHA-256 ${entry.sha256} 不符`, '文件内容变了：确认是有意的改动后重新计算 pack.json 里的 SHA-256（重新签名）；不是的话恢复原文件', {
          field: `/files/${i}/sha256`,
        }),
      );
      continue;
    }
    read.push({ path: entry.path, sha256, size: bytes.byteLength, bytes });
  }
  if (problems.length > 0) return { ok: false, problems };
  let canonical: Uint8Array;
  try {
    canonical = canonicalBytes(manifest);
  } catch (error) {
    // readJsonFile refuses what canonical JSON cannot hold; this stays a refusal should anything slip through.
    if (!(error instanceof CanonicalizationError)) throw error;
    return { ok: false, problems: [problem('manifest.json', MANIFEST_FILE, `pack.json 的 ${error.path || '整个文件'} 无法写成规范化 JSON（RFC 8785）`, '改正这个值', { field: error.path })] };
  }
  const pack: PackDirectory = { root, manifest, digest: sha256Hex(canonical), manifestBytes: canonical, files: read };
  return { ok: true, pack };
}

/** The pack digest of a manifest: SHA-256 of its RFC 8785 canonical JSON. */
export function manifestDigest(manifest: unknown): string {
  return sha256Hex(canonicalBytes(manifest));
}
