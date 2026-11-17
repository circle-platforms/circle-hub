/** Reset side effects and recovery state belong to the host. */
export interface ResetHost {
  inspect(): Promise<void>;
  /** Completes only after the backup has been verified. */
  backup(): Promise<void>;
  stop(): Promise<void>;
  exportConfiguration(): Promise<void>;
  archive(): Promise<void>;
  create(): Promise<void>;
  prepare(): Promise<void>;
  restoreConfiguration(): Promise<void>;
  preflight(): Promise<void>;
  restart(): Promise<void>;
  rollback(): Promise<void>;
}

export type ResetStage = Exclude<keyof ResetHost, 'rollback'>;
export type ResetRollbackOutcome = 'not-needed' | 'succeeded' | 'failed';
export interface ResetOperationReport {
  completed: true;
}

const STAGE_TEXT: Record<ResetStage, string> = {
  inspect: '检查重置条件',
  backup: '备份校验',
  stop: '停止服务',
  exportConfiguration: '导出配置',
  archive: '归档原数据库',
  create: '创建新数据库',
  prepare: '准备重置数据',
  restoreConfiguration: '恢复配置',
  preflight: '启动前自检',
  restart: '重启服务',
};
const ROLLBACK_TEXT: Record<ResetRollbackOutcome, string> = {
  'not-needed': '尚未尝试停止服务，未执行自动恢复',
  succeeded: '已完成自动恢复',
  failed: '自动恢复失败',
};

/** Retains both outcomes without retaining raw host errors, which may contain confidential values. */
export class ResetFailure extends Error {
  readonly stage: ResetStage;
  readonly rollback: ResetRollbackOutcome;

  constructor(stage: ResetStage, rollback: ResetRollbackOutcome) {
    super(`重置在${STAGE_TEXT[stage]}阶段失败；${ROLLBACK_TEXT[rollback]}`);
    this.name = 'ResetFailure';
    this.stage = stage;
    this.rollback = rollback;
  }
}

export async function runReset(host: ResetHost): Promise<ResetOperationReport> {
  let stage: ResetStage = 'inspect';
  let stopAttempted = false;
  try {
    for (const next of ['inspect', 'backup', 'stop', 'exportConfiguration', 'archive', 'create', 'prepare', 'restoreConfiguration', 'preflight', 'restart'] as const) {
      stage = next;
      if (stage === 'stop') stopAttempted = true;
      await host[stage]();
    }
    return { completed: true };
  } catch {
    let rollback: ResetRollbackOutcome = 'not-needed';
    if (stopAttempted) {
      try {
        await host.rollback();
        rollback = 'succeeded';
      } catch {
        rollback = 'failed';
      }
    }
    throw new ResetFailure(stage, rollback);
  }
}
