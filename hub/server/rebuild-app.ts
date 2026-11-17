import { createServer, type Server } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { readServerTls } from '../platform/api.ts';
import type { HubConfig } from '../config/index.ts';
import type { HubApp, AppOptions, ListenInfo } from './api.ts';
import { allowedHosts, hostAllowed, originAllowed, ownOrigins, sendJson, sendText, setCommonHeaders } from './http.ts';
import { createRebuildHandler, type RebuildHttpOptions } from './rebuild-http.ts';
import { parseTarget } from './app.ts';

/** A maintenance-only listener. No RecordsKit, telemetry, background work or ordinary console router is created. */
export async function createRebuildApp(config: HubConfig, options: Omit<RebuildHttpOptions, 'originAllowed'> & { tls?: AppOptions['tls'] }): Promise<HubApp> {
  const hosts = new Set<string>(), origins = new Set<string>();
  const handle = createRebuildHandler({ ...options, originAllowed: request => originAllowed(request, origins) });
  const sockets = new Set<import('node:net').Socket>();
  const listener: import('node:http').RequestListener = (request, response) => {
    setCommonHeaders(response);
    if (!hostAllowed(request, hosts)) { request.resume(); return sendText(response, 403, '访问地址不允许'); }
    const target = parseTarget(request.url);
    if (!target || target.authority !== null && !hosts.has(target.authority)) { request.resume(); return sendText(response, 400, '请求地址无效'); }
    if (target.url.pathname === '/healthz') {
      request.resume();
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendText(response, 405, '只接受 GET', { allow: 'GET, HEAD' });
      return sendJson(response, 200, { needsRebuild: true });
    }
    const url = target.url;
    if (url.pathname === '/' || url.pathname === '/console' || url.pathname === '/console/') {
      request.resume(); response.writeHead(303, { location: '/console/rebuild' }); response.end(); return;
    }
    void handle(request, response, url).catch(() => {
      options.log('重建控制请求未完成；请本机检查 reset 状态，未将异常解释为重建成功');
      if (!response.headersSent) sendText(response, 500, '重建控制请求未完成，请本机检查 reset 状态');
      else response.destroy();
    });
  };
  const server = createServer(listener); let secure: Server | undefined;
  if (config.https) {
    const material = options.tls ?? await readServerTls(config.dataDir);
    secure = createSecureServer(material, listener);
  }
  for (const current of [server, secure]) current?.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  let info: ListenInfo | undefined;
  const bind = (current: Server, host: string, port: number) => new Promise<number>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    current.once('error', fail);
    current.listen(port, host, () => { current.off('error', fail); const address = current.address(); if (!address || typeof address === 'string') return reject(new Error('监听地址不可用')); resolve(address.port); });
  });
  return {
    release: null, handler: listener, consoleStreams: () => 0,
    async listen() {
      if (info) return info;
      const port = await bind(server, config.host, config.port);
      for (const host of allowedHosts(config.host, port, config.allowedHosts)) hosts.add(host);
      for (const origin of ownOrigins(hosts)) origins.add(origin);
      info = { host: config.host, port, url: `http://${config.host.includes(':') ? '[' + config.host + ']' : config.host}:${port}` };
      if (secure && config.https) {
        const httpsPort = await bind(secure, config.https.host, config.https.port);
        const secureHosts = allowedHosts(config.https.host, httpsPort, config.allowedHosts, 443);
        for (const host of secureHosts) hosts.add(host);
        for (const origin of ownOrigins(secureHosts, 'https')) origins.add(origin);
        info.https = { host: config.https.host, port: httpsPort, url: `https://${config.https.host.includes(':') ? '[' + config.https.host + ']' : config.https.host}:${httpsPort}` };
      }
      return info;
    },
    async close() { for (const socket of sockets) socket.destroy(); await Promise.all([server, secure].filter((value): value is Server => value !== undefined).map(current => new Promise<void>(resolve => current.close(() => resolve())))); },
  };
}
