import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentFor, postgresFor, settingsOf, type PlatformContext } from '../../platform/api.ts';
import { exists, sha256File } from '../../platform/api.ts';
import { portOccupied, waitForHealth } from '../../platform/api.ts';
import { quoteIdentifier, withSession } from '../../platform/api.ts';
import { assertProtectedFiles } from './protected-files.ts';

export class RecoveryConflictError extends Error {
  constructor(conflictPath: string, reason: string) {
    super(`上次重建的原库或原文件恢复冲突（${conflictPath}：${reason}）；服务当前已停止且没有重新启动，请核对后清理或移走冲突目录再重试，全部归档和恢复记录已保留`);
    this.name = 'RecoveryConflictError';
  }
}

async function lstatOptional(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function conflictReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return '目录或文件权限不足';
  if (code === 'ENOTDIR') return '路径中存在非目录条目';
  if (code === 'EISDIR') return '路径中存在同名目录';
  if (code === 'ENOSPC') return '磁盘空间不足';
  return '文件系统操作失败';
}

async function ensureBotRuntimeDir(dirPath: string): Promise<void> {
  const info = await lstatOptional(dirPath);
  if (!info) {
    try {
      await mkdir(dirPath, { recursive: true, mode: 0o700 });
      return;
    } catch (error) {
      throw new RecoveryConflictError(dirPath, conflictReason(error));
    }
  }
  if (!info.isDirectory()) {
    throw new RecoveryConflictError(dirPath, '目标路径已存在且不是目录');
  }
}

async function mergeRuntimeEntry(src: string, dest: string): Promise<void> {
  try {
    const srcInfo = await lstat(src);
    const destInfo = await lstatOptional(dest);
    if (srcInfo.isDirectory()) {
      if (!destInfo) {
        await rename(src, dest);
        return;
      }
      if (!destInfo.isDirectory()) {
        throw new RecoveryConflictError(dest, '目标路径已存在且不是目录');
      }
      for (const name of await readdir(src)) {
        await mergeRuntimeEntry(join(src, name), join(dest, name));
      }
      await rmdir(src);
      return;
    }
    if (srcInfo.isFile()) {
      if (!destInfo) {
        await rename(src, dest);
        return;
      }
      if (!destInfo.isFile()) {
        throw new RecoveryConflictError(dest, '目标路径已存在且不是普通文件');
      }
      const [srcDigest, destDigest] = await Promise.all([sha256File(src), sha256File(dest)]);
      if (srcDigest.sha256 !== destDigest.sha256) {
        throw new RecoveryConflictError(dest, '同名文件内容不一致');
      }
      await unlink(src);
      return;
    }
    throw new RecoveryConflictError(dest, '暂存条目不是普通文件或目录');
  } catch (error) {
    if (error instanceof RecoveryConflictError) throw error;
    throw new RecoveryConflictError(dest, conflictReason(error));
  }
}

const Journal = z.object({
  database: z.string(), archive: z.string().max(63), failed: z.string().max(63), originalOid: z.string().regex(/^[0-9]+$/),
  wasLoaded: z.boolean(), wasRunning: z.boolean(),
  botRuntimeStage: z.string().regex(/^reset-bot-[0-9a-f-]+$/).optional(),
  originals: z.array(z.strictObject({ area: z.enum(['keys','vault']), path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative() })),
});
export async function recoverPendingReset(context: PlatformContext): Promise<void> {
  const path = join(context.layout.run, 'reset-operation.json');
  if (!await exists(path)) return;
  try {
    const saved = Journal.parse(JSON.parse(await readFile(path, 'utf8'))), settings = await settingsOf(context);
    const postgres = postgresFor(context), database = postgres.target.database, agent = agentFor(context, settings);
    if (saved.database !== database || !saved.archive.startsWith(database.slice(0, 20) + '_archive_') || !saved.failed.startsWith(database.slice(0, 20) + '_failed_')) throw new Error();
    await agent.stop();
    if ((await agent.status()).running || await portOccupied(settings.port)) throw new Error();
    await withSession(postgres.connector, 'postgres', async session => {
      const [original] = await session.query('SELECT datname FROM pg_database WHERE oid=$1::oid', [saved.originalOid]);
      if (!original || ![database, saved.archive].includes(String(original.datname))) throw new Error();
      if (original.datname === saved.archive) {
        const [current] = await session.query('SELECT 1 AS present FROM pg_database WHERE datname=$1', [database]);
        if (current) {
          await session.query(`ALTER DATABASE ${quoteIdentifier(database)} ALLOW_CONNECTIONS false`);
          await session.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
          await session.query(`ALTER DATABASE ${quoteIdentifier(database)} RENAME TO ${quoteIdentifier(saved.failed)}`);
        }
        await session.query(`ALTER DATABASE ${quoteIdentifier(saved.archive)} RENAME TO ${quoteIdentifier(database)}`);
      }
      await session.query(`ALTER DATABASE ${quoteIdentifier(database)} ALLOW_CONNECTIONS true`);
    });
    await assertProtectedFiles(context.layout, saved.originals);
    if (saved.botRuntimeStage) {
      const stageDir = join(context.layout.setAside, saved.botRuntimeStage);
      const botRuntimeRoot = join(context.layout.root, 'bot-runtime');
      for (const dir of ['files', 'channel-staging'] as const) {
        const staged = join(stageDir, dir);
        if (!await lstatOptional(staged)) continue;
        await ensureBotRuntimeDir(botRuntimeRoot);
        await mergeRuntimeEntry(staged, join(botRuntimeRoot, dir));
      }
      await rm(stageDir, { recursive: true, force: true });
    }
    if (saved.wasLoaded || saved.wasRunning) { await agent.start(); if (saved.wasRunning) await waitForHealth(settings.port, { host: settings.listenHost, authority: settings.allowedHosts?.[0], timeoutMs: context.healthTimeoutMs }); }
    await rm(path);
  } catch (error) {
    if (error instanceof RecoveryConflictError) throw error;
    throw new Error('上次重建的原库或原文件恢复尚未核对；未开始新重建，保留全部归档和恢复记录');
  }
}
