import assert from 'node:assert/strict';
import { request as plainRequest } from 'node:http';
import { request as secureRequest } from 'node:https';
import { test } from 'node:test';
import { HubConfigError, loadConfig } from '../config/index.ts';
import { serviceEnvironment } from '../platform/launchd.ts';
import { layoutAt } from '../platform/layout.ts';
import { newSettingsFile, resolveSettings } from '../platform/settings.ts';
import { createAuthority, issueServerCertificate } from '../platform/tls.ts';
import type { ServerDeps } from './api.ts';
import { createApp } from './app.ts';

const BASE = { CIRCLE_HUB_DATA_DIR: '/srv/synthetic', CIRCLE_HUB_PORT: '8000', CIRCLE_HUB_DATABASE_SOCKET_DIR: '/srv/synthetic/run' };

test('the built-in HTTPS is configured by its port, listens on loopback unless allowed hosts are declared, and never beside a proxy', () => {
  assert.equal(loadConfig(BASE).https, undefined);
  assert.deepEqual(loadConfig({ ...BASE, CIRCLE_HUB_HTTPS_PORT: '8443' }).https, { host: '127.0.0.1', port: 8443 });
  assert.deepEqual(loadConfig({ ...BASE, CIRCLE_HUB_HTTPS_PORT: '8443', CIRCLE_HUB_HTTPS_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: '192.0.2.10,hub.example' }).https, { host: '192.0.2.10', port: 8443 });
  for (const env of [
    { CIRCLE_HUB_HTTPS_HOST: '127.0.0.1' },
    { CIRCLE_HUB_HTTPS_PORT: '8000' },
    { CIRCLE_HUB_HTTPS_PORT: 'https' },
    { CIRCLE_HUB_HTTPS_PORT: '8443', CIRCLE_HUB_HTTPS_HOST: '192.0.2.10' },
    { CIRCLE_HUB_HTTPS_PORT: '8443', CIRCLE_HUB_HTTPS_HOST: '0.0.0.0', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example' },
    { CIRCLE_HUB_HTTPS_PORT: '8443', CIRCLE_HUB_HTTPS_HOST: '198.18.0.1', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example' },
    { CIRCLE_HUB_HTTPS_PORT: '8443', CIRCLE_HUB_HOST: '127.0.0.1', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example', CIRCLE_HUB_PROXY_ORIGIN: 'https://hub.example', CIRCLE_HUB_PROXY_PEER: '127.0.0.1' },
  ]) assert.throws(() => loadConfig({ ...BASE, ...env }), HubConfigError, JSON.stringify(env));
});

test('deployment settings carry the HTTPS listener to the service and refuse a variable that disagrees', () => {
  const layout = layoutAt('/srv/synthetic');
  const file = newSettingsFile({ environment: 'shared', port: 7420, httpsHost: '192.0.2.10', httpsPort: 7443, allowedHosts: ['192.0.2.10', 'hub.example'] });
  assert.equal(file.https_port, 7443);
  const settings = resolveSettings(file, {}, layout);
  assert.deepEqual(settings.https, { host: '192.0.2.10', port: 7443 });
  const env = serviceEnvironment(layout, settings, { home: '/srv/synthetic-home', user: 'synthetic', database: settings.database } as never);
  assert.equal(env.CIRCLE_HUB_HTTPS_HOST, '192.0.2.10');
  assert.equal(env.CIRCLE_HUB_HTTPS_PORT, '7443');
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_HTTPS_PORT: '9443' }, layout), /CIRCLE_HUB_HTTPS_PORT/);
  assert.throws(() => resolveSettings(newSettingsFile({ environment: 'shared' }), { CIRCLE_HUB_HTTPS_PORT: '7443' }, layout), /CIRCLE_HUB_HTTPS_PORT/, 'a variable cannot switch HTTPS on behind the settings');
  for (const input of [
    { httpsPort: 7420 },
    { httpsHost: '192.0.2.10', httpsPort: 7443 },
    { httpsHost: '127.0.0.1' },
    { httpsPort: 7443, allowedHosts: ['hub.example'], proxyOrigin: 'https://hub.example', proxyPeer: '127.0.0.1' },
  ]) assert.throws(() => newSettingsFile({ environment: 'shared', port: 7420, ...input }), /部署设置的取值不对/, JSON.stringify(input));
});

interface Answer {
  status: number;
  cookies: string[];
}

