// `circle-hub <command>`: the server's commands. main(argv) returns the exit code and never runs on import (bin/circle-hub
// calls it). Platform commands go to hub/platform's runPlatformCommand; serve is main.ts; user, token, logs and run need only
// records (run show the assembly module's command-time assembly; run list the same records, administrator only); pack,
// resource, secret, knowledge, init-admin, operator-token and anything else the assembly module registers through
// registerCommand. The built-in commands that change state (user create once an admin exists, user disable|enable, token
// issue|revoke) act as the admin of the operator token (CIRCLE_HUB_TOKEN, else the deployment's keychain item), like the
// assembly's; the read-only ones that read as an account (logs export, run show) read as the token's account, like the
// assembly's listings. run list is read-only and refuses every account that is not an administrator. Output is Chinese, made safe for a
// terminal (stored text may come from users' documents), and never shows a secret: a token is printed once, when it is
// issued, and never again.
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PARTITION, PERMISSION_ROLE, isPermissionRole, labelOf, type PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { HubConfigError, HubEnvironmentError, assertNoRetiredEnvironment, type HubConfig } from '../config/index.ts';
import { PLATFORM_COMMANDS, hubKeyProvider, isPlatformCommand, liveKeyPipe, runPlatformCommand } from '../platform/api.ts';
import { RecordsError, openRecords, type CallLogLine, type Principal, type RecordsKit, type User } from '../records/index.ts';
import type { AssemblyModule, CliCommand, CliContext, CliIo, RegisterCommand, ServerDeps } from './api.ts';
import { OPERATOR_TOKEN_VARIABLE, takeEnvironmentToken, type OperatorTokenStore } from './assemble/operator-token.ts';
import { jsonSafe, terminalSafe } from './assemble/terminal.ts';
import type { OperatorAct } from './cli-admin.ts';
import { AssemblyMissingError, CliError, UsageError, isAssemblyMissing } from './errors.ts';
import { SERVE_USAGE, loadServerConfig, prepareDatabase, serve, type ServeOptions } from './main.ts';
import { localToolsCommand, LOCAL_TOOLS_USAGE } from './cli-local-tools.ts';
import { listRunInventory, RUN_LIST_DEFAULT_LIMIT, RUN_LIST_MAX_LIMIT, RUN_LIST_STATES, runListLines, type RunListState } from './run-list.ts';
import { countsLine } from './text.ts';
import { issueSetupCode } from './setup-code.ts';

export interface CliOptions extends Omit<ServeOptions, 'io'> {
  io: CliIo;
  /**
   * Where the built-in state-changing commands find the operator token when CIRCLE_HUB_TOKEN is not set; default the
   * deployment's keychain item (as the assembly's commands). Tests pass a store of their own: never the owner's keychain.
   */
  operatorTokens?: (config: HubConfig, service: string) => OperatorTokenStore;
}

/** Commands the assembly module registers; while the module in use does not, they print a clear message. */
interface ReservedCommandDescriptions {
  readonly skill:string;
  readonly pack:string;
  readonly resource:string;
  readonly secret:string;
  readonly knowledge:string;
  readonly 'init-admin':string;
  readonly 'operator-token':string;
}
const RESERVED_COMMAND_DESCRIPTIONS: ReservedCommandDescriptions = {
  pack: '管理任务包',
  skill:'管理通用技能包的迁移声明',
  resource: '管理资源声明',
  secret: '管理密钥库条目',
  knowledge: '读取和管理知识树',
  'init-admin': '初始化管理员',
  'operator-token': '管理操作令牌',
};
export const RESERVED_COMMANDS: readonly string[] = Object.keys(RESERVED_COMMAND_DESCRIPTIONS);
const BUILT_IN = new Set(['help', 'serve', 'user', 'token', 'logs', 'run', 'local-tools', 'setup-code']);
const COMMAND_NAME = /^[a-z][a-z0-9-]{1,30}$/;

const registry = new Map<string, CliCommand>();

