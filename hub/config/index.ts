// Hub configuration from CIRCLE_HUB_* environment variables. Secrets never come from the environment: they enter through the vault.
import { isAbsolute, join, resolve } from 'node:path';
import { HUB_ENVIRONMENT, HUB_PREFIX, isHubEnvironmentName, isPlatformOnlyName } from './names.ts';
import { assertNoRetiredEnvironment } from './retired.ts';
import { validAllowedHosts, validListenAddress, validProxyOrigin } from '../listen.ts';

export { HUB_ENVIRONMENT, HUB_PREFIX, PLATFORM_ONLY_ENVIRONMENT, RETIRED_PREFIX, isHubEnvironmentName, isPlatformOnlyName } from './names.ts';
export type { HubEnvironmentName, PlatformOnlyName } from './names.ts';
export { HubEnvironmentError, assertNoRetiredEnvironment, retiredEnvironmentKeys } from './retired.ts';

export interface DatabaseConfig {
  /** Unix-socket directory (absolute path) or loopback IP address. */
  host: string;
  port: number;
  database: string;
  user: string;
  /** Never read from the environment. The platform may fill it from the vault for a TCP connection. */
  password?: string;
}

export interface Limits {
  /** Largest upload or stored object, in bytes. */
  maxUploadBytes: number;
  /** Largest record body (canonical JSON), in bytes. */
  maxRecordBytes: number;
  /** Largest HTTP request body, in bytes; at least the base64 size of the largest upload. */
  maxRequestBytes: number;
}

export interface HubConfig {
  dataDir: string;
  logDir: string;
  host: string;
  allowedHosts?: readonly string[];
  proxyOrigin?: string;
  proxyPeer?: string;
  port: number;
  /** The Hub's own HTTPS listener (its certificate and key are in <dataDir>/tls); absent when HTTPS is off. */
  https?: { host: string; port: number };
  database: DatabaseConfig;
  keychain: { service: string; account: string };
  limits: Limits;
}

export interface LoadConfigOptions {
  /** CIRCLE_HUB_* names the calling program reads itself (for example a client token in an admin shell); never read here. */
  allowUnknown?: readonly string[];
}

const MIB = 1024 * 1024;
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxUploadBytes: 32 * MIB,
  maxRecordBytes: 16 * MIB,
  maxRequestBytes: requestBytesFor(32 * MIB),
});

/** The credential scan decodes an upload to one string; 256 MiB stays far below V8's string limit (about 512 Mi characters). */
const UPLOAD_RANGE = [1024, 256 * MIB] as const;
const RECORD_RANGE = [64 * 1024, 256 * MIB] as const;
/** At least the request a 256 MiB upload needs (its base64 plus framing). */
const REQUEST_MAX = 512 * MIB;
/** macOS sun_path holds 104 bytes including the terminating NUL. */
const SOCKET_PATH_MAX = 103;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const KEYCHAIN_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SECRET_LIKE = /PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|PRIVATE|API_KEY/;

export const DEFAULT_KEYCHAIN_SERVICE = 'circle-hub';
/** The keychain account of the vault master key; the platform package and the brief use the same name. */
export const DEFAULT_KEYCHAIN_ACCOUNT = 'vault-master-key';

export class HubConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`circle-hub 配置有误，拒绝启动：\n- ${problems.join('\n- ')}`);
    this.name = 'HubConfigError';
    this.problems = Object.freeze([...problems]);
  }
}

/** Base64 size of the largest upload plus 1 MiB of JSON-RPC framing, and never less than 48 MiB. */
export function requestBytesFor(maxUploadBytes: number): number {
  return Math.max(48 * MIB, Math.ceil(maxUploadBytes / 3) * 4 + MIB);
}

export function isLoopbackAddress(host: string): boolean {
  if (host === '::1') return true;
  const match = /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(host);
  return match !== null && match.slice(1).every((part) => Number(part) <= 255 && String(Number(part)) === part);
}

