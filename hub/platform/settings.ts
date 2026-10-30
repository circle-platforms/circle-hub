// Deployment settings of one data root (config/platform.json). This is the deployment instance of D01 R[6]: it carries the
// environment class, the port, the database names and the credential reference, and it is their only source. A
// CIRCLE_HUB_* variable may repeat a value but never change it: a disagreeing variable is refused, naming it.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { EnvironmentSchema, labelOf, type Environment } from '../../contracts/generated/vocabulary.ts';
import { PLATFORM_VARIABLES, variable } from './environment.ts';
import { PlatformError } from './errors.ts';
import { writeFileExclusive } from './files.ts';
import { OPERATOR_TOKEN_ITEM, VAULT_KEY_ITEM } from './keychain-items.ts';
import { validAllowedHosts, validListenAddress, validProxyOrigin } from '../listen.ts';
import { isIP } from 'node:net';
import type { Layout } from './layout.ts';

export const SETTINGS_SCHEMA = 'circle-hub-platform@2';
/** Earlier format without database names; read with the defaults it implied. */
const SETTINGS_SCHEMA_V1 = 'circle-hub-platform@1';
export const DEFAULT_PORT = 7420;
export const DEFAULT_KEYCHAIN_SERVICE = 'circle-hub';
export const DEFAULT_KEYCHAIN_ACCOUNT = 'vault-master-key';
/**
 * Keychain account of the operator token item, beside the vault master key under the deployment's keychain service.
 * Reserved: the vault master key may not use it, or the two would be one keychain item.
 */
export const OPERATOR_TOKEN_ACCOUNT = 'operator-token';
export const DEFAULT_BACKUPS_KEEP = 14;
export const DATABASE_NAME = 'circle_hub';
/**
 * Role the Hub server connects as: not a superuser and owns nothing; it connects and holds the grants the migrations
 * give it. The Hub database and every object in it belong to the cluster's superuser role (roles.ts).
 */
export const APPLICATION_ROLE = 'circle_hub';
/** Names the socket file only: the cluster has no TCP listener. */
export const DATABASE_PORT = 5432;
export const SERVICE_LABEL = 'io.github.circle-platforms.circle-hub';

const Port = z.number().int().min(1024).max(65535);
export const KeychainName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
/** Same rule as hub/config for database and role names. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const Identifier = z.string().regex(IDENTIFIER);
/**
 * The application role of a new deployment: the records package grants only roles named so (grantRuntime in
 * hub/records/migrations.ts), so a name hub/config would accept beyond it makes every migration, and every deploy, fail.
 * Settings written before this rule keep their name (deploy refuses them, see assertApplicationRoleName).
 */
export const APPLICATION_ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const APPLICATION_ROLE_RULE = '应用角色名只能用小写字母、数字和下划线，以小写字母或下划线开头，最长 63 个字符（记录包只给这样的角色授权，迁移会拒绝别的写法）';

/** A name of that form close to `name`, for the hint. */
function suggestedRoleName(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return (/^[a-z_]/.test(base) ? base : `_${base}`).slice(0, 63);
}

/** Refuses to deploy with an application role the records package would not grant: such a deploy can only fail. */
export function assertApplicationRoleName(role: string): void {
  if (APPLICATION_ROLE_NAME.test(role)) return;
  const suggested = suggestedRoleName(role);
  throw new PlatformError(
    `部署设置里的应用角色名 ${role} 不符合要求，不部署：${APPLICATION_ROLE_RULE}`,
    `改名：先停掉服务，以本机账户的角色连上 PostgreSQL 执行 ALTER ROLE "${role}" RENAME TO ${suggested}，把部署设置里的 database.role 改成 ${suggested}，再部署；新的数据根在 init 之前用 CIRCLE_HUB_DATABASE_USER 选一个符合要求的名字`,
  );
}

const DatabaseSettings = z
  .object({
    name: Identifier,
    role: Identifier.describe('application role of the server'),
    socket_port: z.number().int().min(1).max(65535).describe('names the unix socket file; there is no TCP listener'),
  })
  .strict();

