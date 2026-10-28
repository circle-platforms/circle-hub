// The CIRCLE_HUB_* variables the Hub reads. This table is the single list; anything else under the prefix refuses to start,
// except the names only platform commands read (PLATFORM_ONLY_ENVIRONMENT), which are tolerated and never read here.

export const HUB_PREFIX = 'CIRCLE_HUB_';
export const RETIRED_PREFIX = 'CIRCLE_SERVER_';

/** Variable name -> Chinese description shown in configuration errors and generated documentation. */
export const HUB_ENVIRONMENT = {
  CIRCLE_HUB_DATA_DIR: '数据目录，绝对路径，必填；对象、密钥库和日志默认都在它下面',
  CIRCLE_HUB_LOG_DIR: '日志目录，绝对路径，默认是 <数据目录>/logs',
  CIRCLE_HUB_HOST: '监听地址，默认回环；指定内网地址时须同时声明允许主机',
  CIRCLE_HUB_ALLOWED_HOSTS: '允许的主机名或 IP 字面，以逗号分隔，不含端口、协议、路径或通配符',
  CIRCLE_HUB_PROXY_ORIGIN: '可选的 HTTPS 代理公开来源，必须属于允许主机且与直接 HTTP 监听权威不同',
  CIRCLE_HUB_PROXY_PEER: 'HTTPS 代理连接到 Hub 时的可信对端 IP，必须与代理来源同时配置',
  CIRCLE_HUB_PORT: '监听端口，必填，0 表示由系统分配',
  CIRCLE_HUB_DATABASE_SOCKET_DIR: 'PostgreSQL 的 Unix 套接字目录，绝对路径；与 CIRCLE_HUB_DATABASE_HOST 二选一',
  CIRCLE_HUB_DATABASE_HOST: 'PostgreSQL 的回环地址；与 CIRCLE_HUB_DATABASE_SOCKET_DIR 二选一',
  CIRCLE_HUB_DATABASE_PORT: 'PostgreSQL 端口，默认 5432（用套接字时决定套接字文件名）',
  CIRCLE_HUB_DATABASE_NAME: '数据库名，默认 circle_hub',
  CIRCLE_HUB_DATABASE_USER: '数据库用户，默认 circle_hub；口令不从环境变量读取',
  CIRCLE_HUB_KEYCHAIN_SERVICE: '钥匙串服务名，部署的两个钥匙串项都在它下面：密钥库主密钥（账户见 CIRCLE_HUB_KEYCHAIN_ACCOUNT）和操作令牌（账户 operator-token）；默认 circle-hub',
  CIRCLE_HUB_KEYCHAIN_ACCOUNT: '钥匙串里密钥库主密钥的账户名，默认 vault-master-key；operator-token 留给操作令牌，不能用',
  CIRCLE_HUB_MAX_UPLOAD_BYTES: '单个上传或对象的字节上限，默认 33554432（32 MiB），最大 268435456（256 MiB）',
  CIRCLE_HUB_MAX_RECORD_BYTES: '单条记录正文（规范化 JSON）的字节上限，默认 16777216（16 MiB）',
  CIRCLE_HUB_MAX_REQUEST_BYTES: '单个 HTTP 请求体的字节上限，默认按上传上限的 base64 长度再加 1 MiB，至少 48 MiB，最大 512 MiB',
} as const;

export type HubEnvironmentName = keyof typeof HUB_ENVIRONMENT;

export function isHubEnvironmentName(name: string): name is HubEnvironmentName {
  return Object.hasOwn(HUB_ENVIRONMENT, name);
}

/**
 * CIRCLE_HUB_* names only platform commands read: the values of hub/platform/environment.ts PLATFORM_VARIABLES that are
 * not in HUB_ENVIRONMENT (the platform's list is the source; a test keeps the two equal). loadConfig tolerates them and
 * never reads them, so an operator shell that sets them can still run `circle-hub serve`.
 */
export const PLATFORM_ONLY_ENVIRONMENT = {
  CIRCLE_HUB_LIBPQ_BIN: 'pg_dump 和 pg_restore 所在的目录（绝对路径），只有平台的备份、恢复和部署命令读取；circle-hub serve 不读',
} as const;

export type PlatformOnlyName = keyof typeof PLATFORM_ONLY_ENVIRONMENT;

export function isPlatformOnlyName(name: string): name is PlatformOnlyName {
  return Object.hasOwn(PLATFORM_ONLY_ENVIRONMENT, name);
}
