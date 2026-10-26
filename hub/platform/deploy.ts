// Deploy and rollback. deploy: build releases/<id> (git archive or copy, npm ci) and check its PostgreSQL major and the
// application role while the Hub keeps running -> stop service -> backup -> stop database -> switch current -> start
// database on the new binaries -> migrate (server entry with --migrate-only, as the owner role; see MIGRATE_ARGUMENTS)
// -> start service -> GET /healthz -> record. On failure the service is stopped, data touched by the migration is set
// aside and the pre-deploy backup restored, current points back and the
// previous release is started again. While an operation changes things, releases/operation.json says how far it got:
// an operation that died (killed, power loss) or whose recovery could not finish is finished by the next deploy or
// rollback. A signal (Ctrl-C, closed terminal, SIGTERM) lets the running step finish, then stops and recovers.
// Every step and recovery action goes to logs/deploy.log as one JSON line.
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { IsoTime } from '../../contracts/src/common.ts';
import { backupPath, createBackup, pruneBackups, verifyBackup } from './backup.ts';
import { agentFor, identityOf, keychainNamesFor, platformLockPath, postgresFor, settingsOf, type PlatformContext } from './context.ts';
import { messageOf, PlatformError } from './errors.ts';
import { withLock, writeFileAtomic } from './files.ts';
import { portAnswers, waitForHealth } from './health.ts';
import { checkNode, serviceDefinition, serviceEnvironment, stableNodePath } from './launchd.ts';
import type { Layout } from './layout.ts';
import { dataMajorMismatch, ensureDatabaseRunning } from './postgres.ts';
import { tailLines, type CommandRunner } from './process.ts';
import { findRelease, prepareRelease, readCurrentRelease, switchCurrent, type ReleaseRef, type ReleaseSource } from './release.ts';
import { restoreBackup, setAside } from './restore.ts';
import { assertApplicationRole } from './roles.ts';
import { assertApplicationRoleName, type PlatformSettings } from './settings.ts';

/**
 * Arguments after bin/circle-hub that run the server's migrations and exit. Roles (records decision 16): the child runs
 * as this operating-system account with the service environment, so CIRCLE_HUB_DATABASE_USER names the application role.
 * `serve --migrate-only` connects as the account's own role, the cluster's superuser that owns the Hub database (hub/server
 * takes it from the operating-system account), applies the migrations as that owner and grants the application role
 * through migrateRecords(..., { runtimeRole }). The service later runs `serve` without --migrate: it connects as the
 * application role and only verifies the migrations. After the child the deploy checks that the application role still
 * owns nothing.
 */
export const MIGRATE_ARGUMENTS = ['serve', '--migrate-only'] as const;

export const DeploymentEntry = z
  .object({
    at: IsoTime,
    release: z.string(),
    previous: z.string().optional(),
    /** Name of the backup under backups/ (older records hold an absolute path; only its last part is used). */
    backup: z.string(),
    rollback: z.boolean().optional(),
  })
  .strict();
export type DeploymentEntry = z.infer<typeof DeploymentEntry>;

export const OPERATION_SCHEMA = 'circle-hub-operation@1';
/** In releases/: the progress of a deploy or rollback that has not finished. */
export const OPERATION_FILE = 'operation.json';

const DeployProgress = z
  .object({
    schema: z.literal(OPERATION_SCHEMA),
    operation: z.literal('deploy'),
    started_at: IsoTime,
    step: z.string(),
    release: z.string(),
    previous: z.string().optional(),
    backup: z.string().optional(),
    service_was_loaded: z.boolean(),
    data_touched: z.boolean().describe('the migration has started: the pre-deploy backup must be restored'),
    recovery_failed: z.boolean().optional(),
  })
  .strict();
export type DeployProgress = z.infer<typeof DeployProgress>;

const RollbackProgress = z
  .object({
    schema: z.literal(OPERATION_SCHEMA),
    operation: z.literal('rollback'),
    started_at: IsoTime,
    step: z.string(),
    from: z.string(),
    to: z.string(),
    target_backup: z.string(),
    safety: z.string().optional(),
    aside: z.string().optional(),
    service_was_loaded: z.boolean(),
    data_moved: z.boolean().describe('the data was set aside: the rollback can only be finished, not undone'),
  })
  .strict();
export type RollbackProgress = z.infer<typeof RollbackProgress>;

export const OperationProgress = z.discriminatedUnion('operation', [DeployProgress, RollbackProgress]);
export type OperationProgress = z.infer<typeof OperationProgress>;

