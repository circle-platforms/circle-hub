// Backups: a pg_dump -Fc of the Hub database taken inside an exported snapshot, then copies of objects/, vault/ and
// config/ made AFTER the dump (so every object a dumped record names is present), all listed with SHA-256 in a manifest.
// The manifest also lists every privilege the application role holds, so a restore can prove it reproduced them; a
// database the application role owns anything in is not backed up (a restore could not reproduce that, see roles.ts).
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
import { copyFileIfPresent, listFiles, removeWithin, sha256File, slug, timestampName, uniqueChild, writeFileExclusive, type FileDigest } from './files.ts';
import type { Layout } from './layout.ts';
import { toolVersion, type PostgresControl } from './postgres.ts';
import { runCommand, tailLines, toolEnvironment, type CommandRunner } from './process.ts';
import { applicationRoleError, inspectRole, rolePrivileges } from './roles.ts';
import { summarizeTables, type TableSummary } from './sql.ts';

/** @3: table digests per TABLE_DIGEST in sql.ts (bucketed) and the application role's privileges. */
export const BACKUP_SCHEMA = 'circle-hub-backup@3';
/** Earlier formats, not restored by this version, and why. */
const OLD_BACKUP_SCHEMAS: Readonly<Record<string, string>> = {
  'circle-hub-backup@1': '表摘要的算法不同',
  'circle-hub-backup@2': '那时 Hub 数据库和表属于应用角色，清单里也没有应用角色的权限',
};
export const DUMP_FILE = 'database.dump';
export const MANIFEST_FILE = 'manifest.json';
export const DEFAULT_LIBPQ_BIN = '/opt/homebrew/opt/libpq/bin';
/**
 * Data root areas copied as files. Not packs/: the extracted pack trees are derived from the objects, and the server's
 * registry builds them again from the restored objects at their first use.
 */
export const FILE_AREAS = ['objects', 'vault', 'config'] as const;
export type FileArea = (typeof FILE_AREAS)[number];

const TableSummarySchema = z.object({ schema: z.string(), table: z.string(), rows: z.number().int().nonnegative(), digest: Sha256 }).strict();
const FileEntry = z.object({ path: z.string(), size: z.number().int().nonnegative(), sha256: Sha256 }).strict();

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
        application_role: z
          .object({
            name: z.string(),
            /** rolePrivileges in roles.ts at the snapshot: the restore must reproduce exactly these. */
            privileges: z.array(z.string()),
          })
          .strict(),
      })
      .strict(),
    files: z.array(FileEntry),
  })
  .strict();
export type BackupManifest = z.infer<typeof BackupManifest>;

/** The file list of the previous backup for object reuse; any manifest version will do, each reused copy is re-hashed. */
const PreviousFiles = z.object({ files: z.array(FileEntry) });

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

/** Linux defers the default until the receiving PostgreSQL major is known; explicit settings always take precedence. */
export function platformLibpqDirectory(explicit?: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const dir = explicit ?? env[PLATFORM_VARIABLES.libpqBin];
  if (dir !== undefined) return libpqDirectory(dir, env);
  return platform === 'linux' ? undefined : libpqDirectory(undefined, env);
}

