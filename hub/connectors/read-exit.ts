// Caller-visible exit for a failed source read, keyed only by the connector error code.
// Transport failures tell Circle the missing fact and the next step. Credential and identity failures do not:
// the caller stays on the neutral unavailable answer, and the command stays in the admin reason.
// Neither text is chosen by matching the failure message. Hosts, tokens and response bodies stay out of the caller text.
import { secretNameOf } from '../../contracts/src/variables.ts';
import { CONNECTOR_ERRORS, type ConnectorErrorCode } from './errors.ts';

export type ReadExitProtocol = 'SOURCE_READ_FAILED' | 'SOURCE_READ_LIMIT' | 'SOURCE_REDIRECT_REFUSED' | 'SOURCE_RETRYABLE';

export interface CallerExit {
  protocol: ReadExitProtocol;
  /** The missing fact. */
  message: string;
  /** Who does what, and how the read continues. */
  fix: string;
}

/** How the administrator command is built. `account` has no resource command. */
export type AdminExitKind = 'show' | 'reset-login' | 'list' | 'pack-list' | 'account';

export interface ReadExit {
  /** Null when this code is not a caller-visible read failure (a disabled reader, or an admin-only refusal). */
  caller: CallerExit | null;
  admin: AdminExitKind;
}

const RETRY_FIX = '稍后用同样参数重新开始；仍失败请管理员核对资源地址与网络';
const SHOW_FIX = '请管理员核对资源地址与网络后，用同样参数重新开始';
/** Credential and identity failures stay SOURCE_UNAVAILABLE for the caller. The command is admin-only. */
const hidden = (admin: AdminExitKind): ReadExit => ({ caller: null, admin });

const caller = (protocol: ReadExitProtocol, message: string, fix: string): CallerExit => ({ protocol, message, fix });

