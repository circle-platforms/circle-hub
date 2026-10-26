// The HTTP surface of the Hub: POST /mcp, the read-only console under /console and GET /healthz, on a loopback address only.
// Every request first passes the Host check (only 127.0.0.1:<port> and localhost:<port>, against DNS rebinding) and the
// Origin check (absent, or a loopback origin); then the route decides. The request target is parsed once and never throws:
// a target that is neither a path nor an absolute http URL of this server is a 400. close() stops accepting, lets requests in
// flight end (bounded), closes every connection, then waits (bounded again) for the handlers it cut off, so their call-log
// lines are written before the caller closes the records; it never stops the database.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isLoopbackAddress } from '../config/index.ts';
import type { AppOptions, HubApp, ListenInfo, ServerDeps } from './api.ts';
import { handleConsole } from './console/index.ts';
import { SessionStore } from './console/session.ts';
import { BodyBudget, allowedHosts, hostAllowed, originAllowed, ownOrigins, sendJson, sendRpcError, sendText } from './http.ts';
import { handleLocalTools, localToolsTarget } from './local-tools.ts';
import { handleMcp } from './mcp.ts';
import { describeError } from './notes.ts';
import { packageVersion, readReleaseId } from './release.ts';

const REFUSED_HOST = '拒绝：Host 必须是本机地址 127.0.0.1:<端口> 或 localhost:<端口>';
const REFUSED_ORIGIN = '拒绝：Origin 不是本机来源';
const BAD_TARGET = '请求目标不对：要么是以 / 开头的路径，要么是本服务器的 http 绝对地址';

/** A parsed request target: the URL on this server, and the authority an absolute-form target named (null for a path). */
export interface RequestTarget {
  url: URL;
  authority: string | null;
}

/**
 * The request target, parsed once and without throwing (RFC 9112 3.2). An origin-form target is always a path on this
 * server, so `//x/mcp` stays the path `//x/mcp` and is never read as an authority; an absolute-form target must be http
 * without user information. Anything else (asterisk form, a URL the parser refuses) is null.
 */
export function parseTarget(target: string | undefined): RequestTarget | null {
  if (typeof target !== 'string' || target.length === 0) return null;
  try {
    if (target.startsWith('/')) return { url: new URL(`http://127.0.0.1${target}`), authority: null };
    if (/^http:\/\//i.test(target)) {
      const url = new URL(target);
      if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') return null;
      return { url, authority: url.host.toLowerCase() };
    }
  } catch {
    return null;
  }
  return null;
}

/** A target for the operator's log: at most 200 characters, controls replaced. */
function printable(target: string | undefined): string {
  return String(target ?? '').slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, '?');
}

