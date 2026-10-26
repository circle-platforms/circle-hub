// HttpSource against loopback stubs: refusals before any I/O (allow-list, origin, plaintext), redirects never followed, byte
// caps never truncated, timeouts, concurrency and interval limits, the typed mapping of 401 and envelope codes, the login
// exchange, header values redacted from every error and log event, and the injectable fetch.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { SystemProfile, type RouteDeclaration } from '../../contracts/src/resources.ts';
import { ConnectorError } from './errors.ts';
import { HttpSource, decodeText, expiryOf, type ConnectorLogEvent, type HttpExchange } from './http.ts';
import { Redactor } from './redact.ts';
import { json, startStub, text, type StubHandler, type StubServer } from './testing/stub.ts';
import { plmSystem } from './testing/packs.ts';

const servers: StubServer[] = [];
after(async () => {
  for (const server of servers) await server.close();
});

async function stub(handler: StubHandler): Promise<StubServer> {
  const server = await startStub(handler);
  servers.push(server);
  return server;
}

const profile = SystemProfile.parse(plmSystem());
const SECRET = ["tok-7f","3c9a1e","5b2d4c","6a8e0f"].join('');

function source(server: StubServer, options: { allowPlaintext?: boolean; routes?: RouteDeclaration[]; limits?: Record<string, number>; log?: ConnectorLogEvent[]; redactor?: Redactor } = {}): HttpSource {
  return new HttpSource({
    resource: 'res_01jacd5z8q3w7v9h2k4m6n8p0t',
    origins: { 'plm-api': server.origin, 'plm-oauth': server.origin },
    allowPlaintext: options.allowPlaintext === false ? [] : [server.origin],
    routes: options.routes ?? profile.routes,
    envelope: profile.envelope,
    limits: options.limits,
    log: options.log ? (event) => void options.log!.push(event) : undefined,
    redactor: options.redactor,
  });
}

async function refusal(promise: Promise<unknown>, code: string): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ConnectorError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const credential = { name: 'Authorization', value: SECRET };

test('a write route under the read prefix is refused before any I/O, a listed POST read is sent', async () => {
  const server = await stub(() => json({ code: 1000, msg: '', data: [] }));
  const http = source(server);
  await refusal(http.request({ method: 'POST', path: '/plmquery/testtask/edit/', body: { id: 1 }, credential }), 'ROUTE_REFUSED');
  await refusal(http.request({ method: 'POST', path: '/plmquery/bug/detail/', body: { bug_ids: [1], status: 'closed' }, credential }), 'ROUTE_REFUSED');
  assert.equal(server.requests.length, 0, 'nothing reached the server');
  const reply = await http.request({ method: 'POST', path: '/plmquery/bug/detail/', body: { bug_ids: [4242] }, credential });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.json, { code: 1000, msg: '', data: [] });
  assert.equal(server.requests.length, 1);
  assert.equal(server.requests[0].method, 'POST');
  assert.equal(server.requests[0].path, '/plmquery/bug/detail/');
  assert.deepEqual(server.requests[0].json, { bug_ids: [4242] });
  assert.equal(server.requests[0].headers.authorization, SECRET);
  assert.equal(server.requests[0].headers['content-type'], 'application/json');
});

test('credentials never go over plain HTTP unless the origin is declared allow_plaintext', async () => {
  const server = await stub(() => json({ code: 1000, msg: '', data: [] }));
  const strict = source(server, { allowPlaintext: false });
  const error = await refusal(strict.request({ method: 'GET', path: '/plmquery/product/all/', credential }), 'PLAINTEXT_REFUSED');
  assert.ok(!error.message.includes(SECRET) && !error.message.includes(server.origin));
  await refusal(strict.login(profile.auth.kind === 'login_token' ? profile.auth.login : (null as never), { username: 'u', password: SECRET }), 'PLAINTEXT_REFUSED');
  assert.equal(server.requests.length, 0);
  // Without a credential plain HTTP is fine (an anonymous site).
  const reply = await strict.request({ method: 'GET', path: '/plmquery/product/all/' });
  assert.equal(reply.status, 200);
  assert.equal(server.requests[0].headers.authorization, undefined);
});

