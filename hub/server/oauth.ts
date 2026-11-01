// The MCP standard authorization (decision 78; the MCP authorization specification: OAuth 2.1 with PKCE, RFC 8414, RFC 7591,
// RFC 8707, RFC 9728, RFC 7009, RFC 9207). This Hub is both the protected resource /mcp and its authorization server. An
// unauthenticated /mcp answer names the resource metadata; a client discovers the authorization server from it, registers
// itself, and opens the authorization endpoint in a browser, which hands the request to the console's authorization page
// (console/authorize.ts: the account is that of the browser's console session, or the one an invitation code names). An
// approved request gives a one-time code bound to the client, its redirect URI, the resource and the PKCE challenge; the
// token endpoint exchanges it for an ordinary Hub token labelled with the client's name. Access tokens are the Hub's
// long-lived revocable tokens, checked against the records on every request, so there is no refresh token: disconnecting a
// Circle is revoking its token. Authorization requests live in memory for AUTHORIZATION_REQUEST_TTL_MS and codes for
// AUTHORIZATION_CODE_TTL_MS; a restart ends both, as it ends console sessions. A request belongs to the browser that opened
// it: the authorization endpoint sets a cookie for the request's page, and the page answers nothing without it, so nobody
// else can finish (or watch) a request another browser identified itself on. A request the endpoint refuses is answered with
// a page, never by redirecting to a URI a client registered for itself (no open redirector, RFC 9700 4.11). The error codes
// and descriptions on the wire are the protocol's own (RFC 6749 5.2, RFC 7591 3.2.2): codes of OAuth, ASCII descriptions.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import { LimitError, RecordsError, type IssuedToken, type OAuthClient, type Principals } from '../records/api.ts';
import { cookie } from './console/session.ts';
import { mediaTypeOf, readBody, sendJson, setCommonHeaders } from './http.ts';

export const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
export const AUTHORIZATION_CODE_TTL_MS = 2 * 60 * 1000;
/** Where the authorization endpoint sends the browser: under /console, so the console session cookie is sent. */
export const AUTHORIZE_PAGE = '/console/authorize';
/** Open requests in all; beyond it new ones are refused, so a flood never evicts a request somebody is finishing. */
const MAX_REQUESTS = 5000;
/** Open requests of one client, and of one sender: a new one beyond this ends that client's (that sender's) oldest. */
const REQUESTS_PER_CLIENT = 10;
const REQUESTS_PER_PEER = 100;
/** Registrations one sender may make in REGISTRATION_WINDOW_MS (the records bound all senders together as well). */
const REGISTRATIONS_PER_PEER = 20;
const REGISTRATION_WINDOW_MS = 10 * 60 * 1000;
const MAX_CODES = 1000;
/** The cookie that ties a request to the browser that opened it (scoped to the request's page). */
export const AUTHORIZE_COOKIE = 'circle_hub_authorize';
export const SECURE_AUTHORIZE_COOKIE = '__Secure-circle_hub_authorize';
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
 * private-use scheme named by a reversed domain name (RFC 8252 7.1: `com.example.app:`), which leaves out the operating
 * system's own handlers (`tel:`, `ms-msdt:`, `search-ms:`, …); never a fragment or user information.
 */
export function redirectUriProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return 'not an absolute URI';
  }
  // Stored, shown and matched as sent: so it must be what a URL parser writes (no spaces, tabs or NUL, lower-case host).
  if (url.href !== uri) return 'a redirect URI is sent in its normalized form, as a URL parser writes it';
  if (uri.includes('#')) return 'a redirect URI has no fragment';
  if (url.username !== '' || url.password !== '') return 'a redirect URI has no user information';
  if (url.protocol === 'https:') return /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(url.hostname) || /^\[[0-9a-f:.]+\]$/.test(url.hostname) ? null : 'an https redirect URI names a DNS name or an IP address';
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname) ? null : 'http is accepted for loopback addresses only';
  if (REFUSED_SCHEMES.has(url.protocol) || !/^[a-z][a-z0-9+-]*(?:\.[a-z0-9+-]+)+:$/.test(url.protocol)) return 'a private-use scheme is a reversed domain name, such as com.example.app';
  return null;
}

/** Whether a redirect URI leads to this machine of the browser (an http loopback address) rather than to another host. */
export function redirectIsLocal(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
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
  if (url.href !== sent || url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username !== '' || url.password !== '' || sent.includes('#')) return false;
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
  /** Only what the page shows and the code needs, not the client's whole registration. */
  client: Pick<OAuthClient, 'id' | 'name'>;
  redirectUri: string;
  /** Whether the request named its redirect URI (the token request must then name the same, RFC 6749 4.1.3). */
  redirectSent: boolean;
  state: string | null;
  challenge: string;
  /** The sender's address, for the bound on open requests per sender. */
  peer: string;
  /** The resource the token is for (RFC 8707): this Hub's /mcp on the origin of the request. */
  resource: string;
  issuer: string;
  /** Requests opened over HTTPS are answered only over HTTPS. */
  secure: boolean;
  created: number;
  /** CSRF token of the page's forms. */
  csrf: string;
  /** The value of the cookie that ties the request to the browser that opened it. */
  browser: string;
  /** The invitation the identity step accepted, and its account. */
  invitation: { id: string; user: string; name: string; role: PermissionRole } | null;
  /** Wrong invitation codes typed for this request. */
  failures: number;
  ended: 'approved' | 'denied' | null;
  /**
   * The decision under way or taken: where the browser goes next, or why not. A request is decided once; a second submit
   * (a double click) gets the same answer, so the browser never drops the redirect that carries the code.
   */
  decision: Promise<{ location: string } | { status: number; error: string }> | null;
}