/** pg_dump and pg_restore by absolute path; missing tools are an error with the install hint. */
export async function libpqTools(dir: string): Promise<LibpqTools> {
  const tools = { dir, pg_dump: join(dir, 'pg_dump'), pg_restore: join(dir, 'pg_restore') };
  for (const tool of [tools.pg_dump, tools.pg_restore]) {
    try {
      await access(tool);
    } catch {
      throw new PlatformError(`找不到 ${tool}`, `用 Homebrew 安装 libpq（brew install libpq），或在 Linux 安装同主版本的 PostgreSQL 客户端，或把 ${PLATFORM_VARIABLES.libpqBin} 设成工具所在目录`);
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

/** Resolve absolute tools without a shell. On Linux search PATH in order for a pair whose selected tool matches. */
export async function libpqToolsForMajor(
  explicit: string | undefined, expected: number, tool: 'pg_dump' | 'pg_restore', runner: CommandRunner,
  env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
): Promise<LibpqTools> {
  const configured = platformLibpqDirectory(explicit, env, platform);
  if (configured !== undefined) {
    const tools = await libpqTools(configured);
    await checkToolMajor(tools[tool], expected, runner);
    return tools;
  }
  for (const dir of [...new Set((env.PATH ?? '').split(':').filter(isAbsolute))]) {
    try {
      const tools = await libpqTools(dir);
      await checkToolMajor(tools[tool], expected, runner);
      return tools;
    } catch {
      // A missing, unusable or wrong-major candidate is not a valid match; later PATH entries may be suitable.
    }
  }
  throw new PlatformError(`PATH 中没有与 PostgreSQL ${expected} 主版本一致的 ${tool} 和 pg_dump/pg_restore`,
    `安装 PostgreSQL ${expected} 客户端，或把 ${PLATFORM_VARIABLES.libpqBin} 设成工具所在的绝对目录`);
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
  const { target } = postgres;
  const role = postgres.application.user;
  await mkdir(layout.backups, { recursive: true, mode: 0o700 });
  const started = now();
  const before = await previousManifest(layout);
  const partial = join(layout.backups, `.partial-${timestampName(started)}-${randomBytes(4).toString('hex')}`);
  await mkdir(partial, { mode: 0o700 });
  try {
    const session = await postgres.connector(target.database);
    let tables: TableSummary[];
    let privileges: string[];
    let serverVersion: string;
    let dumpTool: string;
    try {
      await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // Objects the application role owns would belong to the restoring superuser after a restore, with none of the
      // privileges their owner had, and its default privileges would come back and fail the restore's own check: such a
      // backup could never be restored as it was taken. This holds for large objects and default privileges too.
      const report = await inspectRole(session, role);
      if (report.problems.length > 0) throw applicationRoleError(postgres, report, '备份之前，');
      const [version] = await session.query("SELECT current_setting('server_version') AS text, current_setting('server_version_num')::int AS num");
      serverVersion = String(version?.text ?? '');
      const serverMajor = Math.floor(Number(version?.num ?? 0) / 10000);
      const tools = await libpqToolsForMajor(options.libpqBin, serverMajor, 'pg_dump', runner);
      dumpTool = await checkToolMajor(tools.pg_dump, serverMajor, runner);
      const [snapshot] = await session.query('SELECT pg_catalog.pg_export_snapshot() AS id');
      tables = await summarizeTables(session);
      // Grants change only when the owner migrates; deploy migrates under the platform lock, which circle-hub backup takes too.
      privileges = await rolePrivileges(session, role);
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
    const parsedBefore = before ? PreviousFiles.safeParse(before.value) : undefined;
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
      database: { name: target.database, server_version: serverVersion, dump_tool: dumpTool, tables, application_role: { name: role, privileges } },
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
  if (typeof schema === 'string' && Object.hasOwn(OLD_BACKUP_SCHEMAS, schema)) {
    throw new PlatformError(`备份 ${dir} 是旧格式 ${schema}（${OLD_BACKUP_SCHEMAS[schema]}），这一版不恢复它`, '用生成它的那一版 circle-hub 恢复');
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

/** The time a backup directory's name starts with (timestampName), in milliseconds; -Infinity when it has none. */
function nameTime(name: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(name);
  if (!match) return Number.NEGATIVE_INFINITY;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/** created_at of the backup's manifest in milliseconds; undefined without a manifest; the name's time when it cannot be read. */
async function createdAt(dir: string): Promise<number | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return nameTime(basename(dir));
  }
  try {
    const at = Date.parse(String((JSON.parse(text) as { created_at?: unknown } | null)?.created_at));
    return Number.isNaN(at) ? nameTime(basename(dir)) : at;
  } catch {
    return nameTime(basename(dir));
  }
}

/**
 * Complete backups (with a manifest), oldest first by the manifest's created_at, then by name. Names alone do not order
 * them: within one second `<time>` sorts before an earlier `<time>-<label>`. A manifest that cannot be read is placed by
 * the time its directory name starts with.
 */
export async function listBackups(layout: Layout): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(layout.backups, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const found: { dir: string; at: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(layout.backups, entry.name);
    const at = await createdAt(dir);
    if (at !== undefined) found.push({ dir, at });
  }
  return found.sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)).map((backup) => backup.dir);
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
