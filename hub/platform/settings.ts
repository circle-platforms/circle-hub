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
import type { Layout } from './layout.ts';

export const SETTINGS_SCHEMA = 'circle-hub-platform@2';
/** Earlier format without database names; read with the defaults it implied. */
const SETTINGS_SCHEMA_V1 = 'circle-hub-platform@1';
export const DEFAULT_PORT = 7420;
export const DEFAULT_KEYCHAIN_SERVICE = 'circle-hub';
export const DEFAULT_KEYCHAIN_ACCOUNT = 'vault-master-key';
export const DEFAULT_BACKUPS_KEEP = 14;
export const DATABASE_NAME = 'circle_hub';
/** Role the Hub server connects as: owns the Hub database, not a superuser. */
export const APPLICATION_ROLE = 'circle_hub';
/** Names the socket file only: the cluster has no TCP listener. */
export const DATABASE_PORT = 5432;
export const SERVICE_LABEL = 'io.github.circle-platforms.circle-hub';

const Port = z.number().int().min(1024).max(65535);
export const KeychainName = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
/** Same rule as hub/config for database and role names. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const Identifier = z.string().regex(IDENTIFIER);

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
    keychain_service: KeychainName,
    keychain_account: KeychainName,
    database: DatabaseSettings,
    backups_keep: z.number().int().min(1).max(365),
    node: z.string().startsWith('/').optional().describe('absolute path of the Node 24 binary the service runs'),
  })
  .strict();
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
  keychainService?: string;
  keychainAccount?: string;
  backupsKeep?: number;
  database?: Partial<DatabaseNames>;
}): PlatformSettingsFile {
  const parsed = PlatformSettingsFile.safeParse({
    schema: SETTINGS_SCHEMA,
    environment: input.environment,
    port: input.port ?? DEFAULT_PORT,
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
    throw new PlatformError(`部署设置的取值不对（字段：${parsed.error.issues.map((issue) => issue.path.join('.') || '(根)').join('、')}）`, '钥匙串名只能含字母、数字、点、下划线和连字符；数据库名与角色名是字母或下划线开头的标识符');
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
  for (const [key, field] of [
    [PLATFORM_VARIABLES.databaseName, 'name'],
    [PLATFORM_VARIABLES.databaseUser, 'role'],
  ] as const) {
    const value = variable(env, key);
    if (value === undefined) continue;
    if (!IDENTIFIER.test(value)) throw new PlatformError(`${key} 的写法不对：只能是字母或下划线开头的标识符`);
    names[field] = value;
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