export interface CodeGrant {
  client: string;
  redirectUri: string;
  redirectSent: boolean;
  challenge: string;
  resource: string;
  user: string;
  expires: number;
  used: boolean;
  /** The token the code was exchanged for (its value, kept while the code lives), revoked if the code comes back. */
  token: string | null;
  /** The code came back (RFC 6749 4.1.2): an exchange still under way revokes what it issues. */
  compromised: boolean;
}

export class AuthorizationStore {
  readonly #requests = new Map<string, AuthorizationRequest>();
  readonly #codes = new Map<string, CodeGrant>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** A new request, or null when too many are open (a flood is refused instead of evicting others' requests). */
  open(fields: Pick<AuthorizationRequest, 'client' | 'redirectUri' | 'redirectSent' | 'state' | 'challenge' | 'peer' | 'resource' | 'issuer' | 'secure'>): AuthorizationRequest | null {
    this.#prune();
    const own = [...this.#requests.values()].filter((request) => request.client.id === fields.client.id);
    if (own.length >= REQUESTS_PER_CLIENT) this.#requests.delete(own[0].id);
    const sender = [...this.#requests.values()].filter((request) => request.peer === fields.peer);
    if (sender.length >= REQUESTS_PER_PEER) this.#requests.delete(sender[0].id);
    if (this.#requests.size >= MAX_REQUESTS) return null;
    const request: AuthorizationRequest = { ...fields, id: secret(), created: this.#now(), csrf: secret(), browser: secret(), invitation: null, failures: 0, ended: null, decision: null };
    this.#requests.set(request.id, request);
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

  /** Approves an open request for `user`: the one-time code for the redirect; null for a request already decided. */
  grant(request: AuthorizationRequest, user: string): string | null {
    if (request.ended !== null) return null;
    this.#prune();
    const code = secret();
    request.ended = 'approved';
    this.#codes.set(digest(code), { client: request.client.id, redirectUri: request.redirectUri, redirectSent: request.redirectSent, challenge: request.challenge, resource: request.resource, user, expires: this.#now() + AUTHORIZATION_CODE_TTL_MS, used: false, token: null, compromised: false });
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
  /** Registrations per sender, in this process. */
  registrations?: RegistrationWindow;
  /** True for a request over the built-in TLS listener or the configured HTTPS proxy. */
  secureRequest: (request: IncomingMessage) => boolean;
  log: (line: string) => void;
}

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

/** The sender of a request: its peer address (behind the configured TLS proxy, the proxy, so all senders share it). */
export function peerOf(request: IncomingMessage): string {
  return (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/** Registrations of each sender in the last REGISTRATION_WINDOW_MS, in memory. */
export class RegistrationWindow {
  readonly #times = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Counts a registration of `peer`; false when it already made REGISTRATIONS_PER_PEER in the window. */
  take(peer: string): boolean {
    const now = this.#now();
    for (const [key, times] of this.#times) {
      const kept = times.filter((at) => now - at < REGISTRATION_WINDOW_MS);
      if (kept.length === 0) this.#times.delete(key);
      else this.#times.set(key, kept);
    }
    const times = this.#times.get(peer) ?? [];
    if (times.length >= REGISTRATIONS_PER_PEER) return false;
    times.push(now);
    this.#times.set(peer, times);
    return true;
  }

  clear(): void {
    this.#times.clear();
  }
}

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
    return authorize(request, response, url, options, issuer, secure, refuse);
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
  // RFC 7591 3.2.1: the server may replace metadata it does not support. Every client here is public (no secret is issued,
  // whatever token_endpoint_auth_method was asked) and gets the authorization code only; a client that cannot use the
  // authorization code at all is refused.
  const grants = metadata.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.includes('authorization_code'))) return oauthError(response, 400, 'invalid_client_metadata', 'grant_types must include authorization_code');
  const types = metadata.response_types;
  if (types !== undefined && (!Array.isArray(types) || !types.includes('code'))) return oauthError(response, 400, 'invalid_client_metadata', 'response_types must include code');
  if (options.registrations !== undefined && !options.registrations.take(peerOf(request))) return oauthError(response, 503, 'temporarily_unavailable', 'too many registrations from this sender; retry later', { 'retry-after': '600' });
  // At most 100 characters (code points, so no surrogate pair is cut), without control or format characters: a
  // self-chosen name is shown on the authorization page, where a bidirectional override could reorder the text around it.
  const given = typeof metadata.client_name === 'string' ? [...metadata.client_name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, 100).join('').trim() : '';
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

async function authorize(request: IncomingMessage, response: ServerResponse, url: URL, options: OAuthOptions, issuer: string, secure: boolean, refuse: AuthorizeRefusal): Promise<void> {
  const query = url.searchParams;
  for (const name of new Set(query.keys())) if (query.getAll(name).length > 1) return refuse(response, 400, '授权请求无效：参数重复。请在 Circle 中重新连接 Hub。');
  const client = await options.principals.client(query.get('client_id') ?? '');
  if (client === null) return refuse(response, 400, '授权请求无效：客户端未在本 Hub 登记。请在 Circle 中重新连接 Hub。');
  const sent = query.get('redirect_uri');
  const redirectUri = sent ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : null);
  if (redirectUri === null || !redirectMatches(client.redirect_uris, redirectUri)) return refuse(response, 400, '授权请求无效：回调地址与客户端登记的地址不一致。请在 Circle 中重新连接 Hub。');
  const state = query.get('state');
  // Refused before anybody looked at the request: a page, not a redirect to a URI the client chose for itself.
  if (query.get('response_type') !== 'code') return refuse(response, 400, '授权请求无效：只支持授权码（response_type=code）。请在 Circle 中重新连接 Hub。');
  const challenge = query.get('code_challenge');
  if (challenge === null || !CHALLENGE.test(challenge) || query.get('code_challenge_method') !== 'S256') return refuse(response, 400, '授权请求无效：需要 PKCE（code_challenge_method=S256）。请在 Circle 中重新连接 Hub。');
  if (state !== null && state.length > 2000) return refuse(response, 400, '授权请求无效：state 超过 2000 个字符。');
  const resource = `${issuer}/mcp`;
  const asked = query.get('resource');
  if (asked !== null && asked !== resource) return refuse(response, 400, '授权请求无效：访问范围不是本 Hub 的 MCP 服务。请在 Circle 中重新连接 Hub。');
  const opened = options.store.open({ client: { id: client.id, name: client.name }, redirectUri, redirectSent: sent !== null, state, challenge, peer: peerOf(request), resource, issuer, secure });
  if (opened === null) return refuse(response, 503, '当前待处理的授权请求过多，请稍后在 Circle 中重新连接 Hub。');
  const page = `${AUTHORIZE_PAGE}/${opened.id}`;
  setCommonHeaders(response);
  response.writeHead(303, {
    location: page,
    'content-length': '0',
    // Lax: the browser arrives from the client's own navigation, which a Strict cookie set on this redirect may not follow.
    'set-cookie': cookie(secure ? SECURE_AUTHORIZE_COOKIE : AUTHORIZE_COOKIE, opened.browser, page, AUTHORIZATION_REQUEST_TTL_MS / 1000, secure, true),
    ...NO_STORE,
  });
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
  if (taken === null) return oauthError(response, 400, 'invalid_grant', 'the authorization code is invalid or expired');
  const grant = taken.grant;
  if (taken.reused) {
    // RFC 6749 4.1.2: a code presented again revokes the token it gave; an exchange still under way revokes it itself.
    grant.compromised = true;
    if (grant.token !== null) await options.principals.revokeTokenValue(grant.token);
    options.log(`标准授权：客户端 ${client.id} 的授权码被再次使用，由它签发的令牌已吊销`);
    return oauthError(response, 400, 'invalid_grant', 'the authorization code was already used');
  }
  if (grant.client !== client.id) return oauthError(response, 400, 'invalid_grant', 'the authorization code is invalid or expired');
  // RFC 6749 4.1.3: required, and identical, when the authorization request named it.
  const sentUri = form.get('redirect_uri');
  if (grant.redirectSent ? sentUri !== grant.redirectUri : sentUri !== null && sentUri !== grant.redirectUri) return oauthError(response, 400, 'invalid_grant', 'redirect_uri differs from the authorization request');
  if (!pkceMatches(form.get('code_verifier') ?? '', grant.challenge)) return oauthError(response, 400, 'invalid_grant', 'code_verifier does not match the code_challenge');
  const resource = form.get('resource');
  if (resource !== null && resource !== grant.resource) return oauthError(response, 400, 'invalid_target', 'the resource differs from the authorization request');
  const user = await options.principals.get(grant.user);
  if (user === null || user.disabled) return oauthError(response, 400, 'invalid_grant', 'the account is not available');
  let issued: IssuedToken;
  try {
    issued = await options.principals.issueToken({ id: user.id, name: user.name, role: user.role }, user.id, client.name, client.id);
  } catch (error) {
    // The account was disabled meanwhile, or the client went away: not this request's fault, and no 500.
    if (error instanceof RecordsError && error.code === null && error.name !== 'IntegrityError') return oauthError(response, 400, 'invalid_grant', 'the account is not available');
    throw error;
  }
  if (grant.compromised) {
    await options.principals.revokeTokenValue(issued.token);
    return oauthError(response, 400, 'invalid_grant', 'the authorization code was used twice');
  }
  grant.token = issued.token;
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