test('redirects are refused, never followed; the answer is handed over before it is interpreted', async () => {
  const server = await stub((request) => (request.path === '/plmquery/product/all/' ? { status: 302, headers: { location: 'http://192.0.2.50/elsewhere' }, body: 'moved' } : json({})));
  const seen: HttpExchange[] = [];
  const error = await refusal(source(server).request({ method: 'GET', path: '/plmquery/product/all/' }, { received: async (exchange) => void seen.push(exchange) }), 'SOURCE_REDIRECT_REFUSED');
  assert.equal(error.layer, 'transport');
  assert.equal(server.requests.length, 1, 'the redirect was not followed');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 302);
  assert.equal(Buffer.from(seen[0].bytes).toString(), 'moved');
});

test('byte caps: a declared or streamed answer over the cap is an error, never truncated', async () => {
  const small: RouteDeclaration = { id: 'small', role: 'plm-api', method: 'GET', path: '/big/{how}', response: 'text', max_bytes: 1000, read: true };
  const server = await stub((request) =>
    request.path === '/big/declared'
      ? text('x'.repeat(5000), 'text/plain')
      : request.path === '/big/streamed'
        ? { status: 200, headers: { 'content-type': 'text/plain' }, chunks: Array.from({ length: 10 }, () => 'y'.repeat(300)), chunkDelayMs: 5 }
        : text('fits', 'text/plain'),
  );
  const http = source(server, { routes: [small] });
  let handed = 0;
  const hooks = { received: async () => void (handed += 1) };
  const declared = await refusal(http.request({ method: 'GET', path: '/big/declared' }, hooks), 'RESPONSE_TOO_LARGE');
  assert.equal(declared.detail.limit, 1000);
  await refusal(http.request({ method: 'GET', path: '/big/streamed' }, hooks), 'RESPONSE_TOO_LARGE');
  assert.equal(handed, 0, 'nothing over the cap is handed over for storing');
  const ok = await http.request({ method: 'GET', path: '/big/fine' }, hooks);
  assert.equal(ok.text, 'fits');
  assert.equal(handed, 1);
});

test('timeouts: a slow answer or a slow body is SOURCE_TIMEOUT', async () => {
  const route: RouteDeclaration = { id: 'slow', role: 'plm-api', method: 'GET', path: '/slow/{how}', response: 'text', max_bytes: 100_000, timeout_ms: 200, read: true };
  const server = await stub((request) =>
    request.path === '/slow/head' ? { ...text('late', 'text/plain'), delayMs: 1000 } : { status: 200, headers: { 'content-type': 'text/plain' }, chunks: ['a', 'b', 'c', 'd'], chunkDelayMs: 150 },
  );
  const http = source(server, { routes: [route] });
  const started = Date.now();
  await refusal(http.request({ method: 'GET', path: '/slow/head' }), 'SOURCE_TIMEOUT');
  await refusal(http.request({ method: 'GET', path: '/slow/body' }), 'SOURCE_TIMEOUT');
  assert.ok(Date.now() - started < 1500, 'each request stops at its timeout');
});

test('concurrency and interval limits', async () => {
  const route: RouteDeclaration = { id: 'item', role: 'plm-api', method: 'GET', path: '/item/{n}', response: 'text', max_bytes: 1000, read: true };
  const server = await stub(() => ({ ...text('ok', 'text/plain'), delayMs: 60 }));
  const http = source(server, { routes: [route], limits: { concurrency: 2 } });
  await Promise.all(Array.from({ length: 8 }, (_, i) => http.request({ method: 'GET', path: `/item/${i}` })));
  assert.equal(server.requests.length, 8);
  assert.ok(server.maxInFlight <= 2, `in flight at once: ${server.maxInFlight}`);
  assert.equal(server.maxInFlight, 2);

  const spaced = await stub(() => text('ok', 'text/plain'));
  const slow = source(spaced, { routes: [route], limits: { concurrency: 4, interval_ms: 80 } });
  await Promise.all(Array.from({ length: 4 }, (_, i) => slow.request({ method: 'GET', path: `/item/${i}` })));
  const starts = spaced.requests.map((r) => r.at).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 60, `gap ${starts[i] - starts[i - 1]} ms`);
});

