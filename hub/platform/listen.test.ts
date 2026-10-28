import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { checkHealth, portAnswers, portOccupied } from './health.ts';
import { layoutAt } from './layout.ts';
import { serviceEnvironment } from './launchd.ts';
import { newSettingsFile, parseSettingsText, resolveSettings } from './settings.ts';

test('deployment settings persist and pin the explicit listener and allowed authorities', () => {
  const file = newSettingsFile({ environment: 'shared', port: 8000, listenHost: '192.0.2.10', allowedHosts: ['hub.example', '192.0.2.10'], proxyOrigin: 'https://hub.example' });
  assert.deepEqual(parseSettingsText(JSON.stringify(file), 'synthetic'), file);
  const settings = resolveSettings(file, {});
  assert.equal(settings.listenHost, '192.0.2.10');
  assert.deepEqual(settings.allowedHosts, ['hub.example', '192.0.2.10']);
  const env = serviceEnvironment(layoutAt('/srv/synthetic'), settings, { home: '/srv/synthetic', user: 'synthetic', database: settings.database });
  assert.equal(env.CIRCLE_HUB_HOST, '192.0.2.10');
  assert.equal(env.CIRCLE_HUB_ALLOWED_HOSTS, 'hub.example,192.0.2.10');
  assert.equal(env.CIRCLE_HUB_PROXY_ORIGIN, 'https://hub.example');
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_HOST: '192.0.2.11' }), /不一致/);
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_ALLOWED_HOSTS: 'evil.example' }), /不一致/);
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_PROXY_ORIGIN: 'https://evil.example' }), /不一致/);
  assert.throws(() => newSettingsFile({ environment: 'shared', listenHost: '192.0.2.10' }), /allowed_hosts/);
  assert.throws(() => newSettingsFile({ environment: 'shared', listenHost: '0.0.0.0', allowedHosts: ['hub.example'] }), /listen_host/);
  const old = newSettingsFile({ environment: 'test' });
  assert.equal(resolveSettings(old, {}).listenHost, undefined);
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
