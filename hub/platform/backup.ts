// Backups: a pg_dump -Fc of the Hub database taken inside an exported snapshot, then copies of objects/, vault/ and
// config/ made AFTER the dump (so every object a dumped record names is present), all listed with SHA-256 in a manifest.
// Each backup is a timestamped directory under backups/, written beside it and renamed into place only when complete.
// A backup may run while the Hub writes (cron): in-flight temporaries are never copied and a file that vanished after
// listing is skipped. Objects unchanged since the previous backup are hard links to its copy, re-hashed each time.
import { randomBytes } from 'node:crypto';
import { access, chmod, link, lstat, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';
import { IsoTime, Sha256 } from '../../contracts/src/common.ts';
import { PLATFORM_VARIABLES } from './environment.ts';
import { PlatformError } from './errors.ts';
import { copyFileIfPresent, exists, listFiles, removeWithin, sha256File, slug, timestampName, uniqueChild, writeFileExclusive, type FileDigest } from './files.ts';
import type { Layout } from './layout.ts';
import { toolVersion, type PostgresControl } from './postgres.ts';
import { runCommand, tailLines, toolEnvironment, type CommandRunner } from './process.ts';
import { summarizeTables, type TableSummary } from './sql.ts';

/** @2: table digests per TABLE_DIGEST in sql.ts (bucketed); @1 used one aggregate per table and is not accepted. */
export const BACKUP_SCHEMA = 'circle-hub-backup@2';
const OLD_BACKUP_SCHEMAS = ['circle-hub-backup@1'];
export const DUMP_FILE = 'database.dump';
export const MANIFEST_FILE = 'manifest.json';
export const DEFAULT_LIBPQ_BIN = '/opt/homebrew/opt/libpq/bin';
/** Data root areas copied as files. */
export const FILE_AREAS = ['objects', 'vault', 'config'] as const;
export type FileArea = (typeof FILE_AREAS)[number];

const TableSummarySchema = z.object({ schema: z.string(), table: z.string(), rows: z.number().int().nonnegative(), digest: Sha256 }).strict();

export const BackupManifest = z
  .object({
    schema: z.literal(BACKUP_SCHEMA),
    created_at: IsoTime,
    label: z.string().optional(),
    database: z
      .object({
        name: z.string(),
        server_version: z.string(),
        dump_tool: z.string(),
        tables: z.array(TableSummarySchema),
      })
      .strict(),
    files: z.array(z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: Sha256 }).strict()),
  })
  .strict();
export type BackupManifest = z.infer<typeof BackupManifest>;

/**
 * Names in a file area that are never part of a backup: dot-files (the object store's `.<sha>.<random>.tmp`, Finder's
 * .DS_Store, AppleDouble ._*) and `*.tmp` (the vault's `<entry>.sealed.<random>.tmp`). No final name has either form.
 */
export function isTransientName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.tmp');
}

/** Operating-system metadata that may appear in a backup directory without changing the backup. */
function isOsMetadata(path: string): boolean {
  const name = basename(path);
  return name === '.DS_Store' || name.startsWith('._');
}

export interface LibpqTools {
  dir: string;
  pg_dump: string;
  pg_restore: string;
}

export function libpqDirectory(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = explicit ?? env[PLATFORM_VARIABLES.libpqBin] ?? DEFAULT_LIBPQ_BIN;
  if (!isAbsolute(dir)) throw new PlatformError(`${PLATFORM_VARIABLES.libpqBin} 必须是绝对路径：${dir}`);
  return dir;
}

/** pg_dump and pg_restore by absolute path; missing tools are an error with the install hint. */
export async function libpqTools(dir: string): Promise<LibpqTools> {
  const tools = { dir, pg_dump: join(dir, 'pg_dump'), pg_restore: join(dir, 'pg_restore') };
  for (const tool of [tools.pg_dump, tools.pg_restore]) {
    try {
      await access(tool);
    } catch {
      throw new PlatformError(`找不到 ${tool}`, `用 Homebrew 安装 libpq（brew install libpq），或把 ${PLATFORM_VARIABLES.libpqBin} 设成装有 pg_dump 的目录`);
    }
  }
  return tools;
}

/** Permission bits kept through backup and restore (objects are read-only, 0400). Owner read is always kept. */
export function keptMode(mode: number): number {
  return (mode & 0o700) | 0o400;
}

/** Permission bits of a file, kept through backup and restore. */
export async function permissions(path: string): Promise<number> {
  return keptMode((await stat(path)).mode);
}

export async function checkToolMajor(tool: string, expected: number, runner: CommandRunner): Promise<string> {
  const version = await toolVersion(tool, runner);
  if (version.major !== expected) {
    throw new PlatformError(`${tool} 是 PostgreSQL ${version.major}，数据库是 PostgreSQL ${expected}：主版本必须相同`, `装 PostgreSQL ${expected} 的 libpq，或设置 ${PLATFORM_VARIABLES.libpqBin}`);
  }
  return version.text;
}

