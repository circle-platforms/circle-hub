import { CallFailure, failCall, formatCallError, type CallFailureOptions } from './text.ts';
import { HubReplyError } from './generated/skills/run-tools/hub-client/index.ts';

/** The CLI's explicit HTTP URL declaration, independent of exception prose. */
export function parseHubOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { failCall('invalid_parameters', '--hub 不是可解析的绝对 URL', '从当前 MCP 条目复制完整 http 或 https 地址后重试', { path: '/hub', legal_form: "--hub '<MCP 条目中的 http 或 https 地址>'" }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') failCall('invalid_parameters', '--hub 的协议不是 http 或 https', '从当前 MCP 条目复制 http 或 https 地址，不使用文件或其他协议', { path: '/hub', legal_form: "--hub '<MCP 条目中的 http 或 https 地址>'" });
  return url.origin;
}

/** Only the declared HTTP reply class carries a remote status; arbitrary Error.status is not evidence. */
export function hubReplyFailure(error: unknown): CallFailure | null {
  if (!(error instanceof HubReplyError)) return null;
  const status = error.status, fact = error.message || `Hub 返回 HTTP ${status}`;
  if (status === 401 || status === 403) return new CallFailure('permission_denied', fact, '核对本次调用身份及该对象的读取授权，再按原请求读取');
  if (status === 404 || status === 410) return new CallFailure('not_found', fact, '核对本次请求的对象标识及服务地址；若标识来自 Hub 回执，请维护者核对该回执和当前路由后再读');
  if (status === 409 || status === 423) return new CallFailure('occupied', fact, '按远端给出的结构化冲突或占用说明处理；缺少说明时请维护者补齐，不盲目重复提交');
  if (status === 400 || status === 422) return new CallFailure('invalid_parameters', fact, '按远端答复中的具体参数位置和合法取值修正请求后重试');
  if (status === 408 || status === 429 || status >= 500 && status <= 599) return new CallFailure('temporarily_unavailable', fact, '有 Retry-After 时按该时刻重试同一请求；否则请维护者核对服务状态后再读');
  return null;
}

/** Client-only adapter; sandboxed pack functions keep using the pure text formatter. */
export function formatClientCallError(error: unknown, options?: CallFailureOptions): string {
  return formatCallError(hubReplyFailure(error) ?? error, options);
}