/** Adds a command (the assembly step calls this). Built-in and platform names cannot be replaced; a name is registered once. */
export function registerCommand(command: CliCommand): void {
  if (typeof command?.name !== 'string' || !COMMAND_NAME.test(command.name) || typeof command.run !== 'function') throw new TypeError('a command has a lowercase name and a run function');
  if (BUILT_IN.has(command.name) || isPlatformCommand(command.name)) throw new Error(`命令 ${command.name} 是内置命令，不能替换`);
  if (registry.has(command.name)) throw new Error(`命令 ${command.name} 已经注册过`);
  registry.set(command.name, command);
}

export function registeredCommands(): CliCommand[] {
  return [...registry.values()];
}

function usage(extra: readonly CliCommand[]): string {
  const lines = [
    '用法：circle-hub <命令>',
    '',
    `  ${SERVE_USAGE}`,
    `  user create <名字> [--role ${PERMISSION_ROLE.join('|')}]   建用户；还没有管理员时先建第一位管理员，并只显示一次它的令牌`,
    '  user list                                    列出用户',
    '  user disable|enable <用户>                    停用或恢复一个账号（停用立即生效）',
    '  token issue <用户> [--label <标签>] [--raw]    签发令牌，令牌只显示这一次；--raw 时标准输出上只有令牌和换行，确认写到标准错误',
    '  token revoke <令牌编号>                        撤销令牌（立即生效）',
    '  token list [<用户>]                           列出令牌（不显示令牌值）',
    '  logs export [--from <时间>] [--to <时间>] [--user <用户>] [--tool <工具>] [--run <运行>] [--out <文件>] [--as <管理员>]   导出调用日志（JSON Lines）',
    `  ${LOCAL_TOOLS_USAGE}`,
    '  setup-code                                   还没有管理员时，给网页控制台发一个设置码（24 小时内有效，只显示一次），在 /console/setup 用它建第一位管理员',
    '  run abandon <运行> --answer-request <摘要> --reason <理由>  管理放弃目标，原效果与冻结不改',
    '  run list [--pack <包>] [--user <用户>] [--state 受理|未受理|进行中] [--since <ISO时间>] [--unknown] [--limit <N>] [--cursor <游标>] [--json] [--as <管理员>]  列出运行（仅管理员；默认 50 条，新到旧，超出给下一页游标）',
    '  run show <运行> [--json] [--as <管理员>]        显示一次运行',
    ...extra.map((command) => `  ${command.name.padEnd(44)} ${command.summary}`),
    ...Object.entries(RESERVED_COMMAND_DESCRIPTIONS).filter(([name]) => !extra.some((command) => command.name === name)).map(([name, description]) => `  ${name.padEnd(44)} ${description}；由装配模块注册；这个装配模块没有注册它`),
    '',
    `平台命令 ${PLATFORM_COMMANDS.join('、')} 由 hub/platform 执行（例如 circle-hub status），用法见 hub/platform/README.md。`,
    `改变状态的命令（建用户、停用、恢复、签发和撤销令牌，以及装配模块的这类命令）以操作令牌的管理员身份执行：${OPERATOR_TOKEN_VARIABLE}（只给一条命令：${OPERATOR_TOKEN_VARIABLE}="$T" circle-hub <命令>），没有时用钥匙串里的操作令牌（init-admin、operator-token set 或 operator-token reissue 存进去）。`,
    '只读命令（logs export、run show 和装配模块的列表）有操作令牌时以令牌的账号读，--as 只能写这个账号；没有令牌时 --as 指明以哪位管理员的身份读，只有一位启用中的管理员时可以省略。',
    'run list 也是只读，但只允许管理员；普通用户的令牌会被拒绝。它按已有的运行和验证结果列出，不新写存储，不输出提交正文、引文或凭据。--limit 默认 50，最大 500，按开始时间新到旧；还有更多时给出下一页游标，不悄悄截断。未知和各要求项终态取最新一条已受理结果，没有已受理结果时未知为 0、终态为无。验证状态取最新一条验证结果：没有结果是进行中。',
  ];
  return lines.join('\n');
}

