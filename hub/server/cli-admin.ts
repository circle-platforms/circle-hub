// The administrator commands the assembly registers with the server CLI: pack, resource, secret, knowledge, init-admin and
// operator-token. Every command that changes state acts as the admin of the operator token: CIRCLE_HUB_TOKEN, or when it is
// not set the keychain item of the deployment (account operator-token beside the vault master key, hub/platform
// keychainStore); anything else is refused. The server CLI's built-in state-changing commands use the same rule
// (operatorAdmin, operatorAct). Read-only commands, the server CLI's included (operatorViewer), act as the token's account
// when there is a token (`--as` must then name that account), else as the acting admin (`--as`, or the only enabled one); a
// keychain item that cannot be read only costs a notice. Reads are not an access boundary: without any token they act as
// the only admin. A lost or dead item is replaced without a token by `operator-token reissue`: a new token of an enabled
// admin goes straight into the item and is never shown. Output is Chinese, made safe for a terminal, and never shows a token
// or a secret value: tokens come from stdin, credentials from stdin or explicitly named environment-file keys, never as argv values.
import { RECORD_KINDS, type RecordKind } from '../../contracts/generated/protocol.ts';
import {referencesIn} from '../../contracts/src/variables.ts';
import {bindLegacySkills,bindLegacyParser} from '../refs/api.ts';
import { variableCommand, namedSecretCommand, VAR_USAGE, NAMED_SECRET_USAGE } from './variables.ts';
import { executorCommand, jobCommand, EXECUTOR_USAGE, JOB_USAGE, bedCommand, BED_USAGE } from './cli-job.ts';
import { copyFile, open, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { LeaseService } from '../leases/service.ts';
import { createPool, Database } from '../records/db.ts';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ENVIRONMENT, isEnvironment, isLeaseOp, labelOf, type Environment } from '../../contracts/generated/vocabulary.ts';
import { HubConfigError, HubEnvironmentError, type HubConfig } from '../config/index.ts';
import { ConnectorError, type AddResourceInput, type LoginStatus, type UpdateResourceInput } from '../connectors/api.ts';
import { KnowledgeError, createKnowledgeReader, formatKnowledgeRetract, formatSeedReport, formatSyncReport, knowledgeRetract, knowledgeSeed, knowledgeSync, parseKnowledgeSeedArgs, parseKnowledgeSyncArgs, type KnowledgeSeedArgs, type KnowledgeSyncArgs } from '../knowledge/api.ts';
import { DocsError } from './docs.ts';
import type { ProductHandle } from '../ports.ts';
import { productionShareKey, RecordsError, WHOLE_HUB, parseStrictJson, isSha256, scanForCredentials, type EffectiveScanAcceptance, type IssuedToken, type Page, type Principal, type RecordsKit, type SourceArtifactBody, type StoredRecord, type User } from '../records/api.ts';
import { unruledShapes, parsePackRef, type PackProblem } from '../runs/api.ts';
import type { CliCommand, CliContext } from './api.ts';
import { hintOf, messageOf } from './assemble/errors.ts';
import { assembleHub, type AssembledHub, type AssemblyOptions } from './assemble/hub.ts';
import { OPERATOR_TOKEN_VARIABLE, deploymentKeychainService, fileOperatorTokens, keychainOperatorTokens, takeEnvironmentToken, tokenBytes, type OperatorTokenStore } from './assemble/operator-token.ts';
import { SecretInputError, readSecret as readSecretFromStdin } from './assemble/secret-input.ts';
import { terminalSafe } from './assemble/terminal.ts';
import { readNamedEnvironment } from './assemble/env-file.ts';
import { vaultKeyProblem } from './assemble/vault.ts';
import { CliError, UsageError } from './errors.ts';

export interface AdminCommandOptions {
  /**
   * Where the operator token is kept when CIRCLE_HUB_TOKEN is not set; default the macOS keychain item of the deployment.
   * `service` is the deployment's keychain service, resolved as the vault master key's (deploymentKeychainService).
   */
  tokens?: (config: HubConfig, service: string) => OperatorTokenStore;
  /** Reads a secret value for `secret set`; default standard input (no echo on a terminal). */
  readSecret?: (label: string) => Promise<string>;
  /** Options of the commands' own assembly (tests: no OS isolation where sandbox-exec is missing). */
  assembly?: AssemblyOptions;
}

export const SKILL_USAGE='skill bind-legacy <解析器 id@版本> <技能包 id@版本>';
export const PACK_USAGE =
  'pack install <技能包@版本> | uninstall <技能包> | bind-skills <旧运行> --skill <技能包@版本>… --reason <理由> | publish <目录> [--stage] [--answer-request <请求摘要> ...] | grant-publish <用户> | revoke-publish <用户> | assign <用户> <任务包> | unassign <用户> <任务包> | retire <任务包@版本> | activate <产品包> | deactivate <产品包> | list | shapes <任务包>';
export const RESOURCE_USAGE = 'resource add <系统包> --name <名字> --environment <环境> --origin <角色>=<地址> [--allow-plaintext <角色>] [--credential <凭据项>=<密钥名>…（包声明项必填）] [--setting <键>=<文字> | --setting-json <键>=<JSON> | --setting-var <键>=<变量名>] | update <资源> [--system-pack <系统包>] [--name <名字>] [--environment <环境>] [--origin <角色>=<地址>…] [--allow-plaintext <角色>… | --clear-plaintext] [--credential <凭据项>=<密钥名>] [--setting <键>=<文字> | --setting-json <键>=<JSON> | --setting-var <键>=<变量名>] [--unset-setting <键>]（地址整项替换，设置逐键修改） | show <资源> [--values] | read <资源> <读取名> <键> [--events] | list | disable <资源> | enable <资源> | reset-login <资源>';
export const SECRET_USAGE = NAMED_SECRET_USAGE;
export const SOURCE_USAGE = 'source held [--limit <条数>] | findings <sha256> | accept <sha256> --note <说明> | withdraw <sha256> [--note <说明>]';
export const ORIGINAL_USAGE = 'original list [--external <外部标识的前缀>] [--suffix <外部标识的后缀>] [--limit <条数>] | export <sha256> --out <文件>';
export const LEASE_USAGE = 'lease list [--prefix <键前缀>] | release <键> --reason <理由> | register <前缀> --owner <用户> --reason <理由> | unregister <前缀> --reason <理由>';
export const SHARE_USAGE = 'share run <运行> (--users <用户,…> | --pack-users) [--reason <理由>] | production <任务包> [--reason <理由>] | list [--object <对象>]';
export const UNSHARE_USAGE = 'unshare run <运行> (--user <用户> | --pack-users) | production <任务包>';
export const DOC_USAGE = 'doc put <名字> <文件> | list | show <名字>';
export const KNOWLEDGE_USAGE = 'knowledge sync --product <产品> [--line <版本线>] [--dry-run] [--recheck] [--include-unreleased] | seed --product <产品> --line <版本线> [--build <构建>] --basis <一句理由> [--dry-run] | retract (--entry <记录摘要> | --run <运行> | --object <对象摘要>)… --reason <一行原因> | roots <产品> | diff <根A> <根B> | view <knowledge外部标识> [--only <取值列表>] [--as <管理员>] --out <文件>';
export const INIT_ADMIN_USAGE = 'init-admin <名字>   建第一位管理员，令牌存进钥匙串（账户 operator-token），不显示';
export const OPERATOR_TOKEN_USAGE =
  'operator-token set   从标准输入读一个启用中的管理员的令牌，存进钥匙串（账户 operator-token）；钥匙串项丢失时用，已有的项不覆盖 | reissue [--as <管理员>]   手里没有管理员令牌时：给一位启用中的管理员签发新令牌，直接存进钥匙串，不显示；已有的项不覆盖 | remove --confirm-only-operator-token   Linux 仅删除本地操作令牌文件，不改主密钥、不撤销数据库令牌';

const USER_ID = /^usr_[0-9a-z]{26}$/;
/** Label of a token `operator-token reissue` issues (shown by `token list`). */
const REISSUE_LABEL = '操作令牌（重新签发）';
/** The break-glass path: a new admin token straight into the keychain item, without any token. */
const REISSUE = 'circle-hub operator-token reissue';
/** What to do when the keychain item's token no longer works (revoked, its account disabled or no longer an admin). */
const DEAD_ITEM = `在“钥匙串访问”里删掉这个项，再运行 ${REISSUE}（给一位启用中的管理员签发新令牌存进钥匙串，不显示；有几位管理员时加 --as <管理员>）`;

const removeItemHint = (store: OperatorTokenStore): string => store.remove ? '运行 circle-hub operator-token remove --confirm-only-operator-token（仅删除本地操作令牌，不改密钥库主密钥；不会撤销数据库令牌）' : '在“钥匙串访问”里删掉这个项';
const deadItemHint = (store: OperatorTokenStore): string => store.remove ? `${removeItemHint(store)}，再运行 ${REISSUE}（有几位管理员时加 --as <管理员>）` : DEAD_ITEM;

/**
 * How to give one command a token other than the keychain item's. Not exported: serve refuses to start while the variable
 * is set, and a token kept in a shell's environment reaches everything that shell starts.
 */
const ONE_COMMAND_TOKEN = `只给这一条命令一个令牌：${OPERATOR_TOKEN_VARIABLE}="$T" circle-hub <命令>（先用 read -rs T 读入，令牌不进命令历史）；不要 export ${OPERATOR_TOKEN_VARIABLE}：serve 见到它会拒绝启动，留在 shell 里的令牌也会传给这个 shell 启动的每个程序`;
/**
 * What a running Hub does after `secret set` or `resource reset-login` removed the vault's session entry (hub/connectors,
 * "Between processes"): it reads the entry again before a read that needs the credential (and when its login status is
 * shown), so a stop or a cool-down it holds ends then and it logs in once; a usable token it holds stays in use until its
 * next login, which takes the new value. No restart.
 */
const RUNNING_HUB_LOGIN = '正在运行的 Hub 下一次读取会核对密钥版本及重置代数，旧令牌、停止和冷却不再沿用，用当前版本登录一次；不用重启 Hub';

type Flags = Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>;

function parse<T extends Flags>(args: readonly string[], options: T, positionals: number) {
  let parsed;
  try {
    parsed = parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== positionals) throw new UsageError(`需要 ${positionals} 个参数，给了 ${parsed.positionals.length} 个`);
  return parsed;
}

const principalOf = (user: Pick<User, 'id' | 'name' | 'role'>): Principal => ({ id: user.id, name: user.name, role: user.role });

/** A refusal of another package as an operator message with its fix (records' `fix`, the connectors' and knowledge's text). */
async function decided<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof RecordsError) throw new CliError(error.message, error.fix ?? null);
    if (error instanceof DocsError) throw new CliError(error.message, error.hint);
    if (error instanceof ConnectorError || error instanceof KnowledgeError || error instanceof SecretInputError) throw new CliError(error.message);
    throw error;
  }
}

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
class Session {
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

