// Releases: one deployed copy per commit under releases/<id>, each with its own node_modules from npm ci, and the
// `current` symlink that the service runs. A release directory is built beside its final name and renamed into place
// only when complete, so a directory named after a release is always usable.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { IsoTime } from '../../contracts/src/common.ts';
import { PlatformError } from './errors.ts';
import {
  copyFileHashed,
  exists,
  listFiles,
  readSymlink,
  removeWithin,
  sha256File,
  sha256Text,
  switchSymlink,
  writeFileAtomic,
} from './files.ts';
import type { Layout } from './layout.ts';
import { inheritedEnvironment, runCommand, tailLines, type CommandRunner } from './process.ts';

export const RELEASE_SCHEMA = 'circle-hub-release@1';
export const RELEASE_FILE = 'release.json';
/** Reference archives that the runtime never uses (AGENTS.md: foundation/ and references/). */
export const RELEASE_EXCLUDES = ['foundation', 'references'] as const;
/** Top-level entries never copied from a plain directory. */
const COPY_EXCLUDES = ['node_modules', '.tmp', 'runtime-data', 'coverage', 'dist', ...RELEASE_EXCLUDES];
const RELEASE_ID = /^[0-9a-f]{12}$/;

/**
 * Names never copied from a plain directory, at any depth, so a copy cannot carry an owner's secrets or local state:
 * environment files, npm credentials, Circle's local data, logs, version control and Finder metadata. They are never
 * even read (not hashed into the release id).
 */
export function isPrivateName(name: string): boolean {
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.npmrc' ||
    name === '.circle' ||
    name === '.git' ||
    name === '.DS_Store' ||
    name.startsWith('._') ||
    name.endsWith('.log')
  );
}

/** Mode of a copied file: executable bits as in the source, owner-only files stay owner-only. */
export function copiedMode(sourceMode: number): number {
  const executable = (sourceMode & 0o111) !== 0;
  const ownerOnly = (sourceMode & 0o077) === 0;
  if (ownerOnly) return executable ? 0o700 : 0o600;
  return executable ? 0o755 : 0o644;
}

export const ReleaseFile = z
  .object({
    schema: z.literal(RELEASE_SCHEMA),
    id: z.string().regex(RELEASE_ID),
    commit: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
    tree_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    created_at: IsoTime,
  })
  .strict();
export type ReleaseFile = z.infer<typeof ReleaseFile>;

export interface ReleaseRef {
  id: string;
  dir: string;
}

export interface ReleaseSource {
  /** A git work tree (deployed with git archive) or, with copy, a directory that is not one. */
  path: string;
  /** Commit to deploy from a git work tree; default HEAD. */
  commit?: string;
  /** Copy a plain directory instead of archiving a commit (private names are left out; see isPrivateName). */
  copy?: boolean;
}

export interface ReleaseOptions {
  layout: Layout;
  runner?: CommandRunner;
  env?: NodeJS.ProcessEnv;
  git?: string;
  npm?: string;
  tar?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface PreparedRelease extends ReleaseRef {
  file: ReleaseFile;
  reused: boolean;
}

export function releaseDir(layout: Layout, id: string): string {
  if (!RELEASE_ID.test(id)) throw new PlatformError(`发布标识不合法：${id}`);
  return join(layout.releases, id);
}

export async function readReleaseFile(dir: string): Promise<ReleaseFile | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, RELEASE_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const parsed = ReleaseFile.safeParse(value);
  if (!parsed.success) throw new PlatformError(`发布记录不符合 ${RELEASE_SCHEMA}：${join(dir, RELEASE_FILE)}`);
  return parsed.data;
}

export async function findRelease(layout: Layout, id: string): Promise<ReleaseRef | undefined> {
  const dir = releaseDir(layout, id);
  return (await readReleaseFile(dir)) ? { id, dir } : undefined;
}

/** The release `current` points at, or undefined before the first deploy. */
export async function readCurrentRelease(layout: Layout): Promise<ReleaseRef | undefined> {
  const target = await readSymlink(layout.current);
  if (target === undefined) return undefined;
  const id = basename(target);
  const release = RELEASE_ID.test(id) ? await findRelease(layout, id) : undefined;
  if (!release) throw new PlatformError(`current 指向的不是一个完整的发布：${target}`, '手动检查 releases/ 与 current');
  return release;
}

/** Switches `current` atomically; undefined removes it. The link is relative so the data root can move. */
export async function switchCurrent(layout: Layout, id: string | undefined): Promise<void> {
  if (id !== undefined && !(await findRelease(layout, id))) throw new PlatformError(`没有这个发布：${id}`);
  await switchSymlink(layout.current, id === undefined ? undefined : join('releases', id));
}

