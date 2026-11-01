// The MCP standard authorization (decision 78; the MCP authorization specification: OAuth 2.1 with PKCE, RFC 8414, RFC 7591,
// RFC 8707, RFC 9728, RFC 7009, RFC 9207). This Hub is both the protected resource /mcp and its authorization server. An
// unauthenticated /mcp answer names the resource metadata; a client discovers the authorization server from it, registers
// itself, and opens the authorization endpoint in a browser, which hands the request to the console's authorization page
// (console/authorize.ts: the account is that of the browser's console session, or the one an invitation code names). An
// approved request gives a one-time code bound to the client, its redirect URI, the resource and the PKCE challenge; the
// token endpoint exchanges it for an ordinary Hub token labelled with the client's name. Access tokens are the Hub's
// long-lived revocable tokens, checked against the records on every request, so there is no refresh token: disconnecting a
// Circle is revoking its token. Authorization requests live in memory for AUTHORIZATION_REQUEST_TTL_MS and codes for
// AUTHORIZATION_CODE_TTL_MS; a restart ends both, as it ends console sessions. The error codes and descriptions on the wire
// are the protocol's own (RFC 6749 5.2 and 4.1.2.1, RFC 7591 3.2.2, RFC 8707): codes of OAuth, ASCII descriptions.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { LimitError, type OAuthClient, type Principals } from '../records/api.ts';
import { mediaTypeOf, readBody, sendJson, setCommonHeaders } from './http.ts';

export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 2 * 60 * 1000;
/** Where the authorization endpoint sends the browser: under /console, so the console session cookie is sent. */
export const AUTHORIZE_PAGE = '/console/authorize';
const MAX_REQUESTS = 1000;
const MAX_CODES = 1000;
const FORM_LIMIT = 16 * 1024;
const REGISTRATION_LIMIT = 16 * 1024;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const REFUSED_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'blob:', 'about:', 'vbscript:', 'filesystem:', 'ftp:', 'ws:', 'wss:']);
const UNNAMED_CLIENT = '未命名的客户端';

const PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke',
]);

export function oauthTarget(pathname: string): boolean {
  return PATHS.has(pathname);
}

/** The origin a request reached this Hub on, which is the issuer and the resource's origin for that request. */
export function issuerOf(request: IncomingMessage, secure: boolean): string {
  return `${secure ? 'https' : 'http'}://${(request.headers.host ?? '127.0.0.1').toLowerCase()}`;
}

export function resourceMetadataUrl(request: IncomingMessage, secure: boolean): string {
  return `${issuerOf(request, secure)}/.well-known/oauth-protected-resource/mcp`;
}

/**
 * Why a client may not register this redirect URI, or null: https, http on a loopback address (RFC 8252 7.3) or a
 * private-use scheme (RFC 8252 7.1); never a fragment or user information.
 */
export function redirectUriProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'not an absolute URI';
  }
  if (uri.includes('#')) return 'a redirect URI has no fragment';
  if (url.username !== '' || url.password !== '') return 'a redirect URI has no user information';
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname) ? null : 'http is accepted for loopback addresses only';
  if (REFUSED_SCHEMES.has(url.protocol) || !/^[a-z][a-z0-9+.-]*:$/.test(url.protocol)) return 'this scheme is not accepted';
  return null;
}

/** Whether `sent` is one of the registered URIs: exactly, or for an http loopback URI, up to the port (RFC 8252 7.3). */
export function redirectMatches(registered: readonly string[], sent: string): boolean {
  if (registered.includes(sent)) return true;
  let url: URL;
  try {
    url = new URL(sent);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username !== '' || url.password !== '' || sent.includes('#')) return false;
  return registered.some((uri) => {
    try {
      const known = new URL(uri);
      return known.protocol === 'http:' && known.hostname === url.hostname && known.pathname === url.pathname && known.search === url.search;
    } catch {
      return false;
    }
  });
}

/** `uri` with the parameters of an authorization response (RFC 6749 4.1.2), keeping its own query. */
export function responseUri(uri: string, params: Readonly<Record<string, string | null>>): string {
  const url = new URL(uri);
  for (const [name, value] of Object.entries(params)) if (value !== null) url.searchParams.set(name, value);
  return url.toString();
}

const secret = (): string => randomBytes(32).toString('base64url');
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

// ---------------------------------------------------------------- authorization requests and codes

export interface AuthorizationRequest {
  id: string;
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  challenge: string;
  /** The resource the token is for (RFC 8707): this Hub's /mcp on the origin of the request. */
  resource: string;
  issuer: string;
  /** Requests opened over HTTPS are answered only over HTTPS. */
  secure: boolean;
  created: number;
  /** CSRF token of the page's forms when the browser has no console session. */
  csrf: string;
  /** The invitation the identity step accepted, and its account. */
  invitation: { id: string; user: string; name: string; role: PermissionRole } | null;
  /** Wrong invitation codes typed for this request. */
  failures: number;
  ended: 'approved' | 'denied' | null;
}

