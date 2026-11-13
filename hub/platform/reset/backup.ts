// Native PostgreSQL backup and verification. No business shape, migration SQL or previous-release reader is loaded.
import { randomUUID } from 'node:crypto';
import { mkdir, chmod, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlatformContext } from '../context.ts';
import type { PostgresControl } from '../postgres.ts';
import { libpqToolsForMajor } from '../backup.ts';
import { sha256File, writeFileExclusive } from '../files.ts';
import { toolEnvironment } from '../process.ts';
import { quoteIdentifier, summarizeTables, compareSummaries, withSession, type SqlSession, type TableSummary } from '../sql.ts';

export interface ResetBackup { directory: string; tables: readonly TableSummary[]; }
async function summaries(session: SqlSession): Promise<TableSummary[]> {
  const known = await summarizeTables(session);
  const all = await session.query("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname<>'information_schema' AND n.nspname NOT LIKE 'pg\\_%' ORDER BY 1,2");
  // summarizeTables omits expiring diagnostics for scheduled backups. A reset's native archive includes every table.
  const skipped = all.filter(row => !known.some(table => table.schema === row.schema && table.table === row.name));
  for (const row of skipped) {
    const table = `${quoteIdentifier(String(row.schema))}.${quoteIdentifier(String(row.name))}`;
    const [summary] = await session.query(`SELECT count(*)::text AS rows,coalesce(encode(sha256(convert_to(string_agg(h,'' ORDER BY h COLLATE "C"),'UTF8')),'hex'),encode(sha256(''::bytea),'hex')) AS digest FROM (SELECT encode(sha256(convert_to(ROW(t.*)::text,'UTF8')),'hex') AS h FROM ${table} t) q`);
    known.push({ schema: String(row.schema), table: String(row.name), rows: Number(summary!.rows), digest: String(summary!.digest) });
  }
  return known.sort((a, b) => a.schema.localeCompare(b.schema) || a.table.localeCompare(b.table));
}

/** Restores the dump into a disposable database and compares snapshot counts/digests before accepting the backup. */
export async function nativeResetBackup(context: PlatformContext, postgres: PostgresControl): Promise<ResetBackup> {
  const id = randomUUID(), partial = join(context.layout.backups, '.reset-' + id), directory = join(context.layout.backups, 'reset-' + id);
  const verifyName = 'circle_hub_reset_verify_' + id.replaceAll('-', '').slice(0, 24);
  const dump = join(partial, 'database.dump');
  await mkdir(partial, { recursive: true, mode: 0o700 });
  let verificationCreated = false;
  const source = await postgres.connector(postgres.target.database);
  try {
    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const [version] = await source.query("SELECT current_setting('server_version_num')::int AS version");
    const major = Math.floor(Number(version!.version) / 10000);
    const tools = await libpqToolsForMajor(context.libpqBin, major, 'pg_dump', context.runner, context.env, context.platform);
    await libpqToolsForMajor(tools.dir, major, 'pg_restore', context.runner, context.env, context.platform);
    const [snapshot] = await source.query('SELECT pg_export_snapshot() AS id');
    const tables = await summaries(source);
    const common = [`--host=${postgres.target.socketDir}`, `--port=${postgres.target.port}`, `--username=${postgres.target.user}`, '--no-password'];
    const dumped = await context.runner(tools.pg_dump, ['--format=custom', `--file=${dump}`, ...common, `--dbname=${postgres.target.database}`, `--snapshot=${String(snapshot!.id)}`], { env: toolEnvironment({ HOME: context.home, USER: context.user }), timeoutMs: 15 * 60_000 });
    if (dumped.code !== 0) throw new Error('原生数据库备份失败；未停止服务，未输出数据库原始错误');
    await chmod(dump, 0o600);
    await withSession(postgres.connector, 'postgres', async session => {
      await session.query(`CREATE DATABASE ${quoteIdentifier(verifyName)} OWNER ${quoteIdentifier(postgres.target.user)} TEMPLATE template0`);
      verificationCreated = true;
    });
    const restored = await context.runner(tools.pg_restore, ['--exit-on-error', '--no-owner', ...common, `--dbname=${verifyName}`, dump], { env: toolEnvironment({ HOME: context.home, USER: context.user }), timeoutMs: 15 * 60_000 });
    if (restored.code !== 0) throw new Error('备份试恢复失败；未停止服务，未输出数据库原始错误');
    const actual = await withSession(postgres.connector, verifyName, summaries);
    if (compareSummaries(tables, actual).length) throw new Error('备份试恢复的表、行数或内容身份不同；未停止服务');
    const fingerprint = await sha256File(dump);
    await writeFileExclusive(join(partial, 'manifest.json'), JSON.stringify({ verified: true, database: postgres.target.database, dump: { size: fingerprint.size, sha256: fingerprint.sha256 }, tables }, null, 2), 0o600);
    await source.query('COMMIT');
    await rename(partial, directory);
    return { directory, tables };
  } catch {
    await source.query('ROLLBACK').catch(() => {});
    throw new Error('重建前备份或试恢复未能核对；原数据库和服务未改，检查备份工具与私有目录后重试');
  } finally {
    await source.close();
    if (verificationCreated) await withSession(postgres.connector, 'postgres', async session => {
      await session.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [verifyName]);
      await session.query(`DROP DATABASE ${quoteIdentifier(verifyName)}`);
    });
    await rm(partial, { recursive: true, force: true });
  }
}
