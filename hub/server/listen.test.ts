import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { loadConfig, HubConfigError } from '../config/index.ts';
import { createApp } from './app.ts';
import { installLocalTools, localHubAddress, localToolsCommand } from './cli-local-tools.ts';
import { ensureLayout, layoutAt } from '../platform/layout.ts';
import { newSettingsFile, writeSettingsFile } from '../platform/settings.ts';
import { allowedHosts, originAllowed, ownOrigins } from './http.ts';
import type { ServerDeps } from './api.ts';

const BASE = { CIRCLE_HUB_DATA_DIR: '/srv/synthetic', CIRCLE_HUB_PORT: '8000', CIRCLE_HUB_DATABASE_SOCKET_DIR: '/srv/synthetic/run' };

test('local-tools accepts only a fixed deployment address and refuses conflicts before reading the token', async () => {
  const locked = { listenHost: '192.0.2.10', allowedHosts: ['hub.example'], port: 8000 };
  assert.equal(localHubAddress(undefined, {}, locked).href, 'http://192.0.2.10:8000/');
  for (const url of ['http://192.0.2.11:8000/', 'http://192.0.2.10:8001/', 'http://hub.example:8000/', 'http://127.0.0.1:8000/']) assert.throws(() => localHubAddress(url, {}, locked));
  assert.throws(() => localHubAddress('http://192.0.2.10:8000/', {}));
  const root = await mkdtemp(join(tmpdir(), 'listen-lock-'));
  try {
    const layout = layoutAt(root); await ensureLayout(layout);
    await writeSettingsFile(layout, newSettingsFile({ environment: 'shared', ...locked }));
    let read = false;
    const secret = new Readable({ read() { read = true; this.push('synthetic-token'); this.push(null); } });
    const env = { CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_HOST: '192.0.2.11', CIRCLE_HUB_PORT: '8000', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example' };
    const code = await localToolsCommand(['install', 'synthetic@1.0.0', '--digest', 'a'.repeat(64), '--into', root], { env, cwd: root, stdout: () => {}, stderr: () => {} }, { input: secret });
    assert.equal(code, 1); assert.equal(read, false);
    const noLock = new Readable({ read() { read = true; this.push('synthetic-token'); this.push(null); } });
    const codeWithoutLock = await localToolsCommand(['install', 'synthetic@1.0.0', '--digest', 'a'.repeat(64), '--into', root, '--hub', 'http://192.0.2.10:8000'], { env: {}, cwd: root, stdout: () => {}, stderr: () => {} }, { input: noLock });
    assert.equal(codeWithoutLock, 1); assert.equal(read, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('locked local-tools use the declared authority while connecting to the pinned literal', async () => {
  let authority = '';
  const server = createServer((req, res) => { authority = req.headers.host ?? ''; res.writeHead(401); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const root = await mkdtemp(join(tmpdir(), 'listen-target-'));
  try {
    await assert.rejects(installLocalTools('synthetic@1.0.0', 'a'.repeat(64), '/tmp/synthetic-hub-tools', new URL(`http://127.0.0.1:${port}`), 'synthetic-token', 'hub.example'));
    assert.equal(authority, `hub.example:${port}`);
    const layout = layoutAt(root); await ensureLayout(layout);
    await writeSettingsFile(layout, newSettingsFile({ environment: 'shared', listenHost: '127.0.0.1', allowedHosts: ['hub.example'], port }));
    authority = '';
    const code = await localToolsCommand(['install', 'synthetic@1.0.0', '--digest', 'a'.repeat(64), '--into', root], { env: { CIRCLE_HUB_DATA_DIR: root }, cwd: root, stdout: () => {}, stderr: () => {} }, { input: Readable.from(['synthetic-token']) });
    assert.equal(code, 1, 'the synthetic server refuses authentication');
    assert.equal(authority, `hub.example:${port}`, 'the locked endpoint was reached with its declared Host');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('non-loopback authorities do not implicitly admit localhost or an arbitrary origin', () => {
  const hosts = allowedHosts('192.0.2.10', 8000, ['hub.example']);
  assert.deepEqual([...hosts], ['hub.example:8000']);
  const origins = ownOrigins(hosts);
  assert.equal(originAllowed({ headers: { origin: 'http://localhost:8000' } } as never, origins), false);
  assert.equal(originAllowed({ headers: { origin: 'https://hub.example:8000' } } as never, origins), false);
  assert.equal(originAllowed({ headers: { origin: 'http://evil.example:8000' } } as never, origins), false);
});

test('an explicit non-loopback listener needs a closed authority list and cannot bind a wildcard or public address', () => {
  const config = loadConfig({ ...BASE, CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example,192.0.2.10' });
  assert.equal(config.host, '192.0.2.10');
  assert.deepEqual(config.allowedHosts, ['hub.example', '192.0.2.10']);
  for (const env of [
    { CIRCLE_HUB_HOST: '192.0.2.10' },
    { CIRCLE_HUB_HOST: '0.0.0.0', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example' },
    { CIRCLE_HUB_HOST: '::', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example' },
    { CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: '*.example' },
    { CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example,hub.example' },
    { CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example:8000' },
    { CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example', CIRCLE_HUB_PROXY_ORIGIN: 'https://hub.example:8000' },
    { CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example', CIRCLE_HUB_PROXY_ORIGIN: 'https://other.example' },
    { CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: '[2001:0db8:0:0:0:0:0:1]' },
    { CIRCLE_HUB_HOST: 'fe80::1%synthetic', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example' },
    { CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example', CIRCLE_HUB_PROXY_ORIGIN: 'https://hub.example' },
  ]) assert.throws(() => loadConfig({ ...BASE, ...env }), HubConfigError);
});

test('declared hosts and origins are exact and console POSTs must match the request host', async () => {
  const deps = { config: { host: '127.0.0.1', port: 0, allowedHosts: ['hub.example', 'other.example'], proxyOrigin: 'https://hub.example', proxyPeer: '127.0.0.1', limits: { maxRequestBytes: 1024 } }, records: { principals: { authenticate: async () => null } } } as unknown as ServerDeps;
  const app = createApp(deps);
  const { port } = await app.listen();
  const send = (host: string, origin?: string, method = 'GET', path = '/healthz') => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...(origin ? { origin } : {}), ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await send(`hub.example:${port}`, `http://hub.example:${port}`), 200);
    assert.equal(await send('hub.example', 'https://hub.example'), 200);
    assert.equal(await send('hub.example', 'http://hub.example'), 403);
    assert.equal(await send(`hub.example:${port}`, `https://hub.example:${port}`), 403);
    assert.equal(await send(`hub.example:${port}`, `http://hub.example:${port}`, 'POST', '/mcp'), 401);
    assert.equal(await send(`attacker.example:${port}`), 403);
    assert.equal(await send(`hub.example:${port}`, 'http://localhost:1'), 403);
    assert.equal(await send(`hub.example:${port}`, `http://other.example:${port}`, 'POST', '/console/login'), 403);
    assert.equal(await send('hub.example', `http://hub.example:${port}`, 'POST', '/console/login'), 403);
  } finally { await app.close(); }
});

test('a direct connection cannot forge the proxy Host and HTTPS Origin from an untrusted peer', async () => {
  const deps = { config: { host: '127.0.0.1', port: 0, allowedHosts: ['hub.example'], proxyOrigin: 'https://hub.example', proxyPeer: '127.0.0.2', limits: { maxRequestBytes: 1024 } } } as unknown as ServerDeps;
  const app = createApp(deps); const { port } = await app.listen();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/healthz', headers: { host: 'hub.example', origin: 'https://hub.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 403);
    const mixed = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/healthz', headers: { host: `hub.example:${port}`, origin: 'https://hub.example' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
    assert.equal(mixed, 403);
    const absolute = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: 'http://hub.example/healthz', headers: { host: `hub.example:${port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
    assert.equal(absolute, 403);
  } finally { await app.close(); }
});
