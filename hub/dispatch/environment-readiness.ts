// Local observations only. This report grants no use permission and is never an admission or dispatch gate.
import { isAdmin, isSha256, sha256Hex, type Principal, type User, type RecordsKit } from '../records/api.ts';
import type { LeaseService } from '../leases/api.ts';
import type { ExecutorDefinition } from './definition.ts';
import type { ReleaseCheck } from './release-diagnostics.ts';
import type { ExecutorRegistry } from './executors.ts';
import type { EnvironmentPermission } from './member-environments.ts';

export interface EnvironmentReadinessSources {
  account(id: string): Promise<User | null>;
  executors(): Promise<readonly { id: string; definition: Pick<ExecutorDefinition, 'target' | 'enabled' | 'manifest_sha256' | 'premises' | 'bed_state' | 'resources'> }[]>;
  canUse(actor: Principal, executor: string): Promise<boolean>;
  source(actor: Principal, sha256: string): Promise<{ bytes: Uint8Array | null } | null>;
  baseline(executor: string, probe: string): Promise<{ recorded_at: string } | null>;
  leases: Pick<LeaseService, 'view'>;
  now?(): Date;
}
export interface EnvironmentReadinessCheck extends Pick<ReleaseCheck, 'condition' | 'label' | 'satisfied' | 'missing_fact' | 'next_action'> {
  observed_at: string;
  references: string[];
}
export interface EnvironmentReadinessExecutor {
  ordinal: number;
  /** Only the current administrator receives the configuration identity. */
  executor?: string;
  checks: EnvironmentReadinessCheck[];
  occupancy: Array<{ mine: boolean; since: string; until: string | null }> | null;
  baseline_registrations: Array<{ ordinal: number; recorded_at: string }>;
}
export interface EnvironmentReadiness {
  target: string | null;
  observed_at: string;
  executors: EnvironmentReadinessExecutor[];
  missing_fact?: string;
  next_action?: string;
  limitations: string[];
}

export function createEnvironmentReadiness(
  records: Pick<RecordsKit, 'principals' | 'authorizations' | 'artifacts'>,
  registry: Pick<ExecutorRegistry, 'get'>,
  baselines: { getBaseline(executor: string, probe: string): Promise<{ created_at: string } | null> },
  leases: Pick<LeaseService, 'view'>,
  permission: EnvironmentPermission,
  now?: () => Date,
): (caller: Principal, target: string) => Promise<EnvironmentReadiness> {
  return (caller, target) => readEnvironmentReadiness({
    account: id => records.principals.get(id),
    executors: async () => {
      const ids = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = await records.authorizations.history({ permission: 'resource_config', limit: 500, cursor });
        for (const record of page.items) if (record.body.object.startsWith('executor.')) ids.add(record.body.object.slice('executor.'.length));
        cursor = page.next;
      } while (cursor !== null);
      const entries: Awaited<ReturnType<EnvironmentReadinessSources['executors']>>[number][] = [];
      for (const id of [...ids].sort()) {
        const entry = await registry.get(id);
        if (!entry) continue;
        const { target, enabled, manifest_sha256, premises, bed_state, resources } = entry.definition;
        entries.push({ id: entry.id, definition: { target, enabled, manifest_sha256, premises, bed_state, resources } });
      }
      return entries;
    },
    canUse: (actor, executor) => permission(actor, executor),
    source: async (actor, hash) => {
      const source = await records.artifacts.source(actor, hash, { consumer: 'function' });
      return source ? { bytes: source.bytes } : null;
    },
    baseline: async (executor, probe) => {
      const metadata = await baselines.getBaseline(executor, probe);
      return metadata ? { recorded_at: metadata.created_at } : null;
    },
    leases,
    ...(now ? { now } : {}),
  }, caller, target);
}

