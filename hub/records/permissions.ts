// Role checks operate on the current account supplied by the calling permission boundary.
import type { RunRecord } from '../../contracts/src/run.ts';
import type { Principal } from './api.ts';
import { AccessError } from './errors.ts';
import { withRequestPermissions } from './request-permissions.ts';

export function isAdmin(principal: Pick<Principal, 'role'>): boolean {
  return principal.role === 'admin';
}

/** This is ownership visibility, not a read-only share or a resource assignment. */
export function canSeeRun(principal: Principal, run: Pick<RunRecord, 'runner' | 'host' | 'pack_space'>): boolean {
  if (run.pack_space && run.pack_space !== 'team') return run.runner === principal.id;
  if (isAdmin(principal)) return true;
  if (run.host === 'hub') return false;
  return run.runner !== undefined && run.runner === principal.id;
}

export interface MemberPackCapability { name: string; ref: string; owner?: string }
export interface MemberConnectionCapability { name: string; systemPack: string; environment: string }
export interface MemberEnvironmentCapability {
  name: string;
  enabled: boolean;
  assigned: boolean;
  can_use: boolean;
  /** null is unknown; [] means no local lease is recorded, never physical idleness. */
  occupancy: Array<{ name: string; since: string; until: string | null; mine: boolean }> | null;
  missing: string[];
}
export interface MemberCapabilities {
  member: { name: string; enabled: boolean };
  teams: string[];
  workflows: MemberPackCapability[];
  unassigned_workflows_count: number;
  skills: MemberPackCapability[];
  connections: MemberConnectionCapability[];
  environments: MemberEnvironmentCapability[];
  /** Own bookings without a verified executor binding; null means the holding read is unknown. */
  unattributed_holdings: Array<{
    booking_run: string; since: string; until: string | null;
    target: null; assigned: false | null; can_use: false;
    assignment_reason: string; target_missing: string;
  }> | null;
  environmentAccess: { ready: boolean; enforced: boolean; missing: string | null; nextAction: string | null };
  denials: Array<{ reason: string; nextAction: string }>;
}
export interface MemberCapabilitySources {
  /** The existing pack permission boundary, including globally installed generic skills. */
  canUsePack(by: Principal, pack: string): Promise<boolean>;
  /** Public workflow IDs with a current non-withdrawn publication; never personal directories. */
  publicWorkflowIds(): Promise<readonly string[]>;
  packs(by: Principal): Promise<readonly { id: string; version: string; title: string; kind: import('../../contracts/generated/vocabulary.ts').PackKind; space?: string }[]>;
  connections(by: Principal): Promise<readonly { id: string; name: string; systemPack: string; environment: string; enabled: boolean }[]>;
  personalPackUse(by: Principal, owner: string, pack: string): Promise<boolean>;
  /** Only already-authorized environments and already-redacted holder names may cross this port. */
  environments(by: Principal): Promise<{ ready: boolean; enforceEnvironmentAssignments?: boolean; items: readonly MemberEnvironmentCapability[]; missing: string | null; nextAction: string | null }>;
  unattributedHoldings(by: Principal): Promise<MemberCapabilities['unattributed_holdings']>;
}

