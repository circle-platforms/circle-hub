// Dedicated previous-release upgrader. Imported lazily by the upgrade command, never by serve.
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { join } from 'node:path';
import { rename, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import { DEFAULT_LIMITS } from '../../config/index.ts';
import { migrateRecords, openRecords } from '../../records/api.ts';
import { createBackup, verifyBackup } from '../backup.ts';
import { agentFor, platformLockPath, postgresFor, settingsOf, type PlatformContext } from '../context.ts';
import { guardSignals } from '../deploy.ts';
import { withLock, writeFileAtomic, exists, sha256File } from '../files.ts';
import { readCurrentRelease, readReleaseFile, releaseDir, switchCurrent } from '../release.ts';
import { waitForHealth, portOccupied } from '../health.ts';
import { quoteIdentifier, withSession, type SqlSession } from '../sql.ts';
import { runUpgrade, UpgradeFailure, type UpgradeHost, type UpgradeReport } from './operation.ts';
import { schemaGeneration, type MigrationIdentity } from './signatures.ts';
import { fileMetadataSource, exportSecretMetadata, type UpgradeSecretFile } from './metadata.ts';
import { readState, transferState, StateTransferFailure, type TransferPlan } from './transfer.ts';
import type { UpgradeIssue } from './state.ts';
import { remoteUpgradeIssues } from './remote.ts';
import { producerMetadataWriter } from './producer.ts';

const RecoveryJournal = z.strictObject({
  database: z.string(), archive: z.string(), failed: z.string(), backup: z.string().nullable(),
  wasRunning: z.boolean(), wasLoaded: z.boolean(), archived: z.boolean(), created: z.boolean(),
  installedMetadata: z.array(z.string().regex(/^secret\.[a-z][a-z0-9_]{0,63}\.sealed$/)),
  metadataDirectoryExisted: z.boolean(), previousRelease: z.string().optional(), nextRelease: z.string().optional(),
});

export interface UpgradeMetadataWriter {
  /** Authenticates metadata only. It must not decrypt sealed credential values or modify their original files. */
  write(file: UpgradeSecretFile): Promise<void>;
  verify(files: readonly UpgradeSecretFile[]): Promise<void>;
}
export interface UpgradeOptions {
  metadata?: UpgradeMetadataWriter;
  /** Reuses dispatch's existing physical-target decision over its journal; absence refuses journal-bearing databases. */
  remoteSafe?: (source: SqlSession) => Promise<UpgradeIssue[]>;
  /** Synthetic fault injection; the CLI never supplies a transform. */
  hostTransform?: (host: UpgradeHost) => UpgradeHost;
}
export interface DatabaseUpgradeReport extends UpgradeReport {
  archive: string | null;
  backup: string | null;
  tables: TransferPlan['tables'];
  issues: readonly UpgradeIssue[];
}

export async function upgradeDatabase(context: PlatformContext, options: UpgradeOptions = {}): Promise<DatabaseUpgradeReport> {
  return withLock(platformLockPath(context), async () => {
    const settings = await settingsOf(context);
    const metadataWriter = options.metadata ?? producerMetadataWriter(context);
    const postgres = postgresFor(context), agent = agentFor(context, settings);
    const database = postgres.target.database;
    const suffix = context.now().toISOString().replaceAll(/[^0-9]/g, '') + '_' + randomBytes(3).toString('hex');
    let archive = database.slice(0, 24) + '_archive_' + suffix;
    let failed = database.slice(0, 24) + '_failed_' + suffix;
    const journalPath = join(context.layout.run, 'upgrade-operation.json');
    const reportPath = join(context.layout.logs, 'upgrade-' + suffix + '.json');
    let backup: string | null = null, archived = false, created = false, wasRunning = false, wasLoaded = false;
    let previousRelease: string | undefined, nextRelease: string | undefined;
    let source: SqlSession | undefined, destination: SqlSession | undefined, plan: TransferPlan | undefined;
    let metadata: UpgradeSecretFile[] = [];
    const installedMetadata: string[] = [];
    let metadataDirectoryExisted = await exists(join(context.layout.vault, 'metadata'));
    const issues: UpgradeIssue[] = [];
    const guard = guardSignals(context.log);
    const checkSignal = () => { if (guard.received()) throw new Error('升级已取消，恢复原状态'); };
    const maintenance = <T>(fn: (session: SqlSession) => Promise<T>) => withSession(postgres.connector, 'postgres', fn);
    const disconnect = async (session: SqlSession, name: string) => {
      await session.query(`ALTER DATABASE ${quoteIdentifier(name)} ALLOW_CONNECTIONS false`);
      await session.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    };
    const closeTransfers = async () => {
      const connections = [source, destination]; source = undefined; destination = undefined;
      const results = await Promise.allSettled(connections.filter(connection => connection !== undefined).map(connection => connection.close()));
      if (results.some(result => result.status === 'rejected')) issues.push({ table: 'connections', row: 0, reason: '连接正常关闭未确认，将由数据库维护连接强制断开' });
    };
    const save = async () => writeFileAtomic(journalPath, JSON.stringify({ database, archive, failed, backup, wasRunning, wasLoaded, archived, created, installedMetadata, metadataDirectoryExisted, previousRelease, nextRelease }));
    const writeReport = async (completed = false, restored = false) => writeFileAtomic(reportPath, JSON.stringify({ completed, restored, database, failedDatabase: created ? failed : null, archive: archived ? archive : null, backup, tables: plan?.tables ?? [], recordDecisions: plan?.selection.decisions ?? [], archivedRecords: Object.fromEntries(plan?.selection.archived ?? []), issues }, null, 2));
    const rollback = async () => {
      await closeTransfers();
      await agent.stop();
      if ((await agent.status()).running || await portOccupied(settings.port)) throw new Error('服务仍运行，不能自动恢复数据库');
      await maintenance(async session => {
        const names = new Set((await session.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [[database, archive, failed]])).map(row => String(row.datname)));
        if (names.has(archive)) {
          if (names.has(database)) {
            await disconnect(session, database);
            await session.query(`ALTER DATABASE ${quoteIdentifier(database)} RENAME TO ${quoteIdentifier(failed)}`);
          }
          await disconnect(session, archive);
          await session.query(`ALTER DATABASE ${quoteIdentifier(archive)} RENAME TO ${quoteIdentifier(database)}`);
          await session.query(`ALTER DATABASE ${quoteIdentifier(database)} ALLOW_CONNECTIONS true`);
          await session.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(postgres.application.user)}`);
          archived = false;
        } else if (names.has(database)) await session.query(`ALTER DATABASE ${quoteIdentifier(database)} ALLOW_CONNECTIONS true`);
        else throw new Error('旧数据库原件未找到，保留全部归档');
      });
      if (installedMetadata.length) {
        const aside = join(context.layout.setAside, 'upgrade-metadata-' + suffix);
        await mkdir(aside, { recursive: true, mode: 0o700 });
        if (!metadataDirectoryExisted && await exists(join(context.layout.vault, 'metadata'))) {
          await rename(join(context.layout.vault, 'metadata'), join(aside, 'metadata'));
        } else for (const name of installedMetadata) if (await exists(join(context.layout.vault, 'metadata', name))) await rename(join(context.layout.vault, 'metadata', name), join(aside, name));
      }
      if (previousRelease !== undefined) await switchCurrent(context.layout, previousRelease);
      if (wasLoaded || wasRunning) {
        await agent.start();
        if (wasRunning) await waitForHealth(settings.port, { host: settings.listenHost, authority: settings.allowedHosts?.[0], timeoutMs: context.healthTimeoutMs });
      }
      await rm(journalPath, { force: true });
    };
    const host: UpgradeHost = {
      async current() {
        checkSignal();
        const rows = await withSession(postgres.connector, database, session => session.query('SELECT version,name,sha256 FROM schema_migrations ORDER BY version'));
        return schemaGeneration(rows as unknown as MigrationIdentity[]) === 'current';
      },
      async backup() {
        checkSignal();
        const status = await agent.status(); wasRunning = status.running; wasLoaded = status.loaded;
        previousRelease = (await readCurrentRelease(context.layout))?.id;
        const candidate = await readReleaseFile(context.codeRoot);
        if (candidate && await realpath(releaseDir(context.layout, candidate.id)) === await realpath(context.codeRoot)) nextRelease = candidate.id;
        if ((wasLoaded || wasRunning) && (!nextRelease || !previousRelease)) throw new Error('已加载服务的升级必须从已准备好的新发布执行，且旧发布可恢复');
        const result = await createBackup({ layout: context.layout, postgres, libpqBin: context.libpqBin, runner: context.runner, now: context.now, label: 'pre-upgrade' });
        await verifyBackup(result.dir);
        if (result.skipped.length) throw new Error('升级备份有未复制的原件，不能继续');
        backup = result.dir;
      },
      async stop() {
        checkSignal(); await save(); await agent.stop();
        if ((await agent.status()).running || await portOccupied(settings.port)) throw new Error('原服务没有停止');
      },
      async archive() {
        checkSignal();
        await maintenance(async session => {
          await disconnect(session, database);
          await session.query(`ALTER DATABASE ${quoteIdentifier(database)} RENAME TO ${quoteIdentifier(archive)}`);
          archived = true; await save();
          await session.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(archive)} FROM PUBLIC, ${quoteIdentifier(postgres.application.user)}`);
          await session.query(`ALTER DATABASE ${quoteIdentifier(archive)} ALLOW_CONNECTIONS true`);
        });
      },
      async create() { checkSignal(); await postgres.ensureDatabase(); created = true; await save(); },
      async migrate() {
        checkSignal();
        await migrateRecords({ database: { host: postgres.target.socketDir, port: postgres.target.port, database, user: postgres.target.user } }, { runtimeRole: postgres.application.user });
      },
      async transfer() {
        checkSignal();
        source = await postgres.connector(archive);
        await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const rows = await source.query('SELECT version,name,sha256 FROM schema_migrations ORDER BY version');
        if (schemaGeneration(rows as unknown as MigrationIdentity[]) !== 'previous') throw new Error('冻结旧库身份变化');
        const files = fileMetadataSource(context.layout.objects, context.layout.vault);
        const readObject = async (hash: string): Promise<Uint8Array | null> => {
          try { return await files.definition(hash); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const [row] = await source!.query(`SELECT p.data FROM personal_objects o JOIN personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256)
              WHERE o.sha256=$1 AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE (x.owner,x.epoch)=(o.owner,o.epoch)) ORDER BY o.owner,o.epoch LIMIT 1`, [hash]);
            return row ? row.data as Uint8Array : null;
          }
        };
        plan = await readState(source, readObject);
        issues.push(...await (options.remoteSafe ?? remoteUpgradeIssues)(source));
        const exported = await exportSecretMetadata(plan.selection.secretDecisions, fileMetadataSource(context.layout.objects, context.layout.vault));
        metadata = exported.files; issues.push(...plan.issues, ...exported.issues);
        if (issues.length) throw new StateTransferFailure(issues);
        destination = await postgres.connector(database);
        try { await transferState(source, destination, plan); }
        catch (error) { if (error instanceof StateTransferFailure) issues.push(...error.issues); throw error; }
        for (const file of metadata) {
          const name = 'secret.' + file.name.toLowerCase() + '.sealed';
          if (await exists(join(context.layout.vault, 'metadata', name))) throw new Error('元数据已存在，不能覆写原文件');
          installedMetadata.push(name); await save();
          await metadataWriter.write(file);
        }
        await closeTransfers();
      },
      async preflight() {
        checkSignal();
        if (!plan || issues.length) throw new Error('没有完整迁移结果');
        await withSession(postgres.connector, database, async session => {
          for (const count of plan!.tables) {
            if (count.migrated === 0) continue;
            const [got] = await session.query(`SELECT count(*)::text AS n FROM ${quoteIdentifier(count.table)}`);
            if (Number(got!.n) !== count.migrated) throw new Error('目标表计数不符');
          }
          for (const [index, hash] of [...plan!.selection.objects].entries()) {
            const [registered] = await session.query('SELECT size::text FROM objects WHERE sha256=$1', [hash]);
            if (!registered) throw new StateTransferFailure([{ table: 'objects', row: index + 1, reason: '保留状态的原件登记缺失' }]);
            const path = join(context.layout.objects, hash.slice(0, 2), hash);
            if (await exists(path)) {
              const actual = await sha256File(path);
              if (actual.sha256 !== hash || actual.size !== Number(registered.size)) throw new StateTransferFailure([{ table: 'objects', row: index + 1, reason: '保留状态的原件字节摘要或长度不符' }]);
            } else {
              const [actual] = await session.query(`SELECT octet_length(data)::text AS size,encode(sha256(data),'hex') AS fingerprint FROM (
                SELECT data FROM held_objects WHERE sha256=$1 UNION ALL SELECT data FROM run_originals WHERE sha256=$1
                UNION ALL SELECT p.data FROM personal_objects o JOIN personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256)
                  WHERE o.sha256=$1 AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE (x.owner,x.epoch)=(o.owner,o.epoch))) q LIMIT 1`, [hash]);
              if (!actual || actual.fingerprint !== hash || Number(actual.size) !== Number(registered.size)) throw new StateTransferFailure([{ table: 'objects', row: index + 1, reason: '保留状态的独立或个人原件缺失，未把缺文件当备份成功' }]);
            }
          }
          const [missing] = await session.query('SELECT count(*)::text AS n FROM leases l LEFT JOIN users u ON u.id=l.user_id WHERE u.id IS NULL');
          if (Number(missing!.n)) throw new Error('预订的持有人未迁入');
          const [history] = await session.query('SELECT count(*)::text AS n FROM records WHERE kind=ANY($1::text[])', [['run','submission','validation_result','request','call_log','effect','result_summary']]);
          if (Number(history!.n)) throw new Error('运行历史不应转入');
        });
        const kit = await openRecords({ dataDir: context.layout.root, logDir: context.layout.logs, database: { host: postgres.application.socketDir, port: postgres.application.port, database, user: postgres.application.user }, limits: { ...DEFAULT_LIMITS } }, { migrate: false, keyProvider: { getKey: async () => { throw new Error('升级自检不得读取业务值'); } } });
        try {
          for (const digest of plan.selection.selected) if (!await kit.store.get(digest)) throw new Error('保留记录不能按当前读取器完整读取');
        } finally { await kit.close(); }
        if (metadata.length) await metadataWriter.verify(metadata);
        await writeReport();
      },
      async restart() {
        checkSignal();
        if (nextRelease !== undefined) await switchCurrent(context.layout, nextRelease);
        if (wasLoaded || wasRunning) {
          await agent.start();
          if (wasRunning) await waitForHealth(settings.port, { host: settings.listenHost, authority: settings.allowedHosts?.[0], timeoutMs: context.healthTimeoutMs });
        }
        await maintenance(session => session.query(`ALTER DATABASE ${quoteIdentifier(archive)} ALLOW_CONNECTIONS false`).then(() => {}));
        await writeReport(true);
        await rm(journalPath, { force: true });
      },
      rollback,
    };
    try {
      if (await exists(journalPath)) {
        try {
          const saved = RecoveryJournal.parse(JSON.parse(await readFile(journalPath, 'utf8')));
          const prefix = database.slice(0, 24);
          if (saved.database !== database || !saved.archive.startsWith(prefix + '_archive_') || !saved.failed.startsWith(prefix + '_failed_') || saved.archive.length > 63 || saved.failed.length > 63) throw new Error();
          archive = saved.archive; failed = saved.failed; backup = saved.backup;
          wasRunning = saved.wasRunning; wasLoaded = saved.wasLoaded; archived = saved.archived; created = saved.created;
          previousRelease = saved.previousRelease; nextRelease = saved.nextRelease;
          metadataDirectoryExisted = saved.metadataDirectoryExisted; installedMetadata.push(...saved.installedMetadata);
          await rollback();
          archive = database.slice(0, 24) + '_archive_' + suffix;
          failed = database.slice(0, 24) + '_failed_' + suffix;
          backup = null; archived = false; created = false; installedMetadata.length = 0;
          context.log('已恢复上次中断的升级，继续从原数据库开始');
        } catch { throw new UpgradeFailure('current', 'failed'); }
      }
      const checkedHost: UpgradeHost = { ...host, async preflight() {
        try { await host.preflight(); }
        catch (error) { if (error instanceof StateTransferFailure) issues.push(...error.issues); throw error; }
      } };
      const result = await runUpgrade(options.hostTransform?.(checkedHost) ?? checkedHost);
      return { ...result, archive: result.status === 'upgraded' ? archive : null, backup, tables: plan?.tables ?? [], issues };
    } catch (error) {
      if (error instanceof StateTransferFailure) issues.push(...error.issues);
      try { await writeReport(false, error instanceof UpgradeFailure && error.rollback === 'succeeded'); }
      catch { try { context.log('升级报告未能写入；原数据库恢复结果以命令错误为准，未输出原始异常'); } catch {} }
      throw error;
    } finally { try { await closeTransfers(); } finally { guard.release(); } }
  });
}