/** A state-changing command takes no --as: who it acts as is the operator token's account. */
function noAs(as: string | undefined): void {
  if (as !== undefined) {
    throw new UsageError(`改变状态的命令不用 --as：它以操作令牌的管理员身份执行（${OPERATOR_TOKEN_VARIABLE}，没有时用钥匙串里的操作令牌）`);
  }
}

/** The operator token rules of the assembly's commands (hub/server/cli-admin.ts, loaded only when a command needs them). */
async function tokenRules(options: CliOptions) {
  const rules = await import('./cli-admin.ts');
  const tokens = options.operatorTokens === undefined ? {} : { tokens: options.operatorTokens };
  return {
    /** The enabled admin of the operator token, for a built-in state-changing command. */
    member:(ctx:CliContext):Promise<Principal>=>rules.operatorMember(ctx,tokens),
    admin: (ctx: CliContext): Promise<Principal> => rules.operatorAdmin(ctx, tokens),
    /** The same, for a command that may cut off its own token (token revoke, user disable). */
    act: (ctx: CliContext): Promise<OperatorAct> => rules.operatorAct(ctx, tokens),
    /** Who a built-in read-only command reads as: the operator token's account, else --as or the only enabled admin. */
    viewer: (ctx: CliContext, as: string | undefined): Promise<Principal> => rules.operatorViewer(ctx, tokens, as),
  };
}

async function operatorOf(ctx: CliContext, options: CliOptions): Promise<Principal> {
  return (await tokenRules(options)).admin(ctx);
}

/** What a state-changing built-in says after it ran when it cut off the operator token it acted with. */
async function sayIfLost(io: CliIo, act: OperatorAct): Promise<void> {
  const notice = await act.noticeIfLost();
  if (notice !== null) io.stderr(terminalSafe(`注意：${notice}`));
}

/** A line of stored text (names, labels, ids from users' documents) for the terminal: control characters as escapes. */
const out = (io: CliIo, line: string): void => io.stdout(terminalSafe(line));

function parse<T extends Record<string, { type: 'string' | 'boolean' }>>(args: readonly string[], options: T, positionals: number) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== positionals) throw new UsageError(`需要 ${positionals} 个参数，给了 ${parsed.positionals.length} 个`);
  return parsed;
}

/**
 * The context of one CLI invocation: configuration (CIRCLE_HUB_TOKEN accepted, for the operator token) and records are
 * opened lazily, once, and closed at the end; the full dependencies come from the module's command-time assembly.
 */
function contextFor(options: CliOptions, assembly: () => Promise<AssemblyModule>): CliContext & { close(): Promise<void> } {
  let config: HubConfig | undefined;
  let records: Promise<RecordsKit> | undefined;
  const ctx = {
    io: options.io,
    config(): HubConfig {
      config ??= loadServerConfig(options.io.env, { command: true });
      return config;
    },
    records(): Promise<RecordsKit> {
      records ??= (async () => {
        const loaded = ctx.config();
        await prepareDatabase(loaded, options);
        return openRecords(loaded, { keyProvider: (options.keyProvider ?? hubKeyProvider)(options.io.env), migrate: false, ...(options.now ? { now: options.now } : {}) });
      })();
      return records;
    },
    async deps(): Promise<ServerDeps> {
      const module = await assembly();
      // Never serve's assemble: a command needs neither the vault master key nor the sandbox probe.
      if (module.assembleCommand === undefined) {
        throw new AssemblyMissingError('这个装配模块没有给单条命令用的装配（assembleCommand），要用运行、知识或连接器模块的命令用不了');
      }
      return module.assembleCommand(ctx.config(), await ctx.records(), { stderr: (line) => options.io.stderr(line) });
    },
    async actingAdmin(as?: string): Promise<Principal> {
      const kit = await ctx.records();
      if (as !== undefined) {
        const user = await findUser(kit, as);
        if (user === null || user.role !== 'admin' || user.disabled) throw new CliError(`${as} 不是启用中的管理员`);
        return { id: user.id, name: user.name, role: user.role };
      }
      const admins = (await kit.principals.list()).filter((user) => user.role === 'admin' && !user.disabled);
      if (admins.length === 0) throw new CliError('还没有管理员', '先建第一位管理员：circle-hub user create <名字> --role admin');
      if (admins.length > 1) throw new CliError('有多位管理员，要用 --as <名字> 指明以谁的身份操作');
      return { id: admins[0].id, name: admins[0].name, role: admins[0].role };
    },
    async close(): Promise<void> {
      if (records !== undefined) await (await records.catch(() => null))?.close();
    },
  };
  return ctx;
}

