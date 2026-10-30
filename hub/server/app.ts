// The HTTP surface of the Hub: POST /mcp, the console under /console and GET /healthz, on a loopback address unless the
// configuration declares the allowed hosts; the same routes also over the built-in HTTPS when it is configured (a second
// listener with the certificate of <data root>/tls). Every request first passes the Host check of the listener it arrived
// on (127.0.0.1:<port>, localhost:<port> and the declared names, against DNS rebinding) and the Origin check (absent, or
// one of this server's own origins); then the route decides. The request target is parsed once and never throws:
// a target that is neither a path nor an absolute http URL of this server is a 400. close() stops accepting, lets requests in
// flight end (bounded), closes every connection, then waits (bounded again) for the handlers it cut off, so their call-log
// lines are written before the caller closes the records; it never stops the database.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { isLoopbackAddress } from '../config/index.ts';
import { validAllowedHosts, validListenAddress, validProxyOrigin } from '../listen.ts';
import type { AppOptions, HubApp, ListenInfo, ServerDeps } from './api.ts';
import { handleConsole } from './console/index.ts';
import { JobStore } from './console/manage.ts';
import { SessionStore } from './console/session.ts';
import { BodyBudget, allowedHosts, hostAllowed, originAllowed, ownOrigins, sendJson, sendRpcError, sendText } from './http.ts';
import { handleLocalTools, localToolsTarget } from './local-tools.ts';
import { handleMcp } from './mcp.ts';
import { describeError } from './notes.ts';
import { packageVersion, readReleaseId } from './release.ts';

const REFUSED_HOST = '拒绝：Host 不在此服务允许的主机名单里';
const REFUSED_ORIGIN = '拒绝：Origin 不在此服务允许的来源名单里';
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

/** True for a request that arrived over the built-in TLS listener. */
function encrypted(request: IncomingMessage): boolean {
  return (request.socket as TLSSocket).encrypted === true;
}

/** A target for the operator's log: at most 200 characters, controls replaced. */
function printable(target: string | undefined): string {
  return String(target ?? '').slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, '?');
}