/** One row per connector code. A new code fails this record until it has an exit. */
export const READ_EXITS: Record<ConnectorErrorCode, ReadExit> = {
  ROUTE_REFUSED: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.ROUTE_REFUSED, '缺少符合路由声明的读取请求；由系统包负责人修复规划，按允许路由重读'), admin: 'show' },
  ORIGIN_REFUSED: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.ORIGIN_REFUSED, '规划链接不在允许的同源范围；由资源管理员核对地址声明或系统包负责人修复规划后重读'), admin: 'show' },
  PLAINTEXT_REFUSED: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.PLAINTEXT_REFUSED, '本地传输策略拒绝经明文发送凭据；由资源管理员核对 HTTPS 与地址声明后重读'), admin: 'show' },
  SOURCE_REDIRECT_REFUSED: { caller: caller('SOURCE_REDIRECT_REFUSED', CONNECTOR_ERRORS.SOURCE_REDIRECT_REFUSED, '由资源管理员核对来源给出的 Location 与路由声明，修复配置后按原对象重读'), admin: 'show' },
  RESPONSE_TOO_LARGE: { caller: caller('SOURCE_READ_LIMIT', CONNECTOR_ERRORS.RESPONSE_TOO_LARGE, '由资源管理员调整声明或缩小读取范围后重新完整读取'), admin: 'show' },
  SOURCE_TIMEOUT: { caller: caller('SOURCE_RETRYABLE', CONNECTOR_ERRORS.SOURCE_TIMEOUT, RETRY_FIX), admin: 'show' },
  SOURCE_UNREACHABLE: { caller: caller('SOURCE_RETRYABLE', CONNECTOR_ERRORS.SOURCE_UNREACHABLE, RETRY_FIX), admin: 'show' },
  SOURCE_ABSENT: { caller: caller('SOURCE_READ_FAILED', '未读到要求的锁定修订', '未读到要求的锁定修订；由资源管理员核对对象修订后重读，需要改修订时开始新运行'), admin: 'show' },
  SOURCE_FORBIDDEN: hidden('show'),
  SOURCE_HTTP_STATUS: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.SOURCE_HTTP_STATUS, '来源明确以非成功 HTTP 状态作答；由资源管理员核对路由、参数与系统状态后重读'), admin: 'show' },
  SOURCE_LOGIN_EXPIRED: hidden('reset-login'),
  SOURCE_ENVELOPE_ERROR: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.SOURCE_ENVELOPE_ERROR, '来源在应答信封中明确报错；由资源管理员核对参数与系统状态后重读'), admin: 'show' },
  SOURCE_MALFORMED: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.SOURCE_MALFORMED, '缺少符合声明格式的应答；由资源管理员核对应答格式与路由声明，修复后重读'), admin: 'show' },
  SOURCE_CREDENTIAL: hidden('show'),
  LOGIN_FAILED: hidden('reset-login'),
  CREDENTIAL_REFUSED: hidden('reset-login'),
  CREDENTIAL_MISSING: hidden('reset-login'),
  PLAN_INVALID: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.PLAN_INVALID, '缺少符合契约的完整读取计划；由系统包负责人核对规划函数与路由，修复后重读'), admin: 'show' },
  PROJECTION_FAILED: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.PROJECTION_FAILED, '缺少符合投影契约的出件；由系统包负责人核对投影输入、输出与回读，修复后重读'), admin: 'show' },
  FUNCTION_FAILED: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.FUNCTION_FAILED, '缺少包函数的成功出件；由系统包负责人修复函数后重读'), admin: 'show' },
  READ_LIMIT: { caller: caller('SOURCE_READ_LIMIT', CONNECTOR_ERRORS.READ_LIMIT, '由资源管理员调整声明或缩小读取范围后重新完整读取'), admin: 'show' },
  STORE_FAILED: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.STORE_FAILED, '缺少已保存并可回读的来源原件；由 Hub 管理员修复对象存储，必要时从备份恢复后重读'), admin: 'show' },
  RESOURCE_UNAVAILABLE: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.RESOURCE_UNAVAILABLE, SHOW_FIX), admin: 'list' },
  READ_UNDECLARED: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.READ_UNDECLARED, '由系统包负责人补上这种外部对象的读取声明后重读'), admin: 'show' },
  PACK_UNAVAILABLE: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.PACK_UNAVAILABLE, '由管理员重新发布或恢复该系统包后，用同样参数重新开始'), admin: 'pack-list' },
  PROFILE_INVALID: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.PROFILE_INVALID, '由系统包负责人修正 system.json 后重读'), admin: 'show' },
  RESOURCE_INVALID: { caller: caller('SOURCE_READ_FAILED', CONNECTOR_ERRORS.RESOURCE_INVALID, '由管理员修正资源配置后，用同样参数重新开始'), admin: 'show' },
  ACCESS_DENIED: { caller: null, admin: 'account' },
  READER_INVALID: { caller: null, admin: 'account' },
};

export function readExit(code: ConnectorErrorCode): ReadExit {
  return READ_EXITS[code];
}

export function secretNamesOf(credentials: Readonly<Record<string, string>> | null | undefined): string[] {
  if (credentials == null) return [];
  return [...new Set(Object.values(credentials).map(secretNameOf).filter((name): name is string => name !== null))].sort();
}

/** The administrator's next command. Secret names may appear; secret values and hosts do not. */
export function adminCommand(kind: AdminExitKind, resource: string, secretNames: readonly string[] = []): string {
  const id = resource.trim();
  const show = id === '' ? 'circle-hub resource list' : `circle-hub resource show ${id}`;
  if (kind === 'show') return show;
  if (kind === 'list') return 'circle-hub resource list';
  if (kind === 'pack-list') return 'circle-hub pack list';
  if (kind === 'account') return '由管理员核对账号是否启用';
  const names = [...new Set(secretNames)].sort();
  const set = names.length === 0 ? '' : `circle-hub secret set ${names.map(name => `--name ${name}`).join(' ')} 或 `;
  return `${set}circle-hub resource reset-login ${id === '' ? '<资源>' : id}`;
}
