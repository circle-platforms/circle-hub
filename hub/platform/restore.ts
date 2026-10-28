// Restore of one backup into an empty data root. The manifest is verified first; nothing existing is ever overwritten.
// A restore that fails half way moves its partial state to set-aside/ so the data root is empty again for a retry.
//
// Roles: pg_restore runs as the cluster's superuser role, which owns the Hub database (ensureDatabase creates it and the
// application role first), with --no-owner, so every restored object belongs to that role whoever owned it where the dump
// was taken. The GRANTs in the dump are kept: they are exactly what the migration of the release that wrote the data gave
// the application role. Re-granting instead would need the records package's table list (RUNTIME_GRANTS), which the
// platform may not import, and the restoring code's list could name tables the restored schema does not have yet. The
// restore then proves that the application role holds exactly the privileges the manifest recorded and owns nothing.
import { chmod, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DUMP_FILE, libpqToolsForMajor, permissions, verifyBackup } from './backup.ts';
import { messageOf, PlatformError } from './errors.ts';
import { copyFileHashed, exists, isMissingOrEmpty, listFiles, sha256File, slug, timestampName, uniqueChild } from './files.ts';
import { DATA_ROOT_VARIABLE, ensureLayout, type Layout } from './layout.ts';
import type { PostgresControl } from './postgres.ts';
import { runCommand, tailLines, toolEnvironment, type CommandRunner } from './process.ts';
import { comparePrivileges, rolePrivileges, roleProblems } from './roles.ts';
import { compareSummaries, summarizeTables, withSession } from './sql.ts';

/**
 * Areas that hold Hub data. logs/, backups/, releases/ and config/ are not data, and neither is packs/: extracted pack
 * trees derived from the objects, which a restore leaves as they are (the registry checks a tree at every use and builds
 * it again from the objects when it does not match).
 */
const DATA_AREAS = ['db', 'objects', 'vault'] as const;

export interface RestoreOptions {
  layout: Layout;
  backupDir: string;
  /** Control of this data root's cluster, with the binaries the restored cluster will run on. */
  postgres: PostgresControl;
  libpqBin?: string;
  runner?: CommandRunner;
  now?: () => Date;
}

export interface RestoreReport {
  backup: string;
  tables: number;
  rows: number;
  files: number;
  /** Privileges of the application role, equal to those the manifest recorded. */
  privileges: number;
  /** Config files left untouched because the data root already had a different version. */
  keptConfig: string[];
}

export async function assertRestorable(layout: Layout): Promise<void> {
  const problems: string[] = [];
  if (!(await isMissingOrEmpty(layout.db))) problems.push(`数据库目录 ${layout.db} 不是空的`);
  for (const area of ['objects', 'vault'] as const) {
    if ((await listFiles(layout[area])).length > 0) problems.push(`${layout[area]} 里已有文件`);
  }
  if (problems.length > 0) {
    throw new PlatformError(`只能恢复到空的数据根：${problems.join('；')}`, `换一个新的 ${DATA_ROOT_VARIABLE}，或先把现有数据移开`);
  }
}

/** Archive only the vault; callers enforce key/service preconditions and hold any required platform lock. */
export async function setAsideVault(layout:Layout, now:Date=new Date()):Promise<{path:string|null;files:number}> {
  let path:string|null=null, files=0;
  if (!(await isMissingOrEmpty(layout.vault))) {
    files=(await listFiles(layout.vault)).length;
    await mkdir(layout.setAside,{recursive:true,mode:0o700});
    const target=await uniqueChild(layout.setAside,timestampName(now)+'-key-loss');
    await mkdir(target,{mode:0o700});
    path=join(target,'vault');await rename(layout.vault,path);
  }
  await mkdir(layout.vault,{recursive:true,mode:0o700});await chmod(layout.vault,0o700);
  return {path,files};
}

/**
 * Moves db/, objects/ and vault/ into set-aside/<time>-<reason>/ and recreates them empty. The cluster must be stopped.
 * Returns the directory, or undefined when there was nothing to move.
 */