export function createApp(deps: ServerDeps, options: AppOptions = {}): HubApp {
  const host = deps.config.host;
  if (!isLoopbackAddress(host)) throw new Error(`circle-hub 只监听本机回环地址，${host} 不是`);
  const release = readReleaseId(options.codeRoot);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const closeTimeoutMs = options.closeTimeoutMs ?? 10_000;
  const closeGraceMs = options.closeGraceMs ?? 15_000;
  const clock = deps.now ?? (() => new Date());
  const sessions = new SessionStore(() => clock().getTime());
  const budget = new BodyBudget(options.maxInflightBodyBytes ?? 4 * deps.config.limits.maxRequestBytes);
  let hosts = allowedHosts(host, deps.config.port);
  let origins = ownOrigins(hosts);
  let server: Server | null = null;
  let stopping = false;
  let closing: Promise<void> | null = null;
  const inflight = new Set<Promise<void>>();

  const mcpOptions = { deps, serverVersion: packageVersion(), log, budget };
  const consoleOptions = { deps, sessions, ownOrigins: () => origins, log };

  const route = async (request: IncomingMessage, response: ServerResponse, target: RequestTarget | null): Promise<void> => {
    if (stopping) response.setHeader('connection', 'close');
    const isMcp = target?.url.pathname === '/mcp';
    // An absolute-form target names an authority too: it must be this server, like the Host header.
    const hostOk = hostAllowed(request, hosts) && (target === null || target.authority === null || hosts.has(target.authority));
    if (!hostOk || !originAllowed(request)) {
      request.resume();
      const message = hostOk ? REFUSED_ORIGIN : REFUSED_HOST;
      if (isMcp) sendRpcError(response, 403, -32000, message, { connection: 'close' });
      else sendText(response, 403, message, { connection: 'close' });
      return;
    }
    if (target === null) {
      request.resume();
      return sendText(response, 400, BAD_TARGET, { connection: 'close' });
    }
    const url = target.url;
    if (localToolsTarget(request.url)) return handleLocalTools(request, response, deps, log);
    if (url.pathname === '/healthz') {
      request.resume();
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendText(response, 405, '只接受 GET', { allow: 'GET, HEAD' });
      return sendJson(response, 200, { status: 'ok', release });
    }
    if (isMcp) return handleMcp(request, response, mcpOptions, deps.config.limits.maxRequestBytes);
    if (url.pathname === '/console' || url.pathname.startsWith('/console/')) return handleConsole(request, response, url, consoleOptions);
    request.resume();
    sendText(response, 404, '没有这个地址');
  };

  /** The last resort of a request: logs and answers 500 (or drops the connection); never throws. */
  const fail = (request: IncomingMessage, response: ServerResponse, label: string, error: unknown): void => {
    try {
      log(`请求处理出错（${printable(request.method)} ${label}）：${describeError(error)}`);
    } catch {
      // The operator's log itself failed; the answer below still goes out.
    }
    try {
      if (!response.headersSent) sendJson(response, 500, { error: 'Hub 内部错误' }, { connection: 'close' });
      else response.destroy();
    } catch {
      response.destroy();
    }
  };

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const target = parseTarget(request.url);
    const label = target === null ? printable(request.url) : printable(target.url.pathname);
    // `task` never rejects: fail() catches everything, so no request can leave a rejection nobody handles.
    const task: Promise<void> = route(request, response, target).catch((error: unknown) => fail(request, response, label, error));
    inflight.add(task);
    void task.finally(() => inflight.delete(task)).catch(() => {});
  };

  /** Waits until no request is in flight (new ones arriving meanwhile included); false when `ms` ran out first. */
  const drained = async (ms: number): Promise<boolean> => {
    const end = Date.now() + ms;
    while (inflight.size > 0) {
      const left = end - Date.now();
      if (left <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, left);
        timer.unref();
      });
      await Promise.race([Promise.allSettled([...inflight]), deadline]);
      clearTimeout(timer);
    }
    return true;
  };

  const listen = async (): Promise<ListenInfo> => {
    if (server !== null) throw new Error('already listening');
    if (closing !== null) throw new Error('the app is closed');
    const created = createServer({ requestTimeout: 120_000, headersTimeout: 30_000, keepAliveTimeout: 5_000 }, handler);
    await new Promise<void>((resolve, reject) => {
      created.once('error', reject);
      created.listen(deps.config.port, host, () => {
        created.off('error', reject);
        resolve();
      });
    });
    server = created;
    const port = (created.address() as AddressInfo).port;
    hosts = allowedHosts(host, port);
    origins = ownOrigins(hosts);
    const literal = host.includes(':') ? `[${host}]` : host;
    return { host, port, url: `http://${literal}:${port}` };
  };

  const close = (): Promise<void> =>
    (closing ??= (async () => {
      stopping = true;
      const current = server;
      if (current !== null) {
        const closed = new Promise<void>((resolve) => current.close(() => resolve()));
        current.closeIdleConnections();
        await drained(closeTimeoutMs);
        current.closeAllConnections();
        // Cutting a connection does not stop its handler: wait for those too (bounded), so a call that is still running
        // writes its call-log line before the caller stops the sandbox and closes the records.
        if (!(await drained(closeGraceMs))) {
          log(`停止时还有 ${inflight.size} 个请求没有结束（连接已断开，又等了 ${closeGraceMs} 毫秒）；它们的调用日志可能写不进去`);
        }
        await closed;
      } else {
        await Promise.allSettled([...inflight]);
      }
      sessions.clear();
    })());

  return { handler, listen, close, release };
}