export interface DeployReport {
  release: string;
  previous?: string;
  /** Name of the backup taken before the change, under backups/. */
  backup: string;
  steps: string[];
}

/** The side effects a deploy or rollback needs; the system host composes the real modules, tests substitute fakes. */
export interface DeployHost {
  log(event: Record<string, unknown>): Promise<void>;
  currentRelease(): Promise<ReleaseRef | undefined>;
  findRelease(id: string): Promise<ReleaseRef | undefined>;
  serviceLoaded(): Promise<boolean>;
  stopService(): Promise<void>;
  /** Unloads the service and removes its definition, so it does not start again at the next login. */
  unloadService(): Promise<void>;
  startService(release: ReleaseRef): Promise<void>;
  portBusy(): Promise<boolean>;
  /** Starts the cluster on the binaries of `release` (this checkout's when undefined) if it is not running. */
  startDatabase(release: ReleaseRef | undefined): Promise<void>;
  stopDatabase(release: ReleaseRef | undefined): Promise<void>;
  /** Returns the backup's name under backups/. */
  backup(label: string, release: ReleaseRef | undefined): Promise<string>;
  verifyBackup(name: string): Promise<void>;
  prepareRelease(): Promise<ReleaseRef>;
  checkRelease(release: ReleaseRef): Promise<void>;
  switchCurrent(release: ReleaseRef | undefined): Promise<void>;
  migrate(release: ReleaseRef): Promise<void>;
  waitHealthy(release: ReleaseRef): Promise<void>;
  setAside(reason: string): Promise<string | undefined>;
  /** Restores into the emptied data root; the cluster is left running on the binaries of `release`. */
  restore(name: string, release: ReleaseRef | undefined): Promise<void>;
  recordDeployment(entry: DeploymentEntry): Promise<void>;
  lastDeployment(): Promise<DeploymentEntry | undefined>;
  /** Progress of an operation that has not finished: the running one, or one an earlier process left. */
  loadProgress(): Promise<OperationProgress | undefined>;
  saveProgress(progress: OperationProgress): Promise<void>;
  clearProgress(): Promise<void>;
  /** The signal that asked the running operation to stop, if one arrived. */
  interrupted(): string | undefined;
}

const STEP_TEXT: Record<string, string> = {
  'stop-service': '停止服务',
  'unload-service': '卸下服务',
  'check-port': '检查端口',
  'start-database': '启动数据库',
  backup: '备份',
  'prepare-release': '准备发布',
  'check-release': '检查发布',
  'stop-database': '停止数据库',
  'set-aside': '移开当前数据',
  restore: '恢复备份',
  'switch-current': '切换 current',
  'start-new-database': '用新发布启动数据库',
  migrate: '迁移',
  'start-service': '启动服务',
  health: '健康检查',
  record: '记录部署',
};

export function stepText(step: string): string {
  return STEP_TEXT[step] ?? step;
}

interface Progress {
  step: string;
  steps: string[];
}

/** A signal arrived: the operation stops before its next step. */
class Interrupted extends PlatformError {
  readonly signal: string;
  readonly after: string | undefined;

  constructor(signal: string, after: string | undefined) {
    super(`收到 ${signal}，${after ? `在“${stepText(after)}”之后` : '在开始之前'}停下`);
    this.signal = signal;
    this.after = after;
  }
}

function stepper(host: DeployHost, progress: Progress, onBegin: (step: string) => Promise<void> = async () => {}) {
  return async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const signal = host.interrupted();
    if (signal !== undefined) throw new Interrupted(signal, progress.steps.at(-1));
    progress.step = name;
    await onBegin(name);
    await host.log({ step: name, phase: 'begin' });
    const value = await fn();
    progress.steps.push(name);
    await host.log({ step: name, phase: 'done' });
    return value;
  };
}

function attempter(host: DeployHost, notes: string[]) {
  return async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      await host.log({ recovery: name, ok: true });
      return true;
    } catch (error) {
      const message = messageOf(error);
      await host.log({ recovery: name, ok: false, message });
      notes.push(`${stepText(name)}失败：${message}`);
      return false;
    }
  };
}

function headline(operation: string, error: unknown, step: string): string {
  if (error instanceof Interrupted) return `${operation}被 ${error.signal} 中断（${error.after ? `“${stepText(error.after)}”这一步已完成` : '还没有开始'}）`;
  return `${operation}在“${stepText(step)}”这一步失败：${messageOf(error)}`;
}