/** The directory of a backup recorded by name (or, in older records, by absolute path) in this data root. */
export function backupPath(layout: Layout, recorded: string): string {
  const name = basename(recorded);
  if (name === '' || name.startsWith('.') || name !== basename(name)) throw new PlatformError(`备份名不合法：${recorded}`);
  return join(layout.backups, name);
}

export interface BackupOptions {
  layout: Layout;
  /** The running cluster to dump. */
  postgres: PostgresControl;
  libpqBin?: string;
  runner?: CommandRunner;
  now?: () => Date;
  /** Short purpose added to the directory name, for example pre-deploy. */
  label?: string;
}

export interface BackupResult {
  dir: string;
  manifest: BackupManifest;
  /** Files listed but gone before their copy (a vault entry removed meanwhile); not part of the backup. */
  skipped: string[];
  /** Objects hard-linked from the previous backup after checking their SHA-256. */
  reused: number;
}

/** The newest complete backup's manifest, read without a full verification; undefined when there is none or it is unreadable. */
async function previousManifest(layout: Layout): Promise<{ dir: string; value: unknown } | undefined> {
  const dir = (await listBackups(layout)).at(-1);
  if (!dir) return undefined;
  try {
    return { dir, value: JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')) };
  } catch {
    return undefined;
  }
}

type Listed = Map<string, { size: number; sha256: string }>;

/**
 * Hard-links an object from the previous backup when that copy is the same object (named by its SHA-256, same size and
 * mode) and still hashes to it; otherwise undefined and the caller copies the live object.
 */
async function reuseObject(previous: { dir: string; files: Listed }, path: string, source: string, target: string): Promise<FileDigest | undefined> {
  const listed = previous.files.get(path);
  if (!listed || listed.sha256 !== basename(path)) return undefined;
  const old = join(previous.dir, path);
  let live, kept;
  try {
    [live, kept] = await Promise.all([lstat(source), lstat(old)]);
  } catch {
    return undefined;
  }
  if (!live.isFile() || !kept.isFile() || live.size !== listed.size || kept.size !== listed.size) return undefined;
  if ((kept.mode & 0o777) !== keptMode(live.mode)) return undefined;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await link(old, target);
  } catch {
    return undefined;
  }
  const digest = await sha256File(target);
  if (digest.sha256 === listed.sha256 && digest.size === listed.size) return digest;
  await rm(target, { force: true });
  return undefined;
}

