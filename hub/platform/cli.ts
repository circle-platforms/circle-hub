// `circle-hub` platform commands. The server CLI delegates these to runPlatformCommand; bin/circle-hub falls back to
// main() here when the server package is absent. All output is Chinese; the vault master key is never printed.
// The vault is 密钥库 (the design standard's term); its key is named by VAULT_KEY_ITEM.label.
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ENVIRONMENT, isEnvironment, labelOf } from '../../contracts/generated/vocabulary.ts';
import { backupPath, createBackup, listBackups, pruneBackups } from './backup.ts';
import { agentFor, createContext, identityOf, keychainFor, keychainNamesFor, platformLockPath, postgresFor, settingsOf, type PlatformContext } from './context.ts';
import { deploy, deployLogPath, progressPath, progressText, protectedBackups, readDeployments, readProgress, rollback } from './deploy.ts';
import { assertHubEnvironment, assertKnownHubVariables, PLATFORM_VARIABLES, variable } from './environment.ts';
import { messageOf, PlatformError } from './errors.ts';
import { isMissingOrEmpty, withLock } from './files.ts';
import { checkHealth, HEALTH_PATH, portOccupied } from './health.ts';
import { VAULT_KEY_ITEM } from './keychain-items.ts';
import { exportVaultKey, importVaultKey, liveKeyPipe, type KeyPipe } from './key-transfer.ts';
import { checkNode, serviceDefinition, stableNodePath } from './launchd.ts';
import { DATA_ROOT_VARIABLE, ensureLayout, socketFile, type Layout } from './layout.ts';
import { databaseOwner, ensureDatabaseRunning } from './postgres.ts';
import { rehearse } from './rehearse.ts';
import { readCurrentRelease, type ReleaseRef } from './release.ts';
import { restoreBackup, setAsideVault as archiveVault } from './restore.ts';
import { inspectRole, roleFixHint } from './roles.ts';
import {
  environmentText,
  newSettingsFile,
  parsePort,
  parseSettingsText,
  readSettingsFile,
  resolveSettings,
  settingsPath,
  writeSettingsFile,
  type PlatformSettings,
  type PlatformSettingsFile,
} from './settings.ts';
import { withSession } from './sql.ts';
import { RENEW_WITHIN_DAYS, certificateHosts, daysLeft, initTls, readTlsState } from './tls.ts';

export interface PlatformIo {
  stdout(line: string): void;
  stderr(line: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** CIRCLE_HUB_* names the calling program reads itself (the server CLI); every other unknown name is refused. */
  allowVariables?: readonly string[];
  /** Pipe ends for `key export` and `key import`. Absent means neither command may touch a key. */
  keyPipe?: KeyPipe;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

type Handler = (args: readonly string[], context: PlatformContext, io: PlatformIo) => Promise<number>;

/** Exit code of a status command whose subject is not running. */
const NOT_RUNNING = 3;

function environmentChoices(): string {
  return ENVIRONMENT.map((code) => `${code}（${labelOf('environment', code)}）`).join('、');
}

export function usage(platform: NodeJS.Platform = process.platform): string {
  return [
    '用法：circle-hub <命令>',
    '',
    `  init --environment <环境类别> [--port <端口>] [--https-port <端口> [--https-host <地址>]]   建数据根和部署设置，初始化并启动数据库；环境类别：${environmentChoices()}`,
    '  db start|stop|status                           本机 PostgreSQL（只有 unix 套接字，没有 TCP 端口）',
    `  key init [--set-aside-vault]|status|export --confirm|import   建立或查看${VAULT_KEY_ITEM.label}；密钥只经管道传输且不覆盖`,
    `  service install|uninstall|start|stop|status    ${platform === 'linux' ? 'systemd' : 'launchd'} 用户服务 circle-hub serve`,
    '  backup [--keep <份数>]                         备份数据库、对象、密钥库与设置文件，并清理旧备份',
    '  restore <备份目录>                             校验后恢复到空的数据根',
    '  deploy [--source <目录>] [--commit <提交>] [--copy] | --bundle <解开的发布包> [--node <路径>]   部署一个提交或发布包；失败时恢复部署前备份并切回上一版',
    '  rollback                                       回到上一版并恢复它部署前的备份',
    '  rehearse [--keep]                              在临时数据根里演练备份、销毁与恢复',
    '  tls init [--renew-authority]|issue|status      内置 HTTPS 的本地证书颁发机构和服务器证书（数据根的 tls 目录）',
    '  status                                         汇总状态',
    '',
    `数据根默认是 ~/Library/Application Support/circle-hub，可用 ${DATA_ROOT_VARIABLE} 改。端口、数据库名与钥匙串项只来自部署设置。`,
  ].join('\n');
}

function parse<T extends Record<string, { type: 'string' | 'boolean' }>>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(`参数不对：${(error as Error).message}`);
  }
}