async function findUser(kit: RecordsKit, nameOrId: string): Promise<User | null> {
  return /^usr_[0-9a-z]{26}$/.test(nameOrId) ? kit.principals.get(nameOrId) : kit.principals.findByName(nameOrId);
}

async function requireUser(kit: RecordsKit, nameOrId: string): Promise<User> {
  const user = await findUser(kit, nameOrId);
  if (user === null) throw new CliError(`没有用户 ${nameOrId}`);
  return user;
}

const roleText = (role: PermissionRole) => labelOf('permission_role', role);

async function userCommand(args: readonly string[], ctx: CliContext, options: CliOptions): Promise<number> {
  const [sub, ...rest] = args;
  const io = ctx.io;
  if (sub === 'create') {
    const { values, positionals } = parse(rest, { role: { type: 'string' }, as: { type: 'string' } }, 1);
    noAs(values.as);
    const role = values.role ?? 'user';
    if (!isPermissionRole(role)) throw new UsageError(`角色只能是 ${PERMISSION_ROLE.map((code) => `${code}（${roleText(code)}）`).join('、')}`);
    const kit = await ctx.records();
    const admins = (await kit.principals.list()).filter((user) => user.role === 'admin');
    if (admins.length === 0) {
      if (role !== 'admin') throw new CliError('还没有管理员', '先建第一位管理员：circle-hub init-admin <名字>（令牌存进钥匙串），或 circle-hub user create <名字> --role admin（令牌显示一次）');
      const { user, token } = await kit.principals.bootstrapAdmin(positionals[0]);
      out(io, `已建立第一位管理员 ${user.name}（${user.id}）`);
      io.stdout(`它的令牌 ${token.id} 只显示这一次，请立即保存到只有你能读的地方：`);
      io.stdout(token.token);
      return 0;
    }
    const by = await operatorOf(ctx, options);
    const user = await kit.principals.createUser(by, positionals[0], role);
    out(io, `已建立用户 ${user.name}（${user.id}，${roleText(user.role)}）；令牌用 circle-hub token issue ${user.name} 签发`);
    return 0;
  }
  if (sub === 'list') {
    parse(rest, {}, 0);
    const kit = await ctx.records();
    const users = await kit.principals.list();
    if (users.length === 0) io.stdout('还没有用户');
    for (const user of users) out(io, [user.id, user.name, roleText(user.role), user.disabled ? '停用' : '启用', user.created_at].join('\t'));
    return 0;
  }
  if (sub === 'disable' || sub === 'enable') {
    const { values, positionals } = parse(rest, { as: { type: 'string' } }, 1);
    noAs(values.as);
    const act = await (await tokenRules(options)).act(ctx);
    const kit = await ctx.records();
    const user = await requireUser(kit, positionals[0]);
    const changed = await kit.principals.setDisabled(act.admin, user.id, sub === 'disable');
    out(io, `${changed.name}（${changed.id}）已${changed.disabled ? '停用：它的令牌立即失效' : '恢复'}`);
    // Disabling the operator token's own account cuts it off: say so, and how to recover (records keep an enabled admin).
    if (changed.disabled) await sayIfLost(io, act);
    return 0;
  }
  throw new UsageError('user 的子命令是 create、list、disable 或 enable');
}