  /** The lease service over this deployment's database (one pool per invocation, closed with it). */
  leases(): Promise<LeaseService> {
    this.#leases ??= (async () => new LeaseService(new Database(createPool(this.config().database, 2)),{records:(await this.records()).store}))();
    return this.#leases;
  }

  /** The operator token item of this deployment: its keychain service is resolved as the vault master key's. */
  tokens(): Promise<OperatorTokenStore> {
    this.#tokens ??= (async () => {
      const config = this.config();
      const service = await deploymentKeychainService(this.ctx.io.env, config.keychain.service);
      return this.options.tokens?.(config, service) ?? (process.platform === 'linux' ? fileOperatorTokens(config.dataDir, service) : keychainOperatorTokens({ service }));
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

  /** The operator token: CIRCLE_HUB_TOKEN, else the keychain item; null when there is none. */
  async operatorToken(): Promise<string | null> {
    if (this.envToken !== null) return this.envToken;
    const store = await this.tokens();
    try {
      return await store.read();
    } catch (error) {
      throw new CliError(`读不出${store.where}里的操作令牌：${messageOf(error)}`, `${hintOf(error) ?? '在这台 Mac 的登录会话里解锁钥匙串后重试'}；或者${ONE_COMMAND_TOKEN}`);
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
        `已有管理员而钥匙串项丢了时，用 ${REISSUE} 给一位启用中的管理员签发新令牌存进${(await this.tokens()).where}（不显示），手里有管理员令牌时也可以用 circle-hub operator-token set 从标准输入存进去；第一位管理员用 circle-hub init-admin <名字> 建立；或者${ONE_COMMAND_TOKEN}`,
      );
    }
    const principal = await kit.principals.authenticate(`Bearer ${token}`);
    if (principal === null || requireAdmin&&principal.role !== 'admin') {
      if(!requireAdmin)throw new CliError('操作令牌无效或账号已停用','用运行者本人或管理员的有效令牌重试');
      const hint =
        this.envToken === null
          ? `${(await this.tokens()).where}里的操作令牌已不能用（已撤销、账号已停用或不再是管理员）：${deadItemHint(await this.tokens())}`
          : `给这条命令一个启用中的管理员的有效令牌（${OPERATOR_TOKEN_VARIABLE}）`;
      throw new CliError('令牌无效，或者不属于启用中的管理员；这个命令只有管理员能执行', hint);
    }
    return { admin: principal, token };
  }