function noArguments(args: readonly string[]): void {
  if (args.length > 0) throw new UsageError(`多余的参数：${args.join(' ')}`);
}

function parseCount(text: string, name: string): number {
  if (!/^[1-9][0-9]{0,3}$/.test(text)) throw new UsageError(`${name} 要是正整数：${text}`);
  return Number(text);
}

/** `owner` is the database's owner as the running cluster reports it (pg_database.datdba); left out when not known. */
function databaseText(layout: Layout, settings: PlatformSettings, owner?: string): string {
  const { name, role, port } = settings.database;
  return `数据库 ${name}（${owner === undefined ? '' : `属于角色 ${owner}，`}应用角色 ${role}，套接字 ${socketFile(layout, port)}）；钥匙串项：服务 ${settings.keychainService}，账户 ${settings.keychainAccount}`;
}

/** Refuses while a deploy or rollback is unfinished: its state must be finished first, and its backups kept. */
async function refuseWhilePending(context: PlatformContext, action: string): Promise<void> {
  const pending = await readProgress(context.layout);
  if (pending) {
    throw new PlatformError(`${progressText(pending)}，现在不${action}`, `先运行 circle-hub ${pending.operation} 完成它；确认已经手动处理好之后才可删除 ${progressPath(context.layout)}`);
  }
}

