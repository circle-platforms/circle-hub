// `circle-hub serve`: configuration from CIRCLE_HUB_* only (a retired CIRCLE_SERVER_* name refuses to start, and so does an
// operator token in the environment: a server needs no admin token), the platform's cluster started when the database is the
// data root's own socket (never initialised, never stopped on exit), records opened as the runtime role without migrating,
// the assembly, then the app on loopback until SIGTERM or SIGINT.
// `serve --migrate-only` applies the migrations as the owner role, grants the runtime role (records decision 16) and exits 0.
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { HubConfigError, HubEnvironmentError, assertNoRetiredEnvironment, loadConfig, type HubConfig } from '../config/index.ts';
import { PLATFORM_ONLY_VARIABLES, ensureHubDatabase, hubKeyProvider, layoutAt } from '../platform/api.ts';
import { migrateRecords, openRecords, type KeyProvider, type RecordsKit } from '../records/index.ts';
import { stopAll, sweepOrphans } from '../rules/api.ts';
import type { AppOptions, AssemblyModule, CliIo, HubApp, ListenInfo } from './api.ts';
import { createApp } from './app.ts';
import { OPERATOR_TOKEN_VARIABLE } from './assemble/operator-token.ts';
import { terminalSafe } from './assemble/terminal.ts';
import { isAssemblyMissing, UsageError } from './errors.ts';
import { describeError } from './notes.ts';

export interface ServeOptions {
  io: CliIo;
  /** Starts the platform's cluster when the database is the data root's socket; default hub/platform ensureHubDatabase. */
  ensureDatabase?: (env: NodeJS.ProcessEnv) => Promise<unknown>;
  /** Vault key provider; default hub/platform hubKeyProvider (the keychain item of the deployment settings). */
  keyProvider?: (env: NodeJS.ProcessEnv) => KeyProvider;
  /** Role that owns the tables for --migrate-only; default the operating-system account, the cluster's own role under hub/platform. */
  ownerRole?: string;
  /** The assembly module; default hub/server/assemble.ts. */
  assembly?: () => Promise<AssemblyModule>;
  /** Resolves when the server should stop; default SIGTERM or SIGINT. */
  stopSignal?: () => Promise<unknown>;
  appOptions?: AppOptions;
  onListening?: (info: ListenInfo) => void;
  now?: () => Date;
}

export const SERVE_USAGE = 'serve [--migrate-only] [--migrate]   启动 Hub（只监听本机）；--migrate-only 以拥有表的角色应用迁移后退出；--migrate 用连接角色先迁移（单角色的开发环境）';

/** CIRCLE_HUB_* names hub/config does not know but this program accepts: the platform's own (its commands read them). */
export const ACCEPTED_PLATFORM_VARIABLES: readonly string[] = PLATFORM_ONLY_VARIABLES;

/**
 * Why `serve` refuses the operator token rather than dropping it: a server never acts as an admin, so a token in its
 * environment can only be a shell's export leaking into a long-lived process (and, through it, into whatever it starts).
 * Refusing makes the operator remove it from the shell; dropping it silently would leave it there for every later command.
 */
export const SERVE_TOKEN_REFUSED = `serve 不接受 ${OPERATOR_TOKEN_VARIABLE}：服务器不以管理员身份做任何事，不需要管理员令牌；它只给单条 CLI 命令用（${OPERATOR_TOKEN_VARIABLE}="$T" circle-hub <命令>）。先在这个 shell 里 unset ${OPERATOR_TOKEN_VARIABLE}，再启动（launchd 的服务环境里没有它）`;

/**
 * The configuration of `serve` (`command` false) or of one CLI command (`command` true). A command also accepts
 * CIRCLE_HUB_TOKEN, the operator token it acts with (never read here; hub/config's allowUnknown names this case); `serve`
 * refuses it with SERVE_TOKEN_REFUSED, after the retired-name guard. The value is never printed.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv, options: { command?: boolean } = {}): HubConfig {
  assertNoRetiredEnvironment(env);
  if (options.command !== true && env[OPERATOR_TOKEN_VARIABLE] !== undefined) throw new HubConfigError([SERVE_TOKEN_REFUSED]);
  return loadConfig(env, { allowUnknown: options.command === true ? [...ACCEPTED_PLATFORM_VARIABLES, OPERATOR_TOKEN_VARIABLE] : ACCEPTED_PLATFORM_VARIABLES });
}

/** The database is the platform's when its socket directory is the data root's run/ directory. */
export function platformManaged(config: HubConfig): boolean {
  try {
    return config.database.host === layoutAt(config.dataDir).run;
  } catch {
    return false;
  }
}

export async function prepareDatabase(config: HubConfig, options: Pick<ServeOptions, 'ensureDatabase' | 'io'>): Promise<void> {
  if (!platformManaged(config)) return;
  await (options.ensureDatabase ?? ensureHubDatabase)(options.io.env);
}

/** Prints a startup failure in Chinese (configuration problems listed, never values of secrets) and gives exit code 1. */
export function reportFailure(io: CliIo, error: unknown): number {
  if (error instanceof UsageError) {
    io.stderr(`错误：${error.message}`);
    io.stderr(`用法：circle-hub ${SERVE_USAGE}`);
    return 2;
  }
  if (error instanceof HubEnvironmentError || error instanceof HubConfigError) {
    io.stderr(error.message);
    return 1;
  }
  const hint = (error as { hint?: unknown } | null)?.hint;
  io.stderr(`错误：${error instanceof Error ? error.message : String(error)}`);
  if (typeof hint === 'string' && hint.length > 0) io.stderr(`处理：${hint}`);
  return 1;
}