export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const { layout, postgres } = options;
  const runner = options.runner ?? runCommand;
  const now = options.now ?? (() => new Date());
  const tools = await libpqTools(libpqDirectory(options.libpqBin));
  const { target } = postgres;
  await mkdir(layout.backups, { recursive: true, mode: 0o700 });
  const started = now();
  const before = await previousManifest(layout);
  const partial = join(layout.backups, `.partial-${timestampName(started)}-${randomBytes(4).toString('hex')}`);
  await mkdir(partial, { mode: 0o700 });
  try {
    const session = await postgres.connector(target.database);
    let tables: TableSummary[];
    let serverVersion: string;
    let dumpTool: string;
    try {
      await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const [version] = await session.query("SELECT current_setting('server_version') AS text, current_setting('server_version_num')::int AS num");
      serverVersion = String(version?.text ?? '');
      const serverMajor = Math.floor(Number(version?.num ?? 0) / 10000);
      dumpTool = await checkToolMajor(tools.pg_dump, serverMajor, runner);
      const [snapshot] = await session.query('SELECT pg_catalog.pg_export_snapshot() AS id');
      tables = await summarizeTables(session);
      const earlier = (before?.value as { database?: { tables?: unknown } } | undefined)?.database?.tables;
      if (tables.length === 0 && Array.isArray(earlier) && earlier.length > 0) {
        throw new PlatformError(
          `数据库 ${target.database} 里没有表，上一份备份（${basename(before!.dir)}）有 ${earlier.length} 张表：可能连错了数据库，不备份`,
          '检查部署设置里的数据库名',
        );
      }
      // The exporting transaction stays open until pg_dump has finished with its snapshot.
      const dump = await runner(
        tools.pg_dump,
        [
          '--format=custom',
          `--file=${join(partial, DUMP_FILE)}`,
          `--host=${target.socketDir}`,
          `--port=${target.port}`,
          `--username=${target.user}`,
          `--dbname=${target.database}`,
          '--no-password',
          `--snapshot=${String(snapshot?.id ?? '')}`,
        ],
        { env: toolEnvironment(), timeoutMs: 6 * 60 * 60 * 1000 },
      );
      if (dump.code !== 0) throw new PlatformError(`pg_dump 失败（退出码 ${dump.code}）：${tailLines(dump.stderr)}`);
      await session.query('COMMIT');
    } finally {
      await session.close();
    }

    const files: BackupManifest['files'] = [];
    await chmod(join(partial, DUMP_FILE), 0o600);
    const dump = await sha256File(join(partial, DUMP_FILE));
    files.push({ path: DUMP_FILE, ...dump });
    const parsedBefore = before ? BackupManifest.safeParse(before.value) : undefined;
    const previous = parsedBefore?.success
      ? { dir: before!.dir, files: new Map(parsedBefore.data.files.filter((file) => file.path.startsWith('objects/')).map((file) => [file.path, file])) }
      : undefined;
    const skipped: string[] = [];
    let reused = 0;
    for (const area of FILE_AREAS) {
      for (const path of await listFiles(layout[area], [], { exclude: isTransientName })) {
        const source = join(layout[area], path);
        const copy = join(partial, area, path);
        const listed = `${area}/${path}`;
        let digest = area === 'objects' && previous ? await reuseObject(previous, listed, source, copy) : undefined;
        if (digest) reused++;
        else digest = await copyFileIfPresent(source, copy, keptMode);
        if (!digest) {
          skipped.push(listed);
          continue;
        }
        files.push({ path: listed, ...digest });
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest = BackupManifest.parse({
      schema: BACKUP_SCHEMA,
      created_at: started.toISOString(),
      ...(options.label ? { label: options.label } : {}),
      database: { name: target.database, server_version: serverVersion, dump_tool: dumpTool, tables },
      files,
    });
    await writeFileExclusive(join(partial, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    const name = options.label ? `${timestampName(started)}-${slug(options.label)}` : timestampName(started);
    const dir = await uniqueChild(layout.backups, name);
    await rename(partial, dir);
    return { dir, manifest, skipped, reused };
  } catch (error) {
    await removeWithin(layout.backups, partial).catch(() => {});
    throw error;
  }
}

function safeManifestPath(path: string): boolean {
  if (path === DUMP_FILE) return true;
  if (isAbsolute(path) || path.includes('\\') || normalize(path) !== path || path.split('/').includes('..')) return false;
  return FILE_AREAS.some((area) => path.startsWith(`${area}/`) && path.length > area.length + 1);
}

/**
 * Checks the manifest against every file of the backup: same set of files, sizes and SHA-256. Finder's .DS_Store and
 * AppleDouble ._* files that the manifest does not list are ignored (opening or copying the folder creates them).
 */
export async function verifyBackup(dir: string): Promise<BackupManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8'));
  } catch {
    throw new PlatformError(`读不了备份清单：${join(dir, MANIFEST_FILE)}`, '确认这是一个完整的 circle-hub 备份目录');
  }
  const schema = (raw as { schema?: unknown } | null)?.schema;
  if (typeof schema === 'string' && OLD_BACKUP_SCHEMAS.includes(schema)) {
    throw new PlatformError(`备份 ${dir} 是旧格式 ${schema}（表摘要的算法不同），这一版不恢复它`, '用生成它的那一版 circle-hub 恢复');
  }
  const parsed = BackupManifest.safeParse(raw);
  if (!parsed.success) throw new PlatformError(`备份清单不符合 ${BACKUP_SCHEMA}：${join(dir, MANIFEST_FILE)}`);
  const manifest = parsed.data;
  const listed = new Map<string, { size: number; sha256: string }>();
  for (const file of manifest.files) {
    if (!safeManifestPath(file.path)) throw new PlatformError(`备份清单里有不允许的路径：${file.path}`);
    if (listed.has(file.path)) throw new PlatformError(`备份清单里路径重复：${file.path}`);
    listed.set(file.path, file);
  }
  if (!listed.has(DUMP_FILE)) throw new PlatformError(`备份清单里没有 ${DUMP_FILE}`);
  const present = new Set((await listFiles(dir)).filter((path) => path !== MANIFEST_FILE && (listed.has(path) || !isOsMetadata(path))));
  const problems: string[] = [];
  for (const path of present) if (!listed.has(path)) problems.push(`多出文件 ${path}`);
  for (const [path, expected] of listed) {
    if (!present.has(path)) {
      problems.push(`缺少文件 ${path}`);
      continue;
    }
    const actual = await sha256File(join(dir, path));
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) problems.push(`文件 ${path} 的 SHA-256 或大小与清单不符`);
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('；');
    throw new PlatformError(`备份 ${dir} 校验不通过：${shown}${problems.length > 5 ? ` 等 ${problems.length} 处` : ''}`, '不要用这份备份恢复');
  }
  return manifest;
}

/** Complete backups (with a manifest), oldest first. */
export async function listBackups(layout: Layout): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(layout.backups, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (await exists(join(layout.backups, entry.name, MANIFEST_FILE))) out.push(join(layout.backups, entry.name));
  }
  return out.sort();
}

/**
 * Keeps the newest `keep` backups plus the protected ones (names, or paths of older records, resolved in this data
 * root); returns the removed directories.
 */
export async function pruneBackups(layout: Layout, keep: number, protect: readonly string[] = []): Promise<string[]> {
  if (!Number.isInteger(keep) || keep < 1) throw new PlatformError(`保留份数必须是正整数：${keep}`);
  const all = await listBackups(layout);
  const kept = new Set([...all.slice(-keep), ...protect.map((recorded) => backupPath(layout, recorded))]);
  const removed: string[] = [];
  for (const dir of all) {
    if (kept.has(dir)) continue;
    await removeWithin(layout.backups, dir);
    removed.push(dir);
  }
  return removed;
}