export async function setAside(layout: Layout, reason: string, now: Date = new Date()): Promise<string | undefined> {
  if (await exists(join(layout.db, 'postmaster.pid'))) {
    throw new PlatformError('数据库还在运行（或上次没有正常停止），不能移开数据目录', '先运行 circle-hub db stop，再检查 db/postmaster.pid');
  }
  const present: (typeof DATA_AREAS)[number][] = [];
  for (const area of DATA_AREAS) if (!(await isMissingOrEmpty(layout[area]))) present.push(area);
  if (present.length === 0) return undefined;
  await mkdir(layout.setAside, { recursive: true, mode: 0o700 });
  const dir = await uniqueChild(layout.setAside, `${timestampName(now)}-${slug(reason) || 'set-aside'}`);
  await mkdir(dir, { mode: 0o700 });
  for (const area of present) await rename(layout[area], join(dir, area));
  await ensureLayout(layout);
  return dir;
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreReport> {
  const { layout, backupDir, postgres } = options;
  const runner = options.runner ?? runCommand;
  const now = options.now ?? (() => new Date());
  const manifest = await verifyBackup(backupDir);
  const role = postgres.application.user;
  const recorded = manifest.database.application_role;
  if (recorded.name !== role) {
    // The dump grants to the recorded name; a cluster whose application role has another name has no such role.
    throw new PlatformError(
      `备份里的应用角色是 ${recorded.name}，这个数据根的部署设置是 ${role}：备份里的授权给的是 ${recorded.name}，不恢复`,
      '让部署设置里的数据库角色（database.role）与备份一致，再恢复到空的数据根',
    );
  }
  await assertRestorable(layout);
  // A dump from an older major restores into a newer one; pg_restore must match the server that receives it.
  const tools = await libpqToolsForMajor(options.libpqBin, (await postgres.binaryVersion()).major, 'pg_restore', runner);

  const keptConfig: string[] = [];
  const copies: { path: string; sha256: string }[] = [];
  for (const file of manifest.files) {
    if (file.path === DUMP_FILE) continue;
    const target = join(layout.root, file.path);
    if (file.path.startsWith('config/') && (await exists(target))) {
      if ((await sha256File(target)).sha256 !== file.sha256) keptConfig.push(file.path);
      continue;
    }
    copies.push(file);
  }

  await ensureLayout(layout);
  const { target } = postgres;
  try {
    if (!(await postgres.initialise())) throw new PlatformError(`恢复前数据库目录应为空：${layout.db}`);
    await postgres.start();
    // The database belongs to the superuser role; the application role exists before the dump's GRANTs name it.
    await postgres.ensureDatabase();
    const restored = await runner(
      tools.pg_restore,
      [
        `--dbname=${target.database}`,
        `--host=${target.socketDir}`,
        `--port=${target.port}`,
        // As the superuser role, which owns the Hub database; no --role: nothing may belong to the application role.
        `--username=${target.user}`,
        '--no-password',
        // Restored objects belong to the restoring role, whoever owned them where the dump was taken.
        '--no-owner',
        '--exit-on-error',
        '--single-transaction',
        join(backupDir, DUMP_FILE),
      ],
      { env: toolEnvironment(), timeoutMs: 6 * 60 * 60 * 1000 },
    );
    if (restored.code !== 0) throw new PlatformError(`pg_restore 失败（退出码 ${restored.code}）：${tailLines(restored.stderr)}`);
    for (const file of copies) {
      const source = join(backupDir, file.path);
      const written = await copyFileHashed(source, join(layout.root, file.path), await permissions(source));
      if (written.sha256 !== file.sha256) throw new PlatformError(`复制 ${file.path} 时内容变了`);
    }
    const { tables, privileges, problems } = await withSession(postgres.connector, target.database, async (session) => ({
      tables: await summarizeTables(session),
      privileges: await rolePrivileges(session, role),
      problems: await roleProblems(session, role),
    }));
    const differences = compareSummaries(manifest.database.tables, tables);
    if (differences.length > 0) throw new PlatformError(`恢复后的数据库与备份清单不一致：${differences.slice(0, 5).join('；')}`);
    const changed = comparePrivileges(recorded.privileges, privileges);
    if (changed.length > 0) {
      throw new PlatformError(`恢复后应用角色 ${role} 的权限与备份时不同：${changed.slice(0, 5).join('；')}${changed.length > 5 ? ` 等 ${changed.length} 处` : ''}`);
    }
    if (problems.length > 0) throw new PlatformError(`恢复后应用角色 ${role} 不只是连接并按授权读写：${problems.join('、')}`);
    return {
      backup: backupDir,
      tables: tables.length,
      rows: tables.reduce((sum, table) => sum + table.rows, 0),
      files: copies.length,
      privileges: privileges.length,
      keptConfig,
    };
  } catch (error) {
    let aside: string | undefined;
    try {
      await postgres.stop();
      aside = await setAside(layout, 'failed-restore', now());
    } catch (cleanup) {
      throw new PlatformError(`恢复失败：${messageOf(error)}；清理也失败：${messageOf(cleanup)}`, '手动检查数据根');
    }
    throw new PlatformError(`恢复失败：${messageOf(error)}`, aside ? `半成品已移到 ${aside}，数据根又是空的，可以重试` : undefined);
  }
}