  async member():Promise<Principal>{return (await this.#operator(false)).admin;}

  /** The operator of a state-changing command that may cut off its own token (token revoke, user disable). */
  async act(): Promise<OperatorAct> {
    const { admin, token } = await this.#operator();
    const lost =
      this.envToken !== null
        ? `${OPERATOR_TOKEN_VARIABLE} 给这条命令的管理员令牌现在已不能用（令牌已撤销或账号已停用）`
        : `${(await this.tokens()).where}里的操作令牌现在已不能用（令牌已撤销或账号已停用）：之后改变状态的命令会被拒绝；恢复：${deadItemHint(await this.tokens())}`;
    return {
      admin,
      noticeIfLost: async () => {
        const still = await (await this.records()).principals.authenticate(`Bearer ${token}`);
        return still !== null && still.role === 'admin' ? null : lost;
      },
    };
  }

  /**
   * Who a read-only command reads as: the account of the operator token (CIRCLE_HUB_TOKEN, else the keychain item), with
   * `--as` allowed only when it names that account; without a token `--as` or the only enabled admin. A keychain item
   * that cannot be read (a locked keychain) is said on stderr and the command reads as if there were none.
   */
  async viewer(as: string | undefined, quietTokenRead = false): Promise<Principal> {
    let token = this.envToken;
    let source = `${OPERATOR_TOKEN_VARIABLE} 的令牌`;
    let hint: string | null = null;
    if (token === null) {
      const store = await this.tokens();
      source = `${store.where}里的操作令牌`;
      hint = `${removeItemHint(store)}后，只读命令按 --as 或唯一启用的管理员读取；改变状态的命令要的新操作令牌用 ${REISSUE} 签发`;
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
    return new Map((await (await this.records()).principals.list()).map((user) => [user.id, user.name]));
  }
}

// ---------------------------------------------------------------- pack

function problemLine(problem: PackProblem): string {
  const where = [problem.file, problem.field ?? (problem.line === undefined ? '' : `第 ${problem.line} 行`)].filter((part) => part !== '').join(' ');
  return `- [${problem.rule}] ${where}：${problem.message}（处理：${problem.fix}）`;
}

/**
 * A temporary directory holding pack.json and the files it lists, copied from `source` (which may hold more: tests, a README).
 * A listed path must be a plain file inside `source`; the publish check still verifies every digest and refuses anything
 * the copy lacks. Returns the directory to publish; its parent is the one to remove.
 */
async function stagePackDirectory(source: string): Promise<string> {
  let manifest: { files?: Array<{ path?: unknown }> };
  try {
    manifest = JSON.parse(await readFile(join(source, 'pack.json'), 'utf8'));
  } catch {
    throw new CliError(`读不出 ${source} 里的 pack.json`, '目录要含 pack.json，它列出包的文件');
  }
  if (!Array.isArray(manifest.files)) throw new CliError('pack.json 没有 files 清单', '先按包的工具生成 pack.json');
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-stage-'));
  const target = join(root, 'pack');
  try {
    await mkdir(target);
    for (const path of ['pack.json', ...manifest.files.map((f) => f.path)]) {
      if (typeof path !== 'string' || path.startsWith('/') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw new CliError(`pack.json 里有不合法的文件路径：${String(path).slice(0, 120)}`);
      }
      const from = join(source, path);
      const info = await lstat(from).catch(() => null);
      if (info === null || !info.isFile()) throw new CliError(`pack.json 列出的 ${path} 不是目录里的普通文件`, '补上这个文件，或重新生成 pack.json');
      await mkdir(dirname(join(target, path)), { recursive: true });
      await copyFile(from, join(target, path));
    }
    return target;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function packIdOf(ref: string, what: string): string {
  const parsed = parsePackRef(ref);
  if (parsed === null || parsed.version !== null) throw new UsageError(`${what}按包号写，不带版本：${ref.slice(0, 120)}`);
  return parsed.id;
}

async function skillCommand(session:Session,args:readonly string[]):Promise<number>{
 const [sub,...rest]=args;if(sub!=='bind-legacy')throw new UsageError(SKILL_USAGE);
 const {positionals}=parse(rest,{},2);const by=await session.admin(),hub=await session.hub();
 const binding=await decided(()=>bindLegacyParser({registry:hub.registry,records:hub.records},by,positionals[0],positionals[1]));
 session.out(`解析器 ${binding.parser} → ${binding.skill.pack}@${binding.skill.version}；摘要 ${binding.skill.digest}`);
 session.out(`迁移时点事后声明；操作者 ${binding.decided_by}；时间 ${binding.at}；测试 ${binding.test}；rec:${binding.record}；旧记录不改`);
 session.out(`本次扫描 ${binding.scanned_runs} 个历史运行；追加绑定 ${binding.bound_runs} 条；已有绑定 ${binding.already_bound_runs} 条`);return 0;
}

async function packCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'install': {
      const {positionals}=parse(rest,{},1);const by=await session.admin();const hub=await session.hub();
      const decision=await decided(()=>hub.registry.install(by,positionals[0]));
      session.out(`通用技能包已安装；决定 ${decision.digest}`);return 0;
    }
    case 'uninstall': {
      const {positionals}=parse(rest,{},1);const by=await session.admin();const hub=await session.hub();
      const decision=await decided(()=>hub.registry.uninstall(by,positionals[0]));
      session.out(`通用技能包已卸载；旧运行仍按冻结摘要复核；决定 ${decision.digest}`);return 0;
    }
    case 'bind-skills': {
      const {positionals,values}=parse(rest,{skill:{type:'string',multiple:true},reason:{type:'string'}},1);
      if(!values.reason||!Array.isArray(values.skill)||!values.skill.length)throw new UsageError('pack bind-skills <旧运行> --skill <技能包@版本>… --reason <理由>');
      const by=await session.admin(),hub=await session.hub();
      const record=await decided(()=>bindLegacySkills({registry:hub.registry,records:hub.records},by,positionals[0],values.skill as string[],values.reason as string));
      session.out(`历史运行的技能摘要声明已追加；不是原执行历史的补造；rec:${record}`);return 0;
    }
    case 'shapes': {
      const {positionals,values}=parse(rest,{as:{type:'string'}},1);
      const viewer=await session.viewer(values.as);
      const pack=packIdOf(positionals[0],'查看判定形状');
      const hub=await session.hub();
      const shapes=await unruledShapes(hub.records.store,viewer,pack);
      if(!shapes.length)session.out('没有未裁定的形状');
      for(const shape of shapes)session.out(`${shape.requirement}\t${shape.interpreter}\t${shape.count}\t${shape.latest_run}`);
      return 0;
    }
    case 'publish': {
      const { positionals, values } = parse(rest, { stage: { type: 'boolean' }, 'answer-request':{type:'string',multiple:true} }, 1);
      const source = isAbsolute(positionals[0]) ? positionals[0] : resolve(session.ctx.io.cwd, positionals[0]);
      const admin = await session.admin();
      const hub = await session.hub();
      // --stage publishes a copy of exactly the files pack.json lists, so a source directory may hold tests and a README.
      const staged = values.stage === true ? await stagePackDirectory(source) : null;
      let outcome;
      try {
        outcome = await decided(() => hub.registry.publish(admin, staged ?? source,{answerRequests:values['answer-request']??[]}));
      } finally {
        if (staged !== null) await rm(dirname(staged), { recursive: true, force: true });
      }
      if (!outcome.ok) {
        for (const problem of outcome.problems) session.err(problemLine(problem));
        for (const problem of outcome.report?.warnings ?? []) session.err(`注意：${problemLine(problem).slice(2)}`);
        const fix = outcome.problems.some((p) => p.rule === 'publish.no_right') ? `管理员先授予发布权：circle-hub pack grant-publish ${admin.name}` : '按上面每条问题的处理改好后重新发布';
        throw new CliError(`任务包没有发布：${outcome.problems.length} 个问题`, fix);
      }
      const version = outcome.version;
      const ref = `${version.id}@${version.version}`;
      const samples = outcome.report.samples;
      session.out(
        outcome.created
          ? `已发布 ${ref}（${labelOf('pack_kind', version.kind)}，摘要 ${version.digest}）：样例 ${samples.passed}/${samples.total} 通过`
          : `${ref} 已经以同样的内容发布过（摘要 ${version.digest}），包版本没有新的记录`,
      );
      if(values['answer-request']?.length)session.out(`请求作答：发布记录 rec:${version.record} 对应 ${new Set(values['answer-request']).size} 个指定请求（重复作答不增写）`);
      for (const warning of outcome.report.warnings) session.err(`注意：${problemLine(warning).slice(2)}`);
      if (version.kind === 'product' && !(await hub.registry.isActive(version.id))) session.out(`产品包启用后才生效：circle-hub pack activate ${version.id}`);
      if (version.kind === 'workflow') session.out(`工作流包分配给用户后才能用：circle-hub pack assign <用户> ${version.id}`);
      if (version.kind === 'system') session.out(`系统包实例化为资源后才读取：circle-hub resource add ${version.id} --name <名字> --environment <环境> --origin <角色>=<地址>`);
      return 0;
    }
    case 'grant-publish':
    case 'revoke-publish': {
      const { positionals } = parse(rest, {}, 1);
      const admin = await session.admin();
      const user = await session.user(positionals[0]);
      const kit = await session.records();
      if (sub === 'grant-publish') await decided(() => kit.authorizations.grantPublishRight(admin, user.id));
      else await decided(() => kit.authorizations.revokePublishRight(admin, user.id));
      session.out(`${user.name}（${user.id}）${sub === 'grant-publish' ? '有了发布权' : '的发布权已撤销'}`);
      return 0;
    }
    case 'assign':
    case 'unassign': {
      const { positionals } = parse(rest, {}, 2);
      const packId = packIdOf(positionals[1], '分配');
      const admin = await session.admin();
      const user = await session.user(positionals[0]);
      const hub = await session.hub();
      if (sub === 'assign') await decided(() => hub.registry.assign(admin, user.id, packId));
      else await decided(() => hub.registry.unassign(admin, user.id, packId));
      session.out(sub === 'assign' ? `已把 ${packId} 分配给 ${user.name}（${user.id}）` : `${user.name}（${user.id}）不再能用 ${packId}`);
      return 0;
    }
    case 'retire': {
      const { positionals } = parse(rest, {}, 1);
      const ref = parsePackRef(positionals[0]);
      if (ref === null || ref.version === null) throw new UsageError(`下架要写 <包号>@<版本>：${positionals[0].slice(0, 120)}`);
      const admin = await session.admin();
      const hub = await session.hub();
      await decided(() => hub.registry.retire(admin, ref.id, ref.version as string));
      hub.connectors.refresh();
      session.out(`${ref.id}@${ref.version} 已下架：新的运行不再用它，已有的运行照常读取和完成`);
      return 0;
    }
    case 'activate':
    case 'deactivate': {
      const { positionals } = parse(rest, {}, 1);
      const packId = packIdOf(positionals[0], sub === 'activate' ? '启用' : '停用');
      const admin = await session.admin();
      const hub = await session.hub();
      if (sub === 'activate') await decided(() => hub.registry.activate(admin, packId));
      else await decided(() => hub.registry.deactivate(admin, packId));
      session.out(sub === 'activate' ? `产品包 ${packId} 已对整个 Hub 启用` : `产品包 ${packId} 已停用`);
      return 0;
    }
    case 'list': {
      const { values } = parse(rest, { as: { type: 'string' } }, 0);
      const viewer = await session.viewer(values.as);
      const hub = await session.hub();
      const listings = await hub.catalog.list(viewer);
      if (listings.length === 0) {
        session.out(viewer.role === 'admin' ? '还没有发布任何任务包' : '没有分配给你的任务包');
        return 0;
      }
      const names = await session.names();
      for (const pack of listings) {
        const state = pack.withdrawn ? '已下架' : pack.kind === 'product' ? (pack.active ? '已启用' : '未启用') : '已发布';
        const fields = [`${pack.id}@${pack.version}`, labelOf('pack_kind', pack.kind), pack.title, state];
        if (viewer.role === 'admin') {
          fields.push(`所有者 ${names.get(pack.owner) ?? pack.owner}`, pack.published_at);
          if (pack.kind === 'workflow') fields.push(`分配给 ${(pack.assigned_to ?? []).map((id) => names.get(id) ?? id).join('、') || '无'}`);
        }
        session.out(fields.join('\t'));
      }
      return 0;
    }
    default:
      throw new UsageError(`pack 的子命令：${PACK_USAGE}`);
  }
}

// ---------------------------------------------------------------- resource

function pairs(values: readonly string[] | undefined, flag: string): [string, string][] {
  return (values ?? []).map((value) => {
    const at = value.indexOf('=');
    if (at <= 0) throw new UsageError(`${flag} 写成 <名字>=<值>，请核对这个参数`);
    return [value.slice(0, at), value.slice(at + 1)];
  });
}

function settingValue(text: string): string {
  if (/^\s*[\[{]/.test(text)) throw new UsageError('数组或对象请用 --setting-json');
  return text;
}
function resourceSettings(values: {setting?:string[];'setting-json'?:string[];'setting-var'?:string[]}) {
  const out:Record<string,unknown>={};
  const add=(key:string,value:unknown)=>{if(Object.hasOwn(out,key))throw new UsageError('设置键重复；逐项核对');out[key]=value;};
  for(const [key,value] of pairs(values.setting,'--setting'))add(key,settingValue(value));
  for(const [key,value] of pairs(values['setting-json'],'--setting-json')) {try {add(key,JSON.parse(value));}catch(error){if(error instanceof UsageError)throw error;throw new UsageError('设置 JSON 无效；核对 --setting-json，不回显原文');}}
  for(const [key,value] of pairs(values['setting-var'],'--setting-var')) {if(!/^[A-Z][A-Z0-9_]{0,63}$/.test(value))throw new UsageError('设置的变量名字不合规则');add(key,'${var:'+value+'}');}
  return out;
}
async function resourceWarnings(session:Session, record:import('../../contracts/src/resources.ts').ResourceRecord) {
  const hub=await session.hub(false); const by=await session.admin();
  const described=await hub.connectors.admin.describe(by,record.id);
  for(const item of described?.credentials??[]) {
    const match=/^\$\{secret:([^}]+)\}$/.exec(item.entry);if(!match)continue;
    if(!item.set)session.out(`密钥 ${match[1]} 还没有设置：用 circle-hub secret set --name ${match[1]} 设置`);
    else if(!item.registered)session.out(`密钥 ${match[1]} 的这一版未登记此使用者和地址：要重新输入一次值才会发往这里`);
  }
}

/**
 * The login column of `resource list`: the state stored in the vault, read fresh by this command (a running server reads it
 * again at its next read that needs the credential, RUNNING_HUB_LOGIN).
 */
function loginText(status: LoginStatus | null): string {
  if (status === null) return '不用登录';
  let state: string;
  if (status.stopped) state = `登录已停止${status.failure ? `（${status.failure}）` : ''}：用 secret set 重设凭据或 resource reset-login 解除（正在运行的 Hub 不用重启）`;
  else if (status.cooldownUntil !== null) state = `登录冷却到 ${status.cooldownUntil}`;
  else if (status.token) state = `已登录${status.expiresAt ? `（到期 ${status.expiresAt}）` : ''}`;
  else state = '还没有登录';
  return `密钥库里的登录状态：${state}`;
}

async function resourceCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add': {
      const { values, positionals } = parse(
        rest,
        {
          name: { type: 'string' },
          environment: { type: 'string' },
          origin: { type: 'string', multiple: true },
          'allow-plaintext': { type: 'string', multiple: true },
          setting: { type: 'string', multiple: true },
          'setting-json': {type:'string',multiple:true},
          'setting-var': {type:'string',multiple:true},
          'unset-setting': {type:'string',multiple:true},
          credential: {type:'string',multiple:true},
        },
        1,
      );
      if (values.name === undefined || values.name.trim() === '') throw new UsageError('要用 --name 给资源起名字');
      const environment = values.environment;
      if (environment === undefined || !isEnvironment(environment)) {
        throw new UsageError(`--environment 是 ${ENVIRONMENT.map((code) => `${code}（${labelOf('environment', code)}）`).join('、')} 之一`);
      }
      const origins: Record<string, string> = {};
      for (const [role, url] of pairs(values.origin, '--origin')) {
        if (Object.hasOwn(origins, role)) throw new UsageError(`角色 ${role} 的地址给了两次`);
        origins[role] = url;
      }
      if (Object.keys(origins).length === 0) throw new UsageError('至少用一个 --origin <角色>=<地址> 给出系统包每个角色的地址');
      const plaintext = new Set<string>();
      for (const role of values['allow-plaintext'] ?? []) {
        if (!Object.hasOwn(origins, role)) throw new UsageError(`--allow-plaintext ${role}：这个角色没有用 --origin 给地址`);
        let origin: URL;
        try {
          origin = new URL(origins[role]);
        } catch {
          throw new UsageError(`角色 ${role} 的地址不是 URL`);
        }
        if (origin.protocol !== 'http:') throw new UsageError(`--allow-plaintext ${role}：只有 http 地址才需要允许明文`);
        plaintext.add(origin.origin);
      }
      const settings = resourceSettings(values);
      if(values['unset-setting']?.length)throw new UsageError('--unset-setting 只用于 update');
      const admin = await session.admin();
      const hub = await session.hub();
      const input: AddResourceInput = {
        credentials:Object.fromEntries(pairs(values.credential,'--credential')),
        system_pack: positionals[0],
        name: values.name,
        environment: environment as Environment,
        origins,
        ...(plaintext.size > 0 ? { allow_plaintext: [...plaintext] } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      };
      const record = await decided(() => hub.connectors.admin.addResource(admin, input));
      session.out(`已添加资源 ${record.id}：${record.name}（系统包 ${record.system_pack}，环境 ${labelOf('environment', record.environment)}）`);
      await resourceWarnings(session,record);
      return 0;
    }
    case 'update': {
      const { values, positionals } = parse(
        rest,
        {
          'system-pack': { type: 'string' },
          name: { type: 'string' },
          environment: { type: 'string' },
          origin: { type: 'string', multiple: true },
          'allow-plaintext': { type: 'string', multiple: true },
          'clear-plaintext': { type: 'boolean' },
          setting: { type: 'string', multiple: true },
          'setting-json': {type:'string',multiple:true},
          'setting-var': {type:'string',multiple:true},
          'unset-setting': {type:'string',multiple:true},
          credential: {type:'string',multiple:true},
        },
        1,
      );
      if (values['clear-plaintext'] && values['allow-plaintext'] !== undefined) {
        throw new UsageError('--clear-plaintext 与 --allow-plaintext 不能同时给');
      }
      const changes: UpdateResourceInput = {};
      if (values['system-pack'] !== undefined) changes.system_pack = values['system-pack'];
      if (values.name !== undefined) {
        if (values.name.trim() === '') throw new UsageError('--name 不能是空的');
        changes.name = values.name;
      }
      if (values.environment !== undefined) {
        if (!isEnvironment(values.environment)) throw new UsageError(`--environment 是 ${ENVIRONMENT.map((code) => `${code}（${labelOf('environment', code)}）`).join('、')} 之一`);
        changes.environment = values.environment as Environment;
      }
      if (values.origin !== undefined) {
        const origins: Record<string, string> = {};
        for (const [role, url] of pairs(values.origin, '--origin')) {
          if (Object.hasOwn(origins, role)) throw new UsageError(`角色 ${role} 的地址给了两次`);
          origins[role] = url;
        }
        changes.origins = origins;
      }
      if (values['clear-plaintext']) {
        changes.allow_plaintext = [];
      } else if (values['allow-plaintext'] !== undefined) {
        const plaintext = new Set<string>();
        for (const role of values['allow-plaintext']) {
          const url = changes.origins?.[role];
          if (url === undefined) throw new UsageError(`--allow-plaintext ${role}：同一条命令里要用 --origin 给出这个角色的地址（地址整项替换）`);
          let origin: URL;
          try {
            origin = new URL(url);
          } catch {
            throw new UsageError(`角色 ${role} 的地址不是 URL`);
          }
          if (origin.protocol !== 'http:') throw new UsageError(`--allow-plaintext ${role}：只有 http 地址才需要允许明文`);
          plaintext.add(origin.origin);
        }
        changes.allow_plaintext = [...plaintext];
      }
      const settings=resourceSettings(values);
      if(Object.keys(settings).length)changes.settings=settings;
      if(values['unset-setting'])changes.unset_settings=values['unset-setting'];
      if(values.credential)changes.credentials=Object.fromEntries(pairs(values.credential,'--credential'));
      if (Object.keys(changes).length === 0) throw new UsageError('没有要改的项：给 --system-pack、--name、--environment、--origin、--allow-plaintext、--clear-plaintext 或 --setting');
      const admin = await session.admin();
      const hub = await session.hub();
      const previous=await hub.connectors.admin.describe(admin,positionals[0]);
      const clearedRoles: string[] = [];
      if (changes.origins !== undefined && values['allow-plaintext'] === undefined && !values['clear-plaintext'] && previous) {
        const prevOrigins = previous.origins ?? {};
        const prevPlaintext = new Set(previous.allow_plaintext ?? []);
        const kept = new Set<string>();
        for (const [role, oldUrl] of Object.entries(prevOrigins)) {
          try {
            const oldOrigin = new URL(oldUrl).origin;
            if (prevPlaintext.has(oldOrigin)) {
              if (changes.origins[role] === oldUrl) {
                kept.add(oldOrigin);
              } else {
                clearedRoles.push(role);
              }
            }
          } catch {}
        }
        changes.allow_plaintext = [...kept];
      }
      const missingLegacy=(previous?.credentials??[]).filter(c=>!c.entry.startsWith('${secret:')&&!c.set&&changes.credentials?.[c.name]);
      const record = await decided(() => hub.connectors.admin.updateResource(admin, positionals[0], changes));
      for(const item of missingLegacy)session.out(`原值不在密钥库里：接着用 circle-hub secret set --name ${changes.credentials![item.name]} 设置`);
      session.out(`已更新资源 ${record.id}：${record.name}（系统包 ${record.system_pack}，环境 ${labelOf('environment', record.environment)}）`);
      if (values['clear-plaintext']) session.out('已清空所有明文放行');
      else if (clearedRoles.length > 0) session.out(`已清掉角色 ${clearedRoles.sort().join('、')} 的明文放行`);
      await resourceWarnings(session,record);
      return 0;
    }
    case 'show': {
      const {positionals,values}=parse(rest,{values:{type:'boolean'}},1);
      const by=await session.admin(), hub=await session.hub(false), kit=await session.records();
      const d=await hub.connectors.admin.describe(by,positionals[0]);if(!d)throw new CliError('资源不可用');
      session.out(`${d.id} ${d.name} ${d.system_pack}`);
      const config=await kit.authorizations.resourceConfig(d.id);let bound=config?.body.bound??null;
      let cursor:string|null=null;
      while(!bound){const page=await kit.authorizations.history({permission:'resource_config',subject:WHOLE_HUB,object:d.id,newestFirst:true,limit:500,cursor});bound=page.items.find(row=>!row.body.revoked&&row.body.bound)?.body.bound??null;if(bound||!page.next)break;cursor=page.next;}
      const bytes=bound?await kit.objects.get(bound):null;if(!bytes)throw new CliError('资源定义原件缺失；请管理员从可信备份恢复后重做 resource show');
      const source=parseStrictJson(Buffer.from(bytes).toString()) as {settings?:Record<string,unknown>};const versions=await kit.variables.list(by);
      for(const [key,value] of Object.entries(source.settings??{})){
        const refs=referencesIn(value).filter(ref=>ref.kind==='var');
        const names=refs.map(ref=>{const version=versions.find(v=>v.kind==='var'&&v.name===ref.name);return '${var:'+ref.name+'} '+(!version?'还没有设置':version.decision.body.revoked?`已撤回（最后第 ${version.version} 版）`:`第 ${version.version} 版`);});
        session.out(`设置 ${key}：${names.length?names.join('；'):values.values?JSON.stringify(value):'长度 '+Buffer.byteLength(JSON.stringify(value))}`);
      }
      for(const c of d.credentials){const version=c.revoked?`已撤回（最后第 ${c.version} 版）`:c.version?`第 ${c.version} 版`:'尚未登记命名版本';const stored=c.stored_digest?labelOf('digest_rule',c.stored_digest):'无当前登记';session.out(`凭据项 ${c.name} ${c.entry} ${version} 长度 ${c.length??'不适用'} 发送规则 ${labelOf('digest_rule',c.digest)} 存储规则 ${stored} ${c.set?'有条目':'无条目'} ${c.registered?'已登记使用者':'无当前使用者登记'}`);}
      return 0;
    }
    case 'read': {
      const { positionals, values } = parse(rest, { events: { type: 'boolean' } }, 3);
      const admin = await session.admin();
      // Default output is metadata only; --events sends redacted connector diagnostics to stderr for smoke capture.
      const hub = await session.hub(true, values.events !== true);
      const [resource, readName, key] = positionals;
      const described = await decided(() => hub.connectors.admin.describe(admin, resource));
      if (described === null) throw new CliError('资源不可用');
      const result = await hub.connectors.executeRead(resource, readName, { id: key }, { principal: admin, purpose: '管理员冒烟读取' });
      session.out(`${described.system_pack}/${readName}：${result.ok ? '读取完成' : `失败（${result.code}）`}`);
      if (result.ok) for (const artifact of result.artifacts) session.out(`产物 ${artifact.name} ${artifact.artifact.body.sha256} ${artifact.artifact.body.size} 字节`);
      if (result.manifest !== null) session.out(`读清单 ${result.manifest}`);
      return result.ok ? 0 : 1;
    }
    case 'list': {
      const { values } = parse(rest, { as: { type: 'string' } }, 0);
      const viewer = await session.viewer(values.as);
      if (viewer.role !== 'admin') throw new CliError('只有管理员能列出资源');
      const hub = await session.hub();
      // The console's listing (ResourceCatalogPort): admins only, with addresses and plaintext declarations.
      const listings = await hub.resources.list(viewer);
      if (listings.length === 0) {
        session.out('还没有资源');
        return 0;
      }
      // The login column is read from the vault, which needs the master key: asked once for the whole listing, so a locked
      // keychain costs one refusal, not one per resource.
      const keyProblem = listings.some((resource) => resource.enabled) ? await vaultKeyProblem(hub.records) : null;
      for (const resource of listings) {
        const fields = [resource.id, resource.name, resource.system_pack, labelOf('environment', resource.environment as Environment), resource.enabled ? '启用' : '停用'];
        fields.push(Object.entries(resource.origins ?? {}).map(([role, url]) => `${role}=${url}`).join(' '));
        if ((resource.allow_plaintext ?? []).length > 0) fields.push(`允许明文 ${(resource.allow_plaintext ?? []).join(' ')}`);
        if (resource.enabled) {
          let login: string;
          if (keyProblem !== null) login = `登录状态读不出：${keyProblem}`;
          else {
            try {
              login = loginText(await hub.connectors.admin.loginStatus(viewer, resource.id));
            } catch (error) {
              login = `登录状态读不出：${messageOf(error)}`;
            }
          }
          fields.push(login);
        }
        session.out(fields.join('\t'));
      }
      return 0;
    }
    case 'disable':
    case 'enable':
    case 'reset-login': {
      const { positionals } = parse(rest, {}, 1);
      const admin = await session.admin();
      // A reset only removes the vault's session entry, which needs no master key.
      const hub = await session.hub();
      const id = positionals[0];
      if (sub === 'disable') await decided(() => hub.connectors.admin.disable(admin, id));
      else if (sub === 'enable') await decided(() => hub.connectors.admin.enable(admin, id));
      else await decided(() => hub.connectors.admin.resetLogin(admin, id));
      if (sub === 'reset-login') {
        session.out(`资源 ${id} 在密钥库里的登录状态已清除：Hub 下一次要用这个资源的凭据时用已存的凭据登录一次`);
        session.err(`注意：${RUNNING_HUB_LOGIN}`);
      } else session.out(sub === 'disable' ? `资源 ${id} 已停用：不再读取` : `资源 ${id} 已启用`);
      return 0;
    }
    default:
      throw new UsageError(`resource 的子命令：${RESOURCE_USAGE}`);
  }
}

// ---------------------------------------------------------------- secret

async function secretCommand(session: Session, args: readonly string[]): Promise<number> { return namedSecretCommand(session, args); }

// ---------------------------------------------------------------- knowledge

async function productOf(hub: AssembledHub, viewer: Principal, name: string): Promise<ProductHandle> {
  const product = (await hub.packs.productByName(name)) ?? (await hub.packs.productById(name));
  if (product === null || !(await hub.packs.readableProducts(viewer)).has(product.product.id)) {
    throw new CliError(`没有叫 ${name.slice(0, 80)} 的启用中的产品包，或者你不能读它的知识`, '用 circle-hub pack list 查看产品包，用 pack activate 启用');
  }
  return product;
}

/** Own the newly created file before writing, so cleanup never removes a competing writer's file. */
export async function writeKnowledgeViewFile(target: string, bytes: Uint8Array, openTarget = async () => open(target, 'wx', 0o600)): Promise<Record<string, unknown>> {
  let file: Awaited<ReturnType<typeof openTarget>>;
  try { file = await openTarget(); }
  catch { throw new CliError('无法创建知识视图文件', '检查目录权限并换一个不存在的文件名后重试'); }
  try { await file.writeFile(bytes); await file.close(); }
  catch {
    await file.close().catch(() => {});
    const removed = await rm(target).then(() => true, () => false);
    throw new CliError('知识视图文件写入失败', removed ? '半截文件已删除；检查磁盘空间和目录权限后重试' : '检查并删除本次创建的半截文件，恢复磁盘空间和目录权限后重试');
  }
  try {
    const view: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (view === null || typeof view !== 'object' || Array.isArray(view)) throw new Error('not a view object');
    return view as Record<string, unknown>;
  } catch {
    const removed = await rm(target).then(() => true, () => false);
    throw new CliError('知识视图字节不是有效的 JSON 对象', removed ? '文件已删除；修复知识视图字节后重新导出' : '检查并删除本次创建的文件，修复知识视图字节后重新导出');
  }
}

async function knowledgeCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'view') {
    const { values, positionals } = parse(rest, { out: { type: 'string' }, only: { type: 'string' }, as: { type: 'string' } }, 1);
    if (!values.out) throw new UsageError('knowledge view 要用 --out 指定新文件');
    const viewer = await session.viewer(values.as, true).catch(error => {
      if (error instanceof CliError || error instanceof UsageError) throw error;
      throw new CliError('无法核对知识视图读取账号', '检查管理员身份及记录库连接后重试；原始异常不输出到终端');
    });
    if (viewer.role !== 'admin') throw new CliError('只有管理员能导出知识视图');
    const target = resolve(values.out);
    if (await lstat(target).then(() => true, () => false)) throw new CliError('输出文件已存在', '换一个新文件');
    let external = positionals[0];
    if (values.only !== undefined) {
      if (!values.only || /[&?#]/.test(values.only) || /[?&]only=/.test(external)) throw new UsageError('--only 要给非空取值列表，不能同时写在引用里；特殊字符按 URI 百分号编码');
      external += `${external.includes('?') ? '&' : '?'}only=${values.only.replaceAll(' ', '%20')}`;
    }
    const result = await (async () => {
      try {
        const hub = await session.hub(false, true);
        return await createKnowledgeReader(hub.knowledge).read(external, { principal: viewer, run: null, purpose: 'administrator view export' });
      } catch { throw new CliError('知识视图计算未完成', '检查装配、来源和视图计算后重试；原始异常不输出到终端'); }
    })();
    if (!result.ok) throw new CliError('未能读取指定知识视图', '核对产品、构建、权限和视图参数后重试；原始读取说明不输出到终端');
    const artifact = result.artifacts.find(a => a.name === 'original');
    const kit = await session.records();
    const bytes = artifact ? await kit.artifacts.trustedBytes(artifact.artifact.body.sha256).catch(() => { throw new CliError('知识视图字节读取失败', '修复原件存储后重新导出；原始异常不输出到终端'); }) : null;
    if (bytes === null) throw new CliError('知识视图字节缺失', '修复原件存储后重新导出');
    const view = await writeKnowledgeViewFile(target, bytes);
    const counts = (value: unknown): unknown => {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
      return Object.fromEntries(Object.entries(value).filter(([key]) => /^[a-z][a-z0-9_]*$/.test(key)).map(([key, entry]) => [key, counts(entry)]).filter(([, entry]) => entry !== undefined));
    };
    session.out(`已导出 ${artifact!.artifact.body.sha256}：${bytes.length} 字节，权限 0600`);
    session.out(`totals：${view.totals == null ? '未提供' : JSON.stringify(counts(view.totals))}；截断：${typeof view.truncated === 'boolean' ? (view.truncated ? '是' : '否') : '未提供'}；跳过：${typeof view.skipped === 'number' ? view.skipped : '未提供'}`);
    return 0;
  }
  if (sub === 'sync') {
    let parsed: KnowledgeSyncArgs;
    try {
      parsed = parseKnowledgeSyncArgs(rest);
    } catch (error) {
      throw new UsageError(messageOf(error));
    }
    const admin = await session.admin();
    const hub = await session.hub(true);
    const report = await decided(() => knowledgeSync(hub.knowledge, hub.packs, admin, parsed));
    for (const line of formatSyncReport(report).trimEnd().split('\n')) session.out(line);
    return report.error === null && report.counts.failed === 0 ? 0 : 1;
  }
  if (sub === 'seed') {
    let parsed: KnowledgeSeedArgs;
    try {
      parsed = parseKnowledgeSeedArgs(rest);
    } catch (error) {
      throw new UsageError(messageOf(error));
    }
    const admin = await session.admin();
    const hub = await session.hub(true);
    const report = await decided(() => knowledgeSeed(hub.knowledge, hub.packs, admin, parsed, hub.resources));
    for (const line of formatSeedReport(report).trimEnd().split('\n')) session.out(line);
    return report.ok ? 0 : 1;
  }
  if (sub === 'retract') {
    const { values } = parse(rest, { entry: { type: 'string', multiple: true }, run: { type: 'string', multiple: true }, object: { type: 'string', multiple: true }, reason: { type: 'string' } }, 0);
    const entries = values.entry ?? [];
    const runs = values.run ?? [];
    const objects = values.object ?? [];
    const reason = values.reason;
    if (reason === undefined || reason.trim() === '') throw new UsageError('knowledge retract 要用 --reason 给一行原因');
    if (reason.includes('\n') || reason.includes('\r')) throw new UsageError('knowledge retract 的 --reason 必须是一行');
    if (entries.length + runs.length + objects.length === 0) throw new UsageError('knowledge retract 至少要一个 --entry、--run 或 --object');
    if ([...entries, ...runs, ...objects].some(id => id.trim() === '')) throw new UsageError('knowledge retract 的目标不能为空');
    if ([...entries, ...objects].some(id => !isSha256(id))) throw new UsageError('knowledge retract 的 --entry 和 --object 是记录摘要（64 位十六进制）');
    const admin = await session.admin();
    const hub = await session.hub(true);
    const feeding = hub.knowledge.feeding;
    if (!feeding) throw new CliError('喂入层没有装上', '用当前 Hub 装配后重试');
    const report = await decided(() => knowledgeRetract(feeding, admin, { entries, runs, objects, reason: reason.trim(), at: hub.knowledge.__context.now().toISOString() }));
    for (const line of formatKnowledgeRetract(report)) session.out(line);
    return 0;
  }
  if (sub === 'roots') {
    const { values, positionals } = parse(rest, { as: { type: 'string' } }, 1);
    const viewer = await session.viewer(values.as);
    const hub = await session.hub();
    const product = await productOf(hub, viewer, positionals[0]);
    const id = product.product.id;
    const builds = await hub.knowledge.builds(id);
    const lines: string[] = [];
    for (const build of builds) if (!lines.includes(build.line)) lines.push(build.line);
    session.out(`产品线 ${id}（${product.product.names.join('、')}）：${builds.length} 个构建，${lines.length} 条版本线`);
    for (const line of lines) {
      const current = await hub.knowledge.currentRoot(id, line);
      session.out(`版本线 ${line}：${current === null ? '还没有当前根' : `当前根 ${current.root}（构建 ${current.build.name}，产出于 ${current.produced_at}）`}`);
      // Builds that have a root first, one line each; a line with many name-only builds stays readable: they
      // close the line as one count instead of one row per build.
      const ofLine = builds.filter((b) => b.line === line);
      const rooted = ofLine.filter((b) => b.root !== null || b.base !== b.name);
      const nameOnly = ofLine.filter((b) => b.root === null && b.base === b.name);
      for (const build of rooted) {
        session.out(
          [
            `  ${build.name}`,
            build.family,
            build.base === build.name ? '自身为基础构建' : `基于 ${build.base}`,
            build.released_at === null ? '未发布' : `发布于 ${build.released_at}`,
            build.root === null ? '还没有根' : `根 ${build.root}`,
          ].join('\t'),
        );
      }
      if (nameOnly.length > 0) session.out(`  另有 ${nameOnly.length} 个构建只有名字，还没有根`);
    }
    return 0;
  }
  if (sub === 'diff') {
    const { values, positionals } = parse(rest, { as: { type: 'string' } }, 2);
    const [from, to] = positionals;
    if (!isSha256(from) || !isSha256(to)) throw new UsageError('knowledge diff 的两个参数都是知识根的摘要（64 位十六进制）');
    const viewer = await session.viewer(values.as);
    const hub = await session.hub();
    const neutral = new CliError('没有这两个知识根，或者你不能读它们');
    if (viewer.role !== 'admin') {
      const readable = await hub.packs.readableProducts(viewer);
      for (const root of [from, to]) {
        const infos = await hub.knowledge.rootInfo(root);
        if (infos.length === 0 || !infos.some((info) => readable.has(info.product))) throw neutral;
      }
    }
    const diff = await hub.knowledge.diffRoots(from, to);
    if (diff === null) throw neutral;
    session.out(`从 ${diff.from} 到 ${diff.to}：增加 ${diff.added.length}，删除 ${diff.removed.length}，改动 ${diff.modified.length}`);
    for (const path of diff.added) session.out(`+ ${path}`);
    for (const path of diff.removed) session.out(`- ${path}`);
    for (const path of diff.modified) session.out(`~ ${path}`);
    return 0;
  }
  throw new UsageError(`knowledge 的子命令：${KNOWLEDGE_USAGE}`);
}

// ---------------------------------------------------------------- init-admin

/**
 * Stores a token nobody has seen in the operator token item. When the write fails the token is revoked, so that no token
 * exists that nobody can account for; the message says what happened (`done` first) and the hint how to go on. Neither
 * names a command that needs the token that could not be stored.
 */
async function storeUnseen(kit: RecordsKit, store: OperatorTokenStore, admin: Pick<User, 'id' | 'name' | 'role'>, token: IssuedToken, done: string): Promise<void> {
  try {
    await store.write(token.token);
  } catch (error) {
    let revoked: boolean;
    let why = '';
    try {
      revoked = await kit.principals.revokeToken(principalOf(admin), token.id);
    } catch (failure) {
      revoked = false;
      why = `（${messageOf(failure)}）`;
    }
    // A write whose read-back failed may still have left the item behind.
    const left = await store.present().catch(() => false);
    const stored = `${done}，但令牌没能存进${store.where}：${messageOf(error)}`;
    const remove = left ? (store.remove ? `${removeItemHint(store)}；` : '钥匙串里留下了这个项，先在“钥匙串访问”里删掉它；') : '';
    const again = store.remove ? `${remove}确认私有密钥目录可用后，用 ${REISSUE} --as ${admin.name} 签发新令牌存进${store.where}（不显示）` : `${remove}钥匙串能用后（例如解锁了钥匙串）用 ${REISSUE} --as ${admin.name} 签发新令牌存进钥匙串（不显示）`;
    if (revoked) throw new CliError(`${stored}。这个令牌已撤销，没有显示`, again);
    throw new CliError(`${stored}。这个没有显示过的令牌 ${token.id} 没能确认已经撤销${why}`, `${again}；再用 circle-hub token revoke ${token.id} 撤销这个没有显示过的令牌`);
  }
}

async function initAdminCommand(session: Session, args: readonly string[]): Promise<number> {
  const { positionals } = parse(args, {}, 1);
  const kit = await session.records();
  if ((await kit.principals.list()).some((user) => user.role === 'admin')) {
    throw new CliError(
      '已经有管理员；init-admin 只建第一位管理员',
      `给用户签发令牌用 circle-hub token issue <用户>（以钥匙串里的操作令牌执行）；操作令牌丢了（钥匙串项丢失，或它的令牌已撤销）就用 ${REISSUE}`,
    );
  }
  const store = await session.tokens();
  if (await store.present()) {
    throw new CliError(`${store.where}里已经有操作令牌`, `它属于另一个 Hub 时先${removeItemHint(store)}，再运行 init-admin`);
  }
  const { user, token } = await decided(() => kit.principals.bootstrapAdmin(positionals[0]));
  await storeUnseen(kit, store, user, token, `已建立第一位管理员 ${user.name}（${user.id}）`);
  session.out(`已建立第一位管理员 ${user.name}（${user.id}）；它的令牌 ${token.id} 已存进${store.where}，没有显示`);
  session.out('之后改变状态的命令（user、token 和 pack、resource、secret、knowledge 里的这类命令）都从这个钥匙串项读管理员令牌，不用另外给出令牌');
  return 0;
}

// ---------------------------------------------------------------- operator-token

/**
 * `operator-token set`: a lost keychain item (another Mac, a reset keychain) is replaced by a token of an enabled admin read
 * from standard input (never argv or the environment), checked against the records before it is stored, never shown.
 * `operator-token reissue [--as <admin>]`: the same without any token in hand (the break-glass path): a new token of an
 * enabled admin (`--as`, or the only one) is issued and goes straight into the item, never shown; when it cannot be stored
 * it is revoked. Neither ever overwrites an item: one that no longer works is removed in Keychain Access first. The reissue
 * needs no token because the CLI is no access boundary against whoever can run it against the database (that account can
 * change the database directly); what it gives exists only in the deployment's keychain item.
 */
async function operatorTokenCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'reissue') return reissueCommand(session, rest);
  if (sub === 'remove') {
    const {values} = parse(rest, {'confirm-only-operator-token':{type:'boolean'}}, 0);
    const store = await session.tokens();
    if (!store.remove) throw new CliError('此存储不支持操作令牌文件删除', '在“钥匙串访问”里仅删除操作令牌项');
    if (values['confirm-only-operator-token'] !== true) throw new UsageError('仅删除本地操作令牌文件须加 --confirm-only-operator-token；不会撤销数据库令牌或改动密钥库主密钥');
    session.out('先停止 Hub 服务并核对旧令牌；删除本地文件不会阻止运行中读取者或撤销旧令牌，恢复后用 token list 和 token revoke 核对并撤销旧令牌');
    session.out(await store.remove() ? '已删除本地操作令牌文件；密钥库主密钥未改动，数据库令牌未撤销' : '本地操作令牌文件本来就不存在；密钥库主密钥未改动');
    session.out(`下一步：${REISSUE}（有几位管理员时加 --as <管理员>），再核对并撤销旧令牌`);
    return 0;
  }
  if (sub !== 'set') throw new UsageError(`operator-token 的子命令：${OPERATOR_TOKEN_USAGE}`);
  parse(rest, {}, 0);
  const kit = await session.records();
  const store = await session.tokens();
  if (await store.present()) {
    throw new CliError(`${store.where}里已经有操作令牌，不覆盖`, `它不能用了就先${removeItemHint(store)}，再运行 circle-hub operator-token set`);
  }
  const read = session.options.readSecret ?? ((label: string) => readSecretFromStdin(label));
  // A Hub token has no white space; a pasted line may.
  const token = (await decided(() => read('管理员令牌'))).trim();
  const principal = tokenBytes(token) === null ? null : await kit.principals.authenticate(`Bearer ${token}`);
  if (principal === null || principal.role !== 'admin') {
    throw new CliError(
      '这个令牌无效，或者不属于启用中的管理员，没有存进钥匙串',
      `给一个启用中的管理员的有效令牌；手里没有的话，用 ${REISSUE} 给一位启用中的管理员签发新令牌，直接存进钥匙串（不显示）`,
    );
  }
  await store.write(token);
  session.out(`已把管理员 ${principal.name}（${principal.id}）的操作令牌存进${store.where}，没有显示；之后改变状态的命令从这里读它`);
  return 0;
}