const init: Handler = async (args, context, io) => {
  const { values, positionals } = parse(args, { environment: { type: 'string' }, port: { type: 'string' }, 'https-port': { type: 'string' }, 'https-host': { type: 'string' } });
  noArguments(positionals);
  const { layout } = context;
  let port: number | undefined;
  let httpsPort: number | undefined;
  try {
    port = values.port === undefined ? undefined : parsePort(values.port, '--port');
    const envHttpsPort = variable(context.env, PLATFORM_VARIABLES.httpsPort);
    httpsPort = values['https-port'] !== undefined ? parsePort(values['https-port'], '--https-port') : envHttpsPort === undefined ? undefined : parsePort(envHttpsPort, PLATFORM_VARIABLES.httpsPort);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const httpsHost = values['https-host'] ?? variable(context.env, PLATFORM_VARIABLES.httpsHost);
  if (httpsHost !== undefined && httpsPort === undefined) throw new UsageError('--https-host 要和 --https-port 一起给');
  if (values.environment !== undefined && !isEnvironment(values.environment)) throw new UsageError(`环境类别只能是：${environmentChoices()}`);
  let file = await readSettingsFile(layout);
  if (!file) {
    if (values.environment === undefined || !isEnvironment(values.environment)) {
      throw new UsageError(`第一次 init 要用 --environment 指定环境类别：${environmentChoices()}`);
    }
    // A new deployment takes the values the shell names explicitly; from then on the file is their only source.
    const envPort = variable(context.env, PLATFORM_VARIABLES.port);
    const fresh = newSettingsFile({
      environment: values.environment,
      port: port ?? (envPort === undefined ? undefined : parsePort(envPort, PLATFORM_VARIABLES.port)),
      listenHost: variable(context.env, PLATFORM_VARIABLES.host),
      allowedHosts: variable(context.env, PLATFORM_VARIABLES.allowedHosts)?.split(','),
      proxyOrigin: variable(context.env, PLATFORM_VARIABLES.proxyOrigin),
      proxyPeer: variable(context.env, PLATFORM_VARIABLES.proxyPeer),
      httpsHost,
      httpsPort,
      keychainService: variable(context.env, PLATFORM_VARIABLES.keychainService),
      keychainAccount: variable(context.env, PLATFORM_VARIABLES.keychainAccount),
      database: context.database,
    });
    // Refuses before anything is written when --port and CIRCLE_HUB_PORT disagree.
    resolveSettings(fresh, context.env, layout);
    await ensureLayout(layout);
    await writeSettingsFile(layout, fresh);
    file = fresh;
    io.stdout(`已写入部署设置：${settingsPath(layout)}`);
  } else {
    const conflict = (values.environment !== undefined && values.environment !== file.environment) || (port !== undefined && port !== file.port) || (httpsPort !== undefined && httpsPort !== file.https_port) || (httpsHost !== undefined && httpsHost !== (file.https_host ?? '127.0.0.1'));
    if (conflict) throw new PlatformError('已有部署设置，与这次给的参数不同，不改写', `要改就手动编辑 ${settingsPath(layout)}`);
    await ensureLayout(layout);
    io.stdout(`沿用已有部署设置：${settingsPath(layout)}`);
  }
  const settings = resolveSettings(file, context.env, layout);
  const cluster = postgresFor({ ...context, database: settings.database }, (await readCurrentRelease(layout))?.dir);
  const initialised = await cluster.initialise();
  const { started, created } = await ensureDatabaseRunning(cluster, { create: true });
  io.stdout(initialised ? '已初始化数据库目录' : '数据库目录已存在，没有重新初始化');
  io.stdout(started ? '数据库已启动' : '数据库本来就在运行');
  if (created) io.stdout(`已建数据库 ${cluster.target.database}`);
  io.stdout(`数据根：${layout.root}`);
  io.stdout(`环境类别：${environmentText(settings.environment)}；端口：${settings.listenHost ?? '127.0.0.1'}:${settings.port}${settings.allowedHosts ? `；允许主机：${settings.allowedHosts.join('、')}` : ''}${settings.proxyOrigin ? `；代理来源：${settings.proxyOrigin}；可信对端：${settings.proxyPeer}` : ''}`);
  io.stdout(databaseText(layout, settings, await databaseOwner(cluster)));
  if (settings.https) io.stdout(`内置 HTTPS：${httpsAuthority(settings.https)}`);
  io.stdout(`下一步：circle-hub key init，${settings.https ? '然后 circle-hub tls init，' : ''}然后 circle-hub deploy`);
  return 0;
};

function httpsAuthority(https: { host: string; port: number }): string {
  return `https://${https.host.includes(':') ? `[${https.host}]` : https.host}:${https.port}`;
}

/** The names the server certificate must cover: the HTTPS listen address when it is not loopback, and every allowed host. */
function certificateNames(settings: PlatformSettings): string[] {
  const names = [...(settings.allowedHosts ?? [])];
  const listen = settings.https?.host;
  if (listen !== undefined && listen !== '::1' && !listen.startsWith('127.') && !names.includes(listen)) names.unshift(listen);
  return names;
}

const tls: Handler = async (args, context, io) => {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest, { 'renew-authority': { type: 'boolean' } });
  noArguments(positionals);
  if (action !== 'init' && action !== 'issue' && action !== 'status') throw new UsageError('用法：circle-hub tls init [--renew-authority]|issue|status');
  if (action !== 'init' && values['renew-authority']) throw new UsageError('--renew-authority 只用于 tls init');
  const { layout } = context;
  const settings = await settingsOf(context);
  if (action === 'status') {
    const state = await readTlsState(layout.root);
    io.stdout(`内置 HTTPS：${settings.https ? httpsAuthority(settings.https) : '没有开启（部署设置里没有 https_port）'}`);
    if (state.authority === null) {
      io.stdout('证书颁发机构：没有；运行 circle-hub tls init 建立');
      return NOT_RUNNING;
    }
    io.stdout(`证书颁发机构：${state.paths.authorityCert}（SHA-256 指纹 ${state.authority.fingerprint256}，${state.authority.validTo} 到期）`);
    const server = state.server;
    if (server === null) {
      io.stdout('服务器证书：没有；运行 circle-hub tls issue 签发');
      return NOT_RUNNING;
    }
    const left = daysLeft(server);
    io.stdout(`服务器证书：${certificateHosts(server).join('、')}；${server.validTo} 到期（还有 ${left} 天）${left <= RENEW_WITHIN_DAYS ? '；快到期了，运行 circle-hub tls issue 重新签发后重启服务' : ''}`);
    const uncovered = certificateNames(settings).filter((name) => !certificateHosts(server).includes(name));
    if (uncovered.length > 0) io.stdout(`注意：服务器证书没有覆盖部署设置里的 ${uncovered.join('、')}；运行 circle-hub tls issue 重新签发`);
    return 0;
  }
  if (!settings.https) io.stdout('注意：部署设置里还没有开启内置 HTTPS（https_port）；证书照样签发，开启后才会用到');
  if (action === 'issue' && (await readTlsState(layout.root)).authority === null) {
    throw new PlatformError('还没有证书颁发机构，不能只签发服务器证书', '先运行 circle-hub tls init');
  }
  const result = await initTls(layout.root, certificateNames(settings), { renewAuthority: values['renew-authority'] === true });
  if (result.createdAuthority) {
    io.stdout(`已建立证书颁发机构：${result.paths.authorityCert}`);
    io.stdout(`SHA-256 指纹：${result.authorityFingerprint}`);
    io.stdout('让浏览器和 Circle 信任这份证书：在浏览器或系统钥匙串里导入它，Circle 在设置的 trust_cert_files 里加上它；信任前核对指纹');
  } else {
    io.stdout(`沿用已有的证书颁发机构：${result.paths.authorityCert}（指纹 ${result.authorityFingerprint}）`);
  }
  io.stdout(`已签发服务器证书：${result.hosts.join('、')}；${result.serverValidTo} 到期`);
  io.stdout('服务正在运行时，重启后才用上新证书：circle-hub service stop，然后 circle-hub service start');
  return 0;
};

