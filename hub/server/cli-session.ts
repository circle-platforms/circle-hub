import { uiLabelOf } from '../../contracts/generated/vocabulary.ts';
import { updateTrace } from '../telemetry/api.ts';
import { LeaseService } from '../leases/service.ts';
import { createPool, Database } from '../records/db.ts';
import { type HubConfig } from '../config/index.ts';
import { type Principal, type RecordsKit, type User } from '../records/api.ts';
import type { CliContext } from './api.ts';
import { hintOf, messageOf } from './assemble/errors.ts';
import { assembleHub, type AssembledHub, type AssemblyOptions } from './assemble/hub.ts';
import { OPERATOR_TOKEN_VARIABLE, deploymentKeyService, fileOperatorTokens, takeEnvironmentToken, type OperatorTokenStore } from './assemble/operator-token.ts';
import { DEFAULT_ADMIN_NAME } from '../records/api.ts';
import { terminalSafe } from './assemble/terminal.ts';
import { CliError } from './errors.ts';

export interface AdminCommandOptions {
  /**
   * Where the operator token is kept when CIRCLE_HUB_TOKEN is not set; default the deployment's private key file
   * (fileOperatorTokens). `service` is the deployment's key service, resolved as the vault master key's (deploymentKeyService).
   */
  tokens?: (config: HubConfig, service: string) => OperatorTokenStore;
  /** Reads a secret value for `secret set`; default standard input (no echo on a terminal). */
  readSecret?: (label: string) => Promise<string>;
  /** Options of the commands' own assembly (tests: no OS isolation where sandbox-exec is missing). */
  assembly?: AssemblyOptions;
}

const USER_ID = /^usr_[0-9a-z]{26}$/;
/** Label of a token `operator-token reissue` issues (shown by `token list`). */
export const REISSUE_LABEL = '操作令牌（重新签发）';
/** The break-glass path: a new admin token straight into the token file, without any token. */
export const REISSUE = 'circle-hub operator-token reissue';
/** How to remove the local operator token that no longer works (revoked, its account disabled or no longer an admin). */
export const REMOVE_ITEM = '运行 circle-hub operator-token remove --confirm-only-operator-token（仅删除本地操作令牌，不改密钥库主密钥；不会撤销数据库令牌）';
export const DEAD_ITEM = `${REMOVE_ITEM}，再运行 ${REISSUE}（有几位管理员时加 --as <管理员>）`;

/**
 * How to give one command a token other than the token file's. Not exported: serve refuses to start while the variable
 * is set, and a token kept in a shell's environment reaches everything that shell starts.
 */
export const ONE_COMMAND_TOKEN = `只给这一条命令一个令牌：${OPERATOR_TOKEN_VARIABLE}="$T" circle-hub <命令>（先用 read -rs T 读入，令牌不进命令历史）；不要 export ${OPERATOR_TOKEN_VARIABLE}：serve 见到它会拒绝启动，留在 shell 里的令牌也会传给这个 shell 启动的每个程序`;
/**
 * What a running Hub does after `secret set` or `resource reset-login` removed the vault's session entry (hub/connectors,
 * "Between processes"): it reads the entry again before a read that needs the credential (and when its login status is
 * shown), so a stop or a cool-down it holds ends then and it logs in once; a usable token it holds stays in use until its
 * next login, which takes the new value. No restart.
 */
export const RUNNING_HUB_LOGIN = '正在运行的 Hub 下一次读取会核对密钥版本及重置代数，旧令牌、停止和冷却不再沿用，用当前版本登录一次；不用重启 Hub';

const principalOf = (user: Pick<User, 'id' | 'name' | 'role'>): Principal => ({ id: user.id, name: user.name, role: user.role });

/** A state-changing command's operator: its admin, and whether its token still works after the command (a revocation). */
export interface OperatorAct {
  admin: Principal;
  /**
   * Null while the operator token still authenticates as an enabled admin; else what the operator is told (the command just
   * revoked that token or disabled its account) and how to recover.
   */
  noticeIfLost(): Promise<string | null>;
}

/** One invocation: the operator token taken from the environment first, then configuration, records and the assembly. */
export class Session {
  readonly ctx: CliContext;
  readonly options: AdminCommandOptions;
  /**
   * CIRCLE_HUB_TOKEN, taken out of the environment object when the session starts, so that no child process this command
   * starts (a pack function, a tool) inherits it. The configuration accepts the name for commands (loadServerConfig).
   */
  readonly envToken: string | null;
  #hub: Promise<AssembledHub> | null = null;
  #tokens: Promise<OperatorTokenStore> | null = null;
  #leases: Promise<LeaseService> | null = null;
  #leaseDatabase: Database | null = null;

