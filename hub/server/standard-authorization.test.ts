// The MCP standard authorization end to end (decision 125): the official SDK client discovers the Hub's metadata from the
// 401, registers, is sent to the authorization page, and after the invitation step and the approval exchanges the code
// for a token it then calls tools with. Also: a signed-in browser approves without an invitation; every refusal of the
// authorization and token endpoints; the request and code lifetimes; revocation; and the one-time login links, which lead
// to the password sign-in and open no session.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AUTHORIZATION_CODE_TTL_MS, AUTHORIZATION_REQUEST_TTL_MS, AuthorizationStore, RegistrationWindow } from './oauth.ts';
import { LOGIN_LINK_TTL_MS } from './console/session.ts';
import { testConsoleCredentials, createTestServer, type TestServer, type TestUser } from './testing.ts';

let server: TestServer;
let clock = Date.parse('2026-11-01T09:00:00.000Z');
let counter = 0;

before(async () => {
  server = await createTestServer({ now: () => new Date(clock) });
});
after(async () => {
  await server?.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method: options.method ?? 'GET', headers: { host: `127.0.0.1:${server.port}`, ...options.headers }, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const origin = (): string => `http://127.0.0.1:${server.port}`;
const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const valueOf = (header: string | undefined): string => (header ?? '').split(';')[0].split('=').slice(1).join('=');
const cookieOf = (reply: Reply, name: string): string | undefined => ([] as string[]).concat(reply.headers['set-cookie'] ?? []).find((value) => value.startsWith(`${name}=`));
const csrfOf = (body: string): string => /name="csrf" value="([^"]+)"/.exec(body)![1];
/** The approval of a confirm page: its CSRF token and the account the page names. */
const approval = (body: string): Record<string, string> => ({ csrf: csrfOf(body), step: 'decide', decision: 'approve', account: /name="account" value="([^"]+)"/.exec(body)![1] });
const pathOf = (location: string | string[] | undefined): string => new URL(String(location), origin()).pathname;

async function member(): Promise<TestUser> {
  counter += 1;
  return server.createUser(`授权成员${counter}`);
}

