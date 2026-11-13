// Role checks operate on the current account supplied by the calling permission boundary.
import type { RunRecord } from '../../contracts/src/run.ts';
import type { Principal } from './api.ts';
import { AccessError } from './errors.ts';

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
  occupancy: null | { since: string; until: string | null; mine: boolean; holder?: string };
}
export interface MemberCapabilities {
  member: { name: string; enabled: boolean };
  teams: string[];
  workflows: MemberPackCapability[];
  skills: MemberPackCapability[];
  connections: MemberConnectionCapability[];
  environments: MemberEnvironmentCapability[];
  environmentAccess: { ready: boolean; missing: string | null; nextAction: string | null };
  denials: Array<{ reason: string; nextAction: string }>;
}
export interface MemberCapabilitySources {
  packs(by: Principal): Promise<readonly { id: string; version: string; title: string; kind: import('../../contracts/generated/vocabulary.ts').PackKind; space?: string }[]>;
  connections(by: Principal): Promise<readonly { id: string; name: string; systemPack: string; environment: string; enabled: boolean }[]>;
  personalPackUse(by: Principal, owner: string, pack: string): Promise<boolean>;
  /** Only already-authorized environments and already-redacted holder names may cross this port. */
  environments(by: Principal): Promise<{ ready: boolean; items: readonly MemberEnvironmentCapability[]; missing: string | null; nextAction: string | null }>;
}

/** One read-only permission projection; caller and target are reloaded, and hidden candidates never become denials. */
export async function memberCapabilities(
  records: Pick<import('./api.ts').RecordsKit, 'principals' | 'teams' | 'authorizations'>,
  sources: MemberCapabilitySources,
  by: Principal,
  userId = by.id,
): Promise<MemberCapabilities> {
  const actor = await records.principals.get(by.id);
  if (!actor || actor.disabled || actor.deleted_at || userId !== actor.id && !isAdmin(actor)) throw new AccessError('对象不存在或无权读取');
  const target = userId === actor.id ? actor : await records.principals.get(userId);
  if (!target) throw new AccessError('对象不存在或无权读取');
  const result: MemberCapabilities = {
    member: { name: target.name, enabled: !target.disabled && !target.deleted_at },
    teams: [], workflows: [], skills: [], connections: [], environments: [],
    environmentAccess: { ready: false, missing: '尚未核对测试环境使用权限', nextAction: '请管理员核对测试环境使用权限接线' },
    denials: [],
  };
  if (!result.member.enabled) {
    result.denials.push({ reason: '账户已停用或删除', nextAction: '由管理员核对账户状态；未启用前不能使用分配' });
    return result;
  }
  result.teams = (await records.teams.memberships(actor, target.id)).map(team => team.name).sort();
  for (const pack of await sources.packs(target)) {
    const personal = pack.space !== undefined && pack.space !== 'team';
    const allowed = personal
      ? await sources.personalPackUse(target, pack.space!, pack.id)
      : await records.authorizations.canUse(target.id, pack.id);
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
  result.environmentAccess = { ready: environment.ready, missing: environment.missing, nextAction: environment.nextAction };
  if (environment.ready) result.environments = environment.items.map(item => ({
    name: item.name,
    occupancy: item.occupancy === null ? null : {
      since: item.occupancy.since, until: item.occupancy.until, mine: item.occupancy.mine,
      ...(item.occupancy.holder === undefined ? {} : { holder: item.occupancy.holder }),
    },
  }));
  result.workflows.sort((a, b) => a.ref.localeCompare(b.ref));
  result.skills.sort((a, b) => a.ref.localeCompare(b.ref));
  result.connections.sort((a, b) => a.name.localeCompare(b.name));
  if (!result.workflows.length && !result.skills.length) result.denials.push({ reason: '尚无可用的工作流或通用技能', nextAction: '请管理员把你加入团队并分配工作流或技能，或直接向账户分配' });
  if (!result.connections.length) result.denials.push({ reason: '尚无可用的已分配连接', nextAction: '请管理员向你所属团队或全体账户分配所需连接' });
  return result;
}