export const PlatformSettingsFile = z
  .object({
    schema: z.literal(SETTINGS_SCHEMA),
    environment: EnvironmentSchema,
    port: Port,
    listen_host: z.string().optional(),
    allowed_hosts: z.array(z.string()).optional(),
    proxy_origin: z.string().optional(),
    proxy_peer: z.string().optional(),
    https_host: z.string().optional().describe('listen address of the built-in HTTPS; loopback when left out'),
    https_port: Port.optional().describe('the built-in HTTPS listens only when this is set'),
    keychain_service: KeychainName,
    keychain_account: KeychainName,
    database: DatabaseSettings,
    backups_keep: z.number().int().min(1).max(365),
    node: z.string().startsWith('/').optional().describe('absolute path of the Node 24 binary the service runs'),
  })
  .strict().superRefine((value, ctx) => {
    const host = value.listen_host ?? '127.0.0.1';
    if (!validListenAddress(host)) ctx.addIssue({ code: 'custom', path: ['listen_host'], message: '监听地址须是明确的内网 IP 或回环地址' });
    if (value.allowed_hosts && !validAllowedHosts(value.allowed_hosts)) ctx.addIssue({ code: 'custom', path: ['allowed_hosts'], message: '允许主机须为精确、无重复的主机名' });
    const loopback = host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
    if (!loopback && !value.allowed_hosts) ctx.addIssue({ code: 'custom', path: ['allowed_hosts'], message: '非回环监听必须声明允许主机' });
    if (value.proxy_origin && !validProxyOrigin(value.proxy_origin, value.allowed_hosts, value.port)) ctx.addIssue({ code: 'custom', path: ['proxy_origin'], message: '代理来源须为明确声明的 HTTPS 主机，且与直接监听权威不同' });
    if (value.https_host !== undefined && value.https_port === undefined) ctx.addIssue({ code: 'custom', path: ['https_host'], message: '有 HTTPS 监听地址就要有 HTTPS 端口' });
    if (value.https_port !== undefined) {
      const httpsHost = value.https_host ?? '127.0.0.1';
      const httpsLoopback = httpsHost === '::1' || (isIP(httpsHost) === 4 && httpsHost.startsWith('127.'));
      if (!validListenAddress(httpsHost)) ctx.addIssue({ code: 'custom', path: ['https_host'], message: 'HTTPS 监听地址须是明确的内网 IP 或回环地址' });
      else if (!httpsLoopback && !value.allowed_hosts) ctx.addIssue({ code: 'custom', path: ['allowed_hosts'], message: '非回环的 HTTPS 监听必须声明允许主机' });
      if (value.https_port === value.port) ctx.addIssue({ code: 'custom', path: ['https_port'], message: 'HTTPS 端口不能和 HTTP 端口相同' });
      if (value.proxy_origin) ctx.addIssue({ code: 'custom', path: ['https_port'], message: '内置 HTTPS 与 HTTPS 代理只能选一个' });
    }
    if (Boolean(value.proxy_origin) !== Boolean(value.proxy_peer) || (value.proxy_peer && !validListenAddress(value.proxy_peer))) ctx.addIssue({ code: 'custom', path: ['proxy_peer'], message: '代理来源和可信对端须同时声明，对端为明确的内网 IP 或回环地址' });
  });
export type PlatformSettingsFile = z.infer<typeof PlatformSettingsFile>;

const PlatformSettingsFileV1 = z
  .object({
    schema: z.literal(SETTINGS_SCHEMA_V1),
    environment: EnvironmentSchema,
    port: Port,
    keychain_service: KeychainName,
    keychain_account: KeychainName,
    backups_keep: z.number().int().min(1).max(365),
    node: z.string().startsWith('/').optional(),
  })
  .strict();

/** Database names shared by the platform and the server. */
export interface DatabaseNames {
  /** Names the socket file only. */
  port: number;
  name: string;
  /** Application role of the server. */
  role: string;
}