interface DeployRecovery {
  previous?: ReleaseRef;
  release?: ReleaseRef;
  backup?: string;
  switched: boolean;
  databaseDown: boolean;
  dataTouched: boolean;
  serviceWasLoaded: boolean;
}

/**
 * Puts the previous release and its data back. Returns true when the data root is consistent again. Nothing is moved
 * while the service cannot be stopped: launchd could keep restarting the failed release against the data being restored.
 */
async function recoverDeploy(host: DeployHost, s: DeployRecovery, notes: string[]): Promise<boolean> {
  const attempt = attempter(host, notes);
  const stopped = await attempt('stop-service', () => host.stopService());
  if (!stopped && (s.switched || s.dataTouched)) {
    notes.push(`发布 ${s.release?.id ?? '（未知）'} 可能还在运行（launchd 会重启它），所以没有动数据和 current；先用 circle-hub service stop 停掉它，再运行 circle-hub deploy 完成恢复`);
    return false;
  }
  let dataOk = true;
  let databaseDown = s.databaseDown;
  if (s.dataTouched) {
    dataOk = false;
    const kept = s.backup;
    if (kept === undefined) notes.push('没有部署前备份');
    else if (await attempt('stop-database', () => host.stopDatabase(s.release))) {
      databaseDown = true;
      let aside: string | undefined;
      if (await attempt('set-aside', async () => (aside = await host.setAside('failed-deploy')))) {
        if (aside) notes.push(`失败部署后的数据已移到 ${aside}`);
        if (await attempt('restore', () => host.restore(kept, s.previous))) {
          dataOk = true;
          databaseDown = false;
          notes.push(`已恢复部署前备份 ${kept}`);
        }
      }
    }
  }
  let currentOk = !s.switched;
  if (s.switched && (await attempt('switch-current', () => host.switchCurrent(s.previous)))) {
    currentOk = true;
    notes.push(s.previous ? `current 已指回 ${s.previous.id}` : '已移除 current');
  }
  if (!dataOk || !currentOk) {
    // The service runs whatever current points at: it must not start before both are back.
    if (await attempt('unload-service', () => host.unloadService())) notes.push('服务已卸下（服务定义已删除，下次登录也不会启动）');
    if (!dataOk) notes.push(`数据没有恢复；部署前备份是 ${s.backup ?? '（没有）'}`);
    if (!currentOk) notes.push(`current 仍指向失败的发布 ${s.release?.id ?? ''}`);
    notes.push('排除原因后运行 circle-hub deploy 或 circle-hub rollback，它们会先完成这次恢复');
    return false;
  }
  if (databaseDown) await attempt('start-database', () => host.startDatabase(s.previous));
  if (!stopped) {
    notes.push('停止服务失败，服务保持原样；数据与 current 都没有改动');
    return true;
  }
  const previous = s.previous;
  if (previous && s.serviceWasLoaded) {
    if ((await attempt('start-service', () => host.startService(previous))) && (await attempt('health', () => host.waitHealthy(previous)))) {
      notes.push(`上一版 ${previous.id} 已重新运行`);
    }
  }
  return true;
}

/** Builds and checks the release; nothing changes yet, so a failure leaves the running Hub as it was. */
async function buildRelease(host: DeployHost, progress: Progress, previous: ReleaseRef | undefined): Promise<ReleaseRef> {
  const step = stepper(host, progress);
  const unchanged = async (error: unknown) => {
    await host.log({ event: 'deploy', phase: 'failed', step: progress.step, message: messageOf(error), changed: false });
    return new PlatformError(headline('部署', error, progress.step), '还没有改动任何东西：服务、数据与 current 都照旧');
  };
  let next: ReleaseRef;
  try {
    next = await step('prepare-release', () => host.prepareRelease());
  } catch (error) {
    throw await unchanged(error);
  }
  if (previous && next.id === previous.id) {
    await host.log({ event: 'deploy', phase: 'refused', reason: 'same-release', release: next.id });
    throw new PlatformError(`发布 ${next.id} 就是当前发布，不重复部署`, '要重启服务用 circle-hub service stop 再 circle-hub service start；要重写服务定义用 circle-hub service install');
  }
  try {
    await step('check-release', () => host.checkRelease(next));
    const signal = host.interrupted();
    if (signal !== undefined) throw new Interrupted(signal, progress.steps.at(-1));
  } catch (error) {
    throw await unchanged(error);
  }
  return next;
}

