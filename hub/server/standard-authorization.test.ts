// The MCP standard authorization end to end (decision 78): the official SDK client discovers the Hub's metadata from the
// 401, registers, is sent to the authorization page, and after the invitation step and the approval exchanges the code
// for a token it then calls tools with. Also: a signed-in browser approves without an invitation; every refusal of the
// authorization and token endpoints; the request and code lifetimes; revocation; and the one-time login links.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AUTHORIZATION_CODE_TTL_MS, AUTHORIZATION_REQUEST_TTL_MS } from './oauth.ts';
import { LOGIN_LINK_TTL_MS } from './console/session.ts';
import { createTestServer, type TestServer, type TestUser } from './testing.ts';

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
    body: form({ token, csrf: csrfOf(page.body) }),
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

/** Opens the authorization page of `url` as a browser with `cookie`: the console path and the page. */
async function openPage(url: string, cookie = ''): Promise<{ path: string; page: Reply }> {
  const start = await send(url, { headers: cookie ? { cookie } : {} });
  assert.equal(start.status, 303, start.body);
  const path = pathOf(start.headers.location);
  assert.match(path, /^\/console\/authorize\/[A-Za-z0-9_-]{43}$/);
  return { path, page: await send(path, { headers: cookie ? { cookie } : {} }) };
}

async function post(path: string, fields: Record<string, string>, cookie = ''): Promise<Reply> {
  return send(path, { method: 'POST', headers: { ...FORM, origin: origin(), ...(cookie ? { cookie } : {}) }, body: form(fields) });
}

