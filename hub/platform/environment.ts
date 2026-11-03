// Hub configuration comes only from CIRCLE_HUB_* variables. The retired CIRCLE_SERVER_* names and the retired keychain
// names (RETIRED_VARIABLES) are never read or aliased: a process that still carries one, even empty, refuses to start.
// Errors name keys only, never values.
import { PlatformError } from './errors.ts';

/**
 * Variables the platform reads, and the ones it sets for the service. The service names are the ones hub/config reads
 * (it refuses any other CIRCLE_HUB_* name), so the generated service environment always passes the server's loadConfig.
 */
export const PLATFORM_VARIABLES = {
  /** The data root; the same name hub/config reads. */
  dataDir: 'CIRCLE_HUB_DATA_DIR',
  port: 'CIRCLE_HUB_PORT',
  host: 'CIRCLE_HUB_HOST',
  allowedHosts: 'CIRCLE_HUB_ALLOWED_HOSTS',
  proxyOrigin: 'CIRCLE_HUB_PROXY_ORIGIN',
  proxyPeer: 'CIRCLE_HUB_PROXY_PEER',
  httpsHost: 'CIRCLE_HUB_HTTPS_HOST',
  httpsPort: 'CIRCLE_HUB_HTTPS_PORT',
  databaseSocketDir: 'CIRCLE_HUB_DATABASE_SOCKET_DIR',
  databaseHost: 'CIRCLE_HUB_DATABASE_HOST',
  databasePort: 'CIRCLE_HUB_DATABASE_PORT',
  databaseName: 'CIRCLE_HUB_DATABASE_NAME',
  databaseUser: 'CIRCLE_HUB_DATABASE_USER',
  /** Directory of pg_dump and pg_restore; platform commands only. */
  libpqBin: 'CIRCLE_HUB_LIBPQ_BIN',
} as const;

/**
 * Copy of the names in hub/config/names.ts (HUB_ENVIRONMENT), which the platform may not import; a test keeps the two
 * equal. The platform reads some of them and accepts the others without reading them.
 */
export const HUB_CONFIG_VARIABLES: readonly string[] = [
  'CIRCLE_HUB_DATA_DIR',
  'CIRCLE_HUB_LOG_DIR',
  'CIRCLE_HUB_HOST',
  'CIRCLE_HUB_ALLOWED_HOSTS',
  'CIRCLE_HUB_PROXY_ORIGIN',
  'CIRCLE_HUB_PROXY_PEER',
  'CIRCLE_HUB_PORT',
  'CIRCLE_HUB_HTTPS_HOST',
  'CIRCLE_HUB_HTTPS_PORT',
  'CIRCLE_HUB_DATABASE_SOCKET_DIR',
  'CIRCLE_HUB_DATABASE_HOST',
  'CIRCLE_HUB_DATABASE_PORT',
  'CIRCLE_HUB_DATABASE_NAME',
  'CIRCLE_HUB_DATABASE_USER',
  'CIRCLE_HUB_SYNC_MAX_BATCH_BYTES', 'CIRCLE_HUB_SYNC_REQUESTS_PER_MINUTE',
  'CIRCLE_HUB_MAX_UPLOAD_BYTES',
  'CIRCLE_HUB_MAX_RECORD_BYTES',
  'CIRCLE_HUB_MAX_REQUEST_BYTES',
  'CIRCLE_HUB_MAX_ENTRY_INDEX_BYTES',
  'CIRCLE_HUB_MAX_SPACE_INDEX_BYTES',
  'CIRCLE_HUB_MAX_MEMORY_DOCUMENT_BYTES',
  'CIRCLE_HUB_MAX_MEMORY_SPACE_BYTES',
  'CIRCLE_HUB_MAX_MEMORY_SPACE_DOCUMENTS',
];

/** Names only platform commands read; hub/config does not know them. */
export const PLATFORM_ONLY_VARIABLES: readonly string[] = [PLATFORM_VARIABLES.libpqBin];

const RETIRED_PREFIX = 'CIRCLE_SERVER_';
const HUB_PREFIX = 'CIRCLE_HUB_';

/** Why the keychain names were retired and where the keys are now (decision 137). Names the variable, never its value. */
const KEY_FILES_MOVED =
  'Hub 不再使用 macOS 钥匙串：密钥库主密钥和操作令牌在每个平台上都存在数据根下的私有密钥文件里，目录 $CIRCLE_HUB_DATA_DIR/keys（0700，文件 0600），文件名由部署设置决定；删掉这个变量';

/** Copy of hub/config/names.ts RETIRED_NAMES, which the platform may not import; a test keeps the two equal. */
export const RETIRED_VARIABLES: Readonly<Record<string, string>> = {
  CIRCLE_HUB_KEYCHAIN_SERVICE: KEY_FILES_MOVED,
  CIRCLE_HUB_KEYCHAIN_ACCOUNT: KEY_FILES_MOVED,
};

export function retiredEnvironmentKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env)
    .filter((key) => (key.startsWith(RETIRED_PREFIX) || Object.hasOwn(RETIRED_VARIABLES, key)) && env[key] !== undefined)
    .sort();
}

export function assertHubEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const keys = retiredEnvironmentKeys(env);
  if (keys.length === 0) return;
  const prefixed = keys.filter((key) => key.startsWith(RETIRED_PREFIX));
  const single = keys.filter((key) => !key.startsWith(RETIRED_PREFIX));
  if (prefixed.length === 0) throw new PlatformError(`circle-hub 不再读取 ${single.join('、')}，设置了就不启动`, RETIRED_VARIABLES[single[0]!]);
  const renames = prefixed.map((key) => `${key} -> ${HUB_PREFIX}${key.slice(RETIRED_PREFIX.length)}`).join('，');
  const also = single.length === 0 ? '' : `；${single.join('、')} 也已停用：${RETIRED_VARIABLES[single[0]!]}`;
  throw new PlatformError(`circle-hub 不再读取 ${RETIRED_PREFIX}* 配置，设置了这些变量就不启动`, `删掉它们，改用 ${HUB_PREFIX}* 名字：${renames}${also}`);
}

/** CIRCLE_HUB_* names that neither hub/config nor the platform knows, sorted. */
export function unknownHubVariables(env: NodeJS.ProcessEnv, allowed: readonly string[] = []): string[] {
  const known = new Set([...HUB_CONFIG_VARIABLES, ...PLATFORM_ONLY_VARIABLES, ...allowed]);
  return Object.keys(env)
    .filter((key) => key.startsWith(HUB_PREFIX) && env[key] !== undefined && !known.has(key))
    .sort();
}

/** Refuses a misspelled or unknown CIRCLE_HUB_* name, as hub/config does: it would silently act on a default. */
export function assertKnownHubVariables(env: NodeJS.ProcessEnv, allowed: readonly string[] = []): void {
  const unknown = unknownHubVariables(env, allowed);
  if (unknown.length === 0) return;
  throw new PlatformError(
    `${unknown.join('、')} 不是 circle-hub 的配置项（可能拼错了），不执行`,
    `删掉或改正它；可用的名字：${[...HUB_CONFIG_VARIABLES, ...PLATFORM_ONLY_VARIABLES].join('、')}`,
  );
}

/** A set variable, or undefined when it is missing or empty. */
export function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}
