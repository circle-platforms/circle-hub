import { archiveResetDatabase, createResetDatabase } from '../../platform/api.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { migrateRecords, FileVault } from '../../records/api.ts';
import { VariableName } from '../../../contracts/src/variables.ts';
import { agentFor, platformLockPath, postgresFor, settingsOf, type PlatformContext } from '../../platform/api.ts';
import { exists, sha256File, withLock, writeFileAtomic } from '../../platform/api.ts';
import { guardSignals } from '../../platform/api.ts';
import { portOccupied, waitForHealth } from '../../platform/api.ts';
import { quoteIdentifier, withSession, type SqlSession } from '../../platform/api.ts';
import { recoverPendingReset } from './recovery.ts';
import { nativeResetBackup, type ResetBackup } from '../../platform/api.ts';
import { protectedFiles, assertProtectedFiles, type ProtectedFile } from './protected-files.ts';
import { inspectCurrentState, clearOfflineSelection, assertCurrentForeignKeys, type CurrentResetState } from './current.ts';
import { classifyCurrentRecord, currentRecordReferences, resolveCurrentRecordScopes, type CurrentRecord } from './selection.ts';
import { inspectReset, resetRequestProblems } from './inspection.ts';
import { runReset, ResetFailure, type ResetHost } from './operation.ts';
import { parseResetRequest, resetScopes, RESET_DATA_SCOPE, type ResetPlan, type ResetPorts, type ResetProblem, type ResetRequest, type ResetReport, type ResetCount, type ResetDataScope } from './types.ts';

export class ResetBlocked extends Error {
  readonly problems: readonly ResetProblem[];
  constructor(problems: readonly ResetProblem[]) { super('重建条件尚未满足，未开始破坏性操作'); this.name = 'ResetBlocked'; this.problems = problems; }
}
export interface ResetExecutionOptions extends ResetPorts { hostTransform?: (host: ResetHost) => ResetHost; }

export interface ResetRecordTally {
  countsUnit: 'records';
  counts: readonly ResetCount[];
  unclassifiedRetainedRecords: number;
}
export type CountedResetPlan = ResetPlan & { countsUnit: 'records'; unclassifiedRetainedRecords: number | null };
export type CountedResetReport = ResetReport & ResetRecordTally;
export function resetRecordTally(records: readonly CurrentRecord[], cleared: ReadonlySet<string> = new Set()): ResetRecordTally {
  const aliases = new Map<string, string>();
  const objectScopes = new Map<string, ResetDataScope[]>();
  for (const record of records) {
    for (const index of record.indices ?? []) if (['knowledge.node','knowledge.entry','knowledge.root','pack.digest'].includes(index.key)) aliases.set(index.value, record.digest);
    const scope = classifyCurrentRecord(record);
    if (scope) for (const edge of currentRecordReferences(record)) if (edge.kind === 'object') {
      objectScopes.set(edge.digest, [...new Set([...objectScopes.get(edge.digest) ?? [], scope])]);
    }
  }
  const owners = resolveCurrentRecordScopes(records, { recordAliases: aliases, objectScopes });
  const counts = RESET_DATA_SCOPE.map(scope => ({ scope, retained: 0, cleared: 0 }));
  let unclassifiedRetainedRecords = 0;
  for (const record of records) {
    const scopes = owners.get(record.digest);
    if (!scopes?.length) { if (!cleared.has(record.digest)) unclassifiedRetainedRecords++; continue; }
    for (const scope of scopes) {
      const count = counts.find(count => count.scope === scope)!;
      if (cleared.has(record.digest)) count.cleared++; else count.retained++;
    }
  }
  return { countsUnit: 'records', counts, unclassifiedRetainedRecords };
}