async function reissueCommand(session: Session, args: readonly string[]): Promise<number> {
  const { values } = parse(args, { as: { type: 'string' } }, 0);
  const kit = await session.records();
  const store = await session.tokens();
  if (await store.present()) {
    throw new CliError(`${store.where}里已经有操作令牌，不覆盖`, `它还能用就不用重新签发；不能用了（令牌已撤销、账号已停用）就先${removeItemHint(store)}，再运行 ${REISSUE}`);
  }
  // Who: `--as`, or the only enabled admin (records keeps at least one enabled admin).
  const admin = await session.ctx.actingAdmin(values.as);
  const token = await decided(() => kit.principals.issueToken(admin, admin.id, REISSUE_LABEL));
  const done = `已为管理员 ${admin.name}（${admin.id}）签发新的操作令牌 ${token.id}`;
  await storeUnseen(kit, store, admin, token, done);
  session.out(`${done}，存进了${store.where}，没有显示；之后改变状态的命令从这里读它`);
  session.out(`原来的操作令牌如果还有效（例如还留在另一台 Mac 的钥匙串里），用 circle-hub token list ${admin.name} 查看，用 circle-hub token revoke <令牌编号> 撤销`);
  return 0;
}

// ---------------------------------------------------------------- source: held-back content and the credential scan

