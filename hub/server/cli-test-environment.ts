// Ordinary environment management, with names at the CLI boundary and one records-owned catalog.
import { TestEnvironmentInput } from '../../contracts/src/resources.ts';
import { ExecutorNames } from '../dispatch/api.ts';
import type { Principal, RecordsKit } from '../records/api.ts';
import { decided, parse } from './cli-arguments.ts';
import { CliError, UsageError } from './errors.ts';
import { environmentPermissionSources } from './env-permission-sources.ts';

export const TEST_ENVIRONMENT_USAGE = 'list | register <名字> --target <目标> [--prefix <前缀>…] [--resource <键>…] [--executor <执行器名字>…] | update <名字> [--name <新名字>] [--prefix <前缀>…] [--resource <键>…] [--executor <执行器名字>…] [--enable|--disable] | remove <名字> | assign|unassign <名字> (--team <团队名字> | --user <账户名字> | --all) [--expires-at <到期时间>] [--note <说明>]';
export interface TestEnvironmentCommandSession {
  admin(): Promise<Principal>;
  records(): Promise<RecordsKit>;
  out(line: string): void;
}

async function continueApprovedInheritance(records: RecordsKit, by: Principal): Promise<void> {
  const state = await records.testEnvironments.inheritance();
  if (state.completed === false) await records.testEnvironments.inherit(by, environmentPermissionSources());
}

export async function testEnvironmentCommand(session: TestEnvironmentCommandSession, args: readonly string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === 'list') {
    parse(rest, {}, 0);
    const by = await session.admin(), records = await session.records();
    const environments = await records.testEnvironments.list(by);
    if (!environments.length) session.out('还没有登记测试环境');
    for (const environment of environments) session.out(`${environment.name ?? '尚未命名的测试环境'}\t${environment.target ?? '目标归属未知'}\t${environment.enabled ? '已启用' : '已停用'}`);
    return 0;
  }
  if (action === 'register' || action === 'update') {
    const { positionals, values } = parse(rest, { target: { type: 'string' }, prefix: { type: 'string', multiple: true }, resource: { type: 'string', multiple: true }, executor: { type: 'string', multiple: true }, name: { type: 'string' }, enable: { type: 'boolean' }, disable: { type: 'boolean' }, 'clear-prefixes': { type: 'boolean' }, 'clear-resources': { type: 'boolean' }, 'clear-executors': { type: 'boolean' } }, 1);
    if (action === 'register' && !values.target) throw new UsageError('登记测试环境须写 --target <目标>');
    if (action === 'register' && (values.name !== undefined || values.enable || values.disable || values['clear-prefixes'] || values['clear-resources'] || values['clear-executors'])) throw new UsageError('登记只写明确名字和目标；编辑选项用于 update');
    if (values.enable && values.disable) throw new UsageError('启用和停用不能同时指定');
    if (values.prefix && values['clear-prefixes'] || values.resource && values['clear-resources'] || values.executor && values['clear-executors']) throw new UsageError('同一登记字段不能同时替换和清空');
    const by = await session.admin(), records = await session.records();
    const existing = action === 'update' ? (await records.testEnvironments.list(by)).find(row => row.name === positionals[0]) : null;
    if (action === 'update' && !existing) throw new CliError('测试环境不存在', '请核对测试环境名字');
    if (existing && values.target !== undefined && values.target !== existing.target) throw new UsageError('不能把已有分配转给另一目标；请另行登记新的测试环境');
    const names = values.executor?.length ? await new ExecutorNames(records).list(by) : [];
    const executors = (values.executor ?? []).map(name => {
      const found = names.find(row => row.name === name);
      if (!found) throw new CliError(`没有名为「${name}」的执行器`, '请在控制台核对已登记的执行器名字');
      return found.executor;
    });
    const at = new Date().toISOString();
    const input = TestEnvironmentInput.parse({ name: values.name ?? existing?.name ?? positionals[0], target: values.target ?? existing?.target, enabled: values.disable ? false : values.enable ? true : existing?.enabled ?? true,
      prefixes: values.prefix ? values.prefix.map(prefix => existing?.prefixes.find(row => row.prefix === prefix) ?? { prefix, owner: by.id, registered_at: at }) : values['clear-prefixes'] ? [] : existing?.prefixes ?? [],
      resources: values.resource ? values.resource.map(key => existing?.resources.find(row => row.key === key) ?? { key, owner: by.id, registered_at: at }) : values['clear-resources'] ? [] : existing?.resources ?? [],
      executors: values.executor ? executors : values['clear-executors'] ? [] : existing?.executors ?? [], missing_facts: [] });
    await continueApprovedInheritance(records, by);
    const registered = await decided(() => existing ? records.testEnvironments.update(by, existing.id, input) : records.testEnvironments.register(by, input));
    session.out(`${existing ? '已更新' : '已登记'}测试环境「${registered.name}」`);
    return 0;
  }
  if (action === 'remove' || action === 'assign' || action === 'unassign') {
    const { positionals, values } = parse(rest, { team: { type: 'string' }, user: { type: 'string' }, all: { type: 'boolean' }, 'expires-at': { type: 'string' }, note: { type: 'string' } }, 1);
    if (action === 'remove' && Object.keys(values).length) throw new UsageError('注销测试环境只写名字；分配选项用于 assign 或 unassign');
    if (action !== 'remove' && Number(values.team !== undefined) + Number(values.user !== undefined) + Number(values.all === true) !== 1) throw new UsageError('测试环境分配须且只能指定团队、账户或全体成员');
    if (action === 'unassign' && values['expires-at'] !== undefined) throw new UsageError('撤回分配不指定到期时间');
    const by = await session.admin(), records = await session.records();
    await continueApprovedInheritance(records, by);
    const found = (await records.testEnvironments.list(by)).filter(row => row.name === positionals[0]);
    if (found.length !== 1) throw new CliError('测试环境名字不存在或不唯一', '请在控制台核对测试环境登记');
    const environment = found[0];
    if (action === 'remove') {
      await decided(() => records.testEnvironments.remove(by, environment.id));
      session.out(`已注销测试环境「${environment.name}」`); return 0;
    }
    const recipient = values.team !== undefined
      ? (await records.teams.list(by)).find(team => team.name === values.team)
      : values.user !== undefined ? await records.principals.findByName(values.user) : null;
    if (values.all !== true && !recipient) throw new CliError(values.team !== undefined ? '团队不存在' : '账户不存在', '请核对名称');
    const subject = values.all === true ? '*' : recipient!.id;
    if (action === 'assign') await decided(() => records.authorizations.assignResource(by, environment.id, subject, { expiresAt: values['expires-at'], note: values.note }));
    else await decided(() => records.authorizations.unassignResource(by, environment.id, subject, values.note));
    session.out(action === 'assign' ? `测试环境「${environment.name}」已分配给${values.all ? '全体成员' : '「' + recipient!.name + '」'}` : `已撤回测试环境「${environment.name}」给${values.all ? '全体成员' : '「' + recipient!.name + '」'}的分配`);
    return 0;
  }
  throw new UsageError(`bed 的测试环境管理命令：${TEST_ENVIRONMENT_USAGE}`);
}
