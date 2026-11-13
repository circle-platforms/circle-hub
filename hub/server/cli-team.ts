import { TeamId, type PermissionRole } from '../../contracts/api.ts';
import { isAdmin, type RecordsKit } from '../records/api.ts';
import { parse, decided } from './cli-arguments.ts';
import type { Session } from './cli-session.ts';
import { CliError, UsageError } from './errors.ts';

export const TEAM_USAGE = 'team list | show <团队ID> | create <名字> | delete <团队ID> | add <团队ID> <账户名或ID> | remove <团队ID> <账户名或ID>';
export type TeamCommandSession = Pick<Session, 'member' | Extract<keyof Session, PermissionRole> | 'out'> & { records(): Promise<Pick<RecordsKit, 'teams'>> };

export function teamId(value: string): string {
  const parsed = TeamId.safeParse(value);
  if (!parsed.success) throw new UsageError('团队须使用有效的团队编号');
  return parsed.data;
}

export async function teamCommand(session: TeamCommandSession, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  const handlers: Record<string, () => Promise<number>> = {
    list: async () => {
      parse(rest, {}, 0);
      const by = await session.member(), records = await session.records();
      const teams = await decided(() => records.teams.list(by));
      for (const team of teams) session.out(isAdmin(by) ? `${team.id}\t${team.name}` : team.name);
      return 0;
    },
    show: async () => {
      const { positionals } = parse(rest, {}, 1), id = teamId(positionals[0]);
      const by = await session.member(), records = await session.records();
      const team = await decided(() => records.teams.get(by, id));
      if (team === null) throw new CliError('团队不可用');
      if (!isAdmin(by)) { session.out(team.name); return 0; }
      session.out(`${team.id}\t${team.name}`);
      const members = await decided(() => records.teams.members(by, id));
      for (const member of members) session.out(`成员\t${member.user.id}\t${member.user.name}`);
      const assignments = await decided(() => records.teams.assignments(by, id));
      for (const assignment of assignments.packs) session.out(`工作流\t${assignment.body.object}`);
      for (const assignment of assignments.resources) session.out(`资源\t${assignment.body.object}`);
      return 0;
    },
    create: async () => {
      const { positionals } = parse(rest, {}, 1);
      const by = await session.admin(), records = await session.records();
      const team = await decided(() => records.teams.create(by, positionals[0]));
      session.out(`已创建团队 ${team.name}（${team.id}）`);
      return 0;
    },
    delete: async () => {
      const { positionals } = parse(rest, {}, 1), id = teamId(positionals[0]);
      const by = await session.admin(), records = await session.records();
      const team = await decided(() => records.teams.delete(by, id));
      session.out(`已删除团队 ${team.name}（${team.id}）；撤回工作流分配 ${team.revoked_packs} 条、资源分配 ${team.revoked_resources} 条`);
      return 0;
    },
    add: async () => membership(true),
    remove: async () => membership(false),
  };
  async function membership(add: boolean): Promise<number> {
    const { positionals } = parse(rest, {}, 2), id = teamId(positionals[0]);
    const by = await session.admin(), records = await session.records(), user = await session.user(positionals[1]);
    if (add) {
      await decided(() => records.teams.add(by, id, user.id));
      session.out(`已将 ${user.name} 加入团队 ${id}`);
    } else {
      const removed = await decided(() => records.teams.remove(by, id, user.id));
      session.out(removed ? `已将 ${user.name} 移出团队 ${id}` : `${user.name} 不在团队 ${id} 中`);
    }
    return 0;
  }
  const handler = sub !== undefined && Object.hasOwn(handlers, sub) ? handlers[sub] : undefined;
  if (handler === undefined) throw new UsageError(`用法：circle-hub ${TEAM_USAGE}`);
  return handler();
}