/** One read-only permission projection; caller and target are reloaded, and hidden candidates never become denials. */
export async function memberCapabilities(
  records: Pick<import('./api.ts').RecordsKit, 'principals' | 'teams' | 'authorizations' | 'artifacts'>,
  sources: MemberCapabilitySources,
  by: Principal,
  userId = by.id,
): Promise<MemberCapabilities> {
  const actor = await records.principals.get(by.id);
  if (!actor || actor.disabled || actor.deleted_at || userId !== actor.id && !isAdmin(actor)) throw new AccessError('对象不存在或无权读取');
  const target = userId === actor.id ? actor : await records.principals.get(userId);
  if (!target) throw new AccessError('对象不存在或无权读取');
  return withRequestPermissions(records.artifacts, target, async () => {
    const result: MemberCapabilities = {
      member: { name: target.name, enabled: !target.disabled && !target.deleted_at },
      teams: [], workflows: [], unassigned_workflows_count: 0, skills: [], connections: [], environments: [], unattributed_holdings: null,
      environmentAccess: { ready: false, enforced: false, missing: '尚未核对测试环境使用权限', nextAction: '请管理员核对测试环境使用权限接线' },
      denials: [],
    };
    if (!result.member.enabled) {
      result.denials.push({ reason: '账户已停用或删除', nextAction: '由管理员核对账户状态；未启用前不能使用分配' });
      return result;
    }
    result.teams = (await records.teams.memberships(actor, target.id)).map(team => team.name).sort();
    for (const id of new Set(await sources.publicWorkflowIds())) {
      if (!await sources.canUsePack(target, id)) result.unassigned_workflows_count += 1;
    }
    for (const pack of await sources.packs(target)) {
      const personal = pack.space !== undefined && pack.space !== 'team';
      const allowed = personal
        ? await sources.personalPackUse(target, pack.space!, pack.id)
        : await sources.canUsePack(target, pack.id);
      if (!allowed) continue;
      const item: MemberPackCapability = { name: pack.title, ref: `${pack.id}@${pack.version}` };
      if (personal) {
        const owner = await records.principals.get(pack.space!);
        if (!owner || owner.disabled || owner.deleted_at) continue;
        item.owner = owner.name;
      }
      if (pack.kind === 'workflow') result.workflows.push(item);
      if (pack.kind === 'skill') result.skills.push(item);
    }
    for (const connection of await sources.connections(target)) {
      if (!await records.authorizations.canUseResource(target.id, connection.id)) continue;
      if (!connection.enabled) {
        result.denials.push({ reason: `连接“${connection.name}”已停用`, nextAction: '请管理员核对并启用已分配的连接' });
        continue;
      }
      result.connections.push({ name: connection.name, systemPack: connection.systemPack, environment: connection.environment });
    }
    const environment = await sources.environments(target);
    result.environmentAccess = { ready: environment.ready, enforced: environment.enforceEnvironmentAssignments === true, missing: environment.missing, nextAction: environment.nextAction };
    if (environment.ready) result.environments = environment.items.map(item => ({
      name: item.name,
      enabled: item.enabled,
      assigned: item.assigned,
      can_use: item.can_use,
      occupancy: item.occupancy === null ? null : item.occupancy.map(holder => ({
        name: holder.name, since: holder.since, until: holder.until, mine: holder.mine,
      })),
      missing: [...item.missing],
    }));
    const holdings = await sources.unattributedHoldings(target);
    result.unattributed_holdings = holdings === null ? null : holdings.map(item => ({
      booking_run: item.booking_run, since: item.since, until: item.until,
      target: item.target, assigned: item.assigned, can_use: item.can_use,
      assignment_reason: item.assignment_reason, target_missing: item.target_missing,
    }));
    result.workflows.sort((a, b) => a.ref.localeCompare(b.ref));
    result.skills.sort((a, b) => a.ref.localeCompare(b.ref));
    result.connections.sort((a, b) => a.name.localeCompare(b.name));
    if (!result.workflows.length) result.denials.push({ reason: '尚无可用的已分配工作流', nextAction: '请管理员把你加入团队并分配工作流，或直接向账户分配工作流' });
    if (!result.skills.length) result.denials.push({ reason: '尚无可用的通用技能', nextAction: '请管理员核对通用技能的安装与使用权限' });
    if (!result.connections.length) result.denials.push({ reason: '尚无可用的已分配连接', nextAction: '请管理员向你所属团队或全体账户分配所需连接' });
    if (environment.ready && !result.environments.some(item => item.assigned)) result.denials.push({ reason: '尚无已分配的运行环境', nextAction: '请管理员向账户或所属团队分配运行环境' });
    return result;
  });
}