/** The shape of a line near a finding, never its text: letters and digits become x, so an admin sees what kind of text it is. */
function shapeAround(line: string, column: number): string {
  const start = Math.max(0, column - 1 - 12);
  return line
    .slice(start, start + 48)
    .replace(/[A-Za-z]/g, 'x')
    .replace(/[0-9]/g, '9')
    .replace(/[\u0080-\uffff]/g, '字');
}

/** Effective acceptance, not the historical scan annotation; no matched text is ever formatted. */
function sourceAcceptanceText(acceptance: EffectiveScanAcceptance | undefined): string {
  if (acceptance === undefined) return '没有受理';
  if (acceptance.kind === 'direct') return `直接受理（决定 ${acceptance.acceptance.authorization}）`;
  return `由派生覆盖（${acceptance.acceptance.sources.length} 份来源）`;
}

async function sourceCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'held': {
      const { values } = parse(rest, { limit: { type: 'string' }, as: { type: 'string' } }, 0);
      const viewer = await session.viewer(values.as);
      if (viewer.role !== 'admin') throw new CliError('只有管理员能看被只保留的内容');
      const limit = values.limit === undefined ? 50 : Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UsageError('--limit 是 1 到 500 的整数');
      const kit = await session.records();
      const seen = new Set<string>();
      const lines: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Page<StoredRecord<SourceArtifactBody>> = await kit.store.list<SourceArtifactBody>({ kind: 'source_artifact', newestFirst: true, limit: 200, ...(cursor === null ? {} : { cursor }) });
        for (const record of page.items) {
          const body = record.body;
          if (body.scan.findings.length === 0 || seen.has(body.sha256)) continue;
          seen.add(body.sha256);
          const origin = 'read' in body.origin ? body.origin.read.object : 'upload' in body.origin ? '上传' : '生成';
          const detectors = [...new Set(body.scan.findings.map((f) => f.detector))].join('、');
          const note = body.scan.truncated ? '，命中太多，不能接受' : '';
          const effective = await kit.artifacts.source(viewer,body.sha256);
          lines.push([body.sha256, `${body.size} 字节`, origin, `${body.scan.findings.length} 处命中（${detectors}）${note}`, sourceAcceptanceText(effective?.acceptance), `当前档位 ${labelOf('read_tier',effective?.readTier ?? body.read_tier)}`, body.captured_at].join('\t'));
          if (lines.length >= limit) break;
        }
        cursor = lines.length >= limit ? null : page.next;
      } while (cursor !== null);
      if (lines.length === 0) session.out('没有凭据扫描命中的来源');
      for (const line of lines) session.out(line);
      return 0;
    }
    case 'findings': {
      const { positionals, values } = parse(rest, { as: { type: 'string' } }, 1);
      const viewer = await session.viewer(values.as);
      if (viewer.role !== 'admin') throw new CliError('只有管理员能看凭据扫描的命中');
      const sha = positionals[0];
      if (!isSha256(sha)) throw new UsageError('sha256 要写成 64 位小写十六进制');
      const kit = await session.records();
      const bytes = await kit.artifacts.trustedBytes(sha);
      if (bytes === null) throw new CliError('Hub 没有保存这份字节');
      const scan = scanForCredentials(bytes);
      const effective = await kit.artifacts.source(viewer,sha);
      session.out(`受理状态：${sourceAcceptanceText(effective?.acceptance)}；当前档位 ${labelOf('read_tier',effective?.readTier ?? 'retain_only')}`);
      if (effective?.acceptance?.kind === 'derived') for (const source of effective.acceptance.acceptance.sources) session.out(`覆盖来源 ${source.sha256}；来源记录 ${source.record}；受理决定 ${source.acceptances.map(a => a.authorization).join('、')}`);
      session.out(`扫描器 ${scan.scanner}：${scan.findings.length} 处命中${scan.truncated ? '（超过可列出的上限，不能接受）' : ''}；下面只写探测器和位置，行的内容只给形状（字母写成 x，数字写成 9）`);
      const lines = new TextDecoder('utf-8', { fatal: false }).decode(bytes).split(/\r?\n/);
      for (const finding of scan.findings.slice(0, 100)) {
        session.out(`第 ${finding.line} 行第 ${finding.column} 列\t${finding.detector}\t${shapeAround(lines[finding.line - 1] ?? '', finding.column)}`);
      }
      if (scan.findings.length > 100) session.out(`… 还有 ${scan.findings.length - 100} 处`);
      return 0;
    }
    case 'accept': {
      const { positionals, values } = parse(rest, { note: { type: 'string' } }, 1);
      const admin = await session.admin();
      const sha = positionals[0];
      if (!isSha256(sha)) throw new UsageError('sha256 要写成 64 位小写十六进制');
      if (values.note === undefined || values.note.trim() === '') throw new UsageError('接受要写说明（--note），例如“手册里的 ftp 示例，口令是占位符”；说明里不要抄命中的内容');
      const kit = await session.records();
      const accepted = await decided(() => kit.artifacts.acceptFindings(admin, sha, values.note));
      session.out(`已接受 ${sha} 的 ${accepted.scan.findings.length} 处命中（扫描器 ${accepted.scan.scanner}）；之后重新读到同样字节时按正常内容保存。决定记录 ${accepted.authorization.digest}`);
      session.out('历史记录的入库档位不改；重新读取时核当前受理，显式要求只保留的策略不放开');
      return 0;
    }
    case 'withdraw': {
      const { positionals, values } = parse(rest, { note: { type: 'string' } }, 1);
      const admin = await session.admin();
      const sha = positionals[0];
      if (!isSha256(sha)) throw new UsageError('sha256 要写成 64 位小写十六进制');
      const kit = await session.records();
      const withdrawn = await decided(() => kit.artifacts.revokeFindings(admin, sha, values.note ?? null));
      session.out(`已撤回对 ${sha} 的接受；以后读到它按只保留处理。决定记录 ${withdrawn.digest}`);
      return 0;
    }
    default:
      throw new UsageError(`source 的子命令：${SOURCE_USAGE}`);
  }
}

