// Console sign-in state, in memory only: a session id (the cookie) maps to the token it was opened with, so every page
// re-authenticates that token and a revoked token or a disabled account ends the session at once. The token never goes into
// the browser after sign-in. Login forms carry a one-time nonce the server issued (also in a cookie scoped to the login path).
import { createHash, randomBytes } from 'node:crypto';

export interface ConsoleSession {
  id: string;
  token: string;
  /** A proxy HTTPS session cannot be replayed over direct HTTP. */
  secure: boolean;
  /** CSRF token of the session's forms. */
  csrf: string;
  created: number;
  seen: number;
}

export interface SessionLimits {
  idleMs: number;
  absoluteMs: number;
  nonceMs: number;
  maxSessions: number;
  maxNonces: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  idleMs: 2 * 60 * 60 * 1000,
  absoluteMs: 12 * 60 * 60 * 1000,
  nonceMs: 15 * 60 * 1000,
  maxSessions: 1000,
  maxNonces: 1000,
};

export const SESSION_COOKIE = 'circle_hub_session';
export const LOGIN_COOKIE = 'circle_hub_login';
export const SECURE_SESSION_COOKIE = '__Secure-circle_hub_session';
export const SECURE_LOGIN_COOKIE = '__Secure-circle_hub_login';

const secret = (): string => randomBytes(32).toString('base64url');

export class SessionStore {
  readonly #sessions = new Map<string, ConsoleSession>();
  readonly #nonces = new Map<string, { expires: number; secure: boolean }>();
  readonly #now: () => number;
  readonly #limits: SessionLimits;

  constructor(now: () => number = Date.now, limits: Partial<SessionLimits> = {}) {
    this.#now = now;
    this.#limits = { ...DEFAULT_SESSION_LIMITS, ...limits };
  }

  /** A one-time login nonce; the oldest are dropped beyond the limit. */
  issueNonce(secure = false): string {
    const nonce = secret();
    this.#nonces.set(nonce, { expires: this.#now() + this.#limits.nonceMs, secure });
    while (this.#nonces.size > this.#limits.maxNonces) this.#nonces.delete(this.#nonces.keys().next().value!);
    return nonce;
  }

  /** True once for a nonce this store issued and that has not expired. */
  takeNonce(nonce: string, secure = false): boolean {
    const entry = this.#nonces.get(nonce);
    if (entry === undefined || entry.secure !== secure) return false;
    this.#nonces.delete(nonce);
    return entry.expires > this.#now();
  }

  open(token: string, secure = false): ConsoleSession {
    const at = this.#now();
    const session: ConsoleSession = { id: secret(), token, secure, csrf: secret(), created: at, seen: at };
    this.#sessions.set(session.id, session);
    while (this.#sessions.size > this.#limits.maxSessions) this.#sessions.delete(this.#sessions.keys().next().value!);
    return session;
  }

  get(id: string | undefined, secure = false): ConsoleSession | null {
    if (id === undefined) return null;
    const session = this.#sessions.get(id);
    if (session === undefined || session.secure !== secure) return null;
    const at = this.#now();
    if (at - session.seen > this.#limits.idleMs || at - session.created > this.#limits.absoluteMs) {
      this.#sessions.delete(id);
      return null;
    }
    session.seen = at;
    return session;
  }

  close(id: string | undefined): void {
    if (id !== undefined) this.#sessions.delete(id);
  }

  clear(): void {
    this.#sessions.clear();
    this.#nonces.clear();
  }
}

/** Set-Cookie value: HttpOnly, SameSite=Strict, scoped to a path; no Max-Age makes it end with the browser session. */
export function cookie(name: string, value: string, path: string, maxAgeSeconds?: number, secure = false): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict${maxAgeSeconds === undefined ? '' : `; Max-Age=${maxAgeSeconds}`}${secure ? '; Secure' : ''}`;
}

export const LOGIN_LINK_TTL_MS = 5 * 60 * 1000;
const MAX_LOGIN_LINKS = 1000;
const HOME = '/console/overview';

/**
 * Where a console path may lead after sign-in: a path of this console (never another host, never a scheme-relative or
 * backslash path, no control characters), with its query; anything else is the overview.
 */
export function safeNext(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length > 500 || !value.startsWith('/console') || /[\\\u0000-\u001f\u007f]/.test(value)) return HOME;
  try {
    const url = new URL(value, 'http://console.invalid');
    if (url.host !== 'console.invalid' || !(url.pathname === '/console' || url.pathname.startsWith('/console/')) || url.pathname.startsWith('/console/login')) return HOME;
    return `${url.pathname}${url.search}`;
  } catch {
    return HOME;
  }
}

/**
 * One-time login links (decision 78), in memory like the sessions: a client asks for one with its Bearer token
 * (POST /console/api/login-links); the browser opens it within LOGIN_LINK_TTL_MS, confirms, and gets a session on that
 * token, which every page re-authenticates. Only the SHA-256 of a link's code is kept; a code works once.
 */
export class LoginLinkStore {
  readonly #links = new Map<string, { token: string; next: string; expires: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  issue(token: string, next: string): { code: string; expires: number } {
    const at = this.#now();
    for (const [key, link] of this.#links) if (link.expires <= at) this.#links.delete(key);
    const code = secret();
    const expires = at + LOGIN_LINK_TTL_MS;
    this.#links.set(digest(code), { token, next: safeNext(next), expires });
    while (this.#links.size > MAX_LOGIN_LINKS) this.#links.delete(this.#links.keys().next().value!);
    return { code, expires };
  }

  /** The link of a code that has not been used or expired, without using it. */
  peek(code: string): { token: string; next: string } | null {
    const link = this.#links.get(digest(code));
    if (link === undefined || link.expires <= this.#now()) return null;
    return { token: link.token, next: link.next };
  }

  take(code: string): { token: string; next: string } | null {
    const link = this.peek(code);
    this.#links.delete(digest(code));
    return link;
  }

  clear(): void {
    this.#links.clear();
  }
}

const digest = (code: string): string => createHash('sha256').update(code, 'utf8').digest('hex');
