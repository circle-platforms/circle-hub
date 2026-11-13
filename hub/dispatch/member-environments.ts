// Member-visible environment assignments and booking admission; source identities stay inside the Hub.
import type { ProtocolError } from '../../contracts/src/common.ts';
import { isAdmin, type Principal, type RecordsKit, type Transaction } from '../records/api.ts';
import type { LeaseService } from '../leases/api.ts';
import type { ExecutorRegistry } from './executors.ts';

export type EnvironmentPermission = (actor: Principal, executor: string, tx?: Transaction) => Promise<boolean>;
export interface MemberEnvironment {
  name: string;
  enabled: boolean;
  assigned: boolean;
  can_use: boolean;
  occupancy: Array<{ name: string; since: string; until: string | null; mine: boolean }> | null;
  missing: string[];
}

export interface UnattributedHolding {
  booking_run: string;
  since: string;
  until: string | null;
  target: null;
  assigned: false;
  can_use: false;
  assignment_reason: string;
  target_missing: string;
}

export class MemberEnvironments {
  readonly records: Pick<RecordsKit, 'authorizations' | 'principals' | 'artifacts'>;
  readonly registry: Pick<ExecutorRegistry, 'readSource'>;
  readonly leases: Pick<LeaseService, 'view' | 'registrations'>;
  readonly permission: EnvironmentPermission;
  constructor(
    records: Pick<RecordsKit, 'authorizations' | 'principals' | 'artifacts'>,
    registry: Pick<ExecutorRegistry, 'readSource'>,
    leases: Pick<LeaseService, 'view' | 'registrations'>,
    permission: EnvironmentPermission,
  ) {
    this.records = records; this.registry = registry; this.leases = leases; this.permission = permission;
  }

  private async ids(): Promise<string[]> {
    const ids = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.records.authorizations.history({ permission: 'resource_config', limit: 500, cursor });
      for (const row of page.items) if (row.body.object.startsWith('executor.')) ids.add(row.body.object.slice('executor.'.length));
      cursor = page.next;
    } while (cursor !== null);
    return [...ids].sort();
  }

  async canUse(actor: Principal, executor: string): Promise<boolean> {
    if (!await this.permission(actor, executor)) return false;
    return (await this.registry.readSource(executor))?.source.enabled === true;
  }

  async authorizeKeys(actor: Principal, keys: readonly string[]): Promise<ProtocolError | null> {
    const allowed = new Set<string>();
    for (const id of await this.ids()) {
      if (!await this.canUse(actor, id)) continue;
      const entry = await this.registry.readSource(id);
      if (entry?.source.enabled) for (const key of entry.source.resources) allowed.add(key);
    }
    if (keys.some(key => !allowed.has(key))) return {
      code: 'SOURCE_NOT_PERMITTED',
      message: '没有分配这些资源对应的启用运行环境，不能预订或续期',
      fix: '请管理员分配相应运行环境；未登记的资源键须先明确登记，不按名称猜测权限',
    };
    return null;
  }

  async list(actor: Principal): Promise<MemberEnvironment[]> {
    const viewer = (await this.records.artifacts.capturePermissionSnapshot?.(actor))?.user;
    if (!viewer || viewer.disabled || viewer.deleted_at) return [];
    const out: MemberEnvironment[] = [];
    for (const id of await this.ids()) {
      if (!await this.permission(actor, id)) continue;
      const entry = await this.registry.readSource(id);
      if (!entry) continue;
      const row: MemberEnvironment = { name: entry.source.target, enabled: entry.source.enabled, assigned: true, can_use: entry.source.enabled, occupancy: null, missing: [] };
      try {
        const keys = new Set(entry.source.resources);
        const entries = (await this.leases.view('', true)).entries.filter(lease => keys.has(lease.key));
        const registered = await this.leases.registrations('');
        const occupants = new Map<string, NonNullable<MemberEnvironment['occupancy']>[number]>();
        for (const lease of entries) {
          const visible = lease.user === viewer.id || isAdmin(viewer) || registered.some(registration => registration.owner === viewer.id && lease.key.startsWith(registration.prefix));
          const account = visible ? await this.records.principals.get(lease.user) : null;
          occupants.set([lease.user, lease.run, lease.since, lease.until].join('\0'), {
            name: account && !account.deleted_at ? account.name : '其他成员',
            since: lease.since, until: lease.until, mine: lease.user === actor.id,
          });
        }
        row.occupancy = [...occupants.values()];
      } catch {
        row.missing.push('当前租约占用未能读取，请稍后重读');
      }
      row.missing.push('租约记录不等于远端作业或物理环境状态；没有租约不代表环境空闲');
      if (!entry.source.enabled) row.missing.push('运行环境已停用，请管理员核对后启用');
      out.push(row);
    }
    return out;
  }

  /** A lease key is not an executor binding; never infer a target for an unassigned booking. */
  async unattributedHoldings(actor: Principal): Promise<UnattributedHolding[] | null> {
    try {
      if (!this.records.artifacts.capturePermissionSnapshot) return null;
      const viewer = (await this.records.artifacts.capturePermissionSnapshot(actor)).user;
      if (!viewer || viewer.disabled || viewer.deleted_at) return [];
      const held = (await this.leases.view('', true)).entries.filter(lease => lease.user === viewer.id);
      if (!held.length) return [];
      const assignedKeys = new Set<string>();
      for (const id of await this.ids()) {
        if (!await this.permission(actor, id)) continue;
        const entry = await this.registry.readSource(id);
        if (!entry) return null;
        for (const key of entry.source.resources) assignedKeys.add(key);
      }
      const holdings = new Map<string, UnattributedHolding>();
      for (const lease of held) {
        if (assignedKeys.has(lease.key)) continue;
        holdings.set([lease.run, lease.since, lease.until].join('\0'), {
          booking_run: lease.run, since: lease.since, until: lease.until,
          target: null, assigned: false, can_use: false,
          assignment_reason: '当前没有分配，不能续期或开始新的上机验证；预订仍由你持有',
          target_missing: '预订没有可核验的执行器绑定，目标归属未知',
        });
      }
      return [...holdings.values()];
    } catch {
      return null;
    }
  }

}