// ---------------------------------------------------------------- original: the stored originals, listed and exported

/**
 * The read originals a gold script needs as input: every stored `source_artifact` whose origin is a read, by external id.
 * Only the external id, the digest, the size and the read time reach the screen — never the content.
 */
async function originalCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const { values } = parse(rest, { external: { type: 'string' }, suffix: { type: 'string' }, limit: { type: 'string' }, as: { type: 'string' } }, 0);
    const viewer = await session.viewer(values.as);
    if (viewer.role !== 'admin') throw new CliError('只有管理员能列出原件');
    const limit = values.limit === undefined ? 100 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UsageError('--limit 是 1 到 500 的整数');
    const kit = await session.records();
    const lines: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Page<StoredRecord<SourceArtifactBody>> = await kit.store.list<SourceArtifactBody>({ kind: 'source_artifact', newestFirst: true, limit: 200, ...(cursor === null ? {} : { cursor }) });
      for (const record of page.items) {
        const body = record.body;
        if (!('read' in body.origin)) continue;
        const object = body.origin.read.object;
        if (values.external !== undefined && !object.startsWith(values.external)) continue;
        if (values.suffix !== undefined && !object.endsWith(values.suffix)) continue;
        // One line per external id: the newest read of the same object decides the digest shown.
        if (seen.has(object)) continue;
        seen.add(object);
        lines.push([object, body.sha256, `${body.size} 字节`, body.captured_at].join('\t'));
        if (lines.length >= limit) break;
      }
      cursor = lines.length >= limit ? null : page.next;
    } while (cursor !== null);
    if (lines.length === 0) session.out(values.suffix !== undefined ? (values.external === undefined ? '没有符合指定后缀的原件' : '没有同时符合指定前缀和后缀的原件') : values.external === undefined ? '还没有读过的原件' : '没有外部标识以这个前缀开头的原件');
    for (const line of lines) session.out(line);
    return 0;
  }
  if (sub === 'export') {
    const { positionals, values } = parse(rest, { out: { type: 'string' } }, 1);
    if (values.out === undefined || values.out === '') throw new UsageError('要用 --out 给出写到哪个文件');
    const sha = positionals[0];
    if (!isSha256(sha)) throw new UsageError('sha256 要写成 64 位小写十六进制');
    const viewer = await session.viewer(undefined);
    if (viewer.role !== 'admin') {
      // A non-admin gets the same answer as for a nonexistent original: no existence signal.
      throw new CliError('Hub 没有保存这份原件');
    }
    const kit = await session.records();
    const bytes = await kit.artifacts.trustedBytes(sha);
    if (bytes === null) throw new CliError('Hub 没有保存这份原件');
    const target = resolve(values.out);
    const existing = await lstat(target).then(() => true, () => false);
    if (existing) throw new CliError(`文件已存在，不覆盖：${target}`, '换一个不存在的文件名');
    try {
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      const why = error !== null && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : error instanceof Error ? error.message : '写入失败';
      throw new CliError(`写不了这个文件：${target}`, `检查路径和权限（${why}）`);
    }
    session.out(`已导出 ${sha}：${bytes.length} 字节，权限 0600`);
    return 0;
  }
  throw new UsageError(`original 的子命令：${ORIGINAL_USAGE}`);
}

