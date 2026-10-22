// Scenario 12 (brief section 9): Console and API: a wrong Host or Origin is refused;
// a request without a token is refused.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../hub/testing/postgres.ts';
import { openConsole, requestHttp, type ConsoleClient } from './support/console.ts';
import { openBed, type Bed } from './support/hub.ts';

let postgres: TemporaryPostgres;
let bed: Bed;
let consoleClient: ConsoleClient;

before(async () => {
  postgres = await startPostgres();
  bed = await openBed({ postgres });
  consoleClient = await openConsole(bed.hub);
});
after(async () => {
  await bed?.close();
  await postgres?.stop();
});

describe('scenario 12: console and API host, origin, and token security', () => {
  test('a request with a wrong Host header is refused with 403', async () => {
    // 1. Wrong Host on /mcp
    const mcpRes = await requestHttp(bed.hub.port, '/mcp', {
      method: 'POST',
      headers: { host: 'evil.attacker.com', authorization: `Bearer ${bed.reviewer.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(mcpRes.status, 403, 'wrong host on /mcp returns 403');

    // 2. Wrong Host on /console/login
    const consoleRes = await requestHttp(bed.hub.port, '/console/login', {
      method: 'GET',
      headers: { host: 'evil.attacker.com' },
    });
    assert.equal(consoleRes.status, 403, 'wrong host on /console returns 403');
  });

  test('a console POST with a wrong Origin is refused with 403', async () => {
    // Attempt login from foreign origin
    const foreignRes = await requestHttp(bed.hub.port, '/console/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://attacker-site.com',
        referer: 'http://attacker-site.com/evil',
      },
      body: new URLSearchParams({ token: bed.reviewer.token, csrf: 'any' }).toString(),
    });
    assert.equal(foreignRes.status, 403, 'foreign origin on /console/login POST returns 403');
  });

  test('a request without a token is refused (401 on /mcp, redirect on /console)', async () => {
    // 1. /mcp without Authorization header -> 401 with WWW-Authenticate
    const unauthMcp = await requestHttp(bed.hub.port, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(unauthMcp.status, 401);
    const authHeader = unauthMcp.headers['www-authenticate'];
    assert.ok(authHeader && String(authHeader).includes('Bearer realm="circle-hub"'));

    // 2. /console/runs without session cookie -> redirects to /console/login
    const unauthConsole = await requestHttp(bed.hub.port, '/console/runs');
    assert.ok(unauthConsole.status === 303 || unauthConsole.status === 401);
    if (unauthConsole.status === 303) {
      assert.equal(unauthConsole.headers.location, '/console/login');
    }

    // 3. Security headers: Content-Security-Policy on console pages
    const loginPage = await requestHttp(bed.hub.port, '/console/login');
    assert.equal(loginPage.status, 200);
    const csp = loginPage.headers['content-security-policy'];
    assert.ok(csp && String(csp).includes("default-src 'none'"));
  });
});
