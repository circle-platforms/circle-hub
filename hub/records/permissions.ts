import type { RunRecord } from '../../contracts/src/run.ts';
import type { Principal } from './api.ts';
import { AccessError } from './errors.ts';
import { withRequestPermissions } from './request-permissions.ts';

export function isAdmin(principal: Pick<Principal, 'role'>): boolean {
  return principal.role === 'admin';
}

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
  environmentAccess: { ready: boolean; missing: string | null; nextAction: string | null };
  denials: Array<{ reason: string; nextAction: string }>;
}
export interface MemberCapabilitySources {
  canUsePack(by: Principal, pack: string): Promise<boolean>;
  publicWorkflowIds(): Promise<readonly string[]>;
  packs(by: Principal): Promise<readonly { id: string; version: string; title: string; kind: import('../../contracts/generated/vocabulary.ts').PackKind; space?: string }[]>;
  connections(by: Principal): Promise<readonly { id: string; name: string; systemPack: string; environment: string; enabled: boolean }[]>;
  personalPackUse(by: Principal, owner: string, pack: string): Promise<boolean>;
  environments(by: Principal): Promise<{ ready: boolean; items: readonly MemberEnvironmentCapability[]; missing: string | null; nextAction: string | null }>;
}

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
      teams: [], workflows: [], unassigned_workflows_count: 0, skills: [], connections: [], environments: [],
      environmentAccess: { ready: false, missing: '尚未核对测试环境使用权限', nextAction: '请管理员核对测试环境使用权限接线' },
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
        result.denials.push({ reason: `业务系统「${connection.name}」已停用`, nextAction: '请管理员核对并启用已分配的业务系统' });
        continue;
      }
      result.connections.push({ name: connection.name, systemPack: connection.systemPack, environment: connection.environment });
    }
    const environment = await sources.environments(target);
    result.environmentAccess = { ready: environment.ready, missing: environment.missing, nextAction: environment.nextAction };
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
    result.workflows.sort((a, b) => a.ref.localeCompare(b.ref));
    result.skills.sort((a, b) => a.ref.localeCompare(b.ref));
    result.connections.sort((a, b) => a.name.localeCompare(b.name));
    if (!result.workflows.length) result.denials.push({ reason: '尚无可用的已分配工作流', nextAction: '请管理员把当前账户加入团队并分配工作流，或直接向账户分配工作流' });
    if (!result.skills.length) result.denials.push({ reason: '尚无可用的通用技能', nextAction: '请管理员核对通用技能的安装与使用权限' });
    if (!result.connections.length) result.denials.push({ reason: '尚无可用的已分配业务系统', nextAction: '请管理员向所属团队或全体账户分配所需业务系统' });
    return result;
  });
}
