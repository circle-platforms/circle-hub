// Dedicated previous-release upgrader. Imported lazily by the upgrade command, never by serve.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { rename, mkdir, readFile, rm } from 'node:fs/promises';
import { DEFAULT_LIMITS } from '../../config/index.ts';
import { migrateRecords, openRecords } from '../../records/api.ts';
import { createBackup, verifyBackup } from '../backup.ts';
import { agentFor, platformLockPath, postgresFor, settingsOf, type PlatformContext } from '../context.ts';
import { guardSignals } from '../deploy.ts';
import { withLock, writeFileAtomic, exists } from '../files.ts';
import { waitForHealth, portOccupied } from '../health.ts';
import { quoteIdentifier, withSession, type SqlSession } from '../sql.ts';
import { runUpgrade, type UpgradeHost, type UpgradeReport } from './operation.ts';
import { schemaGeneration, type MigrationIdentity } from './signatures.ts';
import { fileMetadataSource, exportSecretMetadata, type UpgradeSecretFile } from './metadata.ts';
import { readState, transferState, StateTransferFailure, type TransferPlan } from './transfer.ts';
import type { UpgradeIssue } from './state.ts';

export interface UpgradeMetadataWriter {
  /** Authenticates metadata only. It must not decrypt sealed credential values or modify their original files. */
  write(file: UpgradeSecretFile): Promise<void>;
  verify(files: readonly UpgradeSecretFile[]): Promise<void>;
}
export interface UpgradeOptions {
  metadata?: UpgradeMetadataWriter;
  /** Reuses dispatch's existing physical-target decision over its journal; absence refuses journal-bearing databases. */
  remoteSafe?: (source: SqlSession) => Promise<UpgradeIssue[]>;
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
    const postgres = postgresFor(context), agent = agentFor(context, settings);
    const database = postgres.target.database;
    const suffix = context.now().toISOString().replaceAll(/[^0-9]/g, '') + '_' + randomBytes(3).toString('hex');
    const archive = database.slice(0, 24) + '_archive_' + suffix;
    const failed = database.slice(0, 24) + '_failed_' + suffix;
    const journalPath = join(context.layout.run, 'upgrade-operation.json');
    const reportPath = join(context.layout.logs, 'upgrade-' + suffix + '.json');
    let backup: string | null = null, archived = false, created = false, wasRunning = false, wasLoaded = false;
    let source: SqlSession | undefined, destination: SqlSession | undefined, plan: TransferPlan | undefined;
    let metadata: UpgradeSecretFile[] = [];
    const installedMetadata: string[] = [];
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
      for (const connection of connections) if (connection) await connection.close();
    };
    const save = async () => writeFileAtomic(journalPath, JSON.stringify({ database, archive, failed, backup, wasRunning, wasLoaded, archived, created, installedMetadata }));
    const writeReport = async () => writeFileAtomic(reportPath, JSON.stringify({ archive: archived ? archive : null, backup, tables: plan?.tables ?? [], recordDecisions: plan?.selection.decisions ?? [], archivedRecords: Object.fromEntries(plan?.selection.archived ?? []), issues }, null, 2));
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
        } else if (names.has(database)) await session.query(`ALTER DATABASE ${quoteIdentifier(database)} ALLOW_CONNECTIONS true`);
        else throw new Error('旧数据库原件未找到，保留全部归档');
      });
      if (installedMetadata.length) {
        const aside = join(context.layout.setAside, 'upgrade-metadata-' + suffix);
        await mkdir(aside, { recursive: true, mode: 0o700 });
        for (const name of installedMetadata) if (await exists(join(context.layout.vault, 'metadata', name))) await rename(join(context.layout.vault, 'metadata', name), join(aside, name));
      }
      if (wasLoaded || wasRunning) {
        await agent.start();
        if (wasRunning) await waitForHealth(settings.port, { host: settings.listenHost, authority: settings.allowedHosts?.[0], timeoutMs: context.healthTimeoutMs });
      }
      await rm(journalPath);
    };
    const host: UpgradeHost = {
      async current() {
        checkSignal();
        if (await exists(journalPath)) throw new Error('存在未结束的升级记录，不能另起一次升级');
        const rows = await withSession(postgres.connector, database, session => session.query('SELECT version,name,sha256 FROM schema_migrations ORDER BY version'));
        return schemaGeneration(rows as unknown as MigrationIdentity[]) === 'current';
      },
      async backup() {
        checkSignal();
        const status = await agent.status(); wasRunning = status.running; wasLoaded = status.loaded;
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
        plan = await readState(source);
        if (options.remoteSafe) issues.push(...await options.remoteSafe(source));
        else {
          const [row] = await source.query("SELECT count(*)::text AS n FROM record_index WHERE key='dispatch.job'");
          if (Number(row!.n)) issues.push({ table: 'records', row: 0, reason: '缺少远端作业安全状态核对接口，不能把本地停止当远端停止' });
        }
        const exported = await exportSecretMetadata(plan.selection.secretDecisions, fileMetadataSource(context.layout.objects, context.layout.vault));
        metadata = exported.files; issues.push(...plan.issues, ...exported.issues);
        if (metadata.length && !options.metadata) issues.push({ table: 'vault_metadata', row: 0, reason: 'C12认证元数据写入接口尚未接入，未伪造成功' });
        if (issues.length) throw new StateTransferFailure(issues);
        destination = await postgres.connector(database);
        try { await transferState(source, destination, plan); }
        catch (error) { if (error instanceof StateTransferFailure) issues.push(...error.issues); throw error; }
        for (const file of metadata) {
          const name = 'secret.' + file.name.toLowerCase() + '.sealed';
          if (await exists(join(context.layout.vault, 'metadata', name))) throw new Error('元数据已存在，不能覆写原文件');
          installedMetadata.push(name); await save();
          await options.metadata!.write(file);
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
          const [missing] = await session.query('SELECT count(*)::text AS n FROM leases l LEFT JOIN users u ON u.id=l.user_id WHERE u.id IS NULL');
          if (Number(missing!.n)) throw new Error('预订的持有人未迁入');
          const [history] = await session.query('SELECT count(*)::text AS n FROM records WHERE kind=ANY($1::text[])', [['run','submission','validation_result','request','call_log','effect','result_summary']]);
          if (Number(history!.n)) throw new Error('运行历史不应转入');
        });
        const kit = await openRecords({ dataDir: context.layout.root, logDir: context.layout.logs, database: { host: postgres.application.socketDir, port: postgres.application.port, database, user: postgres.application.user }, limits: { ...DEFAULT_LIMITS } }, { migrate: false, keyProvider: { getKey: async () => { throw new Error('升级自检不得读取业务值'); } } });
        try {
          for (const digest of plan.selection.selected) if (!await kit.store.get(digest)) throw new Error('保留记录不能按当前读取器完整读取');
        } finally { await kit.close(); }
        if (metadata.length) await options.metadata!.verify(metadata);
        await writeReport();
      },
      async restart() {
        checkSignal();
        if (wasLoaded || wasRunning) {
          await agent.start();
          if (wasRunning) await waitForHealth(settings.port, { host: settings.listenHost, authority: settings.allowedHosts?.[0], timeoutMs: context.healthTimeoutMs });
        }
        await maintenance(session => session.query(`ALTER DATABASE ${quoteIdentifier(archive)} ALLOW_CONNECTIONS false`).then(() => {}));
        await rm(journalPath);
      },
      rollback,
    };
    try {
      const result = await runUpgrade(host);
      return { ...result, archive: result.status === 'upgraded' ? archive : null, backup, tables: plan?.tables ?? [], issues };
    } catch (error) {
      if (error instanceof StateTransferFailure) issues.push(...error.issues);
      await writeReport();
      throw error;
    } finally { await closeTransfers(); guard.release(); }
  });
}
