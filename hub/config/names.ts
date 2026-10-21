// The CIRCLE_HUB_* variables the Hub reads. This table is the single list; anything else under the prefix refuses to start.

export const HUB_PREFIX = 'CIRCLE_HUB_';
export const RETIRED_PREFIX = 'CIRCLE_SERVER_';

/** Variable name -> Chinese description shown in configuration errors and generated documentation. */
export const HUB_ENVIRONMENT = {
  CIRCLE_HUB_DATA_DIR: '数据目录，绝对路径，必填；对象、密钥库和日志默认都在它下面',
  CIRCLE_HUB_LOG_DIR: '日志目录，绝对路径，默认是 <数据目录>/logs',
  CIRCLE_HUB_HOST: '监听地址，只允许回环地址（127.0.0.0/8 或 ::1），默认 127.0.0.1',
  CIRCLE_HUB_PORT: '监听端口，必填，0 表示由系统分配',
  CIRCLE_HUB_DATABASE_SOCKET_DIR: 'PostgreSQL 的 Unix 套接字目录，绝对路径；与 CIRCLE_HUB_DATABASE_HOST 二选一',
  CIRCLE_HUB_DATABASE_HOST: 'PostgreSQL 的回环地址；与 CIRCLE_HUB_DATABASE_SOCKET_DIR 二选一',
  CIRCLE_HUB_DATABASE_PORT: 'PostgreSQL 端口，默认 5432（用套接字时决定套接字文件名）',
  CIRCLE_HUB_DATABASE_NAME: '数据库名，默认 circle_hub',
  CIRCLE_HUB_DATABASE_USER: '数据库用户，默认 circle_hub；口令不从环境变量读取',
  CIRCLE_HUB_KEYCHAIN_SERVICE: '钥匙串里密钥库主密钥的服务名，默认 circle-hub',
  CIRCLE_HUB_KEYCHAIN_ACCOUNT: '钥匙串里密钥库主密钥的账户名，默认 vault',
  CIRCLE_HUB_MAX_UPLOAD_BYTES: '单个上传或对象的字节上限，默认 33554432（32 MiB），最大 268435456（256 MiB）',
  CIRCLE_HUB_MAX_RECORD_BYTES: '单条记录正文（规范化 JSON）的字节上限，默认 16777216（16 MiB）',
  CIRCLE_HUB_MAX_REQUEST_BYTES: '单个 HTTP 请求体的字节上限，默认按上传上限的 base64 长度再加 1 MiB，至少 48 MiB，最大 512 MiB',
} as const;

export type HubEnvironmentName = keyof typeof HUB_ENVIRONMENT;

export function isHubEnvironmentName(name: string): name is HubEnvironmentName {
  return Object.hasOwn(HUB_ENVIRONMENT, name);
}
