import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { loadConfig, HubConfigError } from '../config/index.ts';
import { createApp } from './app.ts';
import { installLocalTools, localHubAddress } from './cli-local-tools.ts';
import { allowedHosts, originAllowed, ownOrigins } from './http.ts';
import type { ServerDeps } from './api.ts';

const BASE = { CIRCLE_HUB_DATA_DIR: '/srv/synthetic', CIRCLE_HUB_PORT: '8000', CIRCLE_HUB_DATABASE_SOCKET_DIR: '/srv/synthetic/run' };

test('non-loopback authorities do not implicitly admit localhost or an arbitrary origin', () => {
  const hosts = allowedHosts('192.0.2.10', 8000, ['hub.example']);
  assert.deepEqual([...hosts], ['hub.example:8000']);
  const origins = ownOrigins(hosts, true);
  assert.equal(originAllowed({ headers: { origin: 'http://localhost:8000' } } as never, origins), false);
  assert.equal(originAllowed({ headers: { origin: 'https://hub.example:8000' } } as never, origins), true);
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
  ]) assert.throws(() => loadConfig({ ...BASE, ...env }), HubConfigError);
});

test('local-tools sends credentials only to the explicitly configured literal and port', () => {
  const env = { CIRCLE_HUB_HOST: '192.0.2.10', CIRCLE_HUB_PORT: '8000', CIRCLE_HUB_ALLOWED_HOSTS: 'hub.example' };
  assert.equal(localHubAddress(undefined, env).href, 'http://192.0.2.10:8000/');
  assert.equal(localHubAddress('http://192.0.2.10:8000/', env).hostname, '192.0.2.10');
  for (const url of ['http://192.0.2.11:8000/', 'http://192.0.2.10:8001/', 'http://hub.example:8000/', 'http://user:pass@192.0.2.10:8000/']) assert.throws(() => localHubAddress(url, env));
  assert.throws(() => localHubAddress('http://192.0.2.10:8000/', { ...env, CIRCLE_HUB_ALLOWED_HOSTS: '*' }));
});

test('local-tools requests the declared authority while connecting to a literal address', async () => {
  let authority = '';
  const server = createServer((req, res) => { authority = req.headers.host ?? ''; res.writeHead(401); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(installLocalTools('synthetic@1.0.0', 'a'.repeat(64), '/tmp/synthetic-hub-tools', new URL(`http://127.0.0.1:${port}`), 'synthetic-token', 'hub.example'));
    assert.equal(authority, `hub.example:${port}`);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('declared hosts and origins are exact and console POSTs must match the request host', async () => {
  const deps = { config: { host: '127.0.0.1', port: 0, allowedHosts: ['hub.example', 'other.example'], limits: { maxRequestBytes: 1024 } }, records: { principals: { authenticate: async () => null } } } as unknown as ServerDeps;
  const app = createApp(deps);
  const { port } = await app.listen();
  const send = (host: string, origin?: string, method = 'GET', path = '/healthz') => new Promise<number>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...(origin ? { origin } : {}), ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal(await send(`hub.example:${port}`, `http://hub.example:${port}`), 200);
    assert.equal(await send(`hub.example:${port}`, `http://hub.example:${port}`, 'POST', '/mcp'), 401);
    assert.equal(await send(`attacker.example:${port}`), 403);
    assert.equal(await send(`hub.example:${port}`, 'http://localhost:1'), 403);
    assert.equal(await send(`hub.example:${port}`, `http://other.example:${port}`, 'POST', '/console/login'), 403);
  } finally { await app.close(); }
});