export async function runDeploy(host: DeployHost, now: () => Date = () => new Date()): Promise<DeployReport> {
  const pending = await host.loadProgress();
  if (pending) return finishPending(host, pending, 'deploy', now);
  const previous = await host.currentRelease();
  const serviceWasLoaded = await host.serviceLoaded();
  const progress: Progress = { step: 'start', steps: [] };
  await host.log({ event: 'deploy', phase: 'begin', previous: previous?.id ?? null });
  const next = await buildRelease(host, progress, previous);

  // From here on things change; the progress file says how far they got.
  const state: DeployProgress = {
    schema: OPERATION_SCHEMA,
    operation: 'deploy',
    started_at: now().toISOString(),
    step: 'stop-service',
    release: next.id,
    ...(previous ? { previous: previous.id } : {}),
    service_was_loaded: serviceWasLoaded,
    data_touched: false,
  };
  const save = async (patch: Partial<DeployProgress>) => {
    Object.assign(state, patch);
    await host.saveProgress({ ...state });
  };
  let began = false;
  const step = stepper(host, progress, async (name) => {
    began = true;
    await save({ step: name });
  });
  let switched = false;
  let databaseDown = false;
  try {
    await step('stop-service', () => host.stopService());
    await step('check-port', async () => {
      if (await host.portBusy()) throw new PlatformError('停掉服务后端口仍有进程应答', '先停掉占用端口的进程再部署');
    });
    await step('start-database', () => host.startDatabase(previous));
    const backup = await step('backup', () => host.backup('pre-deploy', previous));
    await save({ backup });
    await step('stop-database', async () => {
      await host.stopDatabase(previous);
      databaseDown = true;
    });
    await step('switch-current', async () => {
      await host.switchCurrent(next);
      switched = true;
    });
    await step('start-new-database', async () => {
      await host.startDatabase(next);
      databaseDown = false;
    });
    await save({ data_touched: true });
    await step('migrate', () => host.migrate(next));
    await step('start-service', () => host.startService(next));
    await step('health', () => host.waitHealthy(next));
    await step('record', () => host.recordDeployment({ at: now().toISOString(), release: next.id, ...(previous ? { previous: previous.id } : {}), backup }));
    await host.clearProgress();
    await host.log({ event: 'deploy', phase: 'done', release: next.id });
    return { release: next.id, ...(previous ? { previous: previous.id } : {}), backup, steps: progress.steps };
  } catch (error) {
    const failedStep = progress.step;
    await host.log({ event: 'deploy', phase: 'failed', step: failedStep, message: messageOf(error), changed: began });
    if (!began) throw new PlatformError(headline('部署', error, failedStep), '还没有改动任何东西：服务、数据与 current 都照旧');
    const notes: string[] = [];
    const consistent = await recoverDeploy(
      host,
      { previous, release: next, ...(state.backup ? { backup: state.backup } : {}), switched, databaseDown, dataTouched: state.data_touched, serviceWasLoaded },
      notes,
    );
    await settle(host, consistent, () => save({ recovery_failed: true }), notes);
    await host.log({ event: 'deploy', phase: 'recovered', ok: consistent, notes });
    throw new PlatformError(headline('部署', error, failedStep), notes.join('；'));
  }
}

/** Clears the progress file once the data root is consistent, else keeps it for the next deploy or rollback. */
async function settle(host: DeployHost, consistent: boolean, keep: () => Promise<void>, notes: string[]): Promise<void> {
  try {
    if (consistent) await host.clearProgress();
    else await keep();
  } catch (error) {
    notes.push(`更新进行中操作记录失败：${messageOf(error)}`);
  }
}