async function objectReader(context: PlatformContext, session: SqlSession, hash: string): Promise<Uint8Array | null> {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('对象引用身份无效');
  try {
    const path = join(context.layout.objects, hash.slice(0, 2), hash), bytes = await readFile(path);
    if ((await sha256File(path)).sha256 !== hash) throw new Error('对象身份不同');
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const [row] = await session.query(`SELECT data FROM held_objects WHERE sha256=$1 UNION ALL
      SELECT data FROM run_originals WHERE sha256=$1 UNION ALL
      SELECT p.data FROM personal_objects o JOIN personal_payloads p ON (p.owner,p.epoch,p.sha256)=(o.owner,o.epoch,o.sha256)
      WHERE o.sha256=$1 AND NOT EXISTS(SELECT 1 FROM personal_purges x WHERE (x.owner,x.epoch)=(o.owner,o.epoch)) LIMIT 1`, [hash]);
    return row ? row.data as Uint8Array : null;
  }
}
async function currentState(context: PlatformContext, request: ResetRequest): Promise<CurrentResetState> {
  const control = postgresFor(context);
  return withSession(control.connector, control.target.database, async session => {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try { return await inspectCurrentState(session, request, hash => objectReader(context, session, hash)); }
    finally { await session.query('ROLLBACK'); }
  });
}
function definitionHelpPath(context: PlatformContext, request: ResetRequest): string | undefined {
  if (!request.definitionFile) return undefined;
  if (!/^src:[0-9a-f]{64}$/.test(request.definitionFile)) return request.definitionFile;
  const hash = request.definitionFile.slice(4);
  return join(context.layout.objects, hash.slice(0, 2), hash);
}
export async function previewReset(context: PlatformContext, input: ResetRequest, ports: ResetPorts = {}): Promise<CountedResetPlan> {
  const request = parseResetRequest(input), inspection = await inspectReset(context);
  const blocked = resetRequestProblems(inspection, request, ports, definitionHelpPath(context, request));
  const counts = RESET_DATA_SCOPE.map(scope => ({ scope, retained: 0, cleared: null as number | null }));
  if (request.scopes === 'all' || blocked.length) return { request, inspection, counts, blocked, countsUnit: 'records', unclassifiedRetainedRecords: null };
  const state = await currentState(context, request);
  return { request, inspection, ...resetRecordTally(state.records, new Set(state.selection.cleared)), blocked: state.blocked.map(problem => ({ ...problem, name: problem.name && /^[0-9a-f]{64}$/.test(problem.name) ? undefined : problem.name })) };
}

async function vaultNotices(context: PlatformContext): Promise<ResetProblem[]> {
  const notices: ResetProblem[] = [], entries = await new FileVault(context.layout.vault).list();
  const names = new Set<string>();
  for (const entry of entries) {
    const match = /^secret\.([a-z][a-z0-9_]{0,63})\.[a-f0-9]{24}$/.exec(entry);
    if (!match) continue;
    const name = VariableName.parse(match[1]!.toUpperCase()); if (names.has(name)) continue; names.add(name);
    if (!await exists(join(context.layout.vault, 'metadata', 'secret.' + match[1] + '.sealed'))) notices.push({ name,
      reason: '原封存存在但缺少认证元数据，重建没有读取、移动或修改该值',
      nextAction: `运行 circle-hub secret set --name ${name}；程序按当前规则归档未认证原件并留审计，勿手工删除封存` });
  }
  return notices;
}