/** Through the invitation step to the approval; the redirect to the client with its code. */
async function approveWithInvitation(url: string, invitation: string): Promise<URL> {
  const { path, page } = await openPage(url);
  assert.match(page.body, /邀请码/);
  const verified = await post(path, { csrf: csrfOf(page.body), step: 'identity', code: invitation });
  assert.equal(verified.status, 303, verified.body);
  const confirm = await send(path);
  assert.match(confirm.body, /的身份授权/);
  const approved = await post(path, { csrf: csrfOf(confirm.body), step: 'decide', decision: 'approve' });
  assert.equal(approved.status, 303, approved.body);
  return new URL(String(approved.headers.location));
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
    const { path, page } = await openPage(authorizeUrl(client, challenge), session);
    assert.equal(page.status, 200);
    assert.match(page.body, new RegExp(`以 <b>${user.user.name}</b>`));
    assert.match(String(page.headers['content-security-policy']), /form-action 'self' http:\/\/127\.0\.0\.1:43123(;|$)/);
    assert.match(page.body, /以其他账号授权/, 'a signed-in browser may still use an invitation');
    const approved = await post(path, { csrf: csrfOf(page.body), step: 'decide', decision: 'approve' }, session);
    const redirect = new URL(String(approved.headers.location));
    const reply = await exchange({ grant_type: 'authorization_code', code: redirect.searchParams.get('code')!, client_id: client, redirect_uri: 'http://127.0.0.1:43123/callback', code_verifier: verifier, resource: `${origin()}/mcp` });
    assert.equal(reply.status, 200, reply.body);
    assert.equal(reply.headers['cache-control'], 'no-store');
    const issued = JSON.parse(reply.body);
    assert.deepEqual(await server.records.principals.authenticate(`Bearer ${issued.access_token}`), user.principal);
    // The browser comes back to the page: it says the request ended.
    assert.match((await send(path, { headers: { cookie: session } })).body, /已授权/);

    // RFC 7009: the holder revokes the token; the Hub then refuses it.
    const revoked = await send('/oauth/revoke', { method: 'POST', headers: FORM, body: form({ token: issued.access_token }) });
    assert.equal(revoked.status, 200);
    assert.equal(await server.records.principals.authenticate(`Bearer ${issued.access_token}`), null);
    assert.equal((await send('/oauth/revoke', { method: 'POST', headers: FORM, body: form({ token: 'unknown' }) })).status, 200, 'an unknown token is answered the same way');
  });

  test('requests the endpoint cannot redirect get a page; the others go back to the client with the error', async () => {
    const client = await register();
    const { challenge } = pkce();
    const unknown = await send(authorizeUrl('cli_00000000000000000000000000', challenge));
    assert.equal(unknown.status, 400);
    assert.equal(unknown.headers.location, undefined);
    assert.match(unknown.body, /客户端未在本 Hub 登记/);
    const elsewhere = await send(authorizeUrl(client, challenge, {}, 'http://127.0.0.1:43123/other'));
    assert.equal(elsewhere.status, 400);
    assert.match(elsewhere.body, /回调地址/);
    const errorOf = async (extra: Record<string, string>): Promise<URLSearchParams> => {
      const reply = await send(authorizeUrl(client, challenge, extra));
      assert.equal(reply.status, 303);
      const location = new URL(String(reply.headers.location));
      assert.equal(location.searchParams.get('state'), 'st-1');
      assert.equal(location.searchParams.get('iss'), origin());
      return location.searchParams;
    };
    assert.equal((await errorOf({ code_challenge_method: 'plain' })).get('error'), 'invalid_request');
    assert.equal((await errorOf({ code_challenge: 'short' })).get('error'), 'invalid_request');
    assert.equal((await errorOf({ response_type: 'token' })).get('error'), 'unsupported_response_type');
    assert.equal((await errorOf({ resource: 'http://192.0.2.10/mcp' })).get('error'), 'invalid_target');

    // A loopback redirect URI matches whatever port the client listens on this time (RFC 8252 7.3).
    const moved = await send(authorizeUrl(client, challenge, {}, 'http://127.0.0.1:50000/callback'));
    assert.equal(moved.status, 303);
    assert.match(pathOf(moved.headers.location), /^\/console\/authorize\//);

    // Refusing sends access_denied back.
    const { path, page } = await openPage(authorizeUrl(client, challenge), await signIn((await member()).token));
    const denied = await post(path, { csrf: csrfOf(page.body), step: 'decide', decision: 'deny' });
    assert.equal(new URL(String(denied.headers.location)).searchParams.get('error'), 'access_denied');
  });

  test('registration accepts public clients with https, loopback http or private-use redirect URIs only', async () => {
    const attempt = (body: unknown, type = 'application/json') => send('/oauth/register', { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    for (const uri of ['http://192.0.2.10/callback', 'javascript:alert(1)', 'https://192.0.2.10/cb#x', 'https://user:pw@192.0.2.10/cb', 'not a uri']) {
      const reply = await attempt({ redirect_uris: [uri] });
      assert.equal(reply.status, 400, uri);
      assert.equal(JSON.parse(reply.body).error, 'invalid_redirect_uri', uri);
    }
    assert.equal(JSON.parse((await attempt({ redirect_uris: ['https://192.0.2.10/cb'], token_endpoint_auth_method: 'client_secret_basic' })).body).error, 'invalid_client_metadata');
    assert.equal(JSON.parse((await attempt({ redirect_uris: ['https://192.0.2.10/cb'], grant_types: ['client_credentials'] })).body).error, 'invalid_client_metadata');
    assert.equal(JSON.parse((await attempt('[]')).body).error, 'invalid_client_metadata');
    assert.equal(JSON.parse((await attempt('redirect_uris=x', 'application/x-www-form-urlencoded')).body).error, 'invalid_client_metadata');
    for (const uri of ['https://192.0.2.10/cb', 'http://[::1]:8080/cb', 'http://localhost/cb', 'com.example.circle:/callback']) assert.equal((await attempt({ redirect_uris: [uri] })).status, 201, uri);
    const unnamed = JSON.parse((await attempt({ redirect_uris: ['http://127.0.0.1/cb'] })).body);
    assert.equal(unnamed.client_name, '未命名的客户端');
    assert.deepEqual(unnamed.grant_types, ['authorization_code']);
  });

  test('the token endpoint refuses a wrong verifier, redirect URI, client or resource, and an expired code', async () => {
    const user = await member();
    const session = await signIn(user.token);
    const client = await register();
    const other = await register();
    const codeFor = async (challenge: string): Promise<string> => {
      const { path, page } = await openPage(authorizeUrl(client, challenge), session);
      const approved = await post(path, { csrf: csrfOf(page.body), step: 'decide', decision: 'approve' }, session);
      return new URL(String(approved.headers.location)).searchParams.get('code')!;
    };
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
    const { path } = await openPage(authorizeUrl(client, challenge));
    clock += AUTHORIZATION_REQUEST_TTL_MS;
    const expired = await send(path);
    assert.equal(expired.status, 410);
    assert.match(expired.body, /授权请求已过期或不存在/);

    const fresh = await openPage(authorizeUrl(client, challenge));
    let page = fresh.page;
    for (let attempt = 1; attempt < 5; attempt++) {
      const wrong = await post(fresh.path, { csrf: csrfOf(page.body), step: 'identity', code: 'AAAA-BBBB-CCCC' });
      assert.equal(wrong.status, 400);
      assert.match(wrong.body, /邀请码不正确/);
      page = wrong;
    }
    const last = await post(fresh.path, { csrf: csrfOf(page.body), step: 'identity', code: 'AAAA-BBBB-CCCC' });
    assert.equal(last.status, 410);
    assert.equal((await send(fresh.path)).status, 410);

    // A form from elsewhere, or without the page's token, is refused.
    const other = await openPage(authorizeUrl(client, challenge));
    assert.equal((await post(other.path, { csrf: 'forged', step: 'identity', code: 'AAAA-BBBB-CCCC' })).status, 403);
    const foreign = await send(other.path, { method: 'POST', headers: { ...FORM, origin: 'http://192.0.2.20' }, body: form({ csrf: csrfOf(other.page.body), step: 'decide', decision: 'approve' }) });
    assert.equal(foreign.status, 403);
  });
});

describe('one-time login links', () => {
  const ask = (token: string | null, body?: unknown) => send('/console/api/login-links', {
    method: 'POST',
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  async function follow(url: string): Promise<Reply> {
    const path = new URL(url).pathname;
    const page = await send(path);
    assert.equal(page.status, 200, page.body);
    return send(path, { method: 'POST', headers: { ...FORM, origin: origin(), cookie: `circle_hub_login=${valueOf(cookieOf(page, 'circle_hub_login'))}` }, body: form({ csrf: csrfOf(page.body) }) });
  }

  test('a client asks with its token; the link opens a session on that token at the page it names, once', async () => {
    const user = await member();
    assert.equal((await ask(null)).status, 401);
    assert.equal((await ask('A'.repeat(43))).status, 401);
    assert.equal((await send('/console/api/login-links', { headers: { authorization: `Bearer ${user.token}` } })).status, 405);
    const reply = await ask(user.token, { next: '/console/runs?result=passed' });
    assert.equal(reply.status, 201, reply.body);
    const { url, expires_at } = JSON.parse(reply.body);
    assert.match(url, new RegExp(`^${origin()}/console/login/[A-Za-z0-9_-]{43}$`));
    assert.equal(Date.parse(expires_at) - clock, LOGIN_LINK_TTL_MS);
    const path = new URL(url).pathname;
    const look = await send(path);
    assert.match(look.body, new RegExp(`以 <b>${user.user.name}</b>`), 'the page names the account before anything happens');
    const opened = await follow(url);
    assert.equal(opened.status, 303);
    assert.equal(opened.headers.location, '/console/runs?result=passed');
    const session = `circle_hub_session=${valueOf(cookieOf(opened, 'circle_hub_session'))}`;
    const me = JSON.parse((await send('/console/api/me', { headers: { cookie: session } })).body);
    assert.equal(me.id, user.user.id);
    const used = await send(path);
    assert.equal(used.status, 410);
    assert.match(used.body, /登录链接已失效/);
    assert.ok(!used.body.includes(user.user.name), 'a spent link does not say whose it was');

    // The session is that of the client's token: revoking the token ends it.
    const [token] = await server.records.principals.tokens(user.user.id);
    await server.records.principals.revokeToken(server.admin.principal, token.id);
    assert.equal((await send('/console/api/me', { headers: { cookie: session } })).status, 401);
  });

  test('a link expires after its lifetime, and a return path off this console leads to the overview', async () => {
    const user = await member();
    const late = JSON.parse((await ask(user.token)).body).url as string;
    clock += LOGIN_LINK_TTL_MS;
    assert.equal((await send(new URL(late).pathname)).status, 410);
    for (const next of ['//192.0.2.10/x', 'https://192.0.2.10/', '/console/login', '/elsewhere', '/console\\..\\x']) {
      const opened = await follow(JSON.parse((await ask(user.token, { next })).body).url);
      assert.equal(opened.headers.location, '/console/overview', next);
    }
    assert.equal((await ask(user.token, { next: 3 })).status, 400);
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
      body: form({ token: user.token, csrf: csrfOf(page.body), next: '/console/runs?result=passed' }),
    });
    assert.equal(reply.headers.location, '/console/runs?result=passed');
  });
});
