import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { createApp } from './app.ts';
import type { ServerDeps } from './api.ts';

interface Reply { status: number; cookies: string[]; body: string }
const token = 't'.repeat(43);
const csrf = (reply: Reply) => /name="csrf" value="([^"]+)"/.exec(reply.body)?.[1] ?? '';
const namedCookie = (reply: Reply, name: string) => reply.cookies.find(value => value.startsWith(`${name}=`)) ?? '';
const valueOf = (value: string) => value.split(';')[0]!.split('=').slice(1).join('=');

test('trusted proxy cookies are Secure and HTTPS and HTTP sessions cannot be replayed across channels', async () => {
  const deps = {
    config: { host: '127.0.0.1', port: 0, allowedHosts: ['hub.example'], proxyOrigin: 'https://hub.example', proxyPeer: '127.0.0.1', limits: { maxRequestBytes: 1024 } },
    records: { principals: { authenticate: async (value: string | null) => value === `Bearer ${token}` ? { id: 'synthetic-user', name: 'synthetic', role: 'user' } : null } },
    runs: { listRuns: async () => ({ items: [], next: null }) }, knowledge: {},
  } as unknown as ServerDeps;
  const app = createApp(deps, { log: () => {} });
  const { port } = await app.listen();
  const send = (path: string, host: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: { host, ...headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode ?? 0, cookies: res.headers['set-cookie'] ?? [], body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject); req.end(body);
  });
  const form = (nonce: string) => new URLSearchParams({ csrf: nonce, token }).toString();
  const headers = (origin: string, cookie: string) => ({ origin, cookie, 'content-type': 'application/x-www-form-urlencoded' });
  const secureHost = 'hub.example';
  const plainHost = `hub.example:${port}`;
  try {
    const securePage = await send('/console/login', secureHost);
    const secureLogin = namedCookie(securePage, '__Secure-circle_hub_login');
    assert.match(secureLogin, /; Secure$/);
    const secureNonce = csrf(securePage); assert.ok(secureNonce);
    const crossNonce = await send('/console/login', plainHost, headers(`http://${plainHost}`, `circle_hub_login=${secureNonce}`), form(secureNonce));
    assert.equal(crossNonce.status, 403, 'renaming an HTTPS nonce cannot authorize an HTTP login');
    const secureLoginReply = await send('/console/login', secureHost, headers('https://hub.example', `__Secure-circle_hub_login=${secureNonce}`), form(secureNonce));
    assert.equal(secureLoginReply.status, 303);
    const secureSession = namedCookie(secureLoginReply, '__Secure-circle_hub_session');
    assert.match(secureSession, /; Secure$/);
    assert.match(namedCookie(secureLoginReply, '__Secure-circle_hub_login'), /Max-Age=0; Secure$/);
    const secureId = valueOf(secureSession); assert.ok(secureId);
    const securePageWithSession = await send('/console/runs', secureHost, { cookie: `__Secure-circle_hub_session=${secureId}` });
    assert.equal(securePageWithSession.status, 200);
    assert.equal((await send('/console/runs', plainHost, { cookie: `__Secure-circle_hub_session=${secureId}` })).status, 303);
    assert.equal((await send('/console/runs', plainHost, { cookie: `circle_hub_session=${secureId}` })).status, 303, 'renaming a Secure cookie cannot replay its HTTPS session over HTTP');

    const spoofed = await send('/console/login', plainHost, {
      forwarded: 'proto=https;host=hub.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': secureHost,
    });
    assert.ok(namedCookie(spoofed, 'circle_hub_login'));
    assert.equal(namedCookie(spoofed, '__Secure-circle_hub_login'), '', 'forwarded headers cannot select the HTTPS channel');
    assert.doesNotMatch(namedCookie(spoofed, 'circle_hub_login'), /; Secure/);

    const plainPage = await send('/console/login', plainHost);
    const plainLogin = namedCookie(plainPage, 'circle_hub_login');
    assert.ok(plainLogin); assert.doesNotMatch(plainLogin, /; Secure/);
    const plainNonce = csrf(plainPage);
    const crossPlainNonce = await send('/console/login', secureHost, headers('https://hub.example', `__Secure-circle_hub_login=${plainNonce}`), form(plainNonce));
    assert.equal(crossPlainNonce.status, 403, 'renaming an HTTP nonce cannot authorize an HTTPS login');
    const plainLoginReply = await send('/console/login', plainHost, headers(`http://${plainHost}`, `circle_hub_login=${plainNonce}`), form(plainNonce));
    assert.equal(plainLoginReply.status, 303);
    const plainSession = namedCookie(plainLoginReply, 'circle_hub_session');
    assert.ok(plainSession); assert.doesNotMatch(plainSession, /; Secure/);
    const plainId = valueOf(plainSession);
    assert.equal((await send('/console/runs', plainHost, { cookie: `circle_hub_session=${plainId}` })).status, 200);
    assert.equal((await send('/console/runs', secureHost, { cookie: `__Secure-circle_hub_session=${plainId}` })).status, 303, 'renaming an HTTP cookie cannot upgrade its session');

    const logout = await send('/console/logout', secureHost, headers('https://hub.example', `__Secure-circle_hub_session=${secureId}`), new URLSearchParams({ csrf: csrf(securePageWithSession) }).toString());
    assert.equal(logout.status, 303);
    assert.match(namedCookie(logout, '__Secure-circle_hub_session'), /Max-Age=0; Secure$/);
    assert.equal((await send('/console/runs', secureHost, { cookie: `__Secure-circle_hub_session=${secureId}` })).status, 303);
    const plainAuthenticated = await send('/console/runs', plainHost, { cookie: `circle_hub_session=${plainId}` });
    assert.equal(plainAuthenticated.status, 200, 'HTTPS logout leaves the separate HTTP session intact');
    const plainLogout = await send('/console/logout', plainHost, headers(`http://${plainHost}`, `circle_hub_session=${plainId}`), new URLSearchParams({ csrf: csrf(plainAuthenticated) }).toString());
    assert.equal(plainLogout.status, 303);
    assert.match(namedCookie(plainLogout, 'circle_hub_session'), /Max-Age=0$/);
    assert.doesNotMatch(namedCookie(plainLogout, 'circle_hub_session'), /; Secure/);
    assert.equal((await send('/console/runs', plainHost, { cookie: `circle_hub_session=${plainId}` })).status, 303);

  } finally { await app.close(); }
});