async function tokenCommand(args: readonly string[], ctx: CliContext, options: CliOptions): Promise<number> {
  const [sub, ...rest] = args;
  const io = ctx.io;
  if (sub === 'issue') {
    const { values, positionals } = parse(rest, { label: { type: 'string' }, raw: { type: 'boolean' }, as: { type: 'string' } }, 1);
    noAs(values.as);
    const by = await operatorOf(ctx, options);
    const kit = await ctx.records();
    const user = await requireUser(kit, positionals[0]);
    const token = await kit.principals.issueToken(by, user.id, values.label ?? '');
    const issued = terminalSafe(`已为 ${user.name} 签发令牌 ${token.id}${token.label ? `（${token.label}）` : ''}`);
    if (values.raw === true) {
      // TOKEN=$(circle-hub token issue <user> --raw): stdout holds the token and a newline only, nothing to log.
      io.stderr(`${issued}；令牌只在标准输出上出现这一次`);
      io.stdout(token.token);
      return 0;
    }
    io.stdout(`${issued}。令牌只显示这一次，请立即保存到只有使用者能读的地方：`);
    io.stdout(token.token);
    return 0;
  }
  if (sub === 'revoke') {
    const { values, positionals } = parse(rest, { as: { type: 'string' } }, 1);
    noAs(values.as);
    const act = await (await tokenRules(options)).act(ctx);
    const kit = await ctx.records();
    const revoked = await kit.principals.revokeToken(act.admin, positionals[0]);
    if (!revoked) throw new CliError(`没有令牌 ${positionals[0]}，或它已经撤销`);
    out(io, `令牌 ${positionals[0]} 已撤销，立即失效`);
    // Revocation is never refused (it is how a leaked token is stopped); revoking the operator token itself is said, with
    // the way back (operator-token reissue), since nothing else then holds an admin token.
    await sayIfLost(io, act);
    return 0;
  }
  if (sub === 'list') {
    const { positionals } = parse(rest, {}, rest.length === 0 ? 0 : 1);
    const kit = await ctx.records();
    const users = positionals.length === 0 ? await kit.principals.list() : [await requireUser(kit, positionals[0])];
    let count = 0;
    for (const user of users) {
      for (const token of await kit.principals.tokens(user.id)) {
        count += 1;
        out(io, [token.id, user.name, token.label || '—', token.created_at, token.last_used_at ?? '未用过', token.revoked_at === null ? '有效' : `已撤销 ${token.revoked_at}`].join('\t'));
      }
    }
    if (count === 0) io.stdout('没有令牌');
    return 0;
  }
  throw new UsageError('token 的子命令是 issue、revoke 或 list');
}

function isoTime(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new UsageError(`${flag} 不是时间，例如 2026-10-21T08:00:00Z`);
  return new Date(time).toISOString();
}

async function logsCommand(args: readonly string[], ctx: CliContext, options: CliOptions): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'export') throw new UsageError('logs 的子命令是 export');
  const { values } = parse(
    rest,
    { from: { type: 'string' }, to: { type: 'string' }, user: { type: 'string' }, tool: { type: 'string' }, run: { type: 'string' }, out: { type: 'string' }, as: { type: 'string' } },
    0,
  );
  const from = isoTime(values.from, '--from');
  const to = isoTime(values.to, '--to');
  const kit = await ctx.records();
  // The viewer's view (records): an admin's has every call with its admin note, a user's only their own calls.
  const by = await (await tokenRules(options)).viewer(ctx, values.as);
  const userId = values.user === undefined ? undefined : (await requireUser(kit, values.user)).id;
  const lines: CallLogLine[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: CallLogLine[]; next: string | null } = await kit.callLog.query(by, {
      ...(userId === undefined ? {} : { userId }),
      ...(values.tool === undefined ? {} : { tool: values.tool }),
      ...(values.run === undefined ? {} : { runId: values.run }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      limit: 500,
      newestFirst: false,
      cursor,
    });
    lines.push(...page.items);
    cursor = page.next;
  } while (cursor !== null);
  // JSON escapes C0 controls; jsonSafe also the C1 and bidirectional controls it leaves raw (the same JSON values).
  const text = lines.map((line) => jsonSafe(JSON.stringify(line))).join('\n');
  if (values.out !== undefined) {
    const target = isAbsolute(values.out) ? values.out : resolve(ctx.io.cwd, values.out);
    try {
      await writeFile(target, lines.length === 0 ? '' : `${text}\n`, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`${target} 已经存在，不覆盖`);
      throw error;
    }
    ctx.io.stdout(`导出了 ${lines.length} 行调用日志到 ${target}（只有你能读）`);
  } else {
    for (const line of lines) ctx.io.stdout(jsonSafe(JSON.stringify(line)));
  }
  return 0;
}