export interface CodeGrant {
  client: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  user: string;
  expires: number;
  used: boolean;
  /** The token the code was exchanged for, revoked if the code comes back (RFC 6749 4.1.2). */
  token: string | null;
}

export class AuthorizationStore {
  readonly #requests = new Map<string, AuthorizationRequest>();
  readonly #codes = new Map<string, CodeGrant>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  open(fields: Pick<AuthorizationRequest, 'client' | 'redirectUri' | 'state' | 'challenge' | 'resource' | 'issuer' | 'secure'>): AuthorizationRequest {
    this.#prune();
    const request: AuthorizationRequest = { ...fields, id: secret(), created: this.#now(), csrf: secret(), invitation: null, failures: 0, ended: null };
    this.#requests.set(request.id, request);
    while (this.#requests.size > MAX_REQUESTS) this.#requests.delete(this.#requests.keys().next().value!);
    return request;
  }

  /** A request this store opened that has not expired; an ended one is still returned, for the page to say so. */
  get(id: string): AuthorizationRequest | null {
    const request = this.#requests.get(id);
    if (request === undefined) return null;
    if (this.#now() - request.created >= AUTHORIZATION_REQUEST_TTL_MS) {
      this.#requests.delete(id);
      return null;
    }
    return request;
  }

  end(id: string): void {
    this.#requests.delete(id);
  }

  /** Approves an open request for `user`: the one-time code for the redirect. */
  grant(request: AuthorizationRequest, user: string): string {
    this.#prune();
    const code = secret();
    request.ended = 'approved';
    this.#codes.set(digest(code), { client: request.client.id, redirectUri: request.redirectUri, challenge: request.challenge, resource: request.resource, user, expires: this.#now() + AUTHORIZATION_CODE_TTL_MS, used: false, token: null });
    while (this.#codes.size > MAX_CODES) this.#codes.delete(this.#codes.keys().next().value!);
    return code;
  }

  /** The grant of a code that has not expired, and whether it was presented before; it is used from now on. */
  take(code: string): { grant: CodeGrant; reused: boolean } | null {
    const grant = this.#codes.get(digest(code));
    if (grant === undefined || grant.expires <= this.#now()) return null;
    const reused = grant.used;
    grant.used = true;
    return { grant, reused };
  }

  clear(): void {
    this.#requests.clear();
    this.#codes.clear();
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, request] of this.#requests) if (now - request.created >= AUTHORIZATION_REQUEST_TTL_MS) this.#requests.delete(id);
    for (const [key, grant] of this.#codes) if (grant.expires <= now) this.#codes.delete(key);
  }
}

// ---------------------------------------------------------------- endpoints

export interface OAuthOptions {
  principals: Principals;
  store: AuthorizationStore;
  /** True for a request over the built-in TLS listener or the configured HTTPS proxy. */
  secureRequest: (request: IncomingMessage) => boolean;
  log: (line: string) => void;
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

function oauthError(response: ServerResponse, status: number, error: string, description: string, headers: Record<string, string> = {}): void {
  sendJson(response, status, { error, error_description: description }, { ...NO_STORE, ...headers });
}

function methodNotAllowed(request: IncomingMessage, response: ServerResponse, allow: string): void {
  request.resume();
  oauthError(response, 405, 'invalid_request', `use ${allow.split(', ')[0]}`, { allow });
}

/** A form body (application/x-www-form-urlencoded) whose parameters each occur at most once (RFC 6749 3.1, 3.2). */
async function formBody(request: IncomingMessage, response: ServerResponse): Promise<URLSearchParams | null> {
  if (mediaTypeOf(request) !== 'application/x-www-form-urlencoded') {
    request.resume();
    oauthError(response, 400, 'invalid_request', 'the body must be application/x-www-form-urlencoded');
    return null;
  }
  const body = await readBody(request, FORM_LIMIT);
  if (!body.ok) {
    if (body.reason === 'aborted') response.destroy();
    else oauthError(response, 413, 'invalid_request', 'the body is too large');
    return null;
  }
  const form = new URLSearchParams(body.bytes.toString('utf8'));
  for (const name of new Set(form.keys())) {
    if (form.getAll(name).length > 1) {
      oauthError(response, 400, 'invalid_request', `parameter ${name.slice(0, 40).replace(/[^\x20-\x21\x23-\x5b\x5d-\x7e]/g, '?')} is repeated`);
      return null;
    }
  }
  return form;
}

/** RFC 9728: the resource is /mcp, its authorization server this Hub on the same origin. */
function protectedResource(issuer: string): Record<string, unknown> {
  return { resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'], resource_name: 'circle-hub' };
}

/** RFC 8414: public clients only, the authorization code with PKCE S256, no refresh token. */
function authorizationServer(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

/** The error page of an authorization request that cannot be answered at its redirect URI (RFC 6749 4.1.2.1). */
export type AuthorizeRefusal = (response: ServerResponse, status: number, message: string) => void;

/** Handles the paths of oauthTarget(). `refuse` renders the console's error page for an unusable authorization request. */
export async function handleOAuth(request: IncomingMessage, response: ServerResponse, url: URL, options: OAuthOptions, refuse: AuthorizeRefusal): Promise<void> {
  const secure = options.secureRequest(request);
  const issuer = issuerOf(request, secure);
  const path = url.pathname;
  if (path.startsWith('/.well-known/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed(request, response, 'GET, HEAD');
    request.resume();
    const body = path === '/.well-known/oauth-authorization-server' ? authorizationServer(issuer) : protectedResource(issuer);
    return sendJson(response, 200, body, { 'cache-control': 'max-age=60' });
  }
  if (path === '/oauth/authorize') {
    if (request.method !== 'GET') return methodNotAllowed(request, response, 'GET');
    request.resume();
    return authorize(response, url, options, issuer, secure, refuse);
  }
  if (request.method !== 'POST') return methodNotAllowed(request, response, 'POST');
  if (path === '/oauth/register') return register(request, response, options);
  if (path === '/oauth/token') return token(request, response, options);
  return revoke(request, response, options);
}

async function register(request: IncomingMessage, response: ServerResponse, options: OAuthOptions): Promise<void> {
  if (mediaTypeOf(request) !== 'application/json') {
    request.resume();
    return oauthError(response, 400, 'invalid_client_metadata', 'the body must be application/json');
  }
  const body = await readBody(request, REGISTRATION_LIMIT);
  if (!body.ok) {
    if (body.reason === 'aborted') return void response.destroy();
    return oauthError(response, 413, 'invalid_client_metadata', 'the body is too large');
  }
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body.bytes.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('not an object');
    metadata = parsed as Record<string, unknown>;
  } catch {
    return oauthError(response, 400, 'invalid_client_metadata', 'the body is not a JSON object');
  }
  const uris = metadata.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || uris.some((uri) => typeof uri !== 'string' || uri.length > 2000)) {
    return oauthError(response, 400, 'invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs of at most 2000 characters');
  }
  for (const uri of uris as string[]) {
    const problem = redirectUriProblem(uri);
    if (problem !== null) return oauthError(response, 400, 'invalid_redirect_uri', problem);
  }
  const method = metadata.token_endpoint_auth_method;
  if (method !== undefined && method !== 'none') return oauthError(response, 400, 'invalid_client_metadata', 'only public clients (token_endpoint_auth_method none) are accepted');
  const grants = metadata.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token'))) {
    return oauthError(response, 400, 'invalid_client_metadata', 'grant_types must include authorization_code and nothing but refresh_token besides');
  }
  const types = metadata.response_types;
  if (types !== undefined && (!Array.isArray(types) || types.length !== 1 || types[0] !== 'code')) return oauthError(response, 400, 'invalid_client_metadata', 'response_types must be [code]');
  // At most 100 characters (code points, so no surrogate pair is cut), without control characters.
  const given = typeof metadata.client_name === 'string' ? [...metadata.client_name.replace(/\p{Cc}/gu, '').trim()].slice(0, 100).join('').trim() : '';
  let client: OAuthClient;
  try {
    client = await options.principals.registerClient(given === '' ? UNNAMED_CLIENT : given, uris as string[]);
  } catch (error) {
    if (error instanceof LimitError) return oauthError(response, 503, 'temporarily_unavailable', 'too many clients registered recently; retry later', { 'retry-after': '600' });
    throw error;
  }
  options.log(`标准授权：客户端 ${client.id}（${client.name}）已登记`);
  sendJson(response, 201, {
    client_id: client.id,
    client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
    client_name: client.name,
    redirect_uris: client.redirect_uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }, NO_STORE);
}

async function authorize(response: ServerResponse, url: URL, options: OAuthOptions, issuer: string, secure: boolean, refuse: AuthorizeRefusal): Promise<void> {
  const query = url.searchParams;
  for (const name of new Set(query.keys())) if (query.getAll(name).length > 1) return refuse(response, 400, '授权请求无效：参数重复。请在 Circle 中重新连接 Hub。');
  const client = await options.principals.client(query.get('client_id') ?? '');
  if (client === null) return refuse(response, 400, '授权请求无效：客户端未在本 Hub 登记。请在 Circle 中重新连接 Hub。');
  const sent = query.get('redirect_uri');
  const redirectUri = sent ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  if (redirectUri === null || !redirectMatches(client.redirect_uris, redirectUri)) return refuse(response, 400, '授权请求无效：回调地址与客户端登记的地址不一致。请在 Circle 中重新连接 Hub。');
  const state = query.get('state');
  const back = (error: string, description: string): void => {
    setCommonHeaders(response);
    response.writeHead(303, { location: responseUri(redirectUri, { error, error_description: description, state, iss: issuer }), 'content-length': '0' });
    response.end();
  };
  if (query.get('response_type') !== 'code') return back('unsupported_response_type', 'only response_type code is supported');
  const challenge = query.get('code_challenge');
  if (challenge === null || !CHALLENGE.test(challenge) || query.get('code_challenge_method') !== 'S256') return back('invalid_request', 'PKCE with code_challenge_method S256 is required');
  if (state !== null && state.length > 2000) return back('invalid_request', 'state is longer than 2000 characters');
  const resource = `${issuer}/mcp`;
  const asked = query.get('resource');
  if (asked !== null && asked !== resource) return back('invalid_target', 'the resource is not this server\'s /mcp');
  const opened = options.store.open({ client, redirectUri, state, challenge, resource, issuer, secure });
  setCommonHeaders(response);
  response.writeHead(303, { location: `${AUTHORIZE_PAGE}/${opened.id}`, 'content-length': '0', ...NO_STORE });
  response.end();
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier)) return false;
  const actual = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function token(request: IncomingMessage, response: ServerResponse, options: OAuthOptions): Promise<void> {
  const form = await formBody(request, response);
  if (form === null) return;
  if (form.get('grant_type') !== 'authorization_code') return oauthError(response, 400, 'unsupported_grant_type', 'only the authorization_code grant is supported');
  const client = await options.principals.client(form.get('client_id') ?? '');
  if (client === null) return oauthError(response, 401, 'invalid_client', 'unknown client_id', { 'www-authenticate': 'Bearer realm="circle-hub"' });
  const code = form.get('code') ?? '';
  const taken = code === '' ? null : options.store.take(code);
  if (taken === null || taken.grant.client !== client.id) return oauthError(response, 400, 'invalid_grant', 'the authorization code is invalid or expired');
  const grant = taken.grant;
  if (taken.reused) {
    // RFC 6749 4.1.2: a code presented again revokes the token it gave.
    await revokeReusedGrant(options.principals, grant);
    options.log(`标准授权：客户端 ${client.id} 的授权码被再次使用，由它签发的令牌已吊销`);
    return oauthError(response, 400, 'invalid_grant', 'the authorization code was already used');
  }
  if ((form.get('redirect_uri') ?? '') !== grant.redirectUri) return oauthError(response, 400, 'invalid_grant', 'redirect_uri differs from the authorization request');
  if (!pkceMatches(form.get('code_verifier') ?? '', grant.challenge)) return oauthError(response, 400, 'invalid_grant', 'code_verifier does not match the code_challenge');
  const resource = form.get('resource');
  if (resource !== null && resource !== grant.resource) return oauthError(response, 400, 'invalid_target', 'the resource differs from the authorization request');
  const user = await options.principals.get(grant.user);
  if (user === null || user.disabled) return oauthError(response, 400, 'invalid_grant', 'the account is not available');
  const issued = await options.principals.issueToken({ id: user.id, name: user.name, role: user.role }, user.id, client.name, client.id);
  grant.token = issued.id;
  options.log(`标准授权：${user.name}（${user.id}）的令牌 ${issued.id} 已签发给客户端 ${client.id}（${client.name}）`);
  sendJson(response, 200, { access_token: issued.token, token_type: 'Bearer' }, NO_STORE);
}

/** RFC 7009: the holder of a token revokes it by its value; an unknown token is answered the same way. */
async function revoke(request: IncomingMessage, response: ServerResponse, options: OAuthOptions): Promise<void> {
  const form = await formBody(request, response);
  if (form === null) return;
  const value = form.get('token');
  if (value === null || value === '') return oauthError(response, 400, 'invalid_request', 'token is required');
  if (await options.principals.revokeTokenValue(value)) options.log('标准授权：一个令牌已由其持有者吊销');
  setCommonHeaders(response);
  response.writeHead(200, { 'content-length': '0', ...NO_STORE });
  response.end();
}

async function revokeReusedGrant(principals: Principals, grant: CodeGrant): Promise<void> {
  if (grant.token === null) return;
  const user = await principals.get(grant.user);
  if (user !== null) await principals.revokeToken({ id: user.id, name: user.name, role: user.role }, grant.token);
}
