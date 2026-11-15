// Console sign-in state: the session cookie holds the console-session token itself (principals.openConsoleSession).
// Every page re-authenticates that token; a revoked token or a disabled account ends the session at once. Idle time is
// tracked in memory by token digest only (restart with no row counts as just seen). Absolute lifetime is tokens.expires_at.
// CSRF is derived from the token (SHA-256 of a fixed label plus the token) and never stored. Login forms carry a one-time
// nonce the server issued (also in a cookie scoped to the login path).
import { createHash, randomBytes } from 'node:crypto';

export interface ConsoleSession {
  /** Same value as the cookie: the console-session token. */
  id: string;
  token: string;
  /** A proxy HTTPS session cannot be replayed over direct HTTP while this process still remembers the channel. */
  secure: boolean;
  /** CSRF token of the session's forms (derived from the token). */
  csrf: string;
  /** One response-only confirmation, set after a completed form action. Never carried by a URL. */
  notice?: string;
  created: number;
  seen: number;
}

export interface SessionLimits {
  idleMs: number;
  /** Unused: absolute lifetime is tokens.expires_at. Kept so call sites that pass Partial<SessionLimits> still typecheck. */
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
/** The one-time nonce of the device page's form (the user code a client shows is typed there). */
export const DEVICE_COOKIE = 'circle_hub_device';
export const SECURE_DEVICE_COOKIE = '__Secure-circle_hub_device';

const CSRF_LABEL = 'circle-hub-console-csrf:';

const secret = (): string => randomBytes(32).toString('base64url');
const digestOf = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** CSRF value derived from the console-session token; render and verify both recompute it. */
export function csrfOf(token: string): string {
  return createHash('sha256').update(CSRF_LABEL + token, 'utf8').digest('base64url');
}

/** Opaque id for artifact upload origin (never the bearer token). */
export function sessionOriginId(token: string): string {
  return digestOf(token);
}

export class SessionStore {
  /** Token digest → last activity and the channel it was opened on. */
  readonly #idle = new Map<string, { seen: number; secure: boolean; created: number }>();
  readonly #notices = new Map<string, string>();
  readonly #nonces = new Map<string, { expires: number; secure: boolean }>();
  readonly #attempts = new Map<string, { count: number; expires: number }>();
  readonly #now: () => number;
  readonly #limits: SessionLimits;

  constructor(now: () => number = Date.now, limits: Partial<SessionLimits> = {}) {
    this.#now = now;
    this.#limits = { ...DEFAULT_SESSION_LIMITS, ...limits };
  }

  /** Reserve before verification so concurrent failures cannot bypass the per-window bound. */
  takeLoginAttempt(key: string, maximum = 5): boolean {
    const now = this.#now();
    for (const [id, entry] of this.#attempts) if (entry.expires <= now) this.#attempts.delete(id);
    const entry = this.#attempts.get(key) ?? { count: 0, expires: now + 15 * 60 * 1000 };
    if (entry.count >= maximum || (!this.#attempts.has(key) && this.#attempts.size >= 10_000)) return false;
    entry.count++;
    this.#attempts.set(key, entry);
    return true;
  }
  clearLoginAttempts(key: string): void { this.#attempts.delete(key); }

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
    const dig = digestOf(token);
    this.#idle.set(dig, { seen: at, secure, created: at });
    this.#notices.delete(dig);
    while (this.#idle.size > this.#limits.maxSessions) this.#idle.delete(this.#idle.keys().next().value!);
    return this.#view(token, secure, at, at);
  }

  get(token: string | undefined, secure = false): ConsoleSession | null {
    return this.#lookup(token, secure, true);
  }

  /** Like get(), but a look does not count as activity: a live stream must not keep an unattended session open. */
  peek(token: string | undefined, secure = false): ConsoleSession | null {
    return this.#lookup(token, secure, false);
  }

  close(token: string | undefined): void {
    if (token === undefined) return;
    const dig = digestOf(token);
    this.#idle.delete(dig);
    this.#notices.delete(dig);
  }

  clear(): void {
    this.#idle.clear();
    this.#notices.clear();
    this.#nonces.clear();
    this.#attempts.clear();
  }

  #lookup(token: string | undefined, secure: boolean, touch: boolean): ConsoleSession | null {
    if (token === undefined || token.length === 0) return null;
    const dig = digestOf(token);
    const at = this.#now();
    const prior = this.#idle.get(dig);
    // Restart: no idle row means just seen (do not kick the browser out). Record it even on peek so idle still runs.
    if (prior === undefined) {
      this.#idle.set(dig, { seen: at, secure, created: at });
      while (this.#idle.size > this.#limits.maxSessions) this.#idle.delete(this.#idle.keys().next().value!);
      return this.#view(token, secure, at, at);
    }
    if (prior.secure !== secure) return null;
    // Keep the idle row on timeout so a later get/peek is not mistaken for a process restart
    // (no row → treat as just seen). Logout and open() still clear or replace the row.
    if (at - prior.seen > this.#limits.idleMs) return null;
    if (touch) {
      prior.seen = at;
      this.#idle.set(dig, prior);
    }
    return this.#view(token, secure, prior.created, touch ? at : prior.seen);
  }

  #view(token: string, secure: boolean, created: number, seen: number): ConsoleSession {
    const dig = digestOf(token);
    const notices = this.#notices;
    const session: ConsoleSession = { id: token, token, secure, csrf: csrfOf(token), created, seen };
    Object.defineProperty(session, 'notice', {
      enumerable: true,
      configurable: true,
      get: () => notices.get(dig),
      set: (value: string | undefined) => {
        if (value === undefined || value === '') notices.delete(dig);
        else notices.set(dig, value);
      },
    });
    return session;
  }
}

/**
 * Set-Cookie value: HttpOnly, SameSite=Strict (Lax where a top-level navigation from another site must carry it), scoped
 * to a path; no Max-Age makes it end with the browser session.
 */
export function cookie(name: string, value: string, path: string, maxAgeSeconds?: number, secure = false, lax = false): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=${lax ? 'Lax' : 'Strict'}${maxAgeSeconds === undefined ? '' : `; Max-Age=${maxAgeSeconds}`}${secure ? '; Secure' : ''}`;
}

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