test('401 and envelope codes are typed; other statuses and malformed answers too', async () => {
  const server = await stub((request) => {
    switch (request.query.case) {
      case '401':
        return { ...json({ error: 'unauthorized' }), status: 401 };
      case 'expired':
        return json({ code: 1001, msg: '登录已过期', data: null });
      case 'error':
        return json({ code: 2002, msg: `内部错误，令牌 ${request.headers.authorization}`, data: null });
      case 'notjson':
        return text('<html>login</html>', 'text/html');
      case '404':
        return { ...json({}), status: 404 };
      case '403':
        return { ...json({}), status: 403 };
      default:
        return { ...json({}), status: 503 };
    }
  });
  const route: RouteDeclaration = {
    id: 'probe',
    role: 'plm-api',
    method: 'GET',
    path: '/probe/',
    query: { type: 'object', properties: { case: { type: 'string', maxLength: 10 } }, additionalProperties: false },
    response: 'json',
    envelope: true,
    max_bytes: 10_000,
    read: true,
  };
  const log: ConnectorLogEvent[] = [];
  const redactor = new Redactor();
  const http = source(server, { routes: [route], log, redactor });
  const probe = (value: string) => http.request({ method: 'GET', path: '/probe/', query: { case: value }, credential });
  assert.equal((await refusal(probe('401'), 'SOURCE_LOGIN_EXPIRED')).layer, 'transport');
  assert.equal((await refusal(probe('expired'), 'SOURCE_LOGIN_EXPIRED')).layer, 'envelope');
  const envelope = await refusal(probe('error'), 'SOURCE_ENVELOPE_ERROR');
  assert.match(envelope.message, /2002/);
  assert.ok(!envelope.message.includes(SECRET), 'a header value echoed by the source is masked');
  assert.match(envelope.message, /\*\*\*/);
  assert.equal((await refusal(probe('notjson'), 'SOURCE_MALFORMED')).layer, 'plugin');
  await refusal(probe('404'), 'SOURCE_ABSENT');
  await refusal(probe('403'), 'SOURCE_FORBIDDEN');
  await refusal(probe('503'), 'SOURCE_HTTP_STATUS');
  const logged = JSON.stringify(log);
  assert.ok(log.length >= 7);
  assert.ok(!logged.includes(SECRET), 'no header value in any log event');
  assert.ok(!logged.includes(server.origin), 'no host in any log event');
});

test('the login exchange: token and expiry on success; the code only on a refusal; never the password', async () => {
  const login = profile.auth.kind === 'login_token' ? profile.auth.login : assert.fail('login profile');
  const server = await stub((request) => {
    const body = request.json as { username?: string; password?: string };
    if (body.password === 'right-digest') return json({ code: 1000, msg: 'ok', data: { token: SECRET, expire: 1_900_000_000 } });
    return json({ code: 1005, msg: `用户 ${body.username} 密码 ${body.password} 错误`, data: null });
  });
  const http = source(server);
  assert.deepEqual(await http.login(login, { username: 'reader', password: 'right-digest' }), { token: SECRET, expiresAt: 1_900_000_000_000 });
  const failed = await refusal(http.login(login, { username: 'reader', password: 'wrong-digest-value' }), 'LOGIN_FAILED');
  assert.match(failed.message, /1005/);
  assert.ok(!failed.message.includes('wrong-digest-value') && !failed.message.includes('reader'), 'nothing of the exchange but the code');
});

test('the URL is the role base plus the route path; links leaving the origin or base path are refused', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const http = new HttpSource({
    resource: 'res_01jacd5z8q3w7v9h2k4m6n8p0t',
    origins: { 'plm-api': 'https://192.0.2.10/base/path', 'plm-oauth': 'https://192.0.2.10' },
    allowPlaintext: [],
    routes: profile.routes,
    envelope: profile.envelope,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ code: 1000, data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  await http.request({ method: 'GET', path: '/plmquery/build/', query: { product: '28' }, credential: { name: 'Authorization', value: SECRET } });
  assert.equal(calls[0].url, 'https://192.0.2.10/base/path/plmquery/build/?product=28');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, SECRET);
  assert.deepEqual(http.resolveHref('plm-api', 'build/?product=7', null), { path: '/build/', query: { product: '7' } });
  assert.deepEqual(http.resolveHref('plm-api', '/base/path/plmquery/x/', null), { path: '/plmquery/x/', query: {} });
  assert.deepEqual(http.resolveHref('plm-api', 'y.html', 'https://192.0.2.10/base/path/dir/page.html'), { path: '/dir/y.html', query: {} });
  for (const href of ['https://192.0.2.99/base/path/x', 'http://192.0.2.10/base/path/x', '/other/x', '//192.0.2.99/x', ["https:","//u:p@","192.0.","2.10/b","ase/pa","th/x"].join('')]) {
    assert.throws(() => http.resolveHref('plm-api', href, null), (e: unknown) => e instanceof ConnectorError && e.code === 'ORIGIN_REFUSED', href);
  }
  assert.throws(() => http.resolveHref('nobody', 'x', null), /角色 nobody/);
});

