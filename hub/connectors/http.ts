import {retryAfterMs} from './read-retry.ts';
// HttpSource: the only way the connectors reach an external system. Per request, before any network I/O: the route allow-list
// (routes.ts), the same-origin rule (the URL is the role's base URL plus the route-space path, and parsing it must change
// nothing), and the plaintext rule (a credential goes over plain HTTP only to an origin the resource declares allow_plaintext).
// Then: a bounded number of requests in flight and a least interval between starts, a timeout over the whole exchange,
// redirects refused (never followed), a byte cap checked on Content-Length and while reading (never truncated). The complete
// answer goes to the `received` hook before anything interprets it; then 3xx, 401, other statuses and the envelope of a JSON
// answer are mapped to typed errors (401 and an envelope "expired" code to SOURCE_LOGIN_EXPIRED; a JSON answer to a request
// that carried the credential is read for the expired codes even on a route that declares no envelope). A request whose URL
// is the login exchange is refused: only the login handling sends it. Messages and log events carry route ids, codes and
// sizes, never a header value, a host or a body.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  DEFAULT_MEDIA_TYPES,
  type EnvelopeDeclaration,
  type HttpMethod,
  type LoginDeclaration,
  type ResourceLimits,
  type RouteDeclaration,
} from '../../contracts/src/resources.ts';
import { mediaTypeEssence } from '../refs/api.ts';
import { ConnectorError, type ErrorLayer } from './errors.ts';
import { Redactor } from './redact.ts';
import { compileRoutes, matchRoute, splitPath, type CompiledRoute } from './routes.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** One admin log event. Every string in it has passed the redactor. */
export interface ConnectorLogEvent {
  at: string;
  event: string;
  resource: string | null;
  [key: string]: unknown;
}
export type ConnectorLog = (event: ConnectorLogEvent) => void;

export interface HttpSourceOptions {
  /** Resource id, for log events. */
  resource: string;
  /** Base URL of each role. */
  origins: Readonly<Record<string, string>>;
  /** Origins whose plain HTTP may carry credentials. */
  allowPlaintext: readonly string[];
  routes: readonly RouteDeclaration[];
  envelope?: EnvelopeDeclaration | null;
  /** The login exchange of the profile: no read request may go to its URL. */
  login?: LoginDeclaration | null;
  limits?: ResourceLimits;
  fetch?: FetchLike;
  log?: ConnectorLog;
  redactor?: Redactor;
  now?: () => number;
}

export interface HttpRequest {
  /** The route the caller means; it must be the route that matches. */
  route?: string;
  method: HttpMethod;
  /** Route-space path: relative to the base URL of the route's role, percent-encoded. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** The credential header, when the route's role carries the credential. */
  credential?: { name: string; value: string } | null;
}

export interface HttpExchange {
  /** Kept inside the connector until its safe observation is built. */
  location?:string;
  route: RouteDeclaration;
  method: HttpMethod;
  path: string;
  query: Record<string, string>;
  body: unknown;
  /** The full URL. For the connectors only: never handed to pack functions, never put into a message. */
  url: string;
  status: number;
  serverMediaType: string;
  mediaType: string;
  etag: string | null;
  bytes: Uint8Array;
  sha256: string;
  startedAt: number;
  endedAt: number;
  credentialSent: boolean;
  retryAfterInvalid?:boolean;
  retryAfterMs?:number;
}

export interface HttpReply extends HttpExchange {
  /** The parsed answer of a json route. */
  json?: unknown;
  /** The decoded answer of a text, xml or html route. */
  text?: string;
}

export interface RequestHooks {
  /** Called with the complete answer before anything interprets it; the read stores it here. */
  received?: (exchange: HttpExchange) => Promise<void>;
}

export interface LoginAnswer {
  token: string;
  /** Epoch milliseconds, or null when the answer says nothing about expiry. */
  expiresAt: number | null;
}

export interface LoginHooks {
  /**
   * Called once the login has its turn (a slot within the resource's limits) and just before it is sent; nothing is sent
   * until it returns. What it throws reaches the caller unchanged: the login was not sent.
   */
  sending?: () => Promise<void>;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOGIN_MAX_BYTES = 64 * 1024;
/** Failures before a connection carried a byte of the request: refused, no route or name, connect timeout, TLS handshake. */
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT']);
const HANDSHAKE_CODE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

/** Whether a fetch failure happened before the request reached the source (the cause chain names a connect-phase code). */
export function beforeDelivery(error: unknown, depth = 0): boolean {
  if (depth > 4 || error === null || typeof error !== 'object') return false;
  if (error instanceof AggregateError && error.errors.length > 0) return error.errors.every((inner) => beforeDelivery(inner, depth + 1));
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (CONNECT_CODES.has(code) || HANDSHAKE_CODE.test(code))) return true;
  return beforeDelivery((error as { cause?: unknown }).cause, depth + 1);
}