const db: Handler = async (args, context, io) => {
  const [action, ...rest] = args;
  noArguments(rest);
  if (action !== 'start' && action !== 'stop' && action !== 'status') throw new UsageError('用法：circle-hub db start|stop|status');
  const cluster = postgresFor(context, (await readCurrentRelease(context.layout))?.dir);
  if (action === 'start') {
    const { started } = await ensureDatabaseRunning(cluster);
    io.stdout(started ? '数据库已启动' : '数据库本来就在运行');
    return 0;
  }
  if (action === 'stop') {
    io.stdout((await cluster.stop()) ? '数据库已停止' : '数据库本来就没在运行');
    return 0;
  }
  if (action === 'status') {
    const status = await cluster.status();
    const state = !status.initialised ? '未初始化' : status.running ? `运行中${status.pid ? `（PID ${status.pid}）` : ''}` : '已停止';
    io.stdout(`数据库：${state}`);
    io.stdout(`数据目录：${context.layout.db}${status.dataMajor ? `（PostgreSQL ${status.dataMajor}）` : ''}`);
    io.stdout(`二进制：${status.binaryVersion}`);
    io.stdout(`套接字目录：${status.socketDir}（没有 TCP 监听）`);
    return status.running ? 0 : NOT_RUNNING;
  }
  return 0;
};

const KEY_INIT_REFUSALS = {
  vault_not_empty: {message:'密钥库非空，不新建主密钥',hint:'已有主密钥时不需要 key init，用 circle-hub key status 查看；只有主密钥丢失且找不回时，才停服务，运行 circle-hub key init --set-aside-vault，将 vault/ 移到 set-aside/<时间>-key-loss/vault 后建立新密钥；操作令牌也丢失时先运行 circle-hub operator-token reissue；然后 circle-hub secret import，最后起服务'},
  service_loaded: {message:'Hub 服务已加载，不移开密钥库或初始化主密钥',hint:'先运行 circle-hub service stop，确认服务停止后再运行 key init --set-aside-vault'},
  port_busy: {message:'配置端口仍有进程应答，不移开密钥库或新建主密钥',hint:'先核对并停妥占用该数据根配置端口的进程，再重试 key init --set-aside-vault'},
  key_present: {message:'主密钥已存在，不移开密钥库且不覆盖密钥',hint:'用 circle-hub key status 核对现有主密钥，保留当前密钥库'},
} as const;
class KeyInitRefusal extends PlatformError {
  readonly reason: keyof typeof KEY_INIT_REFUSALS;
  constructor(reason: keyof typeof KEY_INIT_REFUSALS) {const refusal=KEY_INIT_REFUSALS[reason];super(refusal.message,refusal.hint);this.reason=reason;this.name='KeyInitRefusal';}
}
const KEY_USAGE = `用法：circle-hub key init [--set-aside-vault]|status|export --confirm|import`;

/** Refuses without repeating the argument: a mistaken argument may be the key itself. */
function onlyConfirm(args: readonly string[]): void {
  if (args.length !== 1 || args[0] !== '--confirm') throw new UsageError('用法：circle-hub key export --confirm');
}

const key: Handler = async (args, context, io) => {
  const [action, ...rest] = args;
  if (action === 'export') {
    onlyConfirm(rest);
    const pipe = io.keyPipe ?? { stdoutIsPipe: false, stdinIsPipe: false };
    const settings = await settingsOf(context);
    await exportVaultKey(keychainFor(context, settings), pipe, true);
    io.stderr(`已通过标准输出送出${VAULT_KEY_ITEM.label}（32 字节）；密钥不会显示`);
    return 0;
  }
  if (action === 'import') {
    if (rest.length !== 0) throw new UsageError('用法：circle-hub key import');
    const pipe = io.keyPipe ?? { stdoutIsPipe: false, stdinIsPipe: false };
    const settings = await settingsOf(context);
    await importVaultKey(keychainFor(context, settings), pipe);
    io.stderr(`已从标准输入写入${VAULT_KEY_ITEM.label}；已存在的不会覆盖，密钥不会显示`);
    return 0;
  }
  const setAsideVault = action === 'init' && rest.length === 1 && rest[0] === '--set-aside-vault';
  if ((action !== 'init' && action !== 'status') || (rest.length > 0 && !setAsideVault)) throw new UsageError(KEY_USAGE);
  const settings=await settingsOf(context);
  const store = keychainFor(context, settings);
  const item = `服务 ${store.service}，账户 ${store.account}`;
  if (action === 'init') {
    if (!setAsideVault && !(await isMissingOrEmpty(context.layout.vault))) throw new KeyInitRefusal('vault_not_empty');
    const initialize = async (): Promise<number> => {
      if (setAsideVault) {
        if ((await agentFor(context, settings).status()).loaded) throw new KeyInitRefusal('service_loaded');
        if (await portOccupied(settings.port)) throw new KeyInitRefusal('port_busy');
        if ((await store.status()).present) throw new KeyInitRefusal('key_present');
        const moved=await archiveVault(context.layout,context.now());
        if(moved.path) io.stdout(`密钥库已移到 ${moved.path}，原文件保留`);
      }
      await store.init();
      io.stdout(`已在${context.platform === 'linux' ? '私有密钥文件' : '钥匙串'}建立${VAULT_KEY_ITEM.label}（${item}）；密钥不会显示，也不进备份`);
      return 0;
    };
    return setAsideVault ? withLock(platformLockPath(context),initialize) : initialize();
  }
  const { present } = await store.status();
  io.stdout(present ? `${VAULT_KEY_ITEM.label}：已在${context.platform === 'linux' ? '私有密钥文件' : '钥匙串'}（${item}）` : `${VAULT_KEY_ITEM.label}：没有（${item}）；运行 circle-hub key init`);
  return present ? 0 : NOT_RUNNING;
};