test('text decoding follows the charset; expiry units', () => {
  assert.equal(decodeText(Buffer.from('Café', 'latin1'), 'text/html; charset=ISO-8859-1'), 'Café');
  assert.equal(decodeText(Buffer.from('﻿{"a":1}', 'utf8'), 'application/json'), '{"a":1}');
  assert.equal(decodeText(Buffer.from('中文', 'utf8'), 'text/plain; charset=unknown-x'), '中文');
  assert.equal(expiryOf(1_900_000_000, 'epoch_seconds'), 1_900_000_000_000);
  assert.equal(expiryOf('1900000000', 'epoch_seconds'), 1_900_000_000_000);
  assert.equal(expiryOf(5, 'epoch_millis'), 5);
  assert.equal(expiryOf('2026-10-22T00:00:00Z', 'iso8601'), Date.parse('2026-10-22T00:00:00Z'));
  assert.equal(expiryOf('soon', 'epoch_seconds'), null);
  assert.equal(expiryOf(-1, 'epoch_seconds'), null);
});

test('envelope modes: always, when present, an expired code on an undeclared route that carried the credential, and opted out', async () => {
  const server = await stub((request) => {
    switch (request.query.case) {
      case 'bare':
        return json([{ id: 1 }]);
      case 'ok':
        return json({ code: 1000, msg: '', data: [] });
      case 'expired':
        return json({ code: 1001, msg: '登录已过期', data: null });
      case 'error':
        return json({ code: 2002, msg: '内部错误', data: null });
      default:
        return json({ id: 7 });
    }
  });
  const route = (id: string, envelope?: boolean | 'when_present'): RouteDeclaration => ({
    id,
    role: 'plm-api',
    method: 'GET',
    path: `/${id}/`,
    query: { type: 'object', properties: { case: { type: 'string', maxLength: 10 } }, additionalProperties: false },
    response: 'json',
    max_bytes: 10_000,
    read: true,
    ...(envelope === undefined ? {} : { envelope }),
  });
  const http = source(server, { routes: [route('always', true), route('present', 'when_present'), route('undeclared'), route('optout', false)] });
  const ask = (id: string, value: string, withCredential = true) => http.request({ method: 'GET', path: `/${id}/`, query: { case: value }, credential: withCredential ? credential : null });
  await refusal(ask('always', 'bare'), 'SOURCE_ENVELOPE_ERROR');
  await refusal(ask('always', 'expired'), 'SOURCE_LOGIN_EXPIRED');
  assert.equal((await ask('always', 'ok')).status, 200);
  assert.deepEqual((await ask('present', 'bare')).json, [{ id: 1 }], 'a bare answer is accepted');
  assert.deepEqual((await ask('present', 'other')).json, { id: 7 }, 'an object without the code member is bare too');
  assert.equal((await ask('present', 'ok')).status, 200);
  await refusal(ask('present', 'expired'), 'SOURCE_LOGIN_EXPIRED');
  await refusal(ask('present', 'error'), 'SOURCE_ENVELOPE_ERROR');
  assert.deepEqual((await ask('undeclared', 'bare')).json, [{ id: 1 }]);
  assert.equal((await ask('undeclared', 'error')).status, 200, 'only the expired codes are looked at');
  await refusal(ask('undeclared', 'expired'), 'SOURCE_LOGIN_EXPIRED');
  assert.equal((await ask('undeclared', 'expired', false)).status, 200, 'an anonymous request is not judged by the login envelope');
  assert.equal((await ask('optout', 'expired')).status, 200, 'envelope: false opts out');
});