/** Finishes what an earlier deploy or rollback left; a deploy is undone, a rollback whose data moved is completed. */
async function finishPending(host: DeployHost, pending: OperationProgress, requested: 'deploy' | 'rollback', now: () => Date): Promise<DeployReport> {
  await host.log({ event: 'pending', operation: pending.operation, step: pending.step, requested });
  if (pending.operation === 'rollback') {
    if (requested === 'deploy') throw new PlatformError(`上次回滚（${pending.from} -> ${pending.to}）在“${stepText(pending.step)}”这一步没有完成`, '先运行 circle-hub rollback 完成它，再部署');
    return resumeRollback(host, pending, now);
  }
  const last = await host.lastDeployment();
  if (last && last.rollback !== true && last.release === pending.release && last.backup === pending.backup) {
    await host.clearProgress();
    throw new PlatformError(`上次部署（发布 ${pending.release}）其实已经完成并记录，这次什么也没做`, `要${requested === 'deploy' ? '部署' : '回滚'}就再运行一次`);
  }
  const previous = pending.previous === undefined ? undefined : await host.findRelease(pending.previous);
  if (pending.previous !== undefined && !previous) {
    throw new PlatformError(`上次部署之前的发布 ${pending.previous} 已不在 releases/ 里，不能自动恢复`, `手动处理后删除 releases/${OPERATION_FILE}`);
  }
  const release = await host.findRelease(pending.release);
  const current = await host.currentRelease().catch(() => undefined);
  const notes: string[] = [];
  const consistent = await recoverDeploy(
    host,
    {
      previous,
      release,
      ...(pending.backup ? { backup: pending.backup } : {}),
      switched: current !== undefined && current.id === pending.release,
      databaseDown: true,
      dataTouched: pending.data_touched,
      serviceWasLoaded: pending.service_was_loaded,
    },
    notes,
  );
  await settle(host, consistent, () => host.saveProgress({ ...pending, recovery_failed: true }), notes);
  await host.log({ event: 'deploy', phase: 'recovered', pending: true, ok: consistent, notes });
  if (consistent) notes.push(requested === 'deploy' ? '现在可以重新运行 circle-hub deploy' : '已回到这次部署之前的发布与数据，没有再回滚');
  throw new PlatformError(`上次部署（发布 ${pending.release}）在“${stepText(pending.step)}”这一步中断，${consistent ? '已完成恢复' : '恢复还没有完成'}`, notes.join('；'));
}

export async function runRollback(host: DeployHost, now: () => Date = () => new Date()): Promise<DeployReport> {
  const pending = await host.loadProgress();
  if (pending) return finishPending(host, pending, 'rollback', now);
  return startRollback(host, now);
}

async function startRollback(host: DeployHost, now: () => Date, wasLoaded = false): Promise<DeployReport> {
  const current = await host.currentRelease();
  if (!current) throw new PlatformError('还没有部署过，没有可回滚的发布');
  const entry = await host.lastDeployment();
  if (!entry || entry.release !== current.id || !entry.previous) {
    throw new PlatformError(`找不到把当前发布 ${current.id} 部署上来、且有上一版的记录`, '回滚只能回到最近一次部署之前的发布');
  }
  if (entry.previous === entry.release) {
    throw new PlatformError(`最近一次部署记录的上一版就是当前发布 ${current.id}（同一个发布部署了两次），没有可回滚的发布`, '回滚只能回到另一个发布');
  }
  const previous = await host.findRelease(entry.previous);
  if (!previous) throw new PlatformError(`上一版 ${entry.previous} 已不在 releases/ 里`);
  await host.verifyBackup(entry.backup);
  const state: RollbackProgress = {
    schema: OPERATION_SCHEMA,
    operation: 'rollback',
    started_at: now().toISOString(),
    step: 'stop-service',
    from: current.id,
    to: previous.id,
    target_backup: entry.backup,
    service_was_loaded: wasLoaded || (await host.serviceLoaded()),
    data_moved: false,
  };
  return rollbackSteps(host, now, state, current, previous, false);
}

async function resumeRollback(host: DeployHost, pending: RollbackProgress, now: () => Date): Promise<DeployReport> {
  const last = await host.lastDeployment();
  if (last?.rollback === true && last.release === pending.to && last.previous === pending.from) {
    await host.clearProgress();
    throw new PlatformError(`上次回滚（回到 ${pending.to}）其实已经完成并记录，这次没有再回滚`, '运行 circle-hub status 查看');
  }
  if (!pending.data_moved) {
    // Nothing was moved yet: forget it and roll back from the start.
    await host.clearProgress();
    return startRollback(host, now, pending.service_was_loaded);
  }
  const to = await host.findRelease(pending.to);
  if (!to) throw new PlatformError(`回滚目标 ${pending.to} 已不在 releases/ 里，不能继续`, `手动处理后删除 releases/${OPERATION_FILE}`);
  await host.verifyBackup(pending.target_backup);
  return rollbackSteps(host, now, { ...pending }, await host.findRelease(pending.from), to, true);
}

/**
 * The rollback proper: stop service -> backup pre-rollback -> stop database -> set aside -> restore the pre-deploy backup
 * on the previous binaries -> switch current -> start service -> health -> record. `resumed` continues one whose data
 * was already moved: the partial state of the failed attempt is set aside and the restore is done again.
 */