export async function readEnvironmentReadiness(sources: EnvironmentReadinessSources, caller: Principal, target: string): Promise<EnvironmentReadiness> {
  const now = () => (sources.now?.() ?? new Date()).toISOString();
  const report: EnvironmentReadiness = {
    target: null, observed_at: now(), executors: [],
    limitations: [
      '仅本地只读观察，未连接网关或设备，未读取秘密值，不是预订或上机许可',
      '基线只核登记，未读取基线正文或进行现场比较',
      '本地没有租约不表示物理环境空闲；本次观察没有追加核验记录',
      '清单时效与认证是否适用当前网关版本未确认，不凭文件时间或变量名称猜测',
    ],
  };
  let actor: User | null;
  try { actor = await sources.account(caller.id); }
  catch { return { ...report, missing_fact: '当前账户状态未能读取', next_action: '恢复账户状态读取后重读' }; }
  if (!actor || actor.disabled || actor.deleted_at) return { ...report, missing_fact: '当前账户不可用', next_action: '使用启用的账户重新读取' };
  const administrator = isAdmin(actor);
  const next = (action: string) => administrator ? action : '请管理员' + action;
  let candidates: Awaited<ReturnType<EnvironmentReadinessSources['executors']>>;
  try { candidates = await sources.executors(); }
  catch { return { ...report, missing_fact: '运行环境配置未能完整读取', next_action: next('核对配置读取能力后重读') }; }
  for (const candidate of candidates) {
    if (candidate.definition.target !== target) continue;
    let assigned: boolean | null;
    try { assigned = await sources.canUse(actor, candidate.id); } catch { assigned = null; }
    if (!administrator && assigned !== true) continue;
    const row: EnvironmentReadinessExecutor = { ordinal: report.executors.length + 1, ...(administrator ? { executor: candidate.id } : {}), checks: [], occupancy: null, baseline_registrations: [] };
    const check = (condition: string, label: string, satisfied: boolean | null, references: string[] = [], missing?: string, action = '核对该项声明与可读依据后重读') => {
      row.checks.push({ condition, label, satisfied, observed_at: now(), references, ...(missing ? { missing_fact: missing, next_action: next(action) } : {}) });
    };
    const original = async (condition: string, label: string, hash: string | null) => {
      if (!hash || !isSha256(hash)) { check(condition, label, null, [], '未声明可核对的完整原件摘要'); return; }
      try {
        const source = await sources.source(actor, hash);
        if (!source?.bytes) { check(condition, label, null, [], '原件未取得；不存在、无权或读取策略未放行均不能当作已核对'); return; }
        const matches = sha256Hex(source.bytes) === hash;
        check(condition, label, matches, matches ? ['src:' + hash] : [], matches ? undefined : '受权读取的原件字节与登记摘要不一致');
      } catch { check(condition, label, null, [], '原件读取未完成，未取得可核对的完整字节'); }
    };
    const definition = candidate.definition;
    check('enabled', '执行器启用', definition.enabled, [], definition.enabled ? undefined : '执行器已停用', '核对执行器配置后启用或选择其他已分配环境');
    check('assignment', '当前账户使用分配', assigned, [], assigned === true ? undefined : assigned === false ? '当前账户没有该执行器的使用分配；管理员管理权不代替使用分配' : '当前使用分配未能读取', '核对并明确分配该运行环境后重读');
    await original('manifest', '清单原件可读且摘要一致', definition.manifest_sha256);
    check('manifest_freshness', '清单时效', null, [], '没有足以判定过期的版本或期限依据；未连接目标核对当前清单');
    const probes = definition.bed_state?.items ?? [];
    if (!probes.length) check('baseline', '基线登记', null, [], '执行器没有声明待核对的基线探针');
    for (const [index, probe] of probes.entries()) {
      try {
        const baseline = await sources.baseline(candidate.id, probe.id);
        check('baseline.' + index, `基线登记（第 ${index + 1} 项）`, baseline !== null, [], baseline ? undefined : '该声明探针没有基线登记', '按声明探针登记基线后重读；本报告不进行现场比较');
        if (baseline) row.baseline_registrations.push({ ordinal: index + 1, recorded_at: baseline.recorded_at });
      } catch { check('baseline.' + index, `基线登记（第 ${index + 1} 项）`, null, [], '基线登记元数据未能读取'); }
    }
    const certificates = Object.values(definition.premises).filter(value => value !== undefined);
    if (!certificates.length) check('evidence', '认证证据原件', null, [], '没有声明认证证据；不表示当前目标已经认证');
    for (const [group, certificate] of certificates.entries()) for (const [index, reference] of certificate.evidence.entries()) {
      const hash = reference.startsWith('src:') ? reference.slice(4) : null;
      await original(`evidence.${group}.${index}`, `认证证据原件（第 ${group + 1} 组，第 ${index + 1} 项）`, hash);
    }
    try {
      const keys = new Set(definition.resources);
      const entries = (await sources.leases.view('', true)).entries.filter(lease => keys.has(lease.key));
      row.occupancy = entries.map(lease => ({ mine: lease.user === actor.id, since: lease.since, until: lease.until }));
      check('local_leases_clear', '本地声明资源没有有效租约', entries.length === 0, [], entries.length ? '本地声明资源存在有效租约；不据此判断远端作业或物理状态' : undefined);
    } catch { check('local_leases_clear', '本地声明资源没有有效租约', null, [], '本地租约占用未能读取；不能当作空闲'); }
    report.executors.push(row);
  }
  if (report.executors.length) report.target = target;
  else { report.missing_fact = '该目标当前没有可查看的执行器配置'; report.next_action = next('核对目标配置与账户分配后重读'); }
  return report;
}