test('a request to the login exchange itself is refused before any I/O, whatever route would allow it', async () => {
  const server = await stub(() => json({ code: 1000, msg: '', data: { token: SECRET, expire: 1_900_000_000 } }));
  const login = profile.auth.kind === 'login_token' ? profile.auth.login : assert.fail('login profile');
  const sneaky: RouteDeclaration = {
    id: 'sneaky',
    role: 'plm-api',
    method: 'POST',
    path: '/oauth/login/',
    body: { type: 'object', properties: { username: { type: 'string', maxLength: 64 }, password: { type: 'string', maxLength: 200 } }, additionalProperties: false },
    response: 'json',
    max_bytes: 10_000,
    read: true,
  };
  const http = new HttpSource({
    resource: 'res_01jacd5z8q3w7v9h2k4m6n8p0t',
    origins: { 'plm-api': server.origin, 'plm-oauth': server.origin },
    allowPlaintext: [server.origin],
    routes: [sneaky],
    envelope: profile.envelope,
    login,
  });
  await refusal(http.request({ method: 'POST', path: '/oauth/login/', body: { username: 'u', password: 'p' } }), 'ROUTE_REFUSED');
  assert.throws(() => http.check({ method: 'POST', path: '/oauth/login/', body: { username: 'u', password: 'p' } }, false), (e: unknown) => e instanceof ConnectorError && e.code === 'ROUTE_REFUSED');
  assert.equal(server.requests.length, 0);
  assert.equal((await http.login(login, { username: 'u', password: 'p' })).token, SECRET, 'the login manager still logs in');
  assert.equal(server.requests.length, 1);
});

test('a failed login says whether the request reached the source: not delivered, answered, or unknown', async () => {
  const login = profile.auth.kind === 'login_token' ? profile.auth.login : assert.fail('login profile');
  const closed = await startStub(() => json({}));
  const gone = closed.origin;
  await closed.close();
  const unreachable = new HttpSource({ resource: 'res_01jacd5z8q3w7v9h2k4m6n8p0t', origins: { 'plm-api': gone, 'plm-oauth': gone }, allowPlaintext: [gone], routes: profile.routes, envelope: profile.envelope });
  assert.equal((await refusal(unreachable.login(login, { username: 'u', password: 'p' }), 'LOGIN_FAILED')).detail.delivered, false);
  const refusing = await stub(() => json({ code: 1005, msg: '密码错误', data: null }));
  assert.equal((await refusal(source(refusing).login(login, { username: 'u', password: 'p' }), 'LOGIN_FAILED')).detail.delivered, true);
  const silent = await stub(() => ({ ...json({}), delayMs: 1000 }));
  assert.equal((await refusal(source(silent).login({ ...login, timeout_ms: 200 }, { username: 'u', password: 'p' }), 'LOGIN_FAILED')).detail.delivered, null);
});

test('the sending hook of a login runs once it has its slot and before anything is sent; what it throws is not a login failure', async () => {
  const login = profile.auth.kind === 'login_token' ? profile.auth.login : assert.fail('login profile');
  const server = await stub(() => json({ code: 1000, msg: 'ok', data: { token: SECRET, expire: 1_900_000_000 } }));
  const http = source(server, { limits: { concurrency: 1 } });
  assert.equal(http.loginTimeoutMs(login), 30_000, 'the resource default when the login declares none');
  assert.equal(http.loginTimeoutMs({ ...login, timeout_ms: 1500 }), 1500);
  // A read holds the only slot: the hook waits for it, and nothing is sent until the hook returns.
  const slow = await stub(() => ({ ...json({ code: 1000, msg: '', data: [] }), delayMs: 300 }));
  const shared = new HttpSource({ resource: 'res_01jacd5z8q3w7v9h2k4m6n8p0t', origins: { 'plm-api': slow.origin, 'plm-oauth': server.origin }, allowPlaintext: [slow.origin, server.origin], routes: profile.routes, envelope: profile.envelope, limits: { concurrency: 1 } });
  const reading = shared.request({ method: 'POST', path: '/plmquery/bug/detail/', body: { bug_ids: [4242] }, credential });
  const seen: number[] = [];
  const login1 = shared.login(login, { username: 'u', password: 'p' }, {
    sending: async () => {
      seen.push(slow.inFlight, server.requests.length);
      await new Promise((resolve) => setTimeout(resolve, 100));
      seen.push(server.requests.length);
    },
  });
  await reading;
  assert.equal((await login1).token, SECRET);
  assert.deepEqual(seen, [0, 0, 0], 'after the read freed the slot; the login not sent until the hook returned');
  assert.equal(server.requests.length, 1);
  // A hook that throws: its error as it is, nothing sent, the slot released.
  const before = server.requests.length;
  await assert.rejects(http.login(login, { username: 'u', password: 'p' }, { sending: () => Promise.reject(new Error('synthetic hook failure')) }), /synthetic hook failure/);
  assert.equal(server.requests.length, before);
  assert.equal((await http.login(login, { username: 'u', password: 'p' })).token, SECRET, 'the slot was released');
});
