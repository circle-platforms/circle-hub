/** Side effects for the previous release's database upgrade; the host owns their implementation and recovery state. */
export interface UpgradeHost {
  current(): Promise<boolean>;
  /** Completes only after the backup has been verified. */
  backup(): Promise<void>;
  stop(): Promise<void>;
  archive(): Promise<void>;
  create(): Promise<void>;
  migrate(): Promise<void>;
  transfer(): Promise<void>;
  preflight(): Promise<void>;
  restart(): Promise<void>;
  rollback(): Promise<void>;
}

export type UpgradeStage = Exclude<keyof UpgradeHost, 'rollback'>;
export type UpgradeRollbackOutcome = 'not-needed' | 'succeeded' | 'failed';
export interface UpgradeReport {
  status: 'upgraded' | 'noop';
}

const STAGE_TEXT: Record<UpgradeStage, string> = {
  current: '检查版本',
  backup: '备份校验',
  stop: '停止服务',
  archive: '归档旧数据库',
  create: '创建新数据库',
  migrate: '应用基线迁移',
  transfer: '转入保留数据',
  preflight: '启动前自检',
  restart: '重启服务',
};
const ROLLBACK_TEXT: Record<UpgradeRollbackOutcome, string> = {
  'not-needed': '尚未尝试停止服务，未执行自动恢复',
  succeeded: '已完成自动恢复',
  failed: '自动恢复失败',
};

/** Carries both outcomes without retaining raw host errors, which may contain confidential values. */
export class UpgradeFailure extends Error {
  readonly stage: UpgradeStage;
  readonly rollback: UpgradeRollbackOutcome;

  constructor(stage: UpgradeStage, rollback: UpgradeRollbackOutcome) {
    super(`自动升级在${STAGE_TEXT[stage]}阶段失败；${ROLLBACK_TEXT[rollback]}`);
    this.name = 'UpgradeFailure';
    this.stage = stage;
    this.rollback = rollback;
  }
}

export async function runUpgrade(host: UpgradeHost): Promise<UpgradeReport> {
  let stage: UpgradeStage = 'current';
  let stopAttempted = false;
  try {
    if (await host.current()) return { status: 'noop' };
    stage = 'backup';
    await host.backup();
    for (const next of ['stop', 'archive', 'create', 'migrate', 'transfer', 'preflight', 'restart'] as const) {
      stage = next;
      if (stage === 'stop') stopAttempted = true;
      await host[stage]();
    }
    return { status: 'upgraded' };
  } catch {
    let rollback: UpgradeRollbackOutcome = 'not-needed';
    if (stopAttempted) {
      try {
        await host.rollback();
        rollback = 'succeeded';
      } catch {
        rollback = 'failed';
      }
    }
    throw new UpgradeFailure(stage, rollback);
  }
}