function plain(port: number, host: string, path = '/healthz', headers: Record<string, string> = {}, method = 'GET'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = plainRequest({ host: '127.0.0.1', port, path, method, headers: { host, ...headers }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cookies: res.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    req.end();
  });
}

function secure(port: number, host: string, ca: string, path = '/healthz', headers: Record<string, string> = {}, method = 'GET', servername?: string): Promise<Answer> {
  const name = servername ?? host.slice(0, host.lastIndexOf(':'));
  return new Promise((resolve, reject) => {
    const req = secureRequest({ host: '127.0.0.1', port, path, method, ca, servername: /^[0-9.]+$/.test(name) ? undefined : name, headers: { host, ...headers }, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cookies: res.headers['set-cookie'] ?? [] }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the HTTPS listener serves the same routes with its own authorities, secure cookies and the session origin rules', async () => {
  const authority = createAuthority();
  const tls = issueServerCertificate(authority, ['hub.example']);
  const deps = {
    config: { host: '127.0.0.1', port: 0, allowedHosts: ['hub.example'], https: { host: '127.0.0.1', port: 0 }, limits: { maxRequestBytes: 1024 } },
    records: { principals: { authenticate: async () => null } },
  } as unknown as ServerDeps;
  const app = createApp(deps, { tls, log: () => {} });
  const info = await app.listen();
  try {
    assert.ok(info.https !== undefined);
    const httpPort = info.port;
    const httpsPort = info.https.port;
    assert.equal(info.https.url, `https://127.0.0.1:${httpsPort}`);
    assert.notEqual(httpsPort, httpPort);

    assert.equal((await secure(httpsPort, `127.0.0.1:${httpsPort}`, authority.cert)).status, 200);
    assert.equal((await secure(httpsPort, `hub.example:${httpsPort}`, authority.cert)).status, 200);
    assert.equal((await plain(httpPort, `127.0.0.1:${httpPort}`)).status, 200, 'plain HTTP on loopback keeps working');
    assert.equal((await plain(httpPort, `127.0.0.1:${httpsPort}`)).status, 403, 'an HTTPS authority over plain HTTP is refused');
    assert.equal((await secure(httpsPort, `127.0.0.1:${httpPort}`, authority.cert)).status, 403, 'a plain HTTP authority over TLS is refused');
    assert.equal((await secure(httpsPort, `attacker.example:${httpsPort}`, authority.cert, '/healthz', {}, 'GET', 'hub.example')).status, 403, 'a foreign Host inside a valid TLS session is refused');

    const login = await secure(httpsPort, `127.0.0.1:${httpsPort}`, authority.cert, '/console/login');
    assert.equal(login.status, 200);
    assert.ok(login.cookies.some((cookie) => cookie.startsWith('__Secure-circle_hub_login=') && /; Secure/.test(cookie)), 'a console reached over TLS gets Secure cookies');
    const direct = await plain(httpPort, `127.0.0.1:${httpPort}`, '/console/login');
    assert.ok(direct.cookies.some((cookie) => cookie.startsWith('circle_hub_login=') && !/; Secure/.test(cookie)));

    const mcp = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    assert.equal((await secure(httpsPort, `hub.example:${httpsPort}`, authority.cert, '/mcp', { ...mcp, origin: `https://hub.example:${httpsPort}` }, 'POST')).status, 401, 'its own HTTPS origin passes to authentication');
    assert.equal((await secure(httpsPort, `hub.example:${httpsPort}`, authority.cert, '/mcp', { ...mcp, origin: `https://evil.example:${httpsPort}` }, 'POST')).status, 403);
  } finally {
    await app.close();
  }
});

test('the app refuses HTTPS without a certificate, beside a proxy, or on a non-loopback address without allowed hosts', () => {
  const config = (extra: Record<string, unknown>) => ({ config: { host: '127.0.0.1', port: 0, limits: { maxRequestBytes: 1024 }, ...extra } }) as unknown as ServerDeps;
  const authority = createAuthority();
  const tls = issueServerCertificate(authority, []);
  assert.throws(() => createApp(config({ https: { host: '127.0.0.1', port: 0 } })), /没有给证书和私钥/);
  assert.throws(() => createApp(config({ https: { host: '192.0.2.10', port: 0 } }), { tls }), /内置 HTTPS 的监听地址无效/);
  assert.throws(() => createApp(config({ allowedHosts: ['hub.example'], proxyOrigin: 'https://hub.example', proxyPeer: '127.0.0.1', https: { host: '127.0.0.1', port: 0 } }), { tls }), /内置 HTTPS/);
});