// ---------------------------------------------------------------- lease: the lease table, listed and force-released

/**
 * The administrator's lease commands: `lease list` shows the unexpired, unreleased rows (key, holder run, until) of a
 * prefix — never the fencing token or the lease id; `lease release` force-frees a key with a reason that lands in the
 * action record. Only administrators; a non-administrator gets the same answer as for a row that does not exist.
 */
async function leaseCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const { values } = parse(rest, { prefix: { type: 'string' }, as: { type: 'string' } }, 0);
    const viewer = await session.viewer(values.as);
    if (viewer.role !== 'admin') throw new CliError('只有管理员能列出租约');
    const leases = await session.leases();
    const view = await leases.view(values.prefix ?? '', true);
    const registrations=await leases.registrations(values.prefix??'');
    const names=await session.names();
    const name=(id:string|undefined)=>id===undefined?'—':(names.get(id)??id+'（用户资料缺失，请管理员恢复）');
    if (view.entries.length === 0 && registrations.length===0) session.out('没有未到期的租约');
    for(const row of view.entries){const owner=registrations.find(reg=>row.key.startsWith(reg.prefix));
      session.out([row.key,name(owner?.owner),name(row.user),row.run,row.since,row.until??'无到期时刻'].join('\t'));
    }
    for(const reg of registrations)if(!view.entries.some(row=>row.key.startsWith(reg.prefix)))session.out([reg.prefix,name(reg.owner),'空闲','—','—','—'].join('\t'));
    return 0;
  }
  if(isLeaseOp(sub)&&(sub==='register'||sub==='unregister')){
    const {positionals,values}=parse(rest,{owner:{type:'string'},reason:{type:'string'},as:{type:'string'}},1);
    const prefix=positionals[0]??'';
    if(!values.reason?.trim())throw new UsageError('登记或注销须写 --reason <理由>');
    if(sub==='register'&&!values.owner)throw new UsageError('登记须写 --owner <用户>');
    const viewer=await session.viewer(values.as);
    if(viewer.role!=='admin')throw new CliError('只有管理员能管理登记');
    const leases=await session.leases();
    if(sub==='unregister'){
      const outcome=await leases.unregister({prefix,by:viewer.id,admin:true,reason:values.reason});
      if(!outcome.ok)throw new CliError(outcome.message,'先强制释放，或等它释放；再核对登记');
    }else{
      const owner=await session.user(values.owner!);
      if(owner.disabled)throw new CliError('不能登记给已停用的用户','先核对用户状态');
      const hub=await session.hub();const prefixes:string[]=[];
      for(const pack of await hub.registry.listPacks())if(pack.kind==='workflow')for(const version of pack.versions){
        const loaded=await hub.workflows.byDigest(version.digest);if(loaded?.workflow.leases)prefixes.push(loaded.workflow.leases.prefix);
      }
      const declared=prefixes.filter(root=>prefix.startsWith(root)&&prefix!==root).sort((a,b)=>b.length-a.length)[0];
      if(!declared)throw new CliError('没有工作流声明这个租约前缀','先发布声明对应租约前缀的工作流，再登记其下的键前缀');
      const outcome=await leases.register({prefix,declaredPrefix:declared,owner:owner.id,by:viewer.id,admin:true,reason:values.reason});
      if(!outcome.ok)throw new CliError(outcome.message,'核对登记前缀，不要使已有登记互相包含');
    }
    session.out(sub==='register'?'已登记 '+prefix:'已注销 '+prefix);
    return 0;
  }
  if (sub === 'release') {
    const { positionals, values } = parse(rest, { reason: { type: 'string' }, as: { type: 'string' } }, 1);
    const key = positionals[0] ?? '';
    if (key === '' || !/^[a-z0-9][a-z0-9:._/-]{0,199}$/.test(key)) throw new UsageError('键的写法不对（小写字母、数字和 :._/-，最长 200）');
    if (values.reason === undefined || values.reason.trim() === '') throw new UsageError('强制释放要写 --reason <理由>（写进动作记录）');
    const viewer = await session.viewer(values.as);
    if (viewer.role !== 'admin') {
      // The same answer as for a row that does not exist: no existence signal for a non-administrator.
      throw new CliError('没有租约行');
    }
    const leases = await session.leases();
    const dispatch = (await session.hub()).dispatch;
    if (!dispatch) throw new CliError('缺少未终态作业事实', '请管理员配置只读作业端口后重试');
    const jobs = await dispatch.activeLeaseJobs([key]);
    if (jobs.length) throw new CliError(`作业 ${jobs.map(job=>job.job).join('、')} 还没有终态，本地释放停不了网关上的作业`, '等它结束，或者请管理员用 circle-hub job status 看、用 job dispose 处置');
    const outcome = await leases.forceRelease({ keys: [key], by: viewer.id, reason: values.reason, guard:async()=>{
      const active=await dispatch.activeLeaseJobs([key]);
      if(active.length)throw new CliError('作业 '+active.map(job=>job.job).join('、')+' 还没有终态，本地释放停不了网关上的作业','等它结束，或者请管理员用 circle-hub job status 看、用 job dispose 处置');
    } });
    if (!outcome.ok) throw new CliError(outcome.code === 'LEASE_NO_ROW' ? '没有租约行' : `没有释放：${outcome.message}`, outcome.code === 'LEASE_NO_ROW' ? '键上没有未到期的租约' : '稍后再试');
    session.out(`已释放 ${key}（理由：${values.reason.trim()}）`);
    return 0;
  }
  throw new UsageError(`lease 的子命令：${LEASE_USAGE}`);
}

// ---------------------------------------------------------------- doc: named documents

/**
 * The `doc` command (C4, hub/server/docs.ts): an admin publishes a named document with `doc put` (the file through the
 * source pipeline, the pointer moved by compare-and-set); `doc list` and `doc show` print name, digest and size only.
 * Everyone who is not an admin gets the same answer as for a doc that does not exist.
 */