const SERVICE_USAGE = '用法：circle-hub service install|uninstall|start|stop|status';

async function selectedNode(context: PlatformContext, configured: string | undefined, explicit?: string): Promise<{node:string;version:string}> {
  if (explicit !== undefined && !isAbsolute(explicit)) throw new UsageError('--node 必须是绝对路径');
  const node = explicit ?? context.nodePath ?? configured ?? (await stableNodePath());
  try { return {node,version:await checkNode(node, context.runner)}; }
  catch (error) {
    if (context.platform !== 'linux') throw error;
    throw new PlatformError(`无法使用配置的 Node：${node}`, '确认目标上的 Node 24 路径后，用 --node <绝对路径> 明确指定', {cause:error});
  }
}

const service: Handler = async (args, context, io) => {
  const [action, ...rest] = args;
  const {values, positionals} = parse(rest, {node:{type:'string'}});
  noArguments(positionals);
  if (values.node !== undefined && action !== 'install') throw new UsageError('--node 只能用于 service install');
  if (!['install', 'uninstall', 'start', 'stop', 'status'].includes(action ?? '')) throw new UsageError(SERVICE_USAGE);
  const settings = await settingsOf(context);
  // serve would refuse a vault master key on the operator token's account, and launchd would restart it every 10 s;
  // stop, uninstall and status stay available to clean up.
  if (action === 'install' || action === 'start') keychainNamesFor(context, settings);
  const agent = agentFor(context, settings);
  switch (action) {
    case 'install': {
      if (!(await readCurrentRelease(context.layout))) throw new PlatformError('还没有部署任何发布（没有 current）', '先运行 circle-hub deploy');
      const {node,version} = await selectedNode(context, settings.node, values.node);
      await agent.install(serviceDefinition(context.layout, settings, { node, ...identityOf(context) }));
      io.stdout(`已安装并加载服务 ${settings.label}（${agent.plist}；Node ${version}）`);
      return 0;
    }
    case 'uninstall':
      io.stdout((await agent.uninstall()) ? '已卸下服务并删除服务定义' : '服务本来就没安装');
      return 0;
    case 'start':
      io.stdout((await agent.start()) ? '服务已启动' : '服务本来就在运行');
      return 0;
    case 'stop':
      io.stdout((await agent.stop()) ? '服务已停止（下次登录或 circle-hub service start 时再启动）' : '服务本来就没在运行');
      return 0;
    case 'status': {
      const status = await agent.status();
      const state = !status.loaded ? '未加载' : status.running ? `运行中${status.pid ? `（PID ${status.pid}）` : ''}` : '已加载，未运行';
      io.stdout(`服务：${state}${status.lastExit ? `；上次退出：${status.lastExit}` : ''}`);
      io.stdout(`服务定义：${status.plist}${status.installed ? '' : '（不存在）'}`);
      return status.running ? 0 : NOT_RUNNING;
    }
    default:
      throw new UsageError(SERVICE_USAGE);
  }
};