export function createApp(deps: ServerDeps, options: AppOptions = {}): HubApp {
  const host = deps.config.host;
  const declared = deps.config.allowedHosts;
  const refusedHost = declared ? REFUSED_HOST : '拒绝：Host 必须是本机地址 127.0.0.1:<端口> 或 localhost:<端口>';
  const refusedOrigin = declared ? REFUSED_ORIGIN : '拒绝：Origin 不是本机来源';
  const proxyOrigin = deps.config.proxyOrigin;
  const proxyPeer = deps.config.proxyPeer;
  if (!validListenAddress(host) || (declared && !validAllowedHosts(declared)) || (!isLoopbackAddress(host) && !declared) || (proxyOrigin && !validProxyOrigin(proxyOrigin, declared, deps.config.port)) || Boolean(proxyOrigin) !== Boolean(proxyPeer) || (proxyPeer && !validListenAddress(proxyPeer))) throw new Error('监听地址、允许主机或可信代理无效');
  const proxyAuthority = proxyOrigin ? new URL(proxyOrigin).host : null;
  const https = deps.config.https;
  if (https && (!validListenAddress(https.host) || (!isLoopbackAddress(https.host) && !declared) || proxyOrigin)) throw new Error('内置 HTTPS 的监听地址无效，或与 HTTPS 代理同时配置');
  if (https && !options.tls) throw new Error('配置了内置 HTTPS，但没有给证书和私钥');
  const release = readReleaseId(options.codeRoot);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const closeTimeoutMs = options.closeTimeoutMs ?? 10_000;
  const closeGraceMs = options.closeGraceMs ?? 15_000;
  const clock = deps.now ?? (() => new Date());
  const sessions = new SessionStore(() => clock().getTime());
  const budget = new BodyBudget(options.maxInflightBodyBytes ?? 4 * deps.config.limits.maxRequestBytes);
  let hosts = allowedHosts(host, deps.config.port, declared);
  let secureHosts = https ? allowedHosts(https.host, https.port, declared, 443) : new Set<string>();
  let origins = new Set([...ownOrigins(hosts), ...ownOrigins(secureHosts, 'https')]);
  if (proxyOrigin) { hosts.add(new URL(proxyOrigin).host); origins.add(proxyOrigin); }
  let server: Server | null = null;
  let secureServer: Server | null = null;
  let stopping = false;
  let closing: Promise<void> | null = null;
  const inflight = new Set<Promise<void>>();

  const mcpOptions = { deps, serverVersion: packageVersion(), log, budget };
  const consoleOptions = {
    deps, sessions, ownOrigins: () => origins, log,
    jobs: new JobStore(clock),
    ...(options.bridge ? { bridge: options.bridge } : {}),
    // Forwarded headers never establish the HTTPS channel; only the built-in TLS listener, or the configured proxy
    // authority and peer, do.
    secureRequest: (request: IncomingMessage) => encrypted(request) || (proxyAuthority !== null
      && request.headers.host?.toLowerCase() === proxyAuthority
      && request.socket.remoteAddress?.replace(/^::ffff:/, '') === proxyPeer),
  };

  const route = async (request: IncomingMessage, response: ServerResponse, target: RequestTarget | null): Promise<void> => {
    if (stopping) response.setHeader('connection', 'close');
    // Each listener answers only to its own authorities: an HTTPS name sent over plain HTTP (or the reverse) is refused.
    const listenerHosts = encrypted(request) ? secureHosts : hosts;
    const isMcp = target?.url.pathname === '/mcp';
    // An absolute-form target names an authority too: it must be this server, like the Host header.
    const usesProxy = proxyAuthority !== null && (request.headers.host?.toLowerCase() === proxyAuthority || target?.authority === proxyAuthority || request.headers.origin === proxyOrigin);
    const peer = request.socket.remoteAddress?.replace(/^::ffff:/, '');
    const hostOk = hostAllowed(request, listenerHosts) && (target === null || target.authority === null || listenerHosts.has(target.authority)) && (!usesProxy || peer === proxyPeer);
    if (!hostOk || !originAllowed(request, declared ? origins : undefined)) {
      request.resume();
      const message = hostOk ? refusedOrigin : refusedHost;
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
    let secure: ListenInfo['https'];
    if (https && options.tls) {
      const tls = createSecureServer({ cert: options.tls.cert, key: options.tls.key, minVersion: 'TLSv1.2', requestTimeout: 120_000, headersTimeout: 30_000, keepAliveTimeout: 5_000 }, handler);
      try {
        await new Promise<void>((resolve, reject) => {
          tls.once('error', reject);
          tls.listen(https.port, https.host, () => {
            tls.off('error', reject);
            resolve();
          });
        });
      } catch (error) {
        await new Promise<void>(resolve => created.close(() => resolve()));
        server = null;
        throw error;
      }
      secureServer = tls;
      const securePort = (tls.address() as AddressInfo).port;
      secureHosts = allowedHosts(https.host, securePort, declared, 443);
      const secureLiteral = https.host.includes(':') ? `[${https.host}]` : https.host;
      secure = { host: https.host, port: securePort, url: `https://${secureLiteral}:${securePort}` };
    }
    if (proxyOrigin && !validProxyOrigin(proxyOrigin, declared, port)) {
      await new Promise<void>(resolve => created.close(() => resolve()));
      server = null;
      throw new Error('HTTPS 代理来源不能与实际 HTTP 监听权威相同');
    }
    hosts = allowedHosts(host, port, declared);
    origins = new Set([...ownOrigins(hosts), ...ownOrigins(secureHosts, 'https')]);
    if (proxyOrigin) { hosts.add(new URL(proxyOrigin).host); origins.add(proxyOrigin); }
    const literal = host.includes(':') ? `[${host}]` : host;
    return { host, port, url: `http://${literal}:${port}`, ...(secure ? { https: secure } : {}) };
  };

  const close = (): Promise<void> =>
    (closing ??= (async () => {
      stopping = true;
      const current = server;
      const listeners = [server, secureServer].filter((s): s is Server => s !== null);
      if (current !== null) {
        const closed = Promise.all(listeners.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
        for (const s of listeners) s.closeIdleConnections();
        await drained(closeTimeoutMs);
        for (const s of listeners) s.closeAllConnections();
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
