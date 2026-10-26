// Console sign-in state, in memory only: a session id (the cookie) maps to the token it was opened with, so every page
// re-authenticates that token and a revoked token or a disabled account ends the session at once. The token never goes into
// the browser after sign-in. Login forms carry a one-time nonce the server issued (also in a cookie scoped to the login path).
import { randomBytes } from 'node:crypto';

export interface ConsoleSession {
  id: string;
  token: string;
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

const secret = (): string => randomBytes(32).toString('base64url');

export class SessionStore {
  readonly #sessions = new Map<string, ConsoleSession>();
  readonly #nonces = new Map<string, number>();
  readonly #now: () => number;
  readonly #limits: SessionLimits;

  constructor(now: () => number = Date.now, limits: Partial<SessionLimits> = {}) {
    this.#now = now;
    this.#limits = { ...DEFAULT_SESSION_LIMITS, ...limits };
  }

  /** A one-time login nonce; the oldest are dropped beyond the limit. */
  issueNonce(): string {
    const nonce = secret();
    this.#nonces.set(nonce, this.#now() + this.#limits.nonceMs);
    while (this.#nonces.size > this.#limits.maxNonces) this.#nonces.delete(this.#nonces.keys().next().value!);
    return nonce;
  }

  /** True once for a nonce this store issued and that has not expired. */
  takeNonce(nonce: string): boolean {
    const expires = this.#nonces.get(nonce);
    if (expires === undefined) return false;
    this.#nonces.delete(nonce);
    return expires > this.#now();
  }

  open(token: string): ConsoleSession {
    const at = this.#now();
    const session: ConsoleSession = { id: secret(), token, csrf: secret(), created: at, seen: at };
    this.#sessions.set(session.id, session);
    while (this.#sessions.size > this.#limits.maxSessions) this.#sessions.delete(this.#sessions.keys().next().value!);
    return session;
  }

  get(id: string | undefined): ConsoleSession | null {
    if (id === undefined) return null;
    const session = this.#sessions.get(id);
    if (session === undefined) return null;
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
export function cookie(name: string, value: string, path: string, maxAgeSeconds?: number): string {
  return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict${maxAgeSeconds === undefined ? '' : `; Max-Age=${maxAgeSeconds}`}`;
}
