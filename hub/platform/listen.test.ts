import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { checkHealth, linuxPortOccupied, portAnswers, portOccupied } from './health.ts';
import { layoutAt } from './layout.ts';
import { serviceEnvironment } from './launchd.ts';
import { newSettingsFile, parseSettingsText, resolveSettings } from './settings.ts';

test('deployment settings persist and pin the explicit listener and allowed authorities', () => {
  const file = newSettingsFile({ environment: 'shared', port: 8000, listenHost: '192.0.2.10', allowedHosts: ['hub.example', '192.0.2.10'], proxyOrigin: 'https://hub.example', proxyPeer: '192.0.2.11' });
  assert.deepEqual(parseSettingsText(JSON.stringify(file), 'synthetic'), file);
  const settings = resolveSettings(file, {});
  assert.equal(settings.listenHost, '192.0.2.10');
  assert.deepEqual(settings.allowedHosts, ['hub.example', '192.0.2.10']);
  const env = serviceEnvironment(layoutAt('/srv/synthetic'), settings, { home: '/srv/synthetic', user: 'synthetic', database: settings.database });
  assert.equal(env.CIRCLE_HUB_HOST, '192.0.2.10');
  assert.equal(env.CIRCLE_HUB_ALLOWED_HOSTS, 'hub.example,192.0.2.10');
  assert.equal(env.CIRCLE_HUB_PROXY_ORIGIN, 'https://hub.example');
  assert.equal(env.CIRCLE_HUB_PROXY_PEER, '192.0.2.11');
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_HOST: '192.0.2.11' }), /不一致/);
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_ALLOWED_HOSTS: 'evil.example' }), /不一致/);
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_PROXY_ORIGIN: 'https://evil.example' }), /不一致/);
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_PROXY_PEER: '192.0.2.12' }), /不一致/);
  assert.throws(() => newSettingsFile({ environment: 'shared', listenHost: '192.0.2.10' }), /allowed_hosts/);
  assert.throws(() => newSettingsFile({ environment: 'shared', listenHost: '0.0.0.0', allowedHosts: ['hub.example'] }), /listen_host/);
  const old = newSettingsFile({ environment: 'test' });
  assert.equal(resolveSettings(old, {}).listenHost, undefined);
});

test('Linux listener inventory accepts the distinct real IPv4 and IPv6 kernel headers', async () => {
  const ipv4 = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
  const ipv6 = '  sl  local_address remote_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n';
  const table = (path: string) => path.endsWith('tcp6') ? ipv6 : ipv4;
  assert.equal(await linuxPortOccupied(8000, async path => table(path)), false, 'empty IPv4 and IPv6 inventories are idle');
  assert.equal(await linuxPortOccupied(8000, async path => path.endsWith('tcp6')
    ? `${ipv6}0: 00000000000000000000000001000000:1F40 00000000000000000000000000000000:0000 0A\n`
    : ipv4), true, 'an IPv6 listener still blocks the port');
  assert.equal(await linuxPortOccupied(8000, async path => path.endsWith('tcp6') ? ipv6.replace('remote_address', 'unknown_address') : ipv4), true);
});

test('Linux listener inventory fails closed when either table is missing or malformed', async () => {
  const header = '  sl  local_address rem_address   st\n';
  const inventory = (path: string) => path.endsWith('tcp6') ? header.replace('rem_address', 'remote_address') : header;
  assert.equal(await linuxPortOccupied(8000, async path => inventory(path)), false);
  assert.equal(await linuxPortOccupied(8000, async path => path.endsWith('tcp6') ? inventory(path) : `${header}0: 0100007F:1F40 00000000:0000 0A\n`), true);
  assert.equal(await linuxPortOccupied(8000, async () => 'corrupt'), true);
  assert.equal(await linuxPortOccupied(8000, async () => 'local_address\n'), true);
  assert.equal(await linuxPortOccupied(8000, async () => `${header}broken line\n`), true);
  assert.equal(await linuxPortOccupied(8000, async path => { if (path.endsWith('tcp6')) throw new Error('unavailable'); return header; }), true);
});

test('health and port checks connect to the configured literal and use the declared Host', async () => {
  let authority: string | undefined;
  const server = createServer((req, res) => { authority = req.headers.host; res.end('{}'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal((await checkHealth(port, { host: '127.0.0.1', authority: 'hub.example' })).ok, true);
    assert.equal(authority, `hub.example:${port}`);
    assert.equal(await portAnswers(port, 1000, '127.0.0.1'), true);
    assert.equal(await portOccupied(port), true, 'an old listener on a different interface still prevents restore');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
