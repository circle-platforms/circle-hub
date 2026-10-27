// Typed errors of the connectors. Transport failures the caller may see use the fixed exit of hub/connectors/read-exit.ts.
// Credential and identity failures stay "unavailable" for the caller; the code, the Chinese diagnostic and the command go to
// the admin log. A retained envelope keeps disclosable false. Hosts, tokens and response bodies stay out of caller text.
// Each read error belongs to one of the three layers of D01 R[5]: transport (HTTP, network, limits, refusals before I/O),
// envelope (codes inside a 200 answer, login) or plugin (the system pack's functions and the declared answer format).

/** D01 R[5]: transport, envelope, plugin. Not a vocabulary axis yet (see the README). */
export type ErrorLayer = 'transport' | 'envelope' | 'plugin';

export const CONNECTOR_ERRORS = {
  ROUTE_REFUSED: '请求不在系统包的路由清单里，发出前已拒绝',
  ORIGIN_REFUSED: '请求的地址不在资源为该角色配置的同源范围内，发出前已拒绝',
  PLAINTEXT_REFUSED: '凭据不经明文 HTTP 发送：资源没有为这个地址声明允许明文',
  SOURCE_REDIRECT_REFUSED: '来源要求重定向；Hub 不跟随重定向',
  RESPONSE_TOO_LARGE: '响应超过字节上限，已中止读取，不截断保存',
  SOURCE_TIMEOUT: '读取超时',
  SOURCE_UNREACHABLE: '连不上来源',
  SOURCE_ABSENT: '来源说对象不存在',
  SOURCE_FORBIDDEN: '来源拒绝了这个身份',
  SOURCE_HTTP_STATUS: '来源返回了错误状态',
  SOURCE_LOGIN_EXPIRED: '来源说登录已过期',
  SOURCE_ENVELOPE_ERROR: '来源在应答信封里报了错',
  SOURCE_MALFORMED: '应答不是路由声明的格式',
  SOURCE_CREDENTIAL: '应答含凭据，按只保留档位保存；函数拿不到原文',
  LOGIN_FAILED: '登录失败；来源拒绝或没有确定应答时停止登录，直到管理员重新设置凭据或重置登录',
  CREDENTIAL_REFUSED: '来源拒绝了静态凭据；管理员重新设置凭据或重置之前不再发送',
  CREDENTIAL_MISSING: '密钥库里没有这项凭据',
  PLAN_INVALID: '系统包的读取规划函数给出的计划无效',
  PROJECTION_FAILED: '系统包的投影函数失败',
  FUNCTION_FAILED: '系统包的函数没能在沙箱里运行完',
  READ_LIMIT: '一次读取超过了请求数、字节数或嵌套层数的上限',
  STORE_FAILED: '保存读到的内容失败，读取已中止',
  RESOURCE_UNAVAILABLE: '没有可用的资源能读这个外部对象',
  READ_UNDECLARED: '系统包没有声明这种外部对象的读取',
  PACK_UNAVAILABLE: '资源的系统包不可用（未发布、已撤回或不是系统包）',
  PROFILE_INVALID: '系统包的 system.json 无效',
  RESOURCE_INVALID: '资源配置无效',
  ACCESS_DENIED: '只有管理员能做这件事',
  READER_INVALID: '读取者不是有效的 Hub 账号',
} as const;

export type ConnectorErrorCode = keyof typeof CONNECTOR_ERRORS;

export function isConnectorErrorCode(value: unknown): value is ConnectorErrorCode {
  return typeof value === 'string' && Object.hasOwn(CONNECTOR_ERRORS, value);
}

export interface ConnectorErrorOptions {
  layer?: ErrorLayer | null;
  detail?: Record<string, unknown>;
  cause?: unknown;
}

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly layer: ErrorLayer | null;
  /** Machine-readable cause: route id, status, limit. Never a header value, a URL with a host, a credential or a body. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: ConnectorErrorCode, message?: string, options: ConnectorErrorOptions = {}) {
    super(message ?? CONNECTOR_ERRORS[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConnectorError';
    this.code = code;
    this.layer = options.layer ?? null;
    this.detail = Object.freeze({ ...(options.detail ?? {}) });
  }
}

/** Errors after which a read stops at once instead of handing the failed response to the planner. */
export const FATAL_READ_ERRORS: ReadonlySet<ConnectorErrorCode> = new Set<ConnectorErrorCode>([
  'ROUTE_REFUSED',
  'ORIGIN_REFUSED',
  'PLAINTEXT_REFUSED',
  'SOURCE_LOGIN_EXPIRED',
  'LOGIN_FAILED',
  'CREDENTIAL_REFUSED',
  'CREDENTIAL_MISSING',
  'READ_LIMIT',
  'STORE_FAILED',
  'PLAN_INVALID',
]);

export function asConnectorError(error: unknown, fallback: ConnectorErrorCode, layer: ErrorLayer | null = null): ConnectorError {
  if (error instanceof ConnectorError) return error;
  return new ConnectorError(fallback, undefined, { layer, cause: error });
}