const backup: Handler = async (args, context, io) => {
  const { values, positionals } = parse(args, { keep: { type: 'string' } });
  noArguments(positionals);
  const requested = values.keep === undefined ? undefined : parseCount(values.keep, '--keep');
  const keep = requested ?? (await settingsOf(context)).backupsKeep;
  io.stdout(`数据根：${context.layout.root}`);
  return withLock(platformLockPath(context), async () => {
    await refuseWhilePending(context, '备份');
    const cluster = postgresFor(context, (await readCurrentRelease(context.layout))?.dir);
    const { started } = await ensureDatabaseRunning(cluster);
    try {
      const { dir, manifest, skipped, reused } = await createBackup({ layout: context.layout, postgres: cluster, runner: context.runner, libpqBin: context.libpqBin, now: context.now });
      const rows = manifest.database.tables.reduce((sum, table) => sum + table.rows, 0);
      io.stdout(`备份完成：${dir}`);
      io.stdout(`数据库 ${manifest.database.tables.length} 张表 ${rows} 行；文件 ${manifest.files.length - 1} 个；清单含每个文件的 SHA-256`);
      if (reused > 0) io.stdout(`其中 ${reused} 个对象与上一份备份相同，用硬链接共用一份（SHA-256 已重新核对）`);
      if (skipped.length > 0) io.stdout(`备份期间消失、没有备份的文件 ${skipped.length} 个：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? ' 等' : ''}`);
      const removed = await pruneBackups(context.layout, keep, await protectedBackups(context));
      if (removed.length > 0) io.stdout(`按保留 ${keep} 份删除了 ${removed.length} 份旧备份`);
    } finally {
      if (started) await cluster.stop();
    }
    return 0;
  });
};

/** The settings file inside a backup (it is checked against the manifest by the restore itself). */
async function backupSettings(dir: string): Promise<PlatformSettingsFile | undefined> {
  const path = join(dir, 'config', 'platform.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseSettingsText(text, path);
}

const restore: Handler = async (args, context, io) => {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1) throw new UsageError('用法：circle-hub restore <备份目录>');
  const dir = resolve(io.cwd, positionals[0]!);
  io.stdout(`数据根：${context.layout.root}`);
  return withLock(platformLockPath(context), async () => {
    await refuseWhilePending(context, '恢复');
    if ((await agentFor(context).status()).loaded) {
      throw new PlatformError(`Hub 服务已加载（${context.platform === 'linux' ? 'systemd' : 'launchd'} 会不断重启它，它会和恢复抢数据库），不恢复`, context.platform === 'linux'
        ? '先运行 circle-hub service stop 和 circle-hub service uninstall，确认自启已禁用；恢复完成后重新运行 circle-hub service install'
        : '先运行 circle-hub service stop，恢复完成后再运行 circle-hub service start');
    }
    // The settings that will apply after the restore: the data root's own, else the backup's.
    const file = (await readSettingsFile(context.layout)) ?? (await backupSettings(dir));
    const settings = file ? resolveSettings(file, context.env, context.layout) : undefined;
    if (settings && (await portOccupied(settings.port))) {
      throw new PlatformError(`端口 ${settings.listenHost ?? '127.0.0.1'}:${settings.port} 有进程应答（可能是手动启动的 Hub），不恢复`, '先停掉它再恢复');
    }
    const target = settings ? { ...context, database: settings.database } : context;
    const cluster = postgresFor(target, (await readCurrentRelease(context.layout))?.dir);
    const report = await restoreBackup({ layout: context.layout, backupDir: dir, postgres: cluster, runner: context.runner, libpqBin: context.libpqBin, now: context.now });
    io.stdout(`已从 ${dir} 恢复：${report.tables} 张表 ${report.rows} 行，与清单一致；文件 ${report.files} 个；数据库在运行`);
    io.stdout(`数据库与表属于角色 ${cluster.target.user}；应用角色 ${cluster.application.user} 的 ${report.privileges} 项权限与备份时一致，不拥有任何对象`);
    if (report.keptConfig.length > 0) io.stdout(`这些设置文件与备份里的不同，保留了数据根里现有的：${report.keptConfig.join('、')}`);
    return 0;
  });
};

const deployCommand: Handler = async (args, context, io) => {
  const { values, positionals } = parse(args, { source: { type: 'string' }, commit: { type: 'string' }, copy: { type: 'boolean' }, bundle: { type: 'string' }, node: {type:'string'} });
  noArguments(positionals);
  if (values.copy && values.commit !== undefined) throw new UsageError('--copy 与 --commit 不能同时用');
  if (values.bundle !== undefined && (values.copy || values.commit !== undefined || values.source !== undefined)) throw new UsageError('--bundle 不能和 --source、--commit 或 --copy 同时用');
  const source = values.bundle !== undefined
    ? { path: resolve(io.cwd, values.bundle), bundle: true }
    : {
      path: resolve(io.cwd, values.source ?? '.'),
      ...(values.commit === undefined ? {} : { commit: values.commit }),
      ...(values.copy ? { copy: true } : {}),
    };
  io.stdout(`数据根：${context.layout.root}`);
  const node = context.platform === 'linux' || values.node !== undefined ? (await selectedNode(context, (await settingsOf(context)).node, values.node)).node : undefined;
  const report = await deploy(node === undefined ? context : { ...context, nodePath: node }, source);
  io.stdout(`部署完成：发布 ${report.release}${report.previous ? `（上一版 ${report.previous}）` : ''}`);
  io.stdout(`部署前备份：${backupPath(context.layout, report.backup)}`);
  io.stdout(`日志：${deployLogPath(context)}`);
  return 0;
};