const USER_ID = /^usr_[0-9a-z]{26}$/;

function packIdOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const id = value.split('@')[0] ?? '';
  if (!/^[a-z][a-z0-9-]{0,80}$/.test(id)) throw new UsageError('--pack 要包标识（版本号会被忽略）');
  return id;
}

function stateOf(value: string | undefined): RunListState | null {
  if (value === undefined) return null;
  if (!(RUN_LIST_STATES as readonly string[]).includes(value)) throw new UsageError('--state 只能是 受理、未受理 或 进行中');
  return value as RunListState;
}

function sinceOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!Number.isFinite(Date.parse(value))) throw new UsageError('--since 要能解析的 ISO 时间');
  return value;
}

function limitOf(value: string | undefined): number {
  if (value === undefined) return RUN_LIST_DEFAULT_LIMIT;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > RUN_LIST_MAX_LIMIT) throw new UsageError(`--limit 要 1 到 ${RUN_LIST_MAX_LIMIT} 的整数`);
  return Number(value);
}

async function runListCommand(args: readonly string[], ctx: CliContext, options: CliOptions): Promise<number> {
  const { values } = parse(args, {
    pack: { type: 'string' },
    user: { type: 'string' },
    state: { type: 'string' },
    since: { type: 'string' },
    unknown: { type: 'boolean' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    json: { type: 'boolean' },
    as: { type: 'string' },
  }, 0);
  const by = await (await tokenRules(options)).viewer(ctx, values.as);
  if (by.role !== 'admin') throw new CliError('只有管理员可以列出运行', '用管理员的操作令牌执行这一条命令');
  const kit = await ctx.records();
  const named = values.user;
  const user = named === undefined ? null : USER_ID.test(named) ? await kit.principals.get(named) : await kit.principals.findByName(named);
  if (named !== undefined && user === null) throw new CliError(`没有用户 ${terminalSafe(named)}`);
  const page = await listRunInventory(kit, by, {
    pack: packIdOf(values.pack),
    user: user?.id ?? null,
    state: stateOf(values.state),
    since: sinceOf(values.since),
    unknown: values.unknown === true,
    limit: limitOf(values.limit),
    cursor: values.cursor ?? null,
  });
  if (values.json === true) {
    ctx.io.stdout(jsonSafe(JSON.stringify({ runs: page.items, next: page.next }, null, 2)));
    return 0;
  }
  for (const line of runListLines(page)) out(ctx.io, line);
  return 0;
}

async function runCommand(args: readonly string[], ctx: CliContext, options: CliOptions): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'list') return runListCommand(rest, ctx, options);
  if(sub==='abandon'){
    const {values,positionals}=parse(rest,{'answer-request':{type:'string'},reason:{type:'string'}},1);
    if(!values['answer-request']||!values.reason)throw new UsageError('需要 --answer-request 和 --reason；此命令管理放弃整个运行，不停止远端执行或解除冻结');
    const by=await (await tokenRules(options)).member(ctx);
    const deps=await ctx.deps();
    if(!deps.runs.abandonRun)throw new CliError('运行管理处置没有接线','由管理员补齐运行服务的 abandonRun 接口后重试');
    const receipt=await deps.runs.abandonRun(by,positionals[0],values['answer-request'],values.reason);
    out(ctx.io,'已记录管理放弃：运行 '+positionals[0]+'；处置来源 rec:'+receipt.decision+'；交付投影 rec:'+receipt.record+(receipt.created?'':'（已有回执，未增写）'));
    out(ctx.io,'技术层只保留来源判定，未重新核验；要求项未满足（已放弃）；原效果和冻结记录不改写。');
    return 0;
  }
  if (sub !== 'show') throw new UsageError('run 的子命令是 list、show 或 abandon');
  const { values, positionals } = parse(rest, { json: { type: 'boolean' }, as: { type: 'string' } }, 1);
  const by = await (await tokenRules(options)).viewer(ctx, values.as);
  let deps: ServerDeps;
  try {
    deps = await ctx.deps();
  } catch (error) {
    if (isAssemblyMissing(error)) throw new CliError('run show 要用运行模块，这个装配模块没有提供', (error as Error).message);
    throw error;
  }
  const detail = await deps.runs.getRun(by, positionals[0]);
  if (detail === null) throw new CliError(`没有运行 ${terminalSafe(positionals[0])}`);
  const io = ctx.io;
  if (values.json === true) {
    io.stdout(jsonSafe(JSON.stringify(detail, null, 2)));
    return 0;
  }
  // Item ids and labels come from users' documents, build names from the build site: every line is made safe.
  const run = detail.run;
  out(io, `运行 ${run.run}：任务包 ${run.pack}，开始于 ${run.started_at}`);
  out(io, [run.product && `产品 ${run.product}`, run.version && `版本 ${run.version}`, run.build && `构建 ${run.build}`, run.root && `知识根 ${run.root}`].filter(Boolean).join('，') || '没有锁定产品版本');
  out(io, `条目 ${run.items.length} 个，要求项 ${run.requirements.map((r) => r.key).join('、')}`);
  if(detail.management)out(io,'管理状态：已放弃；选择来源 rec:'+detail.management.record+(detail.management.result?'':'；管理投影等待 Hub 自动补齐')) ;
  out(io, `提交 ${detail.submissions.length} 份：${detail.submissions.map((s) => s.acceptance === null ? '未校验（Hub 中断）' : labelOf('acceptance', s.acceptance)).join('、') || '还没有'}`);
  const latest = detail.latest;
  if (latest === null) io.stdout('还没有校验结果');
  else {
    out(io, (latest.result.system_input?'系统交付；':'')+countsLine(latest.result.acceptance, latest.result.acceptance === 'accepted' ? latest.result.partitions : undefined));
    if(latest.result.system_input)out(io,'系统交付输入摘要 '+latest.result.submission+'；来源 '+latest.result.system_input);
    for (const p of PARTITION) for (const item of latest.result.partitions[p]) out(io, `- ${labelOf('partition', p)} ${item.item} ${item.label}`);
  }
  return 0;
}