async function docCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'put') {
    const { positionals } = parse(rest, {}, 2);
    const [name, file] = positionals;
    // The neutral rule: a non-admin is told what they would hear for a doc that does not exist.
    const viewer = await session.viewer(undefined);
    if (viewer.role !== 'admin') throw new CliError(`没有叫 ${name.slice(0, 80)} 的命名文档`);
    const admin = await session.admin();
    const source = isAbsolute(file) ? file : resolve(session.ctx.io.cwd, file);
    const bytes = await readFile(source).catch(() => null);
    if (bytes === null) throw new CliError(`读不出文件 ${file.slice(0, 120)}`, '给一个有读取权限的现有文件');
    const hub = await session.hub();
    const put = await decided(() => hub.docs.put(admin, name, new Uint8Array(bytes), { fileName: basename(source) }));
    session.out(put.created ? `已发布命名文档 ${put.name}（摘要 ${put.sha256}，${put.size} 字节）` : `命名文档 ${put.name} 已经是这份（摘要 ${put.sha256}，${put.size} 字节）`);
    if (put.findings > 0) session.err(`注意：凭据扫描有 ${put.findings} 处命中，已按只保留存；经运行读取这份文档之前，先用 circle-hub source accept ${put.sha256} --note <说明> 接受`);
    return 0;
  }
  if (sub === 'list') {
    const { values } = parse(rest, { as: { type: 'string' } }, 0);
    const viewer = await session.viewer(values.as);
    if (viewer.role !== 'admin') {
      session.out('还没有命名文档');
      return 0;
    }
    const hub = await session.hub();
    const list = await hub.docs.list();
    if (list.length === 0) {
      session.out('还没有命名文档');
      return 0;
    }
    for (const info of list) session.out(`${info.name}\t${info.sha256}\t${info.size} 字节`);
    return 0;
  }
  if (sub === 'show') {
    const { values, positionals } = parse(rest, { as: { type: 'string' } }, 1);
    const viewer = await session.viewer(values.as);
    if (viewer.role !== 'admin') throw new CliError(`没有叫 ${positionals[0].slice(0, 80)} 的命名文档`);
    const hub = await session.hub();
    const info = await hub.docs.show(positionals[0]);
    if (info === null) throw new CliError(`没有叫 ${positionals[0].slice(0, 80)} 的命名文档`);
    session.out(`${info.name}\t${info.sha256}\t${info.size} 字节`);
    return 0;
  }
  throw new UsageError(`doc 的子命令：${DOC_USAGE}`);
}

async function recordsCommand(session:Session,args:readonly string[]):Promise<number> {
  const [sub,...rest]=args;if(sub!=='verify')throw new UsageError('records verify [--kind <记录类型>] [--vault]');
  const {values}=parse(rest,{kind:{type:'string'},as:{type:'string'},vault:{type:'boolean'}},0);
  const viewer=await session.viewer(values.as);if(viewer.role!=='admin')throw new CliError('只有管理员能核对记录完整性');
  const kind=values.kind ?? 'action';if(!(RECORD_KINDS as readonly string[]).includes(kind))throw new UsageError('记录类型不在生成的协议词表里');
  const records=await session.records();let cursor:string|null=null,total=0,notes=0;
  do {
    const page:Page<StoredRecord>=await records.store.list({kind:kind as RecordKind,limit:500,...(cursor?{cursor}:{})});
    for(const record of page.items){total++;if(record.integrity_note){notes++;if(record.kind==='action')session.out(`记录 ${record.id}；摘要 ${record.digest}；${record.integrity_note}`);}}
    cursor=page.next;
  }while(cursor);
  session.out(`已核对记录 ${total}；正文不是规范写法、内容与摘要一致 ${notes}`);
  if(values.vault){
    if(!records.vault.verify){session.out('密钥库核验未知：当前密钥库不支持只读逐条核验；下一步：安装支持核验的版本并停写后重试');return 1;}
    let result;
    try { result=await records.vault.verify(); } catch {session.out('密钥库核验未知：读取或解密核验未完成；下一步：停写并检查密钥来源和密钥库完整性后重试');return 1;}
    session.out(`密钥库：已核验 ${result.checked} 条；异常 ${result.failed} 项`);
    if(result.unknown){session.out('密钥库核验未知：没有可核对的密文条目或缺少必要事实；下一步：确认迁移源含密文条目和正确主密钥，停写后重试');return 1;}
    if(result.failed){session.out('密钥库核验未通过；下一步：检查备份、密钥及密文条目，停写后重试');return 1;}
  }
  return 0;
}

// ---------------------------------------------------------------- sharing (B04, R02): a read capability only
async function sharingCommand(session: Session, args: readonly string[], withdraw = false): Promise<number> {
  const admin = await session.admin();
  const kit = await session.records();
  const [sub, ...rest] = args;
  if (sub === 'list' && !withdraw) {
    const {values} = parse(rest,{object:{type:'string'}},0);
    const shares = await kit.authorizations.shares(admin,values.object);
    const names = await session.names();
    for (const share of shares) session.out([share.body.object,labelOf('share_audience',share.body.share_audience ?? 'user'),names.get(share.body.subject) ?? share.body.subject,share.body.note ?? ''].map(terminalSafe).join('\t'));
    if (!shares.length) session.out('没有有效分享');
    return 0;
  }
  if (sub !== 'run' && sub !== 'production') throw new UsageError(withdraw ? UNSHARE_USAGE : SHARE_USAGE);
  const {positionals,values} = parse(rest,{users:{type:'string'},user:{type:'string'},'pack-users':{type:'boolean'},reason:{type:'string'}},1);
  const hub = await session.hub();
  let object: string; let pack: string;
  if (sub === 'run') {
    const run = await hub.deps.runs.getRun(admin,positionals[0]);
    if (!run) throw new CliError('对你不可用');
    object = run.run.run; pack = parsePackRef(run.run.pack)!.id;
    if (withdraw) {
      if (Boolean(values.user) === Boolean(values['pack-users']) || values.users) throw new UsageError(UNSHARE_USAGE);
      const audience = values.user ? (await session.user(values.user)).id : {kind:'pack_users' as const,pack};
      await kit.authorizations.unshare(admin,object,audience,values.reason);
    } else {
      if (Boolean(values.users) === Boolean(values['pack-users']) || values.user) throw new UsageError(SHARE_USAGE);
      const audience = values.users ? await Promise.all(values.users.split(',').map(async name => (await session.user(name.trim())).id)) : {kind:'pack_users' as const,pack};
      await kit.authorizations.share(admin,object,audience,values.reason);
    }
  } else {
    if (values.users || values.user || values['pack-users']) throw new UsageError(withdraw ? UNSHARE_USAGE : SHARE_USAGE);
    pack = packIdOf(positionals[0],'分享');
    const published = await hub.registry.resolve(pack);
    if (!published || published.kind !== 'workflow') throw new CliError('对你不可用');
    object = productionShareKey(pack);
    const audience = {kind:'pack_users' as const,pack};
    if (withdraw) await kit.authorizations.unshare(admin,object,audience,values.reason);
    else await kit.authorizations.share(admin,object,audience,values.reason);
  }
  session.out(`${withdraw ? '已撤回分享' : '已分享（只读）'} ${object}`);
  return 0;
}

// ---------------------------------------------------------------- registration

type Handler = (session: Session, args: readonly string[]) => Promise<number>;

const COMMANDS: { name: string; summary: string; handler: Handler }[] = [
  {name:'share',summary:SHARE_USAGE.slice('share '.length),handler:sharingCommand},
  {name:'unshare',summary:UNSHARE_USAGE.slice('unshare '.length),handler:(session,args)=>sharingCommand(session,args,true)},
  {name:'records',summary:'verify [--kind <记录类型>] [--vault]（核存储摘要，可选核验密钥库解密，不输出正文）',handler:recordsCommand},
  { name: 'executor', summary: EXECUTOR_USAGE, handler: executorCommand },
  { name: 'job', summary: JOB_USAGE, handler: jobCommand },
  { name: 'bed', summary: BED_USAGE, handler: bedCommand },
  {name:'skill',summary:SKILL_USAGE.slice('skill '.length),handler:skillCommand},
  { name: 'pack', summary: PACK_USAGE.slice('pack '.length), handler: packCommand },
  { name: 'resource', summary: RESOURCE_USAGE.slice('resource '.length), handler: resourceCommand },
  { name: 'var', summary: VAR_USAGE.slice('var '.length), handler: variableCommand },
  { name: 'secret', summary: SECRET_USAGE.slice('secret '.length), handler: secretCommand },
  { name: 'source', summary: SOURCE_USAGE.slice('source '.length), handler: sourceCommand },
  { name: 'original', summary: ORIGINAL_USAGE.slice('original '.length), handler: originalCommand },
  { name: 'lease', summary: LEASE_USAGE.slice('lease '.length), handler: leaseCommand },
  { name: 'knowledge', summary: KNOWLEDGE_USAGE.slice('knowledge '.length), handler: knowledgeCommand },
  { name: 'doc', summary: DOC_USAGE.slice('doc '.length), handler: docCommand },
  { name: 'init-admin', summary: INIT_ADMIN_USAGE.slice('init-admin '.length), handler: initAdminCommand },
  { name: 'operator-token', summary: OPERATOR_TOKEN_USAGE.slice('operator-token '.length), handler: operatorTokenCommand },
];

/**
 * An error a command ends with, made safe for a terminal (a message or a hint may quote a pack, a resource or a remote
 * system). The configuration's own errors pass unchanged: the server CLI prints them as they are.
 */
function terminalSafeError(error: unknown): unknown {
  if (error instanceof HubEnvironmentError || error instanceof HubConfigError) return error;
  if (error instanceof UsageError) return new UsageError(terminalSafe(error.message));
  if (error instanceof CliError) return new CliError(terminalSafe(error.message), error.hint === null ? null : terminalSafe(error.hint));
  const hint = hintOf(error);
  return new CliError(terminalSafe(messageOf(error)), hint === null ? null : terminalSafe(hint));
}

/**
 * The enabled admin of the operator token (CIRCLE_HUB_TOKEN, else the keychain item), for any state-changing CLI command,
 * the server CLI's built-in ones included. It takes CIRCLE_HUB_TOKEN out of the environment object (no child process this
 * command starts gets it); before or after `ctx.config()`, which accepts the name for commands.
 */
export function operatorAdmin(ctx: CliContext, options: AdminCommandOptions = {}): Promise<Principal> {
  return new Session(ctx, options).admin();
}

export function operatorMember(ctx:CliContext,options:AdminCommandOptions={}):Promise<Principal>{return new Session(ctx,options).member();}

/** operatorAdmin for a command that may cut off its own token: afterwards it says whether the operator token still works. */
export function operatorAct(ctx: CliContext, options: AdminCommandOptions = {}): Promise<OperatorAct> {
  return new Session(ctx, options).act();
}

/**
 * Who a read-only CLI command reads as, the server CLI's built-in ones included: the account of the operator token when
 * there is one (`--as` must then name that account), else `--as` or the only enabled admin (Session.viewer).
 */
export function operatorViewer(ctx: CliContext, options: AdminCommandOptions = {}, as?: string): Promise<Principal> {
  return new Session(ctx, options).viewer(as);
}

/** The administrator commands, for the assembly's registerCommands (tests inject the token store, stdin and the assembly). */
export function adminCommands(options: AdminCommandOptions = {}): CliCommand[] {
  return COMMANDS.map(({ name, summary, handler }) => ({
    name,
    summary,
    run: async (args, ctx) => {
      try {
        return await handler(new Session(ctx, options), args);
      } catch (error) {
        throw terminalSafeError(error);
      }
    },
  }));
}