function defaultStop(): Promise<unknown> {
  return new Promise((resolve) => {
    const done = (signal: string) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      resolve(signal);
    };
    const onTerm = () => done('SIGTERM');
    const onInt = () => done('SIGINT');
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onInt);
  });
}

async function migrateOnly(config: HubConfig, options: ServeOptions): Promise<number> {
  const runtime = config.database.user;
  const owner = options.ownerRole ?? userInfo().username;
  if (owner === runtime) {
    const applied = await migrateRecords({ database: config.database });
    options.io.stdout(`迁移完成：应用了 ${applied.length} 个迁移${applied.length > 0 ? `（版本 ${applied.join('、')}）` : ''}`);
    options.io.stderr(`注意：拥有表的角色和运行角色都是 ${runtime}，只追加约束挡不住运行中的 Hub 本身；部署时让另一个角色执行迁移`);
    return 0;
  }
  const applied = await migrateRecords({ database: { ...config.database, user: owner } }, { runtimeRole: runtime });
  options.io.stdout(`迁移完成：以角色 ${owner} 应用了 ${applied.length} 个迁移${applied.length > 0 ? `（版本 ${applied.join('、')}）` : ''}，运行角色 ${runtime} 已按最小权限授权`);
  return 0;
}

/** `circle-hub serve [...]`; resolves with the exit code once the server has stopped (or failed to start). */
export async function serve(args: readonly string[], options: ServeOptions): Promise<number> {
  const io = options.io;
  let flags: { 'migrate-only'?: boolean; migrate?: boolean };
  let config: HubConfig;
  try {
    try {
      flags = parseArgs({ args: [...args], options: { 'migrate-only': { type: 'boolean' }, migrate: { type: 'boolean' } }, allowPositionals: false, strict: true }).values;
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    if (flags['migrate-only'] === true && flags.migrate === true) throw new UsageError('--migrate-only 和 --migrate 只能用一个');
    config = loadServerConfig(io.env);
    await prepareDatabase(config, options);
    if (flags['migrate-only'] === true) return await migrateOnly(config, options);
  } catch (error) {
    return reportFailure(io, error);
  }

  let records: RecordsKit;
  try {
    records = await openRecords(config, {
      keyProvider: (options.keyProvider ?? hubKeyProvider)(io.env),
      migrate: flags.migrate === true,
      ...(options.now ? { now: options.now } : {}),
    });
  } catch (error) {
    return reportFailure(io, error);
  }
  // The operator's log while serving (launchd's stderr file): one line each, made safe for a terminal, since a line may
  // quote what a caller sent (a tool name, an error about an argument).
  const operatorLog = (line: string): void => io.stderr(terminalSafe(line));
  const now = (options.now ?? (() => new Date()))();
  try {
    // Lines a crash kept out of the JSONL files of the last days are written now (records decision 11).
    await records.callLog.repairFiles({ from: new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString(), to: new Date(now.getTime() + 60_000).toISOString() });
  } catch (error) {
    operatorLog(`调用日志文件补写失败（不影响启动）：${error instanceof Error ? error.message : String(error)}`);
  }
  await sweepOrphans().catch((error: unknown) => operatorLog(`清理遗留的沙箱子进程失败（不影响启动）：${error instanceof Error ? error.message : String(error)}`));

  let app: HubApp | undefined;
  let maintenance: import('./api.ts').ServerDeps['maintenance'];
  try {
    const assembly = await (options.assembly ?? (() => import('./assemble.ts') as Promise<AssemblyModule>))();
    const deps = await assembly.assemble(config, records);
    maintenance=deps.maintenance;
    await maintenance?.startMaintenance();
    app = createApp(deps, { log: operatorLog, ...options.appOptions });
    const info = await app.listen();
    io.stdout(`circle-hub 在 ${info.url} 上监听${app.release === null ? '' : `（发布 ${app.release}）`}`);
    options.onListening?.(info);
  } catch (error) {
    await maintenance?.stopMaintenance().catch(() => {});
    await app?.close().catch(() => {});
    await records.close().catch(() => {});
    if (isAssemblyMissing(error)) {
      io.stderr(`错误：${(error as Error).message}`);
      return 1;
    }
    return reportFailure(io, error);
  }

  const running: HubApp = app;
  // Defence in depth while serving: a rejection nobody handled (a bug anywhere in the process) is reported to the operator's
  // log instead of ending the process with every connection and console session in it. The request path itself never
  // leaves one (app.ts).
  const onRejection = (reason: unknown): void => operatorLog(`未处理的异步错误（服务继续运行）：${describeError(reason)}`);
  process.on('unhandledRejection', onRejection);
  try {
    const signal = await (options.stopSignal ?? defaultStop)();
    io.stdout(`收到${typeof signal === 'string' ? ` ${signal}` : '停止请求'}，正在停止：等进行中的请求结束`);
    await maintenance?.stopMaintenance();
    await running.close();
    // Pack-function children still running after the requests ended are stopped (hub/rules README).
    stopAll();
    await records.close();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
  io.stdout('circle-hub 已停止（数据库保持运行）');
  return 0;
}