/** A one-time code for /console/setup; refused once an administrator exists (they add users in the console). */
async function setupCodeCommand(args: readonly string[], ctx: CliContext): Promise<number> {
  parse(args, {}, 0);
  const kit = await ctx.records();
  if ((await kit.principals.list()).some((user) => user.role === 'admin')) {
    throw new CliError('已经有管理员，不再发设置码', '管理员登录控制台后在“管理”里添加用户、签发令牌；管理员令牌丢了用 circle-hub operator-token reissue');
  }
  const code = await issueSetupCode(ctx.config().dataDir);
  ctx.io.stdout('设置码（24 小时内有效，只显示这一次；再运行一次会作废它）：');
  ctx.io.stdout(code);
  ctx.io.stdout('在浏览器打开控制台的 /console/setup，输入设置码，建立第一位管理员');
  return 0;
}

const BUILT_IN_HANDLERS: Record<string, (args: readonly string[], ctx: CliContext, options: CliOptions) => Promise<number>> = {
  'local-tools': (args, ctx) => localToolsCommand(args, ctx.io),
  user: userCommand,
  token: tokenCommand,
  logs: logsCommand,
  run: runCommand,
  'setup-code': setupCodeCommand,
};

/**
 * The environment a platform command gets: without the operator token. The platform never acts as a Hub admin, and what it
 * starts inherits what it gets (a deploy's git and npm, whose install scripts would see the token). The name is taken out of
 * the caller's environment too, so no later child of this process sees it.
 */
function platformEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  takeEnvironmentToken(env);
  const { [OPERATOR_TOKEN_VARIABLE]: _token, ...rest } = env;
  return rest;
}

