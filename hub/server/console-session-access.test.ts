// Console-session cookie vs access-only entries (Boss 19:27 / 19:30): cookie holds the console token; MCP / run-export /
// local-tools refuse that credential with「无权限」; an access token cannot enter the console as a cookie.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONSOLE_SESSION_REFUSED } from './access-auth.ts';
import { createTestHub } from './testing-real.ts';
import { testConsoleCredentials } from './testing.ts';
import { openConsole, requestHttp } from '../../tests/acceptance/support/console.ts';

const options = { repositoryPacks: false, stubs: false, mindmapSkill: false, workbookSkill: false, xmlSkill: false, htmlSkill: false };

test('console-session Bearer is refused on MCP, run-export and local-tools; access token cannot be a console cookie', async (t) => {
  const hub = await createTestHub(options);
  t.after(() => hub.close());
  const member = await hub.createUser('合成会话边界');
  const api = hub.records.principals;
  const password = await api.verifyPassword(member.user.name, testConsoleCredentials(member.token).password);
  assert.ok(password);
  const session = await api.openConsoleSession(member.user.id, password.revision);
  assert.ok(session);

  assert.equal((await api.authenticateConsoleSession!(`Bearer ${session.token}`))?.id, member.user.id);
  assert.equal(await api.authenticateConsoleSession!(`Bearer ${member.token}`), null, 'access token is not a console session');
  assert.ok(await api.authenticate(`Bearer ${session.token}`), 'authenticate() still accepts console sessions for CLI');
  assert.equal(await api.authenticateAccessToken!(`Bearer ${session.token}`), null);

  const mcp = await requestHttp(hub.port, '/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '0' } } }),
  });
  assert.equal(mcp.status, 403);
  assert.match(mcp.body, /无权限：控制台登录凭证不能用于此入口/);

  const exported = await requestHttp(hub.port, '/run-export/run_00000000000000000000000001', {
    method: 'GET',
    headers: { authorization: `Bearer ${session.token}` },
  });
  assert.equal(exported.status, 403);
  assert.equal(exported.body, CONSOLE_SESSION_REFUSED + '\n');

  const tools = await requestHttp(hub.port, '/local-tools/synthetic@1.0.0', {
    method: 'GET',
    headers: { authorization: `Bearer ${session.token}` },
  });
  assert.equal(tools.status, 403);
  assert.equal(tools.body, CONSOLE_SESSION_REFUSED + '\n');

  const browser = await openConsole(hub, member.token);
  assert.equal((await browser.get('/console/me')).status, 200);
  const spoofed = await requestHttp(hub.port, '/console/me', {
    method: 'GET',
    headers: { cookie: `circle_hub_session=${member.token}` },
  });
  assert.equal(spoofed.status, 303);
  assert.match(String(spoofed.headers.location ?? ''), /\/console\/login/);
});

test('logout revokes the console-session token at once', async (t) => {
  const hub = await createTestHub(options);
  t.after(() => hub.close());
  const member = await hub.createUser('合成登出吊销');
  const browser = await openConsole(hub, member.token);
  const page = await browser.get('/console/me');
  assert.equal(page.status, 200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1];
  assert.ok(csrf);
  const token = browser.sessionCookie!;
  assert.ok(await hub.records.principals.authenticateConsoleSession!(`Bearer ${token}`));
  const out = await browser.post('/console/logout', { csrf });
  assert.equal(out.status, 303);
  assert.equal(await hub.records.principals.authenticateConsoleSession!(`Bearer ${token}`), null);
  assert.equal((await browser.get('/console/me')).status, 303);
});