async function rollbackSteps(
  host: DeployHost,
  now: () => Date,
  state: RollbackProgress,
  current: ReleaseRef | undefined,
  previous: ReleaseRef,
  resumed: boolean,
): Promise<DeployReport> {
  const progress: Progress = { step: 'start', steps: [] };
  const save = async (patch: Partial<RollbackProgress>) => {
    Object.assign(state, patch);
    await host.saveProgress({ ...state });
  };
  let began = false;
  const step = stepper(host, progress, async (name) => {
    began = true;
    await save({ step: name });
  });
  await host.log({ event: 'rollback', phase: resumed ? 'resume' : 'begin', from: state.from, to: state.to, backup: state.target_backup });
  try {
    await step('stop-service', () => host.stopService());
    if (resumed) {
      // Only the restore of the failed attempt can have started the cluster, on the binaries of the target.
      await step('stop-database', () => host.stopDatabase(previous));
    } else {
      await step('start-database', () => host.startDatabase(current));
      const safety = await step('backup', () => host.backup('pre-rollback', current));
      await save({ safety });
      await step('stop-database', () => host.stopDatabase(current));
    }
    await save({ data_moved: true });
    const aside = await step('set-aside', () => host.setAside(resumed ? 'rollback-retry' : 'rollback'));
    if (aside && !state.aside) await save({ aside });
    await step('restore', () => host.restore(state.target_backup, previous));
    await step('switch-current', () => host.switchCurrent(previous));
    await step('start-service', () => host.startService(previous));
    await step('health', () => host.waitHealthy(previous));
    const safety = state.safety;
    if (safety === undefined) throw new PlatformError('进行中操作记录里没有回滚前备份');
    await step('record', () => host.recordDeployment({ at: now().toISOString(), release: state.to, previous: state.from, backup: safety, rollback: true }));
    await host.clearProgress();
    await host.log({ event: 'rollback', phase: 'done', release: state.to, set_aside: state.aside ?? null });
    return { release: state.to, previous: state.from, backup: safety, steps: progress.steps };
  } catch (error) {
    const failedStep = progress.step;
    await host.log({ event: 'rollback', phase: 'failed', step: failedStep, message: messageOf(error), changed: began });
    if (!began && !resumed) throw new PlatformError(headline('回滚', error, failedStep), '还没有改动任何东西');
    const notes: string[] = [];
    const attempt = attempter(host, notes);
    if (!state.data_moved) {
      await attempt('start-database', () => host.startDatabase(current));
      if (current && state.service_was_loaded && (await attempt('start-service', () => host.startService(current)))) {
        notes.push(`当前发布 ${current.id} 已重新运行，数据没有改动`);
      }
      await settle(host, true, async () => {}, notes);
    } else {
      // The data is out of place: the service must not run until the rollback is finished.
      const unloaded = await attempt('unload-service', () => host.unloadService());
      notes.push(unloaded ? '服务已停止并卸下（服务定义已删除，下次登录也不会启动）' : '服务可能还在运行（launchd 会重启它）：先运行 circle-hub service stop');
      notes.push(state.aside ? `回滚前的数据在 ${state.aside}` : '回滚前的数据没有移开');
      if (state.safety) notes.push(`回滚前的备份是 ${state.safety}`);
      notes.push('排除原因后再运行 circle-hub rollback，它从这里继续完成回滚');
      await settle(host, false, () => save({}), notes);
    }
    await host.log({ event: 'rollback', phase: 'recovered', notes });
    throw new PlatformError(headline('回滚', error, failedStep), notes.join('；'));
  }
}

export function deployLogPath(context: PlatformContext): string {
  return join(context.layout.logs, 'deploy.log');
}

export function historyPath(context: PlatformContext): string {
  return join(context.layout.releases, 'deployments.jsonl');
}

export function progressPath(layout: Layout): string {
  return join(layout.releases, OPERATION_FILE);
}