function report(io: CliIo, error: unknown, commands: readonly CliCommand[]): number {
  if (error instanceof UsageError) {
    io.stderr(`错误：${error.message}`);
    io.stderr(usage(commands));
    return 2;
  }
  if (error instanceof HubEnvironmentError || error instanceof HubConfigError) {
    io.stderr(error.message);
    return 1;
  }
  if (error instanceof CliError) {
    io.stderr(`错误：${error.message}`);
    if (error.hint !== null) io.stderr(`处理：${error.hint}`);
    return 1;
  }
  if (error instanceof RecordsError || error instanceof TypeError) {
    io.stderr(`错误：${error.message}`);
    return 1;
  }
  const hint = (error as { hint?: unknown } | null)?.hint;
  io.stderr(`错误：${error instanceof Error ? error.message : String(error)}`);
  if (typeof hint === 'string' && hint.length > 0) io.stderr(`处理：${hint}`);
  return 1;
}

const processIo = (): CliIo => ({
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd(),
});

/** Runs one command and resolves with its exit code: 0 ok, 1 failure, 2 usage (platform status commands may give 3). */
export async function main(argv: readonly string[] = process.argv.slice(2), overrides: Partial<CliOptions> = {}): Promise<number> {
  const options: CliOptions = { ...overrides, io: overrides.io ?? processIo() };
  const io = options.io;
  const [command, ...rest] = argv;
  let loaded: Promise<AssemblyModule> | undefined;
  const assembly = () => (loaded ??= (options.assembly ?? (() => import('./assemble.ts') as Promise<AssemblyModule>))());
  const local = new Map(registry);
  const commands = () => [...local.values()];
  try {
    assertNoRetiredEnvironment(io.env);
  } catch (error) {
    return report(io, error, []);
  }
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    try {
      const module = await assembly();
      module.registerCommands?.(registerInto(local));
    } catch (error) {
      if (!isAssemblyMissing(error)) return report(io, error, commands());
    }
    io.stdout(usage(commands()));
    return command === undefined ? 2 : 0;
  }
  if (isPlatformCommand(command)) {
    // allowVariables names what the server CLI reads itself (hub/platform); the token is not passed on at all.
    return runPlatformCommand(argv, { stdout: io.stdout, stderr: io.stderr, env: platformEnvironment(io.env), cwd: io.cwd, allowVariables: [OPERATOR_TOKEN_VARIABLE], ...(overrides.io === undefined ? { keyPipe: liveKeyPipe() } : {}) });
  }
  if (command === 'serve') return serve(rest, options);
  const ctx = contextFor(options, assembly);
  try {
    const builtIn = Object.hasOwn(BUILT_IN_HANDLERS, command) ? BUILT_IN_HANDLERS[command] : undefined;
    if (builtIn !== undefined) return await builtIn(rest, ctx, options);
    if (!local.has(command)) {
      const module = await assembly();
      module.registerCommands?.(registerInto(local));
    }
    const registered = local.get(command);
    if (registered !== undefined) return await registered.run(rest, ctx);
    if (RESERVED_COMMANDS.includes(command)) {
      throw new CliError(`命令 ${command} 由装配模块注册（默认的 hub/server/assemble.ts 注册 ${RESERVED_COMMANDS.join('、')}），这个装配模块没有注册它`);
    }
    throw new UsageError(`未知命令：${command}`);
  } catch (error) {
    return report(io, error, commands());
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** A register function that adds to one invocation's command table with the same checks as registerCommand. */
function registerInto(local: Map<string, CliCommand>): RegisterCommand {
  return (command) => {
    if (typeof command?.name !== 'string' || !COMMAND_NAME.test(command.name) || typeof command.run !== 'function') throw new TypeError('a command has a lowercase name and a run function');
    if (BUILT_IN.has(command.name) || isPlatformCommand(command.name)) throw new Error(`命令 ${command.name} 是内置命令，不能替换`);
    if (!local.has(command.name)) local.set(command.name, command);
  };
}
