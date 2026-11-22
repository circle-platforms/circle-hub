import { TeamId } from '../../contracts/api.ts';
import { isAdmin, type Principal, type RecordsKit } from '../records/api.ts';
import { parse, decided } from './cli-arguments.ts';
import type { Session } from './cli-session.ts';
import { CliError, UsageError } from './errors.ts';

export const TEAM_USAGE = 'team list | show <团队名或ID> | create <名字> | delete <团队名或ID> | add <团队名或ID> <账户名或ID> | remove <团队名或ID> <账户名或ID>';
export type TeamCommandSession = Pick<Session, 'member' | 'admin' | 'user' | 'out'> & { records(): Promise<Pick<RecordsKit, 'teams'>> };

export function teamId(value: string): string {
  const parsed = TeamId.safeParse(value);
  if (!parsed.success) throw new UsageError('团队须使用有效的团队编号');
  return parsed.data;
}

/**
 * The team a command names: by its number, or by its name as an account is named. The command line never prints team
 * numbers (list and create give names), so a name has to be enough for the commands that take a team.
 */
export async function teamOf(teams: Pick<RecordsKit['teams'], 'list'>, by: Principal, value: string): Promise<string> {
  const parsed = TeamId.safeParse(value);
  if (parsed.success) return parsed.data;
  const named = (await decided(() => teams.list(by))).filter((team) => team.name === value);
  if (named.length === 1) return named[0]!.id;
  if (named.length > 1) throw new UsageError(`有 ${named.length} 个团队都叫「${value.slice(0, 80)}」；请在控制台的团队页里操作其中一个`);
  throw new UsageError(`没有叫「${value.slice(0, 80)}」的团队；团队的名字用 circle-hub team list 查看`);
}

export async function teamCommand(session: TeamCommandSession, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  const handlers: Record<string, () => Promise<number>> = {
    list: async () => {
      parse(rest, {}, 0);
      const by = await session.member(), records = await session.records();
      const teams = await decided(() => records.teams.list(by));
      for (const team of teams) session.out(team.name);
      return 0;
    },
    show: async () => {
      const { positionals } = parse(rest, {}, 1);
      const by = await session.member(), records = await session.records();
      const id = await teamOf(records.teams, by, positionals[0]);
      const team = await decided(() => records.teams.get(by, id));
      if (team === null) throw new CliError('团队不可用');
      if (!isAdmin(by)) { session.out(team.name); return 0; }
      session.out(team.name);
      const members = await decided(() => records.teams.members(by, id));
      for (const member of members) session.out(`成员\t${member.user.name}`);
      const assignments = await decided(() => records.teams.assignments(by, id));
      for (const assignment of assignments.packs) session.out(`工作流\t${assignment.body.object}`);
      for (const assignment of assignments.resources) session.out(`资源\t${assignment.body.object}`);
      return 0;
    },
    create: async () => {
      const { positionals } = parse(rest, {}, 1);
      const by = await session.admin(), records = await session.records();
      const team = await decided(() => records.teams.create(by, positionals[0]));
      session.out(`已创建团队 ${team.name}`);
      return 0;
    },
    delete: async () => {
      const { positionals } = parse(rest, {}, 1);
      const by = await session.admin(), records = await session.records();
      const id = await teamOf(records.teams, by, positionals[0]);
      const team = await decided(() => records.teams.delete(by, id));
      session.out(`已删除团队 ${team.name}；撤回工作流分配 ${team.revoked_packs} 条、资源分配 ${team.revoked_resources} 条`);
      return 0;
    },
    add: async () => membership(true),
    remove: async () => membership(false),
  };
  async function membership(add: boolean): Promise<number> {
    const { positionals } = parse(rest, {}, 2);
    const by = await session.admin(), records = await session.records(), user = await session.user(positionals[1]);
    const id = await teamOf(records.teams, by, positionals[0]);
    const team = await decided(() => records.teams.get(by, id));
    const teamName = team?.name ?? '团队';
    if (add) {
      await decided(() => records.teams.add(by, id, user.id));
      session.out(`已将 ${user.name} 加入团队 ${teamName}`);
    } else {
      const removed = await decided(() => records.teams.remove(by, id, user.id));
      session.out(removed ? `已将 ${user.name} 移出团队 ${teamName}` : `${user.name} 不在团队 ${teamName} 中`);
    }
    return 0;
  }
  const handler = sub !== undefined && Object.hasOwn(handlers, sub) ? handlers[sub] : undefined;
  if (handler === undefined) throw new UsageError(`用法：circle-hub ${TEAM_USAGE}`);
  return handler();
}