/** The progress of a deploy or rollback that has not finished, if any. */
export async function readProgress(layout: Layout): Promise<OperationProgress | undefined> {
  let text: string;
  try {
    text = await readFile(progressPath(layout), 'utf8');
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
  const parsed = OperationProgress.safeParse(value);
  if (!parsed.success) throw new PlatformError(`进行中操作记录看不懂：${progressPath(layout)}`, '手动检查数据根后删除这个文件');
  return parsed.data;
}

/** Backups an unfinished operation still needs; pruning keeps them. */
export function progressBackups(progress: OperationProgress | undefined): string[] {
  if (!progress) return [];
  const names = progress.operation === 'deploy' ? [progress.backup] : [progress.target_backup, progress.safety];
  return names.filter((name): name is string => name !== undefined);
}

/** One line for status and for refusals while an operation is unfinished. */
export function progressText(progress: OperationProgress): string {
  const what = progress.operation === 'deploy' ? `部署（发布 ${progress.release}）` : `回滚（${progress.from} -> ${progress.to}）`;
  return `上次${what}在“${stepText(progress.step)}”这一步没有完成（开始于 ${progress.started_at}）`;
}

async function appendLine(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${line}\n`, { mode: 0o600 });
}

export async function readDeployments(context: PlatformContext): Promise<DeploymentEntry[]> {
  let text: string;
  try {
    text = await readFile(historyPath(context), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        value = undefined;
      }
      const parsed = DeploymentEntry.safeParse(value);
      if (!parsed.success) throw new PlatformError(`部署记录有一行不符合格式：${historyPath(context)}`);
      return parsed.data;
    });
}

/** Backups pruning must keep: the last two deployments' and an unfinished operation's. */
export async function protectedBackups(context: PlatformContext): Promise<string[]> {
  const recent = (await readDeployments(context)).slice(-2).map((entry) => entry.backup);
  return [...recent, ...progressBackups(await readProgress(context.layout))];
}

export interface SignalGuard {
  received(): string | undefined;
  release(): void;
}

const STOP_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * While held, SIGINT, SIGTERM and SIGHUP no longer end the process: the first one is recorded and the operation stops
 * before its next step and recovers. Output errors of a closed terminal are ignored meanwhile.
 */
export function guardSignals(log: (line: string) => void): SignalGuard {
  let received: string | undefined;
  const say = (line: string) => {
    try {
      log(line);
    } catch {
      // The terminal may be gone.
    }
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (received === undefined) {
      received = signal;
      say(`收到 ${signal}：等当前这一步做完就停下并恢复；不要强行结束进程`);
    } else {
      say(`又收到 ${signal}：正在停下并恢复，请等它结束`);
    }
  };
  const ignore = () => {};
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  process.stdout.on('error', ignore);
  process.stderr.on('error', ignore);
  return {
    received: () => received,
    release: () => {
      for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
      process.stdout.off('error', ignore);
      process.stderr.off('error', ignore);
    },
  };
}

/** The real host: launchd, the data root's cluster, backups, releases and the loopback health check. */
export function systemDeployHost(context: PlatformContext, settings: PlatformSettings, source?: ReleaseSource, guard?: SignalGuard): DeployHost {
  // Children run in their own process group: a Ctrl-C reaches this process only, and the running step can finish.
  const runner: CommandRunner = (command, args, options = {}) => context.runner(command, args, { ...options, detached: true });
  const own: PlatformContext = { ...context, runner };
  const { layout } = own;
  const agent = agentFor(own, settings);
  const cluster = (release: ReleaseRef | undefined) => postgresFor(own, release?.dir);
  const identity = identityOf(own);
  const node = async () => own.nodePath ?? settings.node ?? (await stableNodePath());
  return {
    log: (event) => appendLine(deployLogPath(own), JSON.stringify({ at: own.now().toISOString(), ...event })),
    currentRelease: () => readCurrentRelease(layout),
    findRelease: (id) => findRelease(layout, id),
    serviceLoaded: async () => (await agent.status()).loaded,
    stopService: async () => {
      await agent.stop();
    },
    unloadService: async () => {
      await agent.uninstall();
    },
    startService: async () => {
      const binary = await node();
      await checkNode(binary, runner);
      await agent.install(serviceDefinition(layout, settings, { node: binary, ...identity }));
    },
    portBusy: async () => {
      // An old server may still be shutting down right after bootout.
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!(await portAnswers(settings.port))) return false;
        await delay(500);
      }
      return true;
    },
    startDatabase: async (release) => {
      await ensureDatabaseRunning(cluster(release));
    },
    stopDatabase: async (release) => {
      await cluster(release).stop();
    },
    backup: async (label, release) =>
      basename((await createBackup({ layout, postgres: cluster(release), runner, libpqBin: own.libpqBin, now: own.now, label })).dir),
    verifyBackup: async (name) => {
      await verifyBackup(backupPath(layout, name));
    },
    prepareRelease: async () => {
      if (!source) throw new PlatformError('没有指定部署来源');
      const notes: string[] = [];
      const prepared = await prepareRelease(source, {
        layout,
        runner,
        env: own.env,
        git: own.git,
        npm: own.npm,
        tar: own.tar,
        now: own.now,
        log: (line) => notes.push(line),
      });
      notes.push(prepared.reused ? `沿用已有发布 ${prepared.id}` : `已建立发布 ${prepared.id}`);
      for (const note of notes) {
        own.log(note);
        await appendLine(deployLogPath(own), JSON.stringify({ at: own.now().toISOString(), note }));
      }
      return { id: prepared.id, dir: prepared.dir };
    },
    checkRelease: async (release) => {
      const control = cluster(release);
      const status = await control.status();
      if (status.dataMajor !== undefined && status.dataMajor !== status.binaryMajor) throw dataMajorMismatch(status.dataMajor, status.binaryMajor);
      // While the Hub runs its cluster runs: a database the application role owns things in (an earlier platform
      // version) is refused before anything stops. A stopped cluster is checked by the pre-deploy backup.
      if (status.running) await assertApplicationRole(control, '部署之前，');
    },
    switchCurrent: (release) => switchCurrent(layout, release?.id),
    migrate: async (release) => {
      const owner = identity.user;
      const runtime = identity.database.role;
      const note = `迁移以本机账户的角色 ${owner}（拥有 Hub 数据库）执行，并授权应用角色 ${runtime}；之后服务以 ${runtime} 连接，不迁移`;
      own.log(note);
      await appendLine(deployLogPath(own), JSON.stringify({ at: own.now().toISOString(), note }));
      const result = await runner(await node(), [join(release.dir, 'bin', 'circle-hub'), ...MIGRATE_ARGUMENTS], {
        cwd: release.dir,
        env: serviceEnvironment(layout, settings, identity),
        timeoutMs: 30 * 60 * 1000,
      });
      if (result.code !== 0) throw new PlatformError(`迁移失败（退出码 ${result.code}）：${tailLines(result.stderr || result.stdout) || '没有输出'}`);
      await assertApplicationRole(cluster(release), '迁移之后，');
    },
    waitHealthy: async (release) => {
      await waitForHealth(settings.port, { release: release.id, totalMs: own.healthTimeoutMs });
    },
    setAside: (reason) => setAside(layout, reason, own.now()),
    restore: async (name, release) => {
      await restoreBackup({ layout, backupDir: backupPath(layout, name), postgres: cluster(release), runner, libpqBin: own.libpqBin, now: own.now });
    },
    recordDeployment: (entry) => appendLine(historyPath(own), JSON.stringify(DeploymentEntry.parse(entry))),
    lastDeployment: async () => (await readDeployments(own)).at(-1),
    loadProgress: () => readProgress(layout),
    saveProgress: (progress) => writeFileAtomic(progressPath(layout), `${JSON.stringify(OperationProgress.parse(progress), null, 2)}\n`, 0o600),
    clearProgress: () => rm(progressPath(layout), { force: true }),
    interrupted: () => guard?.received(),
  };
}

/** Runs `fn` under the platform lock with signals guarded. */
async function guarded<T>(context: PlatformContext, fn: (guard: SignalGuard) => Promise<T>): Promise<T> {
  return withLock(platformLockPath(context), async () => {
    const guard = guardSignals(context.log);
    try {
      return await fn(guard);
    } finally {
      guard.release();
    }
  });
}

/** Deploys `source` to the data root of `context`, then prunes old backups (the ones a rollback may need are kept). */
export async function deploy(context: PlatformContext, source: ReleaseSource, host?: DeployHost): Promise<DeployReport> {
  const settings = await settingsOf(context);
  // Settings written before these rules existed would fail only after the service stopped: the migration would refuse
  // to grant such a role, and serve would refuse a vault master key on the operator token's account.
  assertApplicationRoleName(settings.database.role);
  keychainNamesFor(context, settings);
  return guarded(context, async (guard) => {
    const report = await runDeploy(host ?? systemDeployHost(context, settings, source, guard), context.now);
    try {
      await pruneBackups(context.layout, settings.backupsKeep, await protectedBackups(context));
    } catch (error) {
      context.log(`部署成功，但清理旧备份失败：${messageOf(error)}`);
    }
    return report;
  });
}

export async function rollback(context: PlatformContext, host?: DeployHost): Promise<DeployReport> {
  const settings = await settingsOf(context);
  // The release rolled back to reads the vault master key when it starts, after the data has moved.
  keychainNamesFor(context, settings);
  return guarded(context, (guard) => runRollback(host ?? systemDeployHost(context, settings, undefined, guard), context.now));
}