/** A path compared the way lenient servers compare it: decoded, case-insensitive, without a trailing slash. */
function loosePath(pathname: string): string {
  let text = pathname;
  try {
    text = decodeURIComponent(pathname);
  } catch {
    // keep the raw path
  }
  return text.toLowerCase().replace(/\/+$/, '');
}
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(\s*;\s*[A-Za-z0-9!#$&^_.+-]+=("[^"\\\r\n]*"|[A-Za-z0-9!#$&^_.+-]+))*$/;
const ETAG = /^[\x21-\x7e]{1,300}$/;
const TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** RFC 6901: the value at a JSON Pointer, or undefined. */
export function atPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current: unknown = value;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(token)) return undefined;
      current = current[Number(token)];
    } else if (typeof current === 'object' && current !== null && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function sameCode(value: unknown, codes: readonly (string | number)[]): boolean {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return codes.some((code) => String(code) === String(value));
}

/** Charset parameter of a media type, lower case, or null. */
export function charsetOf(mediaType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([A-Za-z0-9._:-]+)"?/i.exec(mediaType);
  return match === null ? null : match[1].toLowerCase();
}

/** Text of an answer in the charset its media type names (UTF-8 otherwise), without a byte order mark. */
export function decodeText(bytes: Uint8Array, mediaType: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(mediaType) ?? 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const text = decoder.decode(bytes);
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/**
 * Resolves the effective media type for an exchange.
 * An explicitly declared media type on the server response wins unless the server returned
 * application/octet-stream or omitted Content-Type, in which case a matching extension mapping
 * from the route declaration takes precedence over the generic default.
 */
export function effectiveMediaType(rawMediaType: string, route: RouteDeclaration, url: URL): string {
  const isOctetStream = rawMediaType !== '' && mediaTypeEssence(rawMediaType) === 'application/octet-stream';
  const isMissing = rawMediaType === '';
  if ((isOctetStream || isMissing) && route.media_types_by_extension) {
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // keep raw pathname
    }
    const ext = posix.extname(pathname).toLowerCase();
    if (ext !== '' && Object.hasOwn(route.media_types_by_extension, ext)) {
      return route.media_types_by_extension[ext];
    }
  }
  return isMissing ? DEFAULT_MEDIA_TYPES[route.response] : rawMediaType;
}

/** Splits a base URL into its origin and its path prefix (no trailing slash; empty for the root). */
export function splitBase(base: string): { origin: string; prefix: string } {
  const url = new URL(base);
  return { origin: url.origin, prefix: url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '') };
}

/** Bounded requests in flight and a least interval between two starts (wall clock, whatever clock the Hub is given). */
class Limiter {
  readonly #concurrency: number;
  readonly #interval: number;
  #active = 0;
  #queue: (() => void)[] = [];
  #nextStart = 0;

  constructor(concurrency: number, interval: number) {
    this.#concurrency = concurrency;
    this.#interval = interval;
  }

  async acquire(): Promise<() => void> {
    if (this.#active < this.#concurrency) this.#active += 1;
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    if (this.#interval > 0) {
      const start = Math.max(Date.now(), this.#nextStart);
      this.#nextStart = start + this.#interval;
      const wait = start - Date.now();
      if (wait > 0) await delay(wait);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) next();
      else this.#active -= 1;
    };
  }
}

interface RawAnswer {
  location?:string;
  retryAfterMs?:number;
  status: number;
  mediaType: string;
  etag: string | null;
  bytes: Uint8Array;
}

export class HttpSource {
  readonly resource: string;
  readonly #routes: CompiledRoute[];
  readonly #bases: Map<string, { origin: string; prefix: string }>;
  readonly #allowPlaintext: Set<string>;
  readonly #envelope: EnvelopeDeclaration | null;
  readonly #login: LoginDeclaration | null;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;
  readonly #log: ConnectorLog | undefined;
  readonly #redactor: Redactor;
  readonly #now: () => number;
  readonly #limiter: Limiter;