/** Reads and validates the Hub configuration. Reads only `environment`, never process.env implicitly, never a file. */
export function loadConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: LoadConfigOptions = {},
): HubConfig {
  assertNoRetiredEnvironment(environment);
  const problems: string[] = [];
  const allowed = new Set(options.allowUnknown ?? []);
  for (const key of Object.keys(environment).sort()) {
    if (!key.startsWith(HUB_PREFIX) || environment[key] === undefined || isHubEnvironmentName(key) || isPlatformOnlyName(key) || allowed.has(key)) continue;
    problems.push(
      SECRET_LIKE.test(key.slice(HUB_PREFIX.length))
        ? `${key} 不是 Hub 的配置项；口令、令牌和密钥只经密钥库命令进入 Hub，不从环境变量读取`
        : `${key} 不是 Hub 的配置项（可能拼错了）；可用的名字：${Object.keys(HUB_ENVIRONMENT).join('、')}`,
    );
  }
  const read = (name: keyof typeof HUB_ENVIRONMENT): string | undefined => {
    const value = environment[name];
    return value === undefined || value === '' ? undefined : value;
  };

  const absolute = (name: keyof typeof HUB_ENVIRONMENT, required: boolean): string | undefined => {
    const value = read(name);
    if (value === undefined) {
      if (required) problems.push(`必须设置 ${name}（${HUB_ENVIRONMENT[name]}）`);
      return undefined;
    }
    if (value.includes('\0') || !isAbsolute(value)) {
      problems.push(`${name} 必须是绝对路径`);
      return undefined;
    }
    return resolve(value);
  };

  const integer = (name: keyof typeof HUB_ENVIRONMENT, fallback: number | undefined, min: number, max: number): number | undefined => {
    const value = read(name);
    if (value === undefined) {
      if (fallback === undefined) problems.push(`必须设置 ${name}（${HUB_ENVIRONMENT[name]}）`);
      return fallback;
    }
    if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < min || Number(value) > max) {
      problems.push(`${name} 必须是 ${min} 到 ${max} 之间的整数，现在是 ${JSON.stringify(value)}`);
      return fallback;
    }
    return Number(value);
  };

  const named = (name: keyof typeof HUB_ENVIRONMENT, fallback: string, pattern: RegExp): string => {
    const value = read(name);
    if (value === undefined) return fallback;
    if (!pattern.test(value)) {
      problems.push(`${name} 的写法不对：${HUB_ENVIRONMENT[name]}`);
      return fallback;
    }
    return value;
  };

  const dataDir = absolute('CIRCLE_HUB_DATA_DIR', true);
  const logDir = absolute('CIRCLE_HUB_LOG_DIR', false) ?? (dataDir === undefined ? undefined : join(dataDir, 'logs'));

  const host = read('CIRCLE_HUB_HOST') ?? '127.0.0.1';
  const allowedHostsValue = read('CIRCLE_HUB_ALLOWED_HOSTS');
  const allowedHosts = allowedHostsValue?.split(',');
  if (allowedHosts && !validAllowedHosts(allowedHosts)) problems.push('CIRCLE_HUB_ALLOWED_HOSTS 必须是以逗号分隔的精确主机名或 IP，不能有端口、通配符、重复项或空项');
  if (!validListenAddress(host)) problems.push(`CIRCLE_HUB_HOST 只允许回环地址或明确的内网 IP，不能用通配地址${host === 'localhost' ? '，请写 127.0.0.1' : ''}`);
  else if (!isLoopbackAddress(host) && !allowedHosts) problems.push('CIRCLE_HUB_HOST 只允许回环地址；非回环监听必须显式设置 CIRCLE_HUB_ALLOWED_HOSTS');
  const port = integer('CIRCLE_HUB_PORT', undefined, 0, 65535);
  const proxyOrigin = read('CIRCLE_HUB_PROXY_ORIGIN');
  const proxyPeer = read('CIRCLE_HUB_PROXY_PEER');
  if (proxyOrigin && (port === undefined || !validProxyOrigin(proxyOrigin, allowedHosts, port))) problems.push('CIRCLE_HUB_PROXY_ORIGIN 必须是允许主机上的精确 HTTPS 来源，与直接 HTTP 监听权威不同');
  if (Boolean(proxyOrigin) !== Boolean(proxyPeer) || (proxyPeer && !validListenAddress(proxyPeer))) problems.push('CIRCLE_HUB_PROXY_ORIGIN 与 CIRCLE_HUB_PROXY_PEER 必须同时声明，可信代理对端须是明确的内网 IP 或回环地址');
  const httpsPort = read('CIRCLE_HUB_HTTPS_PORT') === undefined ? undefined : integer('CIRCLE_HUB_HTTPS_PORT', undefined, 0, 65535);
  const httpsHost = read('CIRCLE_HUB_HTTPS_HOST');
  let https: { host: string; port: number } | undefined;
  if (httpsHost !== undefined && read('CIRCLE_HUB_HTTPS_PORT') === undefined) problems.push('设了 CIRCLE_HUB_HTTPS_HOST 就要设 CIRCLE_HUB_HTTPS_PORT');
  if (httpsPort !== undefined) {
    const listen = httpsHost ?? '127.0.0.1';
    if (!validListenAddress(listen)) problems.push(`CIRCLE_HUB_HTTPS_HOST 只允许回环地址或明确的内网 IP，不能用通配地址${listen === 'localhost' ? '，请写 127.0.0.1' : ''}`);
    else if (!isLoopbackAddress(listen) && !allowedHosts) problems.push('CIRCLE_HUB_HTTPS_HOST 不是回环地址时，必须显式设置 CIRCLE_HUB_ALLOWED_HOSTS');
    if (proxyOrigin) problems.push('内置 HTTPS 与 HTTPS 代理（CIRCLE_HUB_PROXY_ORIGIN）只能选一个');
    if (port !== undefined && httpsPort !== 0 && httpsPort === port) problems.push('CIRCLE_HUB_HTTPS_PORT 不能和 CIRCLE_HUB_PORT 相同');
    https = { host: listen, port: httpsPort };
  }

  const socketDir = absolute('CIRCLE_HUB_DATABASE_SOCKET_DIR', false);
  const databaseHost = read('CIRCLE_HUB_DATABASE_HOST');
  const databasePort = integer('CIRCLE_HUB_DATABASE_PORT', 5432, 1, 65535) ?? 5432;
  let resolvedDatabaseHost: string | undefined;
  if (socketDir !== undefined && databaseHost !== undefined) {
    problems.push('CIRCLE_HUB_DATABASE_SOCKET_DIR 和 CIRCLE_HUB_DATABASE_HOST 只能设置一个');
  } else if (socketDir !== undefined) {
    if (Buffer.byteLength(join(socketDir, `.s.PGSQL.${databasePort}`)) > SOCKET_PATH_MAX) {
      problems.push(`CIRCLE_HUB_DATABASE_SOCKET_DIR 太长：套接字文件的完整路径不能超过 ${SOCKET_PATH_MAX} 字节`);
    } else {
      resolvedDatabaseHost = socketDir;
    }
  } else if (databaseHost !== undefined) {
    if (isLoopbackAddress(databaseHost)) resolvedDatabaseHost = databaseHost;
    else problems.push('CIRCLE_HUB_DATABASE_HOST 只允许回环地址（127.0.0.0/8 或 ::1）');
  } else if (read('CIRCLE_HUB_DATABASE_SOCKET_DIR') === undefined) {
    problems.push('必须设置 CIRCLE_HUB_DATABASE_SOCKET_DIR 或 CIRCLE_HUB_DATABASE_HOST 之一（不使用默认数据库）');
  }
  const database = named('CIRCLE_HUB_DATABASE_NAME', 'circle_hub', IDENTIFIER);
  const user = named('CIRCLE_HUB_DATABASE_USER', 'circle_hub', IDENTIFIER);

  const keychain = {
    service: named('CIRCLE_HUB_KEYCHAIN_SERVICE', DEFAULT_KEYCHAIN_SERVICE, KEYCHAIN_NAME),
    account: named('CIRCLE_HUB_KEYCHAIN_ACCOUNT', DEFAULT_KEYCHAIN_ACCOUNT, KEYCHAIN_NAME),
  };

  const maxUploadBytes = integer('CIRCLE_HUB_MAX_UPLOAD_BYTES', DEFAULT_LIMITS.maxUploadBytes, ...UPLOAD_RANGE) ?? DEFAULT_LIMITS.maxUploadBytes;
  const maxRecordBytes = integer('CIRCLE_HUB_MAX_RECORD_BYTES', DEFAULT_LIMITS.maxRecordBytes, ...RECORD_RANGE) ?? DEFAULT_LIMITS.maxRecordBytes;
  const minimumRequest = Math.ceil(maxUploadBytes / 3) * 4;
  const maxRequestBytes =
    integer('CIRCLE_HUB_MAX_REQUEST_BYTES', requestBytesFor(maxUploadBytes), 1024, REQUEST_MAX) ?? requestBytesFor(maxUploadBytes);
  if (maxRequestBytes < minimumRequest) {
    problems.push(`CIRCLE_HUB_MAX_REQUEST_BYTES 至少要 ${minimumRequest}（上传上限的 base64 长度），否则最大的上传进不来`);
  }

  if (problems.length > 0 || dataDir === undefined || logDir === undefined || port === undefined || resolvedDatabaseHost === undefined) {
    throw new HubConfigError(problems.length > 0 ? problems : ['配置不完整']);
  }
  return {
    dataDir,
    logDir,
    host,
    ...(allowedHosts ? { allowedHosts } : {}),
    ...(proxyOrigin ? { proxyOrigin } : {}),
    ...(proxyPeer ? { proxyPeer } : {}),
    port,
    ...(https ? { https } : {}),
    database: { host: resolvedDatabaseHost, port: databasePort, database, user },
    keychain,
    limits: { maxUploadBytes, maxRecordBytes, maxRequestBytes },
  };
}