export interface PlatformSettings {
  environment: Environment;
  port: number;
  listenHost?: string;
  allowedHosts?: readonly string[];
  proxyOrigin?: string;
  proxyPeer?: string;
  /** The built-in HTTPS listener; absent when HTTPS is off. */
  https?: { host: string; port: number };
  keychainService: string;
  keychainAccount: string;
  database: DatabaseNames;
  backupsKeep: number;
  node?: string;
  label: string;
}

export function settingsPath(layout: Layout): string {
  return join(layout.config, 'platform.json');
}

export function newSettingsFile(input: {
  environment: Environment;
  port?: number;
  listenHost?: string;
  allowedHosts?: readonly string[];
  proxyOrigin?: string;
  proxyPeer?: string;
  httpsHost?: string;
  httpsPort?: number;
  keychainService?: string;
  keychainAccount?: string;
  backupsKeep?: number;
  database?: Partial<DatabaseNames>;
}): PlatformSettingsFile {
  const parsed = PlatformSettingsFile.safeParse({
    schema: SETTINGS_SCHEMA,
    environment: input.environment,
    port: input.port ?? DEFAULT_PORT,
    ...(input.listenHost ? { listen_host: input.listenHost } : {}),
    ...(input.allowedHosts ? { allowed_hosts: input.allowedHosts } : {}),
    ...(input.proxyOrigin ? { proxy_origin: input.proxyOrigin } : {}),
    ...(input.proxyPeer ? { proxy_peer: input.proxyPeer } : {}),
    ...(input.httpsHost ? { https_host: input.httpsHost } : {}),
    ...(input.httpsPort !== undefined ? { https_port: input.httpsPort } : {}),
    keychain_service: input.keychainService ?? DEFAULT_KEYCHAIN_SERVICE,
    keychain_account: input.keychainAccount ?? DEFAULT_KEYCHAIN_ACCOUNT,
    database: {
      name: input.database?.name ?? DATABASE_NAME,
      role: input.database?.role ?? APPLICATION_ROLE,
      socket_port: input.database?.port ?? DATABASE_PORT,
    },
    backups_keep: input.backupsKeep ?? DEFAULT_BACKUPS_KEEP,
  });
  if (!parsed.success) {
    throw new PlatformError(`部署设置的取值不对（字段：${parsed.error.issues.map((issue) => issue.path.join('.') || '(根)').join('、')}）`, `钥匙串名只能含字母、数字、点、下划线和连字符；数据库名是字母或下划线开头的标识符；${APPLICATION_ROLE_RULE}`);
  }
  if (!APPLICATION_ROLE_NAME.test(parsed.data.database.role)) {
    throw new PlatformError(`部署设置的取值不对（字段：database.role）：${parsed.data.database.role}`, APPLICATION_ROLE_RULE);
  }
  if (parsed.data.keychain_account === OPERATOR_TOKEN_ACCOUNT) {
    throw new PlatformError(
      `部署设置的取值不对（字段：keychain_account）：账户 ${OPERATOR_TOKEN_ACCOUNT} 留给${OPERATOR_TOKEN_ITEM.label}，${VAULT_KEY_ITEM.label}不能用它`,
      `给 ${PLATFORM_VARIABLES.keychainAccount} 另选一个名字，或不设它（默认 ${DEFAULT_KEYCHAIN_ACCOUNT}）`,
    );
  }
  return parsed.data;
}

/** Parses the text of a settings file; an @1 file gets the database names it implied. `where` names it in errors. */
export function parseSettingsText(text: string, where: string): PlatformSettingsFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PlatformError(`部署设置不是合法的 JSON：${where}`);
  }
  if ((value as { schema?: unknown } | null)?.schema === SETTINGS_SCHEMA_V1) {
    const old = PlatformSettingsFileV1.safeParse(value);
    if (old.success) {
      const { schema: _schema, ...rest } = old.data;
      return { ...rest, schema: SETTINGS_SCHEMA, database: { name: DATABASE_NAME, role: APPLICATION_ROLE, socket_port: DATABASE_PORT } };
    }
  }
  const parsed = PlatformSettingsFile.safeParse(value);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.') || '(根)').join('、');
    throw new PlatformError(`部署设置不符合 ${SETTINGS_SCHEMA}：${where}（字段：${fields}）`);
  }
  return parsed.data;
}