  constructor(options: HttpSourceOptions) {
    this.resource = options.resource;
    this.#routes = compileRoutes(options.routes);
    this.#bases = new Map(Object.entries(options.origins).map(([role, base]) => [role, splitBase(base)]));
    this.#allowPlaintext = new Set(options.allowPlaintext);
    this.#envelope = options.envelope ?? null;
    this.#login = options.login ?? null;
    this.#timeoutMs = options.limits?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#log = options.log;
    this.#redactor = options.redactor ?? new Redactor();
    this.#now = options.now ?? Date.now;
    this.#limiter = new Limiter(options.limits?.concurrency ?? DEFAULT_CONCURRENCY, options.limits?.interval_ms ?? 0);
  }

  /** The route a request is allowed by (no I/O). Throws ROUTE_REFUSED. */
  allowed(request: Omit<HttpRequest, 'credential'>): RouteDeclaration {
    return matchRoute(this.#routes, { method: request.method, path: request.path, query: request.query ?? {}, body: request.body }, request.route).declaration;
  }

  /**
   * Every check `request` makes before I/O, without sending: the allow-list, the URL, and the plaintext rule when the request
   * would carry a credential. The read engine calls it before it fetches a token, so a refused request never causes a login.
   */
  check(request: Omit<HttpRequest, 'credential'>, withCredential: boolean): RouteDeclaration {
    const route = this.allowed(request);
    const url = this.#url(route.role, request.path, request.query ?? {});
    this.#notLogin(url, route.id);
    if (withCredential) this.#plaintext(url, route.role);
    return route;
  }

  /** Base URL of a role as origin and path prefix, or null when the resource configures none. */
  base(role: string): { origin: string; prefix: string } | null {
    return this.#bases.get(role) ?? null;
  }

  /**
   * Resolves a link found in a response against `against` (a full URL the connectors keep) or the role's base, and returns it
   * as a route-space path and query, or throws ORIGIN_REFUSED when it leaves the role's origin or base path.
   */
  resolveHref(role: string, href: string, against: string | null): { path: string; query: Record<string, string> } {
    const base = this.#bases.get(role);
    if (base === undefined) throw new ConnectorError('ORIGIN_REFUSED', `资源没有为角色 ${role} 配置地址`, { layer: 'transport', detail: { role } });
    let url: URL;
    try {
      url = new URL(href.trim(), against ?? `${base.origin}${base.prefix}/`);
    } catch {
      throw new ConnectorError('ORIGIN_REFUSED', '链接不是合法的地址', { layer: 'transport', detail: { role } });
    }
    if (url.origin !== base.origin || url.username !== '' || url.password !== '') {
      throw new ConnectorError('ORIGIN_REFUSED', `链接指向角色 ${role} 的来源以外`, { layer: 'transport', detail: { role } });
    }
    if (base.prefix !== '' && url.pathname !== base.prefix && !url.pathname.startsWith(`${base.prefix}/`)) {
      throw new ConnectorError('ORIGIN_REFUSED', `链接不在角色 ${role} 的根路径之下`, { layer: 'transport', detail: { role } });
    }
    const path = url.pathname.slice(base.prefix.length) || '/';
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(query, key)) throw new ConnectorError('ROUTE_REFUSED', '链接里有重复的查询参数', { layer: 'transport', detail: { role } });
      query[key] = value;
    }
    return { path, query };
  }