export async function resetData(context: PlatformContext, input: ResetRequest, ports: ResetExecutionOptions = {}): Promise<CountedResetReport> {
  const request = parseResetRequest(input);
  const immediate = resetRequestProblems(undefined, request, ports, definitionHelpPath(context, request));
  if (immediate.length) throw new ResetBlocked(immediate);
  return withLock(platformLockPath(context), async () => {
    const settings = await settingsOf(context), postgres = postgresFor(context), agent = agentFor(context, settings);
    const id = randomUUID(), database = postgres.target.database;
    const archive = database.slice(0, 20) + '_archive_' + id.replaceAll('-', '');
    const failed = database.slice(0, 20) + '_failed_' + id.replaceAll('-', '');
    const journal = join(context.layout.run, 'reset-operation.json');
    const resultPath = join(context.layout.logs, 'reset-' + id + '.json');
    const snapshot = request.keepConfig ? join(context.layout.root, 'private-config-snapshots', id + '.json') : undefined;
    const cleansBotRuntime = resetScopes(request).has('config') && !request.keepConfig;
    const botRuntimeStage = cleansBotRuntime ? join(context.layout.setAside, 'reset-bot-' + id) : undefined;
    const botRuntimeDirs = ['files', 'channel-staging'] as const;
    const moveIfPresent = async (from: string, to: string) => {
      try {
        await mkdir(dirname(to), { recursive: true, mode: 0o700 });
        await rename(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    };
    let observedTally: ResetRecordTally | undefined;
    let state: CurrentResetState | undefined, plan: ResetPlan | undefined;
    let backup: ResetBackup | undefined, wasRunning = false, wasLoaded = false, archived = false, created = false;
    let originalOid = '';
    let originals: ProtectedFile[] = [], notices: ResetProblem[] = [], definitionPath: string | undefined;
    let definitionProblem: ResetBlocked | undefined;
    const guard = guardSignals(context.log);
    const checkpoint = () => { if (guard.received()) throw new Error('收到停止请求，自动恢复原状态'); };
    const maintenance = <T>(fn: (session: SqlSession) => Promise<T>) => withSession(postgres.connector, 'postgres', fn);
    const disconnect = async (session: SqlSession, name: string) => {
      await session.query(`ALTER DATABASE ${quoteIdentifier(name)} ALLOW_CONNECTIONS false`);
      await session.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    };
    const save = async () => writeFileAtomic(journal, JSON.stringify({ database, archive, failed, wasLoaded, wasRunning, archived, created, backup: backup?.directory, request, originalOid, originals }), 0o600);
    const buildReport = (): CountedResetReport => {
      if (!observedTally) throw new Error('恢复后的记录数量尚未观测，不能生成完成报告');
      const before = state ? resetRecordTally(state.records, new Set(state.selection.cleared)) : undefined;
      const counts = observedTally.counts.map(count => ({ ...count, cleared: before?.counts.find(row => row.scope === count.scope)?.cleared ?? null }));
      return { archive, backup: backup!.directory, ...(snapshot ? { configurationSnapshot: snapshot } : {}), botRuntime: cleansBotRuntime ? 'cleaned' : 'retained', ...observedTally, counts, notices,
        archivedTables: backup!.tables.map(({ schema, table, rows }) => ({ schema, table, rows })) };
    };
    const host: ResetHost = {
      async inspect() {
        checkpoint();
        await recoverPendingReset(context);
        plan = await previewReset(context, request, ports);
        if (plan.blocked.length) throw new ResetBlocked(plan.blocked);
        if (request.definitionFile) {
          definitionPath = definitionHelpPath(context, request);
          try {
            if (/^src:[0-9a-f]{64}$/.test(request.definitionFile)) {
              if ((await sha256File(definitionPath!)).sha256 !== request.definitionFile.slice(4)) throw new Error();
            } else await readFile(definitionPath!);
          } catch {
            definitionProblem = new ResetBlocked([{ reason: '定义文件无法读取或上传对象身份不符', nextAction: '核对定义文件 ' + request.definitionFile + ' 后重试；未读取或输出文件内容' }]);
            throw definitionProblem;
          }
        }
        const [identity] = await maintenance(session => session.query('SELECT oid::text FROM pg_database WHERE datname=$1', [database]));
        if (!identity) throw new Error('数据库身份未能核对'); originalOid = String(identity.oid);
        originals = await protectedFiles(context.layout);
        notices = await vaultNotices(context);
        const service = await agent.status(); wasRunning = service.running; wasLoaded = service.loaded;
      },
      async backup() { checkpoint(); backup = await nativeResetBackup(context, postgres); },
      async stop() {
        checkpoint(); await save(); await agent.stop();
        if ((await agent.status()).running || await portOccupied(settings.port)) throw new Error('原服务仍运行，不能归档数据');
        if (request.scopes !== 'all') { state = await currentState(context, request); if (state.blocked.length) throw new ResetBlocked(state.blocked); }
        await assertProtectedFiles(context.layout, originals);
      },
      async exportConfiguration() { checkpoint(); if (snapshot) { await ports.exportConfiguration!(snapshot); await assertProtectedFiles(context.layout, originals); } },
      async archive() {
        checkpoint();
        await archiveResetDatabase(postgres, database, archive); archived = true; await save();
      },
      async create() {
        checkpoint();
        await createResetDatabase(postgres, database, request.scopes === 'all' ? {} : { template: archive });
        if (request.scopes === 'all') await migrateRecords({ database: { host: postgres.target.socketDir, port: postgres.target.port, user: postgres.target.user, database } }, { runtimeRole: postgres.application.user });
        created = true; await save();
        await maintenance(session => session.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(database)} FROM ${quoteIdentifier(postgres.application.user)}`).then(() => {}));
      },
      async prepare() {
        checkpoint();
        if (botRuntimeStage) {
          for (const dir of botRuntimeDirs) {
            await moveIfPresent(join(context.layout.root, 'bot-runtime', dir), join(botRuntimeStage, dir));
          }
        }
        if (request.scopes !== 'all') {
          if (!state) throw new Error('停服后的选择不存在');
          await withSession(postgres.connector, database, session => clearOfflineSelection(session, state!));
        }
      },
      async restoreConfiguration() {
        checkpoint();
        if (snapshot && request.scopes === 'all') await ports.restoreConfiguration!(snapshot);
        if (definitionPath) await ports.applyDefinition!(definitionPath);
        await assertProtectedFiles(context.layout, originals);
      },
      async preflight() {
        checkpoint();
        if (!(await inspectReset(context)).compatible) throw new Error('重建后的迁移身份未能核对');
        await withSession(postgres.connector, database, assertCurrentForeignKeys);
        if (state) await withSession(postgres.connector, database, async session => {
          const [remaining] = await session.query('SELECT count(*)::text AS n FROM records WHERE digest=ANY($1::text[])', [state!.selection.cleared]);
          if (Number(remaining!.n)) throw new Error('所选记录仍在当前库中');
          const [retained] = await session.query('SELECT count(*)::text AS n FROM records WHERE digest=ANY($1::text[])', [state!.selection.retained]);
          if (Number(retained!.n) !== state!.selection.retained.length) throw new Error('未选记录的保留计数不符');
        });
        observedTally = resetRecordTally((await currentState(context, request)).records);
        await assertProtectedFiles(context.layout, originals);
        await maintenance(session => session.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO ${quoteIdentifier(postgres.application.user)}`).then(() => {}));
      },
      async restart() {
        checkpoint();
        if (wasLoaded || wasRunning) { await agent.start(); if (wasRunning) await waitForHealth(settings.port, { host: settings.listenHost, authority: settings.allowedHosts?.[0], timeoutMs: context.healthTimeoutMs }); }
        await assertProtectedFiles(context.layout, originals);
        const report = buildReport();
        await writeFileAtomic(resultPath, JSON.stringify({ completed: true, report }), 0o600);
        if (botRuntimeStage) await rm(botRuntimeStage, { recursive: true, force: true });
        await rm(journal, { force: true });
      },
      async rollback() {
        await agent.stop();
        if ((await agent.status()).running || await portOccupied(settings.port)) throw new Error('服务仍运行，不能恢复数据库');
        await maintenance(async session => {
          const names = new Set((await session.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])', [[database, archive]])).map(row => String(row.datname)));
          if (names.has(archive)) {
            if (names.has(database)) { await disconnect(session, database); await session.query(`ALTER DATABASE ${quoteIdentifier(database)} RENAME TO ${quoteIdentifier(failed)}`); }
            await session.query(`ALTER DATABASE ${quoteIdentifier(archive)} RENAME TO ${quoteIdentifier(database)}`);
          }
          await session.query(`ALTER DATABASE ${quoteIdentifier(database)} ALLOW_CONNECTIONS true`);
        });
        if (botRuntimeStage) {
          for (const dir of botRuntimeDirs) {
            await moveIfPresent(join(botRuntimeStage, dir), join(context.layout.root, 'bot-runtime', dir));
          }
          await rm(botRuntimeStage, { recursive: true, force: true }).catch(() => {});
        }
        await assertProtectedFiles(context.layout, originals);
        if (wasLoaded || wasRunning) { await agent.start(); if (wasRunning) await waitForHealth(settings.port, { host: settings.listenHost, authority: settings.allowedHosts?.[0], timeoutMs: context.healthTimeoutMs }); }
        await rm(journal, { force: true });
      },
    };
    try {
      await runReset(ports.hostTransform?.(host) ?? host);
      const report = buildReport();
      return report;
    } catch (error) {
      try { await writeFileAtomic(resultPath, JSON.stringify({ completed: false, restored: error instanceof ResetFailure && error.rollback === 'succeeded', notices }), 0o600); }
      catch { try { context.log('重建报告未能写入；恢复结果以命令返回为准，不输出原始异常'); } catch {} }
      if (definitionProblem && error instanceof ResetFailure && error.stage === 'inspect') throw definitionProblem;
      throw error;
    } finally { guard.release(); }
  });
}