async function signIn(token: string): Promise<string> {
  const page = await send('/console/login');
  const reply = await send('/console/login', {
    method: 'POST',
    headers: { ...FORM, cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}`, origin: origin() },
    body: form({ ...testConsoleCredentials(token), csrf: csrfOf(page.body) }),
  });
  assert.equal(reply.status, 303, reply.body);
  return `circle_hub_session=${valueOf(cookieOf(reply, 'circle_hub_session'))}`;
}

async function register(redirect = 'http://127.0.0.1:43123/callback', name = 'MacBook 上的 Circle'): Promise<string> {
  const reply = await send('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  assert.equal(reply.status, 201, reply.body);
  return JSON.parse(reply.body).client_id as string;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function authorizeUrl(client: string, challenge: string, extra: Record<string, string> = {}, redirect = 'http://127.0.0.1:43123/callback'): string {
  return `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-1', resource: `${origin()}/mcp`, ...extra })}`;
}

/**
 * Opens the authorization page of `url` as a browser with `session` (a console session cookie, or none): the console
 * path, the page, and the browser's cookies from then on (the session and the request's own cookie).
 */
async function openPage(url: string, session = ''): Promise<{ path: string; page: Reply; cookie: string }> {
  const start = await send(url, { headers: session ? { cookie: session } : {} });
  assert.equal(start.status, 303, start.body);
  const path = pathOf(start.headers.location);
  assert.match(path, /^\/console\/authorize\/[A-Za-z0-9_-]{43}$/);
  const bound = cookieOf(start, 'circle_hub_authorize');
  assert.match(bound ?? '', new RegExp(`^circle_hub_authorize=[A-Za-z0-9_-]{43}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=600$`));
  const cookie = [session, `circle_hub_authorize=${valueOf(bound)}`].filter(Boolean).join('; ');
  return { path, page: await send(path, { headers: { cookie } }), cookie };
}

async function post(path: string, fields: Record<string, string>, cookie = ''): Promise<Reply> {
  return send(path, { method: 'POST', headers: { ...FORM, origin: origin(), ...(cookie ? { cookie } : {}) }, body: form(fields) });
}

/** Through the invitation step to the approval; the redirect to the client with its code. */
async function approveWithInvitation(url: string, invitation: string): Promise<URL> {
  const { path, page, cookie } = await openPage(url);
  assert.match(page.body, /邀请码/);
  const verified = await post(path, { csrf: csrfOf(page.body), step: 'identity', code: invitation }, cookie);
  assert.equal(verified.status, 303, verified.body);
  const confirm = await send(path, { headers: { cookie } });
  assert.match(confirm.body, /的身份允许/);
  const approved = await post(path, approval(confirm.body), cookie);
  assert.equal(approved.status, 303, approved.body);
  return new URL(String(approved.headers.location));
}

/** A signed-in browser approves a new request of `client`; the code. */
async function approvedCode(client: string, challenge: string, session: string): Promise<string> {
  const { path, page, cookie } = await openPage(authorizeUrl(client, challenge), session);
  const approved = await post(path, approval(page.body), cookie);
  assert.equal(approved.status, 303, approved.body);
  return new URL(String(approved.headers.location)).searchParams.get('code')!;
}

async function exchange(fields: Record<string, string>): Promise<Reply> {
  return send('/oauth/token', { method: 'POST', headers: FORM, body: form(fields) });
}

class ScriptedProvider implements OAuthClientProvider {
  readonly redirectUrl = 'http://127.0.0.1:43123/callback';
  readonly clientMetadata: OAuthClientMetadata = { client_name: 'MacBook 上的 Circle', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  information: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = '';
  authorization: URL | null = null;
  state(): string {
    return 'sdk-state';
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.information;
  }
  saveClientInformation(information: OAuthClientInformationMixed): void {
    this.information = information;
  }
  tokens(): OAuthTokens | undefined {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens): void {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL): void {
    this.authorization = url;
  }
  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }
  codeVerifier(): string {
    return this.verifier;
  }
}

describe('the MCP standard authorization', () => {
  test('the metadata names this Hub as the resource /mcp and as its authorization server', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const reply = await send(path);
      assert.equal(reply.status, 200);
      assert.deepEqual(JSON.parse(reply.body), { resource: `${origin()}/mcp`, authorization_servers: [origin()], bearer_methods_supported: ['header'], resource_name: 'circle-hub' });
    }
    const server_ = JSON.parse((await send('/.well-known/oauth-authorization-server')).body);
    assert.equal(server_.issuer, origin());
    assert.equal(server_.authorization_endpoint, `${origin()}/oauth/authorize`);
    assert.deepEqual(server_.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(server_.grant_types_supported, ['authorization_code']);
    assert.deepEqual(server_.token_endpoint_auth_methods_supported, ['none']);
    assert.equal((await send('/.well-known/oauth-authorization-server', { method: 'POST', body: '' })).status, 405);
  });

  test('the SDK client registers, is authorized through an invitation, and calls tools with the token it got', async () => {
    const user = await member();
    const invitation = await server.records.principals.invite(server.admin.principal, user.user.id);
    const provider = new ScriptedProvider();
    const first = new Client({ name: 'scripted-circle', version: '1.0.0' });
    await assert.rejects(first.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl), { authProvider: provider })), UnauthorizedError);
    assert.ok(provider.information?.client_id.startsWith('cli_'), 'the SDK registered dynamically');
    const authorization = provider.authorization!;
    assert.equal(authorization.origin, origin());
    assert.equal(authorization.searchParams.get('resource'), `${origin()}/mcp`);

    const redirect = await approveWithInvitation(`${authorization.pathname}${authorization.search}`, invitation.code.toLowerCase());
    assert.equal(`${redirect.origin}${redirect.pathname}`, provider.redirectUrl);
    assert.equal(redirect.searchParams.get('state'), 'sdk-state');
    assert.equal(redirect.searchParams.get('iss'), origin());
    const code = redirect.searchParams.get('code')!;

    const transport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), { authProvider: provider });
    await transport.finishAuth(code);
    assert.equal(provider.saved?.token_type, 'Bearer');
    assert.equal(provider.saved?.refresh_token, undefined, 'no refresh token: the access token is revocable instead');
    const client = new Client({ name: 'scripted-circle', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(server.mcpUrl), { authProvider: provider }));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 6);
    await client.close();

    const [token] = await server.records.principals.tokens(user.user.id).then((all) => all.filter((t) => t.client !== null));
    assert.equal(token.client, provider.information!.client_id);
    assert.equal(token.label, 'MacBook 上的 Circle');
    assert.notEqual(token.last_used_at, null);
    assert.deepEqual(await server.records.principals.checkInvitation(invitation.code), { ok: false, reason: 'used' });

    // The code was used; presented again it is refused and the token it gave is revoked (RFC 6749 4.1.2).
    const again = await exchange({ grant_type: 'authorization_code', code, client_id: provider.information!.client_id, redirect_uri: provider.redirectUrl, code_verifier: provider.verifier });
    assert.equal(again.status, 400);
    assert.equal(JSON.parse(again.body).error, 'invalid_grant');
    assert.equal(await server.records.principals.authenticate(`Bearer ${provider.saved!.access_token}`), null);
  });

  test('a browser signed in to the console approves for its own account, without an invitation', async () => {
    const user = await member();
    const session = await signIn(user.token);
    const client = await register();
    const { verifier, challenge } = pkce();
    const { path, page, cookie } = await openPage(authorizeUrl(client, challenge), session);
    assert.equal(page.status, 200);
    assert.match(page.body, new RegExp(`以 <b data-evidence>${user.user.name}</b>`));
    assert.match(String(page.headers['content-security-policy']), /form-action 'self' http:\/\/127\.0\.0\.1:43123(;|$)/);
    assert.match(page.body, /以其他账号连接/, 'a signed-in browser may still use an invitation');
    assert.doesNotMatch(page.body, /回调地址不在本机/, 'a loopback redirect stays on this machine');
    // A redirect URI on another host is named as such before anyone approves.
    const remote = await register('https://192.0.2.30/callback', '远程服务');
    const away = await openPage(authorizeUrl(remote, challenge, {}, 'https://192.0.2.30/callback'), session);
    assert.match(away.page.body, /回调地址不在本机。<\/b>确认后，连接码发送到 https:\/\/192\.0\.2\.30/);
    const approved = await post(path, approval(page.body), cookie);
    const redirect = new URL(String(approved.headers.location));
    const reply = await exchange({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, client_id: client, redirect_uri: 'http://127.0.0.1:43123/callback', code_verifier: verifier, resource: `${origin()}/mcp` });
    assert.equal(reply.status, 200, reply.body);
    assert.equal(reply.headers['cache-control'], 'no-store');
    const issued = JSON.parse(reply.body);
    assert.deepEqual(await server.records.principals.authenticate(`Bearer ${issued.access_token}`), user.principal);
    // The browser comes back to the page: it says the request ended.
    assert.match((await send(path, { headers: { cookie } })).body, /已允许/);

    // RFC 7009: the holder revokes the token; the Hub then refuses it.
    const revoked = await send('/oauth/revoke', { method: 'POST', headers: FORM, body: form({ token: issued.access_token }) });
    assert.equal(revoked.status, 200);
    assert.equal(await server.records.principals.authenticate(`Bearer ${issued.access_token}`), null);
    assert.equal((await send('/oauth/revoke', { method: 'POST', headers: FORM, body: form({ token: 'unknown' }) })).status, 200, 'an unknown token is answered the same way');
  });

  test('a request the endpoint refuses gets a page and never a redirect to a URI the client chose; refusing on the page goes back', async () => {
    const client = await register();
    const { challenge } = pkce();
    const refusals: [Record<string, string>, string, RegExp][] = [
      [{ client_id: 'cli_00000000000000000000000000' }, 'http://127.0.0.1:43123/callback', /客户端未在本 Hub 登记/],
      [{}, 'http://127.0.0.1:43123/other', /回调地址/],
      [{ code_challenge_method: 'plain' }, 'http://127.0.0.1:43123/callback', /PKCE/],
      [{ code_challenge: 'short' }, 'http://127.0.0.1:43123/callback', /PKCE/],
      [{ response_type: 'token' }, 'http://127.0.0.1:43123/callback', /response_type=code/],
      [{ resource: 'http://192.0.2.10/mcp' }, 'http://127.0.0.1:43123/callback', /访问范围/],
    ];
    for (const [extra, redirect, message] of refusals) {
      const reply = await send(authorizeUrl(client, challenge, extra, redirect));
      assert.equal(reply.status, 400, JSON.stringify(extra));
      assert.equal(reply.headers.location, undefined, 'no open redirector (RFC 9700 4.11)');
      assert.match(reply.body, message);
    }

    // A loopback redirect URI matches whatever port the client listens on this time (RFC 8252 7.3).
    const moved = await send(authorizeUrl(client, challenge, {}, 'http://127.0.0.1:50000/callback'));
    assert.equal(moved.status, 303);
    assert.match(pathOf(moved.headers.location), /^\/console\/authorize\//);

    // Refusing on the page, after the person saw the client and its redirect URI, sends access_denied back.
    const { path, page, cookie } = await openPage(authorizeUrl(client, challenge), await signIn((await member()).token));
    const denied = await post(path, { csrf: csrfOf(page.body), step: 'decide', decision: 'deny' }, cookie);
    const location = new URL(String(denied.headers.location));
    assert.equal(location.searchParams.get('error'), 'access_denied');
    assert.equal(location.searchParams.get('state'), 'st-1');
    assert.equal(location.searchParams.get('iss'), origin());
  });

  test('a request belongs to the browser that opened it: another browser can neither see nor finish it', async () => {
    const victim = await member();
    const invitation = await server.records.principals.invite(server.admin.principal, victim.user.id);
    const client = await register();
    const { challenge } = pkce();
    // Whoever opens a request holds its cookie; a browser sent a link to that request does not.
    const { path, page, cookie } = await openPage(authorizeUrl(client, challenge));
    const elsewhere = await send(path);
    assert.equal(elsewhere.status, 410);
    assert.ok(!elsewhere.body.includes('MacBook') && !elsewhere.body.includes(client), 'nothing of the request is shown to another browser');
    const typed = await post(path, { csrf: csrfOf(page.body), step: 'identity', code: invitation.code });
    assert.equal(typed.status, 410, 'an invitation cannot be typed into a request another browser opened');
    const other = await openPage(authorizeUrl(client, challenge));
    assert.equal((await send(path, { headers: { cookie: other.cookie } })).status, 410, 'the cookie of another request does not open this one');
    // The browser that opened it identifies itself; only that browser can approve.
    assert.equal((await post(path, { csrf: csrfOf(page.body), step: 'identity', code: invitation.code }, cookie)).status, 303);
    assert.equal((await post(path, { ...approval((await send(path, { headers: { cookie } })).body) })).status, 410);
    assert.deepEqual(await server.records.principals.checkInvitation(invitation.code).then((c) => c.ok), true, 'the refused approval used nothing');
  });

  test('registration accepts public clients with https, loopback http or private-use redirect URIs only', async () => {
    const attempt = (body: unknown, type = 'application/json') => send('/oauth/register', { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    for (const uri of ['http://192.0.2.10/callback', 'javascript:alert(1)', 'https://192.0.2.10/cb#x', 'https://user:pw@192.0.2.10/cb', 'not a uri']) {
      const reply = await attempt({ redirect_uris: [uri] });
      assert.equal(reply.status, 400, uri);
      assert.equal(JSON.parse(reply.body).error, 'invalid_redirect_uri', uri);
    }
    // RFC 7591 3.2.1: what the Hub does not support is replaced, not refused: a client asking for a secret is public.
    const confidential = JSON.parse((await attempt({ redirect_uris: ['https://192.0.2.10/cb'], token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token', 'client_credentials'] })).body);
    assert.equal(confidential.token_endpoint_auth_method, 'none');
    assert.equal(confidential.client_secret, undefined);
    assert.deepEqual(confidential.grant_types, ['authorization_code']);
    assert.equal(JSON.parse((await attempt({ redirect_uris: ['https://192.0.2.10/cb'], grant_types: ['client_credentials'] })).body).error, 'invalid_client_metadata', 'a client that cannot use the authorization code is refused');
    // Stored, shown and matched as sent, so a redirect URI is what a URL parser writes, and an https host is a plain name.
    for (const uri of ['https://192.0.2.10/c\u0000b', ' https://192.0.2.10/cb', 'https://192.0.2.10/c\tb', 'https://HUB.example/cb', 'https://a;b.example/cb', 'https://a,b.example/cb']) {
      const reply = await attempt({ redirect_uris: [uri] });
      assert.equal(reply.status, 400, JSON.stringify(uri));
      assert.equal(JSON.parse(reply.body).error, 'invalid_redirect_uri', JSON.stringify(uri));
    }
    assert.equal(JSON.parse((await attempt('[]')).body).error, 'invalid_client_metadata');
    assert.equal(JSON.parse((await attempt('redirect_uris=x', 'application/x-www-form-urlencoded')).body).error, 'invalid_client_metadata');
    for (const uri of ['ms-msdt:/id', 'search-ms:query=x', 'tel:1', 'intent://x', 'cursor://anysphere/callback']) {
      assert.equal(JSON.parse((await attempt({ redirect_uris: [uri] })).body).error, 'invalid_redirect_uri', `${uri}: a private-use scheme is a reversed domain name`);
    }
    for (const uri of ['https://192.0.2.10/cb', 'http://[::1]:8080/cb', 'http://localhost/cb', 'com.example.circle:/callback']) assert.equal((await attempt({ redirect_uris: [uri] })).status, 201, uri);
    const spoofed = JSON.parse((await attempt({ redirect_uris: ['http://127.0.0.1/cb'], client_name: 'Circle\u202e\u0007 上的设备' })).body);
    assert.equal(spoofed.client_name, 'Circle 上的设备', 'control and format characters are dropped from a self-chosen name');
    const unnamed = JSON.parse((await attempt({ redirect_uris: ['http://127.0.0.1/cb'] })).body);
    assert.equal(unnamed.client_name, '未命名的客户端');
    assert.deepEqual(unnamed.grant_types, ['authorization_code']);
  });

  test('the token endpoint refuses a wrong verifier, redirect URI, client or resource, and an expired code', async () => {
    const user = await member();
    const session = await signIn(user.token);
    const client = await register();
    const other = await register();
    const codeFor = (challenge: string): Promise<string> => approvedCode(client, challenge, session);
    const base = { grant_type: 'authorization_code', client_id: client, redirect_uri: 'http://127.0.0.1:43123/callback' };
    const cases: [Record<string, string>, string][] = [
      [{ code_verifier: 'x'.repeat(43) }, 'invalid_grant'],
      [{ redirect_uri: 'http://127.0.0.1:43123/elsewhere' }, 'invalid_grant'],
      [{ client_id: other }, 'invalid_grant'],
      [{ resource: 'http://192.0.2.10/mcp' }, 'invalid_target'],
    ];
    for (const [change, error] of cases) {
      const { verifier, challenge } = pkce();
      const reply = await exchange({ ...base, code: await codeFor(challenge), code_verifier: verifier, ...change });
      assert.equal(reply.status, 400, JSON.stringify(change));
      assert.equal(JSON.parse(reply.body).error, error, JSON.stringify(change));
    }
    assert.equal((await exchange({ ...base, client_id: 'cli_00000000000000000000000000', code: 'x', code_verifier: 'x' })).status, 401);
    assert.equal(JSON.parse((await exchange({ ...base, grant_type: 'refresh_token', refresh_token: 'x' })).body).error, 'unsupported_grant_type');
    assert.equal(JSON.parse((await send('/oauth/token', { method: 'POST', headers: FORM, body: 'grant_type=authorization_code&grant_type=authorization_code' })).body).error, 'invalid_request');
    const { verifier, challenge } = pkce();
    const late = await codeFor(challenge);
    clock += AUTHORIZATION_CODE_TTL_MS;
    assert.equal(JSON.parse((await exchange({ ...base, code: late, code_verifier: verifier })).body).error, 'invalid_grant');
  });

  test('an authorization request ends after its lifetime, and after repeated wrong invitation codes', async () => {
    const client = await register();
    const { challenge } = pkce();
    const { path, cookie } = await openPage(authorizeUrl(client, challenge));
    clock += AUTHORIZATION_REQUEST_TTL_MS;
    const expired = await send(path, { headers: { cookie } });
    assert.equal(expired.status, 410);
    assert.match(expired.body, /连接请求已过期/);

    const fresh = await openPage(authorizeUrl(client, challenge));
    let page = fresh.page;
    for (let attempt = 1; attempt < 5; attempt++) {
      const wrong = await post(fresh.path, { csrf: csrfOf(page.body), step: 'identity', code: 'AAAA-BBBB-CCCC' }, fresh.cookie);
      assert.equal(wrong.status, 400);
      assert.match(wrong.body, /邀请码不正确/);
      page = wrong;
    }
    const last = await post(fresh.path, { csrf: csrfOf(page.body), step: 'identity', code: 'AAAA-BBBB-CCCC' }, fresh.cookie);
    assert.equal(last.status, 410);
    assert.equal((await send(fresh.path, { headers: { cookie: fresh.cookie } })).status, 410);

    // A form from elsewhere, or without the page's token, is refused.
    const other = await openPage(authorizeUrl(client, challenge));
    assert.equal((await post(other.path, { csrf: 'forged', step: 'identity', code: 'AAAA-BBBB-CCCC' }, other.cookie)).status, 403);
    const foreign = await send(other.path, { method: 'POST', headers: { ...FORM, origin: 'http://192.0.2.20', cookie: other.cookie }, body: form({ csrf: csrfOf(other.page.body), step: 'decide', decision: 'approve' }) });
    assert.equal(foreign.status, 403);
  });
});

describe('code replay and request floods', () => {
  test('a code presented again while its first exchange is under way leaves no live token', async () => {
    const user = await member();
    const session = await signIn(user.token);
    const client = await register();
    for (let i = 0; i < 10; i++) {
      const { verifier, challenge } = pkce();
      const code = await approvedCode(client, challenge, session);
      const fields = { grant_type: 'authorization_code', code, client_id: client, redirect_uri: 'http://127.0.0.1:43123/callback', code_verifier: verifier };
      const replies = await Promise.all([exchange(fields), exchange({ ...fields, code_verifier: 'y'.repeat(43) })]);
      assert.equal(replies[1].status, 400);
      for (const reply of replies.filter((r) => r.status === 200)) {
        assert.equal(await server.records.principals.authenticate(`Bearer ${JSON.parse(reply.body).access_token}`), null, 'the replay revoked the token the code gave');
      }
    }
  });

  test('a code replayed after its account was disabled is refused and its token stays revoked when the account returns', async () => {
    const user = await member();
    const session = await signIn(user.token);
    const client = await register();
    const { verifier, challenge } = pkce();
    const fields = { grant_type: 'authorization_code', code: await approvedCode(client, challenge, session), client_id: client, redirect_uri: 'http://127.0.0.1:43123/callback', code_verifier: verifier };
    const first = await exchange(fields);
    assert.equal(first.status, 200, first.body);
    await server.records.principals.setDisabled(server.admin.principal, user.user.id, true);
    const replay = await exchange(fields);
    assert.equal(replay.status, 400, replay.body);
    assert.equal(JSON.parse(replay.body).error, 'invalid_grant');
    await server.records.principals.setDisabled(server.admin.principal, user.user.id, false);
    assert.equal(await server.records.principals.authenticate(`Bearer ${JSON.parse(first.body).access_token}`), null);
  });

  test('a flood of requests never evicts a request another client opened; one client keeps at most ten open', async () => {
    const victim = await register();
    const flooder = await register('http://127.0.0.1:43123/callback', 'flood');
    const { challenge } = pkce();
    const { path, cookie } = await openPage(authorizeUrl(victim, challenge));
    for (let i = 0; i < 1000; i++) await send(authorizeUrl(flooder, challenge));
    assert.equal((await send(path, { headers: { cookie } })).status, 200, 'the victim\'s request is still open');
    const own = [];
    for (let i = 0; i < 11; i++) own.push(await openPage(authorizeUrl(victim, challenge)));
    assert.equal((await send(path, { headers: { cookie } })).status, 410, 'the eleventh request of a client ends its oldest');
    assert.equal((await send(own[10].path, { headers: { cookie: own[10].cookie } })).status, 200);
  });
});

describe('decisions, names and limits', () => {
  test('a double submit of the approval gets the same redirect, and the invitation is taken once', async () => {
    const user = await member();
    const invitation = await server.records.principals.invite(server.admin.principal, user.user.id);
    const client = await register();
    const { verifier, challenge } = pkce();
    const { path, page, cookie } = await openPage(authorizeUrl(client, challenge));
    await post(path, { csrf: csrfOf(page.body), step: 'identity', code: invitation.code }, cookie);
    const fields = approval((await send(path, { headers: { cookie } })).body);
    const [first, second] = await Promise.all([post(path, fields, cookie), post(path, fields, cookie)]);
    assert.equal(first.status, 303, first.body);
    assert.equal(second.status, 303, second.body);
    assert.equal(first.headers.location, second.headers.location, 'the browser keeps whichever answer it shows: both carry the code');
    const code = new URL(String(first.headers.location)).searchParams.get('code')!;
    const exchanged = await exchange({ grant_type: 'authorization_code', code, client_id: client, redirect_uri: 'http://127.0.0.1:43123/callback', code_verifier: verifier });
    assert.equal(exchanged.status, 200, exchanged.body);
    const [listed] = await server.records.principals.invitations(user.user.id);
    assert.equal(listed.used_by_client, client);
  });

  test('the approval names the account the page showed; another account signed in meanwhile is refused', async () => {
    const first = await member();
    const second = await member();
    const client = await register();
    const { challenge } = pkce();
    const opened = await openPage(authorizeUrl(client, challenge), await signIn(first.token));
    const fields = approval(opened.page.body);
    assert.equal(fields.account, first.user.id);
    // The same browser signs in as someone else in another tab; the old page is submitted.
    const bound = opened.cookie.split('; ').find((part) => part.startsWith('circle_hub_authorize='))!;
    const switched = `${await signIn(second.token)}; ${bound}`;
    const refused = await post(opened.path, fields, switched);
    assert.equal(refused.status, 409);
    assert.match(refused.body, new RegExp(`以 <b data-evidence>${second.user.name}</b>`), 'the page now names the account that is signed in');
    const approved = await post(opened.path, approval(refused.body), switched);
    assert.equal(approved.status, 303);
  });

  test('a client name of astral characters still gets its token, and a request without redirect_uri needs none at the token', async () => {
    const name = '\u{1F600}'.repeat(100);
    const reply = await send('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: ['http://127.0.0.1:43123/callback'] }) });
    const client = JSON.parse(reply.body).client_id as string;
    const user = await member();
    const session = await signIn(user.token);
    const { verifier, challenge } = pkce();
    // The request leaves out redirect_uri (the client has one), so the token request may leave it out too.
    const url = `/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client, code_challenge: challenge, code_challenge_method: 'S256', state: 's' })}`;
    const { path, page, cookie } = await openPage(url, session);
    const approved = await post(path, approval(page.body), cookie);
    const code = new URL(String(approved.headers.location)).searchParams.get('code')!;
    const exchanged = await exchange({ grant_type: 'authorization_code', code, client_id: client, code_verifier: verifier });
    assert.equal(exchanged.status, 200, exchanged.body);
    const [token] = (await server.records.principals.tokens(user.user.id)).filter((t) => t.client === client);
    assert.equal(token.label, name, 'a hundred characters, counted as code points');
  });

  test('a private-use redirect is said to go to the app that handles its scheme on this machine', async () => {
    const client = await register('com.example.circle:/callback');
    const { challenge } = pkce();
    const { page } = await openPage(authorizeUrl(client, challenge, {}, 'com.example.circle:/callback'), await signIn((await member()).token));
    assert.match(page.body, /连接码交给本机上处理 com\.example\.circle: 链接的应用/);
    assert.doesNotMatch(page.body, /回调地址不在本机/);
  });

  test('one sender registers at most twenty clients in ten minutes and holds at most a hundred open requests', () => {
    let now = 0;
    const window = new RegistrationWindow(() => now);
    for (let i = 0; i < 20; i++) assert.equal(window.take('192.0.2.1'), true);
    assert.equal(window.take('192.0.2.1'), false);
    assert.equal(window.take('192.0.2.2'), true, 'another sender is not affected');
    now += 10 * 60 * 1000;
    assert.equal(window.take('192.0.2.1'), true, 'the window moves on');

    const store = new AuthorizationStore(() => 0);
    const opened = (client: string, peer: string) => store.open({ client: { id: client, name: client }, redirectUri: 'http://127.0.0.1/cb', redirectSent: true, state: null, challenge: 'c'.repeat(43), peer, resource: 'http://127.0.0.1/mcp', issuer: 'http://127.0.0.1', secure: false })!;
    const victim = opened('cli_victim', '192.0.2.9');
    const flood = [];
    for (let i = 0; i < 101; i++) flood.push(opened(`cli_${i}`, '192.0.2.1'));
    assert.equal(store.get(flood[0].id), null, 'the sender\'s hundred-and-first request ends its oldest');
    assert.notEqual(store.get(flood[100].id), null);
    assert.notEqual(store.get(victim.id), null, 'another sender\'s request stays');
  });
});

describe('one-time login links', () => {
  const ask = (token: string | null, body?: unknown) => send('/console/api/login-links', {
    method: 'POST',
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  /** Posts a link as the confirmation form of earlier versions did, with a nonce of the login page (its cookie's path covers the link). */
  async function postLink(path: string): Promise<Reply> {
    const login = await send('/console/login');
    return send(path, { method: 'POST', headers: { ...FORM, origin: origin(), cookie: `circle_hub_login=${valueOf(cookieOf(login, 'circle_hub_login'))}` }, body: form({ csrf: csrfOf(login.body) }) });
  }

  /**
   * Opens a link (GET), then posts it: both lead to the password sign-in at the page the link names, neither sets a session
   * cookie, and the POST uses the link up. Answers where the link led.
   */
  async function follow(url: string): Promise<string> {
    const path = new URL(url).pathname;
    const look = await send(path);
    assert.equal(look.status, 303, look.body);
    assert.match(String(look.headers.location), /^\/console\/login\?next=/);
    assert.equal(cookieOf(look, 'circle_hub_session'), undefined, 'opening a link opens no session');
    const posted = await postLink(path);
    assert.equal(posted.status, 303, posted.body);
    assert.equal(posted.headers.location, look.headers.location, 'posting the link leads to the same sign-in');
    assert.equal(cookieOf(posted, 'circle_hub_session'), undefined, 'posting a link opens no session either');
    return String(look.headers.location);
  }

  test('a client asks with its token; an administrator\'s link leads to the password sign-in at the page it names, opens no session and is used once', async () => {
    const user = await server.createUser('合成链接管理员'+(++counter),'admin');
    assert.equal((await ask(null)).status, 401);
    assert.equal((await ask('A'.repeat(43))).status, 401);
    assert.equal((await send('/console/api/login-links', { headers: { authorization: `Bearer ${user.token}` } })).status, 405);
    const reply = await ask(user.token, { next: '/console/runs?result=passed' });
    assert.equal(reply.status, 201, reply.body);
    const { url, expires_at } = JSON.parse(reply.body);
    assert.match(url, new RegExp(`^${origin()}/console/login/[A-Za-z0-9_-]{43}$`));
    assert.equal(Date.parse(expires_at) - clock, LOGIN_LINK_TTL_MS);
    const path = new URL(url).pathname;
    const signInAt = `/console/login?next=${encodeURIComponent('/console/runs?result=passed')}`;
    const look = await send(path);
    assert.equal(look.headers.location, signInAt);
    assert.equal(await follow(url), signInAt);
    const used = await send(path);
    assert.equal(used.status, 410);
    assert.match(used.body, /登录链接已失效/);
    assert.ok(!used.body.includes(user.user.name), 'a spent link does not say whose it was');
    assert.equal((await postLink(path)).status, 410, 'and cannot be posted again');

    // The sign-in it leads to takes the administrator's password, never a token, and returns to the page the link named.
    const page = await send(signInAt);
    assert.match(page.body, /name="next" value="\/console\/runs\?result=passed"/);
    assert.doesNotMatch(page.body, /name="token"/);
    const signedIn = await send('/console/login', {
      method: 'POST',
      headers: { ...FORM, cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}`, origin: origin() },
      body: form({ ...testConsoleCredentials(user.token), csrf: csrfOf(page.body), next: '/console/runs?result=passed' }),
    });
    assert.equal(signedIn.headers.location, '/console/runs?result=passed');
    const me = JSON.parse((await send('/console/api/me', { headers: { cookie: `circle_hub_session=${valueOf(cookieOf(signedIn, 'circle_hub_session'))}` } })).body);
    assert.equal(me.id, user.user.id);

    // A link whose token was revoked meanwhile, and a code never issued, read like a spent link.
    const pending = new URL(JSON.parse((await ask(user.token)).body).url).pathname;
    const [token] = await server.records.principals.tokens(user.user.id);
    await server.records.principals.revokeToken(server.admin.principal, token.id);
    assert.equal((await send(pending)).status, 410);
    assert.equal((await postLink(pending)).status, 410);
    assert.equal((await send(`/console/login/${'x'.repeat(43)}`)).status, 410);
  });

  test('a link expires after its lifetime, and a return path off this console leads to the overview', async () => {
    const user = await server.createUser('合成链接管理员'+(++counter),'admin');
    const late = new URL(JSON.parse((await ask(user.token)).body).url).pathname;
    clock += LOGIN_LINK_TTL_MS;
    assert.equal((await send(late)).status, 410);
    assert.equal((await postLink(late)).status, 410);
    for (const next of ['//192.0.2.10/x', 'https://192.0.2.10/', '/console/login', '/elsewhere', '/console\\..\\x']) {
      assert.equal(await follow(JSON.parse((await ask(user.token, { next })).body).url), `/console/login?next=${encodeURIComponent('/console/overview')}`, next);
    }
    assert.equal((await ask(user.token, { next: 3 })).status, 400);
    // One token keeps at most five open links: a sixth ends its own oldest, never another account's.
    const other = await server.createUser('合成其他链接管理员'+(++counter),'admin');
    const others = JSON.parse((await ask(other.token)).body).url as string;
    const links: string[] = [];
    for (let i = 0; i < 6; i++) links.push(JSON.parse((await ask(user.token)).body).url);
    assert.equal((await send(new URL(links[0]).pathname)).status, 410);
    assert.equal((await send(new URL(links[5]).pathname)).status, 303);
    assert.equal((await send(new URL(others).pathname)).status, 303);
  });

  test('a member\'s link leads to the password sign-in the same way, opens no session and is used once',async()=>{
    const user=await member();
    const issued=JSON.parse((await ask(user.token,{next:'/console/team'})).body);
    assert.equal(await follow(issued.url),'/console/login?next=%2Fconsole%2Fteam');
    const path=new URL(issued.url).pathname;
    assert.equal((await send(path)).status,410);
    assert.equal((await postLink(path)).status,410);
  });

  test('a page without a session sends the browser to sign in and back', async () => {
    const user = await member();
    const away = await send('/console/runs?result=passed');
    assert.equal(away.status, 303);
    assert.equal(away.headers.location, `/console/login?next=${encodeURIComponent('/console/runs?result=passed')}`);
    const page = await send(String(away.headers.location));
    assert.match(page.body, /name="next" value="\/console\/runs\?result=passed"/);
    const reply = await send('/console/login', {
      method: 'POST',
      headers: { ...FORM, cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}`, origin: origin() },
      body: form({ ...testConsoleCredentials(user.token), csrf: csrfOf(page.body), next: '/console/runs?result=passed' }),
    });
    assert.equal(reply.headers.location, '/console/runs?result=passed');
  });
});