  /** Sends one read request. See the file comment for the order of checks. */
  async request(request: HttpRequest, hooks: RequestHooks = {}): Promise<HttpReply> {
    const query = request.query ?? {};
    for (const [key, value] of Object.entries(query)) {
      if (typeof value !== 'string') throw new ConnectorError('ROUTE_REFUSED', `查询参数 ${this.#redactor.text(key)} 不是字符串`, { layer: 'transport' });
    }
    const route = matchRoute(this.#routes, { method: request.method, path: request.path, query, body: request.body }, request.route).declaration;
    const url = this.#url(route.role, request.path, query);
    this.#notLogin(url, route.id);
    const credential = request.credential ?? null;
    if (credential !== null) {
      this.#redactor.addSent(credential.value);
      this.#plaintext(url, route.role);
    }
    const headers: Record<string, string> = { accept: '*/*', 'user-agent': 'circle-hub', ...(route.headers ?? {}) };
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers['content-type'] = 'application/json';
    }
    if (credential !== null) headers[credential.name] = credential.value;
    const release = await this.#limiter.acquire();
    const startedAt = this.#now();
    let raw: RawAnswer;
    try {
      raw = await this.#send(url, request.method, headers, body, route.max_bytes, route.timeout_ms ?? this.#timeoutMs, route.id);
    } finally {
      release();
    }
    const endedAt = this.#now();
    const exchange: HttpExchange = {
      route,
      method: request.method,
      path: request.path,
      query,
      body: request.body,
      url: url.href,
      ...(raw.location===undefined?{}:{location:raw.location}),
      status: raw.status,
      serverMediaType: raw.mediaType === '' ? DEFAULT_MEDIA_TYPES[route.response] : raw.mediaType,
      mediaType: effectiveMediaType(raw.mediaType, route, url),
      etag: raw.etag,
      ...(raw.retryAfterMs===undefined?{}:Number.isNaN(raw.retryAfterMs)?{retryAfterInvalid:true}:{retryAfterMs:raw.retryAfterMs}),
      bytes: raw.bytes,
      sha256: createHash('sha256').update(raw.bytes).digest('hex'),
      startedAt,
      endedAt,
      credentialSent: credential !== null,
    };
    this.#event('http', { route: route.id, method: request.method, path: request.path, status: raw.status, bytes: raw.bytes.byteLength, ms: endedAt - startedAt });
    if (hooks.received) await hooks.received(exchange);
    return this.#interpret(exchange);
  }