export async function readSettingsFile(layout: Layout): Promise<PlatformSettingsFile | undefined> {
  let text: string;
  try {
    text = await readFile(settingsPath(layout), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseSettingsText(text, settingsPath(layout));
}

/** The same, synchronously, for building a context. */
export function readSettingsFileSync(layout: Layout): PlatformSettingsFile | undefined {
  let text: string;
  try {
    text = readFileSync(settingsPath(layout), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return parseSettingsText(text, settingsPath(layout));
}

/** Writes the settings file once; an existing file is never replaced. */
export async function writeSettingsFile(layout: Layout, settings: PlatformSettingsFile): Promise<void> {
  await writeFileExclusive(settingsPath(layout), `${JSON.stringify(PlatformSettingsFile.parse(settings), null, 2)}\n`, 0o600);
}

export function parsePort(text: string, source: string): number {
  const value = /^[0-9]{1,5}$/.test(text) ? Number(text) : Number.NaN;
  const parsed = Port.safeParse(value);
  if (!parsed.success) throw new PlatformError(`${source} 不是 1024 到 65535 之间的端口：${text}`);
  return parsed.data;
}

/** A TCP host or another socket directory is refused: the platform manages only this data root's socket-only cluster. */
function checkDatabaseLocation(layout: Layout | undefined, env: NodeJS.ProcessEnv, problems: string[]): void {
  if (variable(env, PLATFORM_VARIABLES.databaseHost) !== undefined) {
    problems.push(`设置了 ${PLATFORM_VARIABLES.databaseHost}：平台只管理这个数据根里只有 unix 套接字的数据库`);
  }
  const socket = variable(env, PLATFORM_VARIABLES.databaseSocketDir);
  if (layout && socket !== undefined && (!isAbsolute(socket) || resolve(socket) !== layout.run)) {
    problems.push(`${PLATFORM_VARIABLES.databaseSocketDir} 是 ${socket}，这个数据根的数据库套接字目录是 ${layout.run}`);
  }
}

/**
 * The settings of `file`. Every CIRCLE_HUB_* variable that names one of them must agree with the file; one that
 * disagrees is refused with its name, so a stray shell variable can never point a command at another port, database
 * or keychain item. With `layout`, the socket directory variable must be that data root's.
 */
export function resolveSettings(file: PlatformSettingsFile, env: NodeJS.ProcessEnv = process.env, layout?: Layout): PlatformSettings {
  const database: DatabaseNames = { port: file.database.socket_port, name: file.database.name, role: file.database.role };
  const problems: string[] = [];
  const agree = (name: string, expected: string) => {
    const actual = variable(env, name);
    if (actual !== undefined && actual !== expected) problems.push(`${name} 是 ${actual}，部署设置里是 ${expected}`);
  };
  agree(PLATFORM_VARIABLES.port, String(file.port));
  agree(PLATFORM_VARIABLES.host, file.listen_host ?? '127.0.0.1');
  agree(PLATFORM_VARIABLES.allowedHosts, (file.allowed_hosts ?? []).join(','));
  agree(PLATFORM_VARIABLES.proxyOrigin, file.proxy_origin ?? '');
  agree(PLATFORM_VARIABLES.proxyPeer, file.proxy_peer ?? '');
  agree(PLATFORM_VARIABLES.httpsPort, file.https_port === undefined ? '' : String(file.https_port));
  agree(PLATFORM_VARIABLES.httpsHost, file.https_port === undefined ? '' : file.https_host ?? '127.0.0.1');
  agree(PLATFORM_VARIABLES.keychainService, file.keychain_service);
  agree(PLATFORM_VARIABLES.keychainAccount, file.keychain_account);
  agree(PLATFORM_VARIABLES.databaseName, database.name);
  agree(PLATFORM_VARIABLES.databaseUser, database.role);
  agree(PLATFORM_VARIABLES.databasePort, String(database.port));
  checkDatabaseLocation(layout, env, problems);
  if (problems.length > 0) {
    throw new PlatformError(
      `环境变量与部署设置${layout ? `（${settingsPath(layout)}）` : ''}不一致，不执行：${problems.join('；')}`,
      '部署设置是唯一的来源：删掉这些变量或改成一致；要改设置就编辑部署设置文件',
    );
  }
  return {
    environment: file.environment,
    port: file.port,
    ...(file.listen_host ? { listenHost: file.listen_host } : {}),
    ...(file.allowed_hosts ? { allowedHosts: file.allowed_hosts } : {}),
    ...(file.proxy_origin ? { proxyOrigin: file.proxy_origin } : {}),
    ...(file.proxy_peer ? { proxyPeer: file.proxy_peer } : {}),
    ...(file.https_port !== undefined ? { https: { host: file.https_host ?? '127.0.0.1', port: file.https_port } } : {}),
    keychainService: file.keychain_service,
    keychainAccount: file.keychain_account,
    database,
    backupsKeep: file.backups_keep,
    ...(file.node ? { node: file.node } : {}),
    label: SERVICE_LABEL,
  };
}

export async function readSettings(layout: Layout, env: NodeJS.ProcessEnv = process.env): Promise<PlatformSettings> {
  const file = await readSettingsFile(layout);
  if (!file) throw new PlatformError(`数据根还没初始化：没有 ${settingsPath(layout)}`, '先运行 circle-hub init --environment <环境类别>');
  return resolveSettings(file, env, layout);
}

/**
 * Database names for a data root that has no settings file yet (init writes them into it): CIRCLE_HUB_DATABASE_PORT,
 * _NAME and _USER when set, else 5432, circle_hub, circle_hub. A TCP host or another socket directory is refused.
 */
export function resolveDatabaseNames(layout: Layout, env: NodeJS.ProcessEnv = process.env): DatabaseNames {
  const problems: string[] = [];
  checkDatabaseLocation(layout, env, problems);
  if (problems.length > 0) throw new PlatformError(problems.join('；'), '删掉这个变量或改成一致');
  const port = variable(env, PLATFORM_VARIABLES.databasePort);
  const portNumber = port === undefined ? DATABASE_PORT : /^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535 ? Number(port) : Number.NaN;
  if (Number.isNaN(portNumber)) throw new PlatformError(`${PLATFORM_VARIABLES.databasePort} 必须是 1 到 65535 之间的整数`);
  const names: DatabaseNames = { port: portNumber, name: DATABASE_NAME, role: APPLICATION_ROLE };
  const name = variable(env, PLATFORM_VARIABLES.databaseName);
  if (name !== undefined) {
    if (!IDENTIFIER.test(name)) throw new PlatformError(`${PLATFORM_VARIABLES.databaseName} 的写法不对：只能是字母或下划线开头的标识符`);
    names.name = name;
  }
  const role = variable(env, PLATFORM_VARIABLES.databaseUser);
  if (role !== undefined) {
    if (!APPLICATION_ROLE_NAME.test(role)) throw new PlatformError(`${PLATFORM_VARIABLES.databaseUser} 的写法不对：${role}`, APPLICATION_ROLE_RULE);
    names.role = role;
  }
  return names;
}

/** The database names of the settings file of `layout` when there is one, else the names for a new data root. */
export function deploymentDatabase(layout: Layout, env: NodeJS.ProcessEnv = process.env): DatabaseNames {
  const file = readSettingsFileSync(layout);
  return file ? resolveSettings(file, env, layout).database : resolveDatabaseNames(layout, env);
}

export function sameDatabase(a: DatabaseNames, b: DatabaseNames): boolean {
  return a.port === b.port && a.name === b.name && a.role === b.role;
}

export function environmentText(environment: Environment): string {
  return `${labelOf('environment', environment)}（${environment}）`;
}