const rollbackCommand: Handler = async (args, context, io) => {
  const { values, positionals } = parse(args, {node:{type:'string'}});
  noArguments(positionals);
  io.stdout(`数据根：${context.layout.root}`);
  const node = context.platform === 'linux' || values.node !== undefined ? (await selectedNode(context, (await settingsOf(context)).node, values.node)).node : undefined;
  const report = await rollback(node === undefined ? context : { ...context, nodePath: node });
  io.stdout(`回滚完成：现在运行发布 ${report.release}（回滚自 ${report.previous}）`);
  io.stdout(`回滚前备份：${backupPath(context.layout, report.backup)}`);
  io.stdout(`日志：${deployLogPath(context)}`);
  return 0;
};

const rehearseCommand: Handler = async (args, context, io) => {
  const { values, positionals } = parse(args, { keep: { type: 'boolean' } });
  noArguments(positionals);
  io.stdout('在临时数据根里演练：初始化、写入合成记录、对象与解包目录、备份、销毁、恢复、核对');
  const report = await rehearse({ runner: context.runner, libpqBin: context.libpqBin, binariesRoot: context.codeRoot, keep: values.keep === true, now: context.now });
  io.stdout(`演练数据根：${report.root}${report.kept ? '（保留；解包目录是只读的，删除前先 chmod -R u+w）' : '（已删除）'}`);
  io.stdout(`写入：${report.tables} 张表 ${report.rows} 行，${report.objects} 个对象，${report.vaultFiles} 个密钥库文件，${report.packFiles} 个解包文件（派生数据，不进备份）`);
  io.stdout(report.keyLoss.skipped ? `钥匙丢失：${report.keyLoss.reason}` : `钥匙丢失：${report.keyLoss.items} 项；备份命中 ${report.keyLoss.backupHits}；丢失后找到 ${report.keyLoss.remaining} 项；移开密钥库 ${report.keyLoss.setAsideFiles} 个文件`);
  io.stdout(`应用角色 ${report.role}：恢复后 ${report.privileges} 项权限，删改历史或表结构的 ${report.refused} 条语句被拒绝`);
  if (report.ok) io.stdout('恢复后核对：行数、表摘要、文件摘要与应用角色的权限全部一致，应用角色不拥有任何对象；解包目录不在备份里，恢复后原样保留');
  else for (const line of report.differences) io.stderr(`不一致：${line}`);
  io.stdout(`用时 ${report.seconds.toFixed(1)} 秒`);
  return report.ok ? 0 : 1;
};