  /**
   * The login exchange of the profile, the one request that carries credentials in its body. Its answer is parsed in memory
   * and never stored or logged; failures name the envelope code at most. Throws ORIGIN_REFUSED / PLAINTEXT_REFUSED when it
   * was refused before any I/O, else LOGIN_FAILED with `detail.delivered`: false when the request provably never reached the
   * source (no connection, no TLS session), true when the source answered (and so judged the credential), null when that is
   * unknown (a timeout or a connection lost after the request left).
   */
  async login(declaration: LoginDeclaration, body: unknown, hooks: LoginHooks = {}): Promise<LoginAnswer> {
    const url = this.#url(declaration.role, declaration.path, {});
    this.#plaintext(url, declaration.role);
    const release = await this.#limiter.acquire();
    let raw: RawAnswer;
    try {
      if (hooks.sending !== undefined) await hooks.sending();
      try {
        raw = await this.#send(
          url,
          'POST',
          { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'circle-hub' },
          JSON.stringify(body),
          declaration.max_bytes ?? LOGIN_MAX_BYTES,
          this.loginTimeoutMs(declaration),
          'login',
        );
      } catch (error) {
        const code = error instanceof ConnectorError ? error.code : 'SOURCE_UNREACHABLE';
        const delivered = error instanceof ConnectorError && error.detail.connect === true ? false : code === 'RESPONSE_TOO_LARGE' ? true : null;
        throw new ConnectorError('LOGIN_FAILED', `登录请求没有得到可用的应答（${code}）`, { layer: 'transport', detail: { cause: code, delivered } });
      }
    } finally {
      release();
    }
    const answered = (message: string, layer: ErrorLayer, detail: Record<string, unknown> = {}) => new ConnectorError('LOGIN_FAILED', message, { layer, detail: { ...detail, delivered: true } });
    if (raw.status < 200 || raw.status > 299) throw answered(`登录应答的 HTTP 状态是 ${raw.status}`, 'transport', { status: raw.status });
    let answer: unknown;
    try {
      answer = JSON.parse(decodeText(raw.bytes, raw.mediaType || 'application/json'));
    } catch {
      throw answered('登录应答不是 JSON', 'plugin');
    }
    const code = atPointer(answer, declaration.envelope.code);
    if (!sameCode(code, declaration.envelope.ok)) {
      const shown = typeof code === 'number' || (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) ? String(code) : '无';
      throw answered(`登录被拒绝（信封码 ${shown}）`, 'envelope', { envelope_code: shown });
    }
    const token = atPointer(answer, declaration.token);
    if (typeof token !== 'string' || !TOKEN.test(token)) throw answered('登录应答里没有可用的令牌', 'plugin');
    this.#redactor.addSent(token);
    let expiresAt: number | null = null;
    if (declaration.expiry !== undefined) {
      const value = atPointer(answer, declaration.expiry.pointer);
      expiresAt = expiryOf(value, declaration.expiry.unit);
    }
    return { token, expiresAt };
  }

  /** The longest a login exchange may take once sent: its declared timeout, else the resource's. */
  loginTimeoutMs(declaration: LoginDeclaration): number {
    return declaration.timeout_ms ?? this.#timeoutMs;
  }

  #url(role: string, path: string, query: Record<string, string>): URL {
    const base = this.#bases.get(role);
    if (base === undefined) throw new ConnectorError('ORIGIN_REFUSED', `资源没有为角色 ${role} 配置地址`, { layer: 'transport', detail: { role } });
    const split = splitPath(path);
    if (typeof split === 'string') throw new ConnectorError('ROUTE_REFUSED', `${split}；请求在发出前被拒绝`, { layer: 'transport', detail: { role } });
    const search = new URLSearchParams(query).toString();
    const text = `${base.origin}${base.prefix}${path}${search === '' ? '' : `?${search}`}`;
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new ConnectorError('ORIGIN_REFUSED', '拼出的地址不合法', { layer: 'transport', detail: { role } });
    }
    // Parsing must change nothing: no dot segment, backslash or host trick slipped through.
    if (url.origin !== base.origin || url.pathname !== `${base.prefix}${path}` || url.search !== (search === '' ? '' : `?${search}`) || url.hash !== '') {
      throw new ConnectorError('ORIGIN_REFUSED', '拼出的地址与资源配置的来源或路径不一致，请求在发出前被拒绝', { layer: 'transport', detail: { role } });
    }
    return url;
  }

  /** Refuses a read request whose URL is the login exchange (same origin and path, compared leniently). */
  #notLogin(url: URL, route: string): void {
    if (this.#login === null || !this.#bases.has(this.#login.role)) return;
    const login = this.#url(this.#login.role, this.#login.path, {});
    if (url.origin === login.origin && loosePath(url.pathname) === loosePath(login.pathname)) {
      throw new ConnectorError('ROUTE_REFUSED', `路由 ${route} 的请求指向登录交换本身；登录只由 Hub 的登录处理发出，请求在发出前被拒绝`, { layer: 'transport', detail: { route } });
    }
  }

  #plaintext(url: URL, role: string): void {
    if (url.protocol === 'http:' && !this.#allowPlaintext.has(url.origin)) {
      throw new ConnectorError('PLAINTEXT_REFUSED', `角色 ${role} 的地址是明文 HTTP，资源没有为它声明允许明文，凭据不发出`, { layer: 'transport', detail: { role } });
    }
  }

  async #send(url: URL, method: string, headers: Record<string, string>, body: string | undefined, maxBytes: number, timeoutMs: number, route: string): Promise<RawAnswer> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const fail = (error: unknown): ConnectorError => {
      if (error instanceof ConnectorError) return error;
      if (timedOut) return new ConnectorError('SOURCE_TIMEOUT', `路由 ${route} 超过 ${timeoutMs} 毫秒没有读完`, { layer: 'transport', detail: { route, timeout_ms: timeoutMs } });
      // `connect`: the failure came before the request reached the source (no connection or no TLS session).
      return new ConnectorError('SOURCE_UNREACHABLE', `路由 ${route} 连不上来源`, { layer: 'transport', detail: { route, connect: beforeDelivery(error) } });
    };
    try {
      let response: Response;
      try {
        response = await this.#fetch(url.href, { method, headers, body, redirect: 'manual', signal: controller.signal });
      } catch (error) {
        throw fail(error);
      }
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        throw new ConnectorError('RESPONSE_TOO_LARGE', `路由 ${route} 的应答声明 ${declared} 字节，超过上限 ${maxBytes} 字节；不截断保存`, {
          layer: 'transport',
          detail: { route, limit: maxBytes, declared },
        });
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body !== null) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
              controller.abort();
              throw new ConnectorError('RESPONSE_TOO_LARGE', `路由 ${route} 的应答超过上限 ${maxBytes} 字节，已中止读取；不截断保存`, { layer: 'transport', detail: { route, limit: maxBytes } });
            }
            chunks.push(value);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw fail(error);
        }
      }
      const contentType = response.headers.get('content-type');
      const etag = response.headers.get('etag');
      return {
        retryAfterMs:retryAfterMs(response.headers.get('retry-after'),this.#now()),
        ...(response.headers.get('location')===null?{}:{location:response.headers.get('location')!}),
        status: response.status,
        mediaType: contentType !== null && MEDIA_TYPE.test(contentType.trim()) ? contentType.trim() : '',
        etag: etag !== null && ETAG.test(etag) ? etag : null,
        bytes: Buffer.concat(chunks),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  #interpret(exchange: HttpExchange): HttpReply {
    const { route, status } = exchange;
    const detail = { route: route.id, status,...(exchange.retryAfterMs===undefined?{}:{retry_after_ms:exchange.retryAfterMs}) };
    const error = (code: ConstructorParameters<typeof ConnectorError>[0], message: string, layer: ErrorLayer, extra: Record<string, unknown> = {}): ConnectorError =>
      new ConnectorError(code, message, { layer, detail: { ...detail, ...extra } });
    if(exchange.retryAfterInvalid && (status===429 || status>=500 && status<=599))throw error('SOURCE_MALFORMED','来源 Retry-After 不是可表示的合法时间；请来源管理员修正该退避声明','transport');
    if (status >= 300 && status < 400) throw error('SOURCE_REDIRECT_REFUSED', `路由 ${route.id} 的应答要求重定向（HTTP ${status}），Hub 不跟随`, 'transport');
    if (status === 401) throw error('SOURCE_LOGIN_EXPIRED', `路由 ${route.id} 的应答是 HTTP 401`, 'transport');
    if (status === 403) throw error('SOURCE_FORBIDDEN', `路由 ${route.id} 的应答是 HTTP 403`, 'transport');
    if (status === 404 || status === 410) throw error('SOURCE_ABSENT', `路由 ${route.id} 的应答是 HTTP ${status}`, 'transport');
    if (status < 200 || status > 299) throw error('SOURCE_HTTP_STATUS', `路由 ${route.id} 的应答是 HTTP ${status}`, 'transport');
    if (route.response === 'bytes') return { ...exchange };
    const text = decodeText(exchange.bytes, exchange.mediaType);
    if (route.response !== 'json') return { ...exchange, text };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw error('SOURCE_MALFORMED', `路由 ${route.id} 的应答不是 JSON`, 'plugin');
    }
    const envelope = this.#envelope;
    if (envelope !== null && route.envelope !== false) {
      const code = atPointer(json, envelope.code);
      // when_present: an answer is an envelope when its code member exists, else it is a bare answer.
      const checked = route.envelope === true || (route.envelope === 'when_present' && code !== undefined);
      if (checked) {
        if (sameCode(code, envelope.expired)) throw error('SOURCE_LOGIN_EXPIRED', `路由 ${route.id} 的信封码说登录已过期`, 'envelope', { envelope_code: String(code) });
        if (!sameCode(code, envelope.ok)) {
          const message = envelope.message === undefined ? undefined : atPointer(json, envelope.message);
          const shown = typeof code === 'string' || typeof code === 'number' ? this.#redactor.text(String(code)).slice(0, 40) : '无';
          const said = typeof message === 'string' ? `：${this.#redactor.text(message).slice(0, 200)}` : '';
          throw error('SOURCE_ENVELOPE_ERROR', `路由 ${route.id} 的信封码是 ${shown}${said}`, 'envelope', { envelope_code: shown });
        }
      } else if (route.envelope === undefined && exchange.credentialSent && code !== undefined && sameCode(code, envelope.expired)) {
        // The login layer of a system answers every route with its envelope; a route without a declared envelope still
        // must not take "login expired" for its data.
        throw error('SOURCE_LOGIN_EXPIRED', `路由 ${route.id} 没有声明信封，但带凭据请求的应答在信封码的位置说登录已过期`, 'envelope', { envelope_code: String(code) });
      }
    }
    return { ...exchange, json, text };
  }

  #event(event: string, detail: Record<string, unknown>): void {
    if (this.#log === undefined) return;
    try {
      this.#log({ at: new Date(this.#now()).toISOString(), event, resource: this.resource, ...(this.#redactor.value(detail) as Record<string, unknown>) });
    } catch {
      // A failing log sink never fails a read.
    }
  }
}

/** Epoch milliseconds of a token expiry in the declared unit, or null when the value does not say. */
export function expiryOf(value: unknown, unit: 'epoch_seconds' | 'epoch_millis' | 'iso8601'): number | null {
  if (unit === 'iso8601') {
    if (typeof value !== 'string') return null;
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
  }
  const number = typeof value === 'string' && /^[0-9]{1,16}$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return null;
  const ms = unit === 'epoch_seconds' ? number * 1000 : number;
  // Beyond what a Date can hold the value says nothing usable.
  return ms <= 8.64e15 ? ms : null;
}