  constructor(ctx: CliContext, options: AdminCommandOptions) {
    this.ctx = ctx;
    this.options = options;
    this.envToken = takeEnvironmentToken(ctx.io.env);
  }

  /** A line on stdout, made safe for a terminal (it may quote a pack, a resource or a remote system). */
  out(line: string): void {
    this.ctx.io.stdout(terminalSafe(line));
  }

  err(line: string): void {
    this.ctx.io.stderr(terminalSafe(line));
  }

  config(): HubConfig {
    return this.ctx.config();
  }

  records(): Promise<RecordsKit> {
    return this.ctx.records();
  }

  /** The lease service over this deployment's database (one pool per invocation, closed with it by close()). */
  leases(): Promise<LeaseService> {
    this.#leases ??= (async () => {
      const records = await this.records();
      this.#leaseDatabase = new Database(createPool(this.config().database, 2));
      return new LeaseService(this.#leaseDatabase, { records: records.store });
    })();
    return this.#leases;
  }

  /**
   * Ends the pools this invocation opened besides the records kit's (the CLI context closes that one): the lease pool and
   * the assembled hub's dispatch pool. An idle pool keeps the process alive for its idle timeout, so a command that
   * leaves one open returns its output and then waits 30 seconds before it exits.
   */
  async close(): Promise<void> {
    const hub = this.#hub === null ? null : await this.#hub.catch(() => null);
    await hub?.dispatch?.close().catch(() => {});
    await this.#leases?.catch(() => null);
    await this.#leaseDatabase?.end().catch(() => {});
  }

  /** The operator token file of this deployment: its key service is resolved as the vault master key's. */
  tokens(): Promise<OperatorTokenStore> {
    this.#tokens ??= (async () => {
      const config = this.config();
      const service = await deploymentKeyService(this.ctx.io.env);
      return this.options.tokens?.(config, service) ?? fileOperatorTokens(config.dataDir, service);
    })();
    return this.#tokens;
  }

  /**
   * The assembly over this invocation's records (one per invocation): the vault key is required by the commands that read
   * or write a secret value; its operator's log lines (connector and registry events) go to this command's stderr.
   */
  hub(requireVaultKey = false, quiet?: boolean): Promise<AssembledHub> {
    this.#hub ??= (async () =>
      assembleHub(this.config(), await this.records(), { log: (line) => this.err(line), ...this.options.assembly, ...(quiet === undefined ? {} : { log: quiet ? () => {} : (line: string) => this.err(line) }), requireVaultKey, command: true }))();
    return this.#hub;
  }

  /** The operator token: CIRCLE_HUB_TOKEN, else the token file; null when there is none. */
  async operatorToken(): Promise<string | null> {
    if (this.envToken !== null) return this.envToken;
    const store = await this.tokens();
    try {
      return await store.read();
    } catch (error) {
      throw new CliError(`读不出${store.where}里的操作令牌：${messageOf(error)}`, `${hintOf(error) ?? '检查数据根的 keys 目录（当前服务账户拥有，权限 0700，文件 0600）后重试'}；或者${ONE_COMMAND_TOKEN}`);
    }
  }

  /** The admin a state-changing command acts as: the account of the operator token, which must be an enabled admin. */
  async admin(): Promise<Principal> {
    return (await this.#operator()).admin;
  }

  /** The operator token and its enabled admin; refused (before anything is read or written) when there is none. */
  async #operator(requireAdmin=true): Promise<{ admin: Principal; token: string }> {
    const kit = await this.records();
    const token = await this.operatorToken();
    if (token === null) {
      if(!requireAdmin)throw new CliError('这个命令会改变运行状态，需要有效操作令牌',`通过 ${OPERATOR_TOKEN_VARIABLE} 提供运行者本人或管理员的令牌；不采用只读命令的身份回退`);
      throw new CliError(
        '这个命令会改变 Hub 的状态，要管理员令牌，没有找到',
        `已有管理员而操作令牌文件丢了时，用 ${REISSUE} 给一位启用中的管理员签发新令牌存进${(await this.tokens()).where}（不显示），手里有管理员令牌时也可以用 circle-hub operator-token set 从标准输入存进去；第一位管理员用 circle-hub init-admin [<名字>]（省略时为 ${DEFAULT_ADMIN_NAME}）建立；或者${ONE_COMMAND_TOKEN}`,
      );
    }
    const principal = await kit.principals.authenticate(`Bearer ${token}`);
    if (principal === null || requireAdmin&&principal.role !== 'admin') {
      if(!requireAdmin)throw new CliError('操作令牌无效或账号已停用','用运行者本人或管理员的有效令牌重试');
      const hint =
        this.envToken === null
          ? `${(await this.tokens()).where}里的操作令牌已不能用（已撤销、账号已停用或不再是管理员）：${DEAD_ITEM}`
          : `给这条命令一个启用中的管理员的有效令牌（${OPERATOR_TOKEN_VARIABLE}）`;
      throw new CliError('令牌无效，或者不属于启用中的管理员；这个命令只有管理员能执行', hint);
    }
    updateTrace({ userId: principal.id });
    return { admin: principal, token };
  }

  async member():Promise<Principal>{return (await this.#operator(false)).admin;}

  /** The operator of a state-changing command that may cut off its own token (token revoke, user disable). */
  async act(): Promise<OperatorAct> {
    const { admin, token } = await this.#operator();
    const lost =
      this.envToken !== null
        ? `${OPERATOR_TOKEN_VARIABLE} 给这条命令的管理员令牌现在已不能用（令牌已撤销或账号已停用）`
        : `${(await this.tokens()).where}里的操作令牌现在已不能用（令牌已撤销或账号已停用）：之后改变状态的命令会被拒绝；恢复：${DEAD_ITEM}`;
    return {
      admin,
      noticeIfLost: async () => {
        const still = await (await this.records()).principals.authenticate(`Bearer ${token}`);
        return still !== null && still.role === 'admin' ? null : lost;
      },
    };
  }

  /**
   * Who a read-only command reads as: the account of the operator token (CIRCLE_HUB_TOKEN, else the token file), with
   * `--as` allowed only when it names that account; without a token `--as` or the only enabled admin. A token file that
   * cannot be read (wrong owner or permissions) is said on stderr and the command reads as if there were none.
   */
  async viewer(as: string | undefined, quietTokenRead = false): Promise<Principal> {
    const principal = await this.#reader(as, quietTokenRead);
    updateTrace({ userId: principal.id });
    return principal;
  }

  async #reader(as: string | undefined, quietTokenRead: boolean): Promise<Principal> {
    let token = this.envToken;
    let source = `${OPERATOR_TOKEN_VARIABLE} 的令牌`;
    let hint: string | null = null;
    if (token === null) {
      const store = await this.tokens();
      source = `${store.where}里的操作令牌`;
      hint = `${REMOVE_ITEM}后，只读命令按 --as 或唯一启用的管理员读取；改变状态的命令要的新操作令牌用 ${REISSUE} 签发`;
      try {
        token = await store.read();
      } catch (error) {
        if (!quietTokenRead) this.err(`注意：读不出${source}（${messageOf(error)}）；这个只读命令按${as === undefined ? '唯一启用的管理员' : ` --as ${as} `}读取`);
        return this.ctx.actingAdmin(as);
      }
    }
    if (token === null) return this.ctx.actingAdmin(as);
    const principal = await (await this.records()).principals.authenticate(`Bearer ${token}`);
    if (principal === null) throw new CliError(`${source}无效（不存在、已撤销，或者账号已停用）`, hint);
    if (as !== undefined && as !== principal.name && as !== principal.id) {
      throw new CliError(`--as ${as} 与令牌的账号 ${principal.name} 不一致：有令牌时只读命令以令牌的账号读取`, '去掉 --as；要以另一个账号读取，就只给这一条命令那个账号的令牌');
    }
    return principal;
  }

  async user(nameOrId: string): Promise<User> {
    const kit = await this.records();
    const user = USER_ID.test(nameOrId) ? await kit.principals.get(nameOrId) : await kit.principals.findByName(nameOrId);
    if (user === null) throw new CliError(`没有用户 ${nameOrId}`);
    return user;
  }

  /** User id -> name, for listings. */
  async names(): Promise<Map<string, string>> {
    return new Map((await (await this.records()).principals.list()).map((user) => [user.id, user.deleted_at?`${uiLabelOf('account_display_name','deleted_member')}（${user.id}）`:user.name]));
  }
}