async function run(runner: CommandRunner, command: string, args: string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }, action: string) {
  const result = await runner(command, args, options);
  if (result.code !== 0) throw new PlatformError(`${action}失败（退出码 ${result.code}）：${tailLines(result.stderr || result.stdout) || '没有输出'}`);
  return result;
}

/** Builds releases/<id> from a commit or a directory copy and runs npm ci in it; an existing complete release is reused. */
export async function prepareRelease(source: ReleaseSource, options: ReleaseOptions): Promise<PreparedRelease> {
  const { layout } = options;
  const runner = options.runner ?? runCommand;
  const env = inheritedEnvironment(options.env ?? process.env);
  const git = options.git ?? 'git';
  const npm = options.npm ?? 'npm';
  const tar = options.tar ?? 'tar';
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const workTree = await exists(join(source.path, '.git'));
  // A copy of a work tree would carry ignored files (.env, local data) that git archive leaves out.
  if (source.copy && workTree) throw new PlatformError(`${source.path} 是 git 工作区，不按目录复制`, '提交后用 circle-hub deploy --commit <提交> 部署；--copy 只用于不是 git 工作区的目录');
  const useGit = !source.copy && workTree;
  if (!source.copy && !useGit) throw new PlatformError(`${source.path} 不是 git 工作区`, '指定一个 git 工作区，或加 --copy 按目录复制');

  let commit: string | undefined;
  let tree: string | undefined;
  let files: string[] = [];
  if (useGit) {
    const rev = await run(runner, git, ['-C', source.path, 'rev-parse', '--verify', `${source.commit ?? 'HEAD'}^{commit}`], { env, timeoutMs: 60_000 }, '解析提交');
    commit = rev.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new PlatformError(`git 返回的不是提交号：${commit.slice(0, 80)}`);
    if (source.commit === undefined) {
      const dirty = await run(runner, git, ['-C', source.path, 'status', '--porcelain'], { env, timeoutMs: 60_000 }, '检查工作区');
      if (dirty.stdout.trim()) log('工作区有未提交的改动；部署的是 HEAD 提交本身，不含这些改动');
    }
  } else {
    files = await listFiles(source.path, COPY_EXCLUDES, { exclude: isPrivateName });
    const lines: string[] = [];
    for (const path of files) lines.push(`${(await sha256File(join(source.path, path))).sha256}  ${path}`);
    tree = sha256Text(`${lines.join('\n')}\n`);
  }
  const id = (commit ?? tree!).slice(0, 12);
  const dir = releaseDir(layout, id);
  const existing = await readReleaseFile(dir);
  if (existing) return { id, dir, file: existing, reused: true };
  if (await exists(dir)) throw new PlatformError(`${dir} 已存在但不是完整的发布`, '手动检查后删除它再部署');

  await mkdir(layout.releases, { recursive: true, mode: 0o700 });
  const partial = join(layout.releases, `.partial-${id}-${randomBytes(4).toString('hex')}`);
  await mkdir(partial, { mode: 0o700 });
  try {
    if (commit) {
      const archive = `${partial}.tar`;
      try {
        const pathspec = ['.', ...RELEASE_EXCLUDES.map((name) => `:(exclude)${name}`)];
        await run(runner, git, ['-C', source.path, 'archive', '--format=tar', `--output=${archive}`, commit, '--', ...pathspec], { env, timeoutMs: 300_000 }, 'git archive');
        await run(runner, tar, ['-x', '-f', archive, '-C', partial], { env, timeoutMs: 300_000 }, '解开发布包');
      } finally {
        await rm(archive, { force: true });
      }
    } else {
      for (const path of files) {
        await copyFileHashed(join(source.path, path), join(partial, path), copiedMode((await stat(join(source.path, path))).mode));
      }
    }
    if (!(await exists(join(partial, 'bin', 'circle-hub')))) throw new PlatformError('发布里没有 bin/circle-hub');
    if (!(await exists(join(partial, 'package-lock.json')))) throw new PlatformError('发布里没有 package-lock.json，不能 npm ci');
    await run(runner, npm, ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: partial, env, timeoutMs: 1_800_000 }, 'npm ci');
    const file = ReleaseFile.parse({
      schema: RELEASE_SCHEMA,
      id,
      ...(commit ? { commit } : {}),
      ...(tree ? { tree_sha256: tree } : {}),
      created_at: now().toISOString(),
    });
    await writeFileAtomic(join(partial, RELEASE_FILE), `${JSON.stringify(file, null, 2)}\n`, 0o644);
    await rename(partial, dir);
    return { id, dir, file, reused: false };
  } catch (error) {
    await removeWithin(layout.releases, partial).catch(() => {});
    throw error;
  }
}