const status: Handler = async (args, context, io) => {
  noArguments(args);
  const { layout } = context;
  io.stdout(`数据根：${layout.root}`);
  const file = await readSettingsFile(layout);
  if (!file) {
    io.stdout('部署设置：没有；先运行 circle-hub init --environment <环境类别>');
    return NOT_RUNNING;
  }
  const settings = resolveSettings(file, context.env, layout);
  io.stdout(`环境类别：${environmentText(settings.environment)}；端口：${settings.listenHost ?? '127.0.0.1'}:${settings.port}${settings.allowedHosts ? `；允许主机：${settings.allowedHosts.join('、')}` : ''}${settings.proxyOrigin ? `；代理来源：${settings.proxyOrigin}；可信对端：${settings.proxyPeer}` : ''}`);
  // The owner is printed only from the running cluster: a data root of an earlier platform version has another one.
  io.stdout(databaseText(layout, settings));
  if (settings.https) {
    try {
      const server = (await readTlsState(layout.root)).server;
      const left = server === null ? null : daysLeft(server);
      io.stdout(`内置 HTTPS：${httpsAuthority(settings.https)}；${server === null || left === null ? '没有服务器证书，运行 circle-hub tls init' : `服务器证书 ${server.validTo} 到期（还有 ${left} 天）${left <= RENEW_WITHIN_DAYS ? '，运行 circle-hub tls issue 重新签发后重启服务' : ''}`}`);
    } catch (error) {
      io.stdout(`内置 HTTPS：${httpsAuthority(settings.https)}；证书无法确认（${messageOf(error)}）`);
    }
  }
  const unsure = (subject: string, error: unknown) => io.stdout(`${subject}：无法确认（${messageOf(error)}）`);
  try {
    const pending = await readProgress(layout);
    if (pending) io.stdout(`注意：${progressText(pending)}；运行 circle-hub ${pending.operation} 完成它`);
  } catch (error) {
    unsure('进行中的部署或回滚', error);
  }
  let current: ReleaseRef | undefined;
  try {
    current = await readCurrentRelease(layout);
    const last = (await readDeployments(context)).at(-1);
    io.stdout(`当前发布：${current ? current.id : '没有'}${last && current && last.release === current.id && last.previous ? `（上一版 ${last.previous}）` : ''}`);
  } catch (error) {
    unsure('当前发布', error);
  }
  try {
    const cluster = postgresFor(context, current?.dir);
    const db = await cluster.status();
    io.stdout(`数据库：${!db.initialised ? '未初始化' : db.running ? `运行中${db.pid ? `（PID ${db.pid}）` : ''}` : '已停止'}`);
    if (db.running) {
      try {
        const owner = await databaseOwner(cluster);
        io.stdout(owner === undefined ? `数据库 ${cluster.target.database}：不存在` : `数据库 ${cluster.target.database} 属于角色 ${owner}`);
      } catch (error) {
        unsure('数据库的属主', error);
      }
      try {
        const role = cluster.application.user;
        const report = await withSession(cluster.connector, cluster.target.database, (session) => inspectRole(session, role));
        const effect = report.withoutPrivilegeOnly ? '；Hub 照常运行，但备份和部署会拒绝' : '';
        io.stdout(report.problems.length === 0 ? `应用角色 ${role}：只连接并按授权读写，不拥有任何对象` : `应用角色 ${role}：不正常，${report.problems.join('、')}${effect}；处理：${roleFixHint(cluster, report)}`);
      } catch (error) {
        unsure('应用角色', error);
      }
    }
  } catch (error) {
    unsure('数据库', error);
  }
  try {
    io.stdout(`${VAULT_KEY_ITEM.label}：${(await keychainFor(context, settings).status()).present ? (context.platform === 'linux' ? '已在私有密钥文件' : '已在钥匙串') : '没有'}`);
  } catch (error) {
    unsure(VAULT_KEY_ITEM.label, error);
  }
  try {
    const agent = await agentFor(context, settings).status();
    io.stdout(`服务：${!agent.loaded ? '未加载' : agent.running ? `运行中${agent.pid ? `（PID ${agent.pid}）` : ''}` : '已加载，未运行'}`);
  } catch (error) {
    unsure('服务', error);
  }
  const backups = await listBackups(layout);
  io.stdout(`备份：${backups.length} 份${backups.length ? `，最近一份 ${backups.at(-1)}` : ''}`);
  if (!(await isMissingOrEmpty(layout.setAside))) io.stdout(`注意：${layout.setAside} 里有移开的数据，确认不需要后手动删除`);
  const health = await checkHealth(settings.port, { timeoutMs: 1500, host: settings.listenHost, authority: settings.allowedHosts?.[0] });
  const listener = settings.listenHost ?? '127.0.0.1';
  io.stdout(`健康检查（http://${listener.includes(':') ? `[${listener}]` : listener}:${settings.port}${HEALTH_PATH}）：${health.ok ? '正常' : `不正常（${health.status ? `HTTP ${health.status}` : (health.error ?? '没有应答')}）`}`);
  return 0;
};

const HANDLERS: Record<string, Handler> = {
  init,
  db,
  key,
  service,
  backup,
  restore,
  deploy: deployCommand,
  rollback: rollbackCommand,
  rehearse: rehearseCommand,
  status,
  tls,
};

export const PLATFORM_COMMANDS: readonly string[] = Object.keys(HANDLERS);

export function isPlatformCommand(name: string | undefined): boolean {
  return name !== undefined && Object.hasOwn(HANDLERS, name);
}

/** Runs one platform command; returns the exit code (0 ok, 1 failure, 2 usage, 3 not running for status commands). */
export async function runPlatformCommand(argv: readonly string[], io: PlatformIo, overrides: Partial<PlatformContext> = {}): Promise<number> {
  const [command, ...rest] = argv;
  try {
    assertHubEnvironment(io.env);
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      io.stdout(usage(overrides.platform));
      return command === undefined ? 2 : 0;
    }
    const handler = isPlatformCommand(command) ? HANDLERS[command] : undefined;
    if (!handler) throw new UsageError(`未知命令：${command}${command === 'serve' ? '（serve 由服务器包提供，这份代码里没有 hub/server/cli.ts）' : ''}`);
    // A misspelled data root or port variable would silently act on the defaults.
    assertKnownHubVariables(io.env, io.allowVariables);
    const context = createContext(io.env, { log: (line) => io.stdout(line), ...overrides });
    return await handler(rest, context, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(error.message);
      io.stderr(usage(overrides.platform));
      return 2;
    }
    io.stderr(`错误：${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof PlatformError && error.hint) io.stderr(`处理：${error.hint}`);
    return 1;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runPlatformCommand(argv, {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
    keyPipe: liveKeyPipe(),
  });
}
