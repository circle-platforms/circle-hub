import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentFor, postgresFor, settingsOf, type PlatformContext } from '../../platform/api.ts';
import { exists } from '../../platform/api.ts';
import { portOccupied, waitForHealth } from '../../platform/api.ts';
import { quoteIdentifier, withSession } from '../../platform/api.ts';
import { assertProtectedFiles } from './protected-files.ts';

const Journal = z.object({
  database: z.string(), archive: z.string().max(63), failed: z.string().max(63), originalOid: z.string().regex(/^[0-9]+$/),
  wasLoaded: z.boolean(), wasRunning: z.boolean(),
  originals: z.array(z.strictObject({ area: z.enum(['keys','vault']), path: z.string(), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
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
    if (saved.wasLoaded || saved.wasRunning) { await agent.start(); if (saved.wasRunning) await waitForHealth(settings.port, { host: settings.listenHost, authority: settings.allowedHosts?.[0], timeoutMs: context.healthTimeoutMs }); }
    await rm(path);
  } catch { throw new Error('上次重建的原库或原文件恢复尚未核对；未开始新重建，保留全部归档和恢复记录'); }
}
