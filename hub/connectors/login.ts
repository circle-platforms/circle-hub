// The credential handling of one resource (D01 R[9]): LoginManager (login_token) and StaticCredential (static_header).
// - State lives in memory and, sealed, in the vault entry `connector.<resource>.session`, bound to what the session depends on
//   (origins, plaintext declarations, system pack version and digest, credentials and their digest rules): a stored session
//   of another binding is not used, so a token or a stop never carries over to another configuration.
// - A login happens when there is no token, when the token's known expiry is closer than the margin (an expiry the login
//   answer states is used only when it lies beyond the margin; otherwise it is unknown), or after an explicit "expired"
//   answer to a request that carried a confirmed token. Concurrent callers share one login, and the decision to log in is
//   made without waiting on anything, so no second login can slip in while the vault is written.
// - A token is unconfirmed from the login that produced it until a request carrying it gets an answer that is not
//   "expired", whoever sent it. An "expired" answer to an unconfirmed token is a refusal: no second login.
// - A failed login is never retried. When the source answered (an envelope code, an HTTP status, no usable token), when the
//   outcome is unknown (a timeout, a connection lost after the request left) or when a fresh token was refused, logins STOP
//   until an admin sets a credential or resets the login (or the binding changes). Only a login that provably never reached
//   the source (no connection, no TLS session) starts a timed cool-down, after which one attempt is made again.
// - A static credential answered with 401 or an envelope "expired" code stops in the same way; until a request carrying it
//   has been answered otherwise, one request at a time carries it, so a wrong value is refused once, not once per request.
// - The exchange is never stored as a source and never logged; log events carry the outcome and the envelope code only.
import type { Vault } from '../records/api.ts';
import type { LoginDeclaration } from '../../contracts/src/resources.ts';
import { ConnectorError, type ErrorLayer } from './errors.ts';
import type { ConnectorLog, HttpSource } from './http.ts';
import { Redactor } from './redact.ts';

interface SessionState {
  v: 1;
  binding: string;
  token: string | null;
  /** Epoch milliseconds. */
  expires_at: number | null;
  obtained_at: number | null;
  /** True from the login that produced the token until a request carrying it is answered with anything but "expired". */
  unconfirmed: boolean;
  /** A login that never reached the source: none before this time, then one attempt again. */
  cooldown_until: number | null;
  /** The source refused, or the outcome of a login is unknown: nothing until an admin acts. */
  stopped: boolean;
  failed_at: number | null;
  /** Code of the last failure (never a message from the exchange). */
  failure: string | null;
}

export interface LoginStatus {
  token: boolean;
  expiresAt: string | null;
  obtainedAt: string | null;
  cooldownUntil: string | null;
  failure: string | null;
  /** Logins (or the static credential) stopped until an admin sets a credential or resets the login. */
  stopped: boolean;
}

/** Largest time a Date can hold, in epoch milliseconds. */
const MAX_TIME = 8.64e15;
/** Refusals of the login request before any I/O: nothing was sent, so no attempt was made. */
const NOT_SENT = new Set(['PLAINTEXT_REFUSED', 'ORIGIN_REFUSED', 'ROUTE_REFUSED']);

function emptyState(binding: string): SessionState {
  return { v: 1, binding, token: null, expires_at: null, obtained_at: null, unconfirmed: false, cooldown_until: null, stopped: false, failed_at: null, failure: null };
}

function isTimeOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIME);
}

function iso(value: number | null): string | null {
  return value === null || !isTimeOrNull(value) ? null : new Date(value).toISOString();
}

function parseState(text: string | null, binding: string): SessionState {
  if (text === null) return emptyState(binding);
  try {
    const value = JSON.parse(text) as Partial<SessionState>;
    if (
      value?.v === 1 &&
      value.binding === binding &&
      (value.token === null || typeof value.token === 'string') &&
      isTimeOrNull(value.expires_at) &&
      isTimeOrNull(value.obtained_at) &&
      typeof value.unconfirmed === 'boolean' &&
      isTimeOrNull(value.cooldown_until) &&
      typeof value.stopped === 'boolean' &&
      isTimeOrNull(value.failed_at) &&
      (value.failure === null || typeof value.failure === 'string')
    ) {
      return {
        v: 1,
        binding,
        token: value.token,
        expires_at: value.expires_at,
        obtained_at: value.obtained_at,
        unconfirmed: value.unconfirmed,
        cooldown_until: value.cooldown_until,
        stopped: value.stopped,
        failed_at: value.failed_at,
        failure: value.failure,
      };
    }
  } catch {
    // An unreadable entry counts as no session; the next save overwrites it.
  }
  return emptyState(binding);
}

/** Replaces `{name}` in every string of a JSON template by the value of that credential. */
export function fillTemplate(template: unknown, values: Readonly<Record<string, string>>, depth = 0): unknown {
  if (depth > 32) throw new ConnectorError('PROFILE_INVALID', '登录请求体模板嵌套太深');
  if (typeof template === 'string') {
    return template.replace(/\{([a-z][a-z0-9_]{0,31})\}/g, (all, name: string) => {
      const value = values[name];
      if (value === undefined) throw new ConnectorError('PROFILE_INVALID', `登录请求体模板引用了未声明的凭据 ${name}`);
      return value;
    });
  }
  if (Array.isArray(template)) return template.map((item) => fillTemplate(item, values, depth + 1));
  if (typeof template === 'object' && template !== null) {
    return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, fillTemplate(item, values, depth + 1)]));
  }
  return template;
}

/** The session entry of one resource: loaded once, changed in memory first, written to the vault in order. */
class SessionStore {
  readonly #entry: string;
  readonly #binding: string;
  readonly #vault: Vault;
  readonly #failed: () => void;
  #state: SessionState | null = null;
  #loading: Promise<void> | null = null;
  #writes: Promise<void> = Promise.resolve();
  /** Incremented by every stop and reset: a login in flight across one does not record its result. */
  generation = 0;

  constructor(entry: string, binding: string, vault: Vault, failed: () => void) {
    this.#entry = entry;
    this.#binding = binding;
    this.#vault = vault;
    this.#failed = failed;
  }

  get binding(): string {
    return this.#binding;
  }

  /** Loads the entry once; afterwards `state` is the current state. */
  async ready(): Promise<void> {
    if (this.#state !== null) return;
    this.#loading ??= (async () => {
      const text = await this.#vault.getText(this.#entry);
      this.#state ??= parseState(text, this.#binding);
    })().finally(() => {
      this.#loading = null;
    });
    await this.#loading;
  }

  get state(): SessionState {
    if (this.#state === null) throw new Error('session state used before it was loaded');
    return this.#state;
  }

  set(state: SessionState): void {
    this.#state = state;
  }

  /** Writes the state current when the write runs; writes run one after another, so the last one holds the latest state. */
  persist(): Promise<void> {
    const write = this.#writes.then(async () => {
      try {
        await this.#vault.put(this.#entry, JSON.stringify(this.#state ?? emptyState(this.#binding)));
      } catch {
        this.#failed();
      }
    });
    this.#writes = write;
    return write;
  }

  /** Forgets everything (an admin set a credential or reset the login). */
  clear(): Promise<void> {
    this.generation += 1;
    this.#state = emptyState(this.#binding);
    const write = this.#writes.then(async () => {
      try {
        await this.#vault.remove(this.#entry);
      } catch {
        this.#failed();
      }
    });
    this.#writes = write;
    return write;
  }

  status(): LoginStatus {
    const s = this.state;
    return { token: s.token !== null, expiresAt: iso(s.expires_at), obtainedAt: iso(s.obtained_at), cooldownUntil: iso(s.cooldown_until), failure: s.failure, stopped: s.stopped };
  }
}

function emit(log: ConnectorLog | undefined, redactor: Redactor, now: () => number, resource: string, event: string, detail: Record<string, unknown>): void {
  if (log === undefined) return;
  try {
    log({ at: new Date(now()).toISOString(), event, resource, ...(redactor.value(detail) as Record<string, unknown>) });
  } catch {
    // A failing log sink never fails a login.
  }
}

export interface LoginManagerOptions {
  resource: string;
  login: LoginDeclaration;
  /** Credential name -> vault entry. */
  credentials: Readonly<Record<string, string>>;
  sessionEntry: string;
  /** What the session depends on; a stored session of another binding is not used. */
  binding: string;
  vault: Vault;
  http: HttpSource;
  now: () => number;
  /** No login for this long after one that never reached the source. */
  cooldownMs: number;
  /** A token whose known expiry is closer than this is renewed before use. */
  expiryMarginMs: number;
  redactor: Redactor;
  log?: ConnectorLog;
}

export class LoginManager {
  readonly #o: LoginManagerOptions;
  readonly #store: SessionStore;
  #http: HttpSource;
  #pending: Promise<string> | null = null;
  /** Logins attempted by this manager (for tests and the admin view). */
  attempts = 0;

  constructor(options: LoginManagerOptions) {
    this.#o = options;
    this.#http = options.http;
    this.#store = new SessionStore(options.sessionEntry, options.binding, options.vault, () => this.#event('session_store_failed', {}));
  }

  get binding(): string {
    return this.#store.binding;
  }

  /** The transport of the current runtime (its limits may change without changing the binding). */
  useHttp(http: HttpSource): void {
    this.#http = http;
  }

  /** Makes the cached token known to the redactor without logging in, so plans and answers are checked against it. */
  async prime(): Promise<void> {
    await this.#store.ready();
    const token = this.#store.state.token;
    if (token !== null) this.#o.redactor.addSent(token);
  }

  /**
   * A token to send: the cached one unless its known expiry is near, else one login (shared with concurrent callers).
   * `fresh`: the token is unconfirmed, so an "expired" answer to it is a refusal, not an expiry.
   */
  async token(): Promise<{ token: string; fresh: boolean }> {
    await this.#store.ready();
    if (this.#pending !== null) return { token: await this.#pending, fresh: true };
    const s = this.#store.state;
    this.#refuseStopped(s);
    if (s.token !== null && !(s.expires_at !== null && s.expires_at - this.#o.expiryMarginMs <= this.#o.now())) {
      this.#o.redactor.addSent(s.token);
      return { token: s.token, fresh: s.unconfirmed };
    }
    return { token: await this.#login(s.token === null ? 'no_token' : 'expiry_time'), fresh: true };
  }

  /** A request carrying `token` was answered with something other than "expired": the token is confirmed. */
  async confirmed(token: string): Promise<void> {
    await this.#store.ready();
    const s = this.#store.state;
    if (s.token !== token || !s.unconfirmed) return;
    this.#store.set({ ...s, unconfirmed: false });
    await this.#store.persist();
  }

  /**
   * The request that carried `used` was answered "login expired". One login when `used` is the current confirmed token
   * (shared by every caller); the renewed token when another caller already renewed it; a stop when `used` was never
   * confirmed (a second login would not help, and failures may lock the account).
   */
  async expired(used: string): Promise<string> {
    await this.#store.ready();
    if (this.#pending !== null) return this.#pending;
    const s = this.#store.state;
    if (s.token !== null && s.token !== used) {
      this.#o.redactor.addSent(s.token);
      return s.token;
    }
    if (s.token === used && s.unconfirmed) return this.#stop('TOKEN_REFUSED', '登录后拿到的令牌被判过期；不再登录，管理员重新设置凭据或重置登录之前停止');
    return this.#login('expired_answer');
  }

  /**
   * The retry with `token` after a login was answered "expired" too. A token a login produced and nothing confirmed stops
   * the logins; one that was confirmed meanwhile only ends this read (the next read may log in once).
   */
  async refused(token: string): Promise<never> {
    await this.#store.ready();
    const s = this.#store.state;
    if (s.token === token && s.unconfirmed) return this.#stop('TOKEN_REFUSED', '登录后拿到的令牌被判过期；不再登录，管理员重新设置凭据或重置登录之前停止');
    if (s.stopped) throw this.#stoppedError(s);
    throw new ConnectorError('SOURCE_LOGIN_EXPIRED', '重新登录后令牌又被判过期；这次读取停下，不再登录', { layer: 'envelope' });
  }

  /** Forgets the token and ends a stop or cool-down (an admin set a credential or reset the login). */
  async reset(): Promise<void> {
    await this.#store.clear();
  }

  async status(): Promise<LoginStatus> {
    await this.#store.ready();
    return this.#store.status();
  }

  #refuseStopped(s: SessionState): void {
    if (s.stopped) throw this.#stoppedError(s);
    if (s.cooldown_until !== null && this.#o.now() < s.cooldown_until) {
      throw new ConnectorError('LOGIN_FAILED', `上次登录没有送达来源（${s.failure ?? '失败'}）；冷却到 ${iso(s.cooldown_until)}，之后再试一次`, {
        layer: 'transport',
        detail: { cooldown_until: iso(s.cooldown_until), failure: s.failure },
      });
    }
  }

  #stoppedError(s: SessionState): ConnectorError {
    return new ConnectorError('LOGIN_FAILED', `登录已停止（上次：${s.failure ?? '失败'}）；管理员重新设置凭据或重置登录之前不再登录`, {
      layer: 'envelope',
      detail: { stopped: true, failure: s.failure },
    });
  }

  async #stop(failure: string, message: string): Promise<never> {
    this.#store.generation += 1;
    this.#store.set({ ...this.#store.state, token: null, expires_at: null, obtained_at: null, unconfirmed: false, stopped: true, cooldown_until: null, failed_at: this.#o.now(), failure });
    this.#event('login_stopped', { failure });
    await this.#store.persist();
    throw new ConnectorError('LOGIN_FAILED', message, { layer: 'envelope', detail: { stopped: true, code: failure } });
  }

  /** Starts one login, or joins the one in flight. Decides at once: no await before #pending is set. */
  #login(why: string): Promise<string> {
    if (this.#pending !== null) return this.#pending;
    this.#refuseStopped(this.#store.state);
    const generation = this.#store.generation;
    const pending: Promise<string> = this.#attempt(why, generation).finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }

  #dropped(): ConnectorError {
    return new ConnectorError('LOGIN_FAILED', '登录进行中时登录被重置或停止；这次登录的结果不用', { layer: 'transport', detail: { dropped: true } });
  }

  async #attempt(why: string, generation: number): Promise<string> {
    // The token being replaced is not used again, whatever happens next.
    this.#store.set({ ...this.#store.state, token: null, expires_at: null, obtained_at: null, unconfirmed: false });
    const values: Record<string, string> = {};
    for (const [name, entry] of Object.entries(this.#o.credentials)) {
      const value = await this.#o.vault.getText(entry);
      if (value === null || value === '') throw new ConnectorError('CREDENTIAL_MISSING', `资源 ${this.#o.resource} 的凭据 ${name} 还没有设置`, { detail: { credential: name } });
      this.#o.redactor.add(value);
      values[name] = value;
    }
    const body = fillTemplate(this.#o.login.body, values);
    this.attempts += 1;
    this.#event('login_attempt', { reason: why });
    let answer: Awaited<ReturnType<HttpSource['login']>>;
    try {
      answer = await this.#http.login(this.#o.login, body);
    } catch (error) {
      if (error instanceof ConnectorError && NOT_SENT.has(error.code)) {
        this.attempts -= 1;
        throw error;
      }
      if (this.#store.generation !== generation) throw this.#dropped();
      return this.#failed(error);
    }
    if (this.#store.generation !== generation) throw this.#dropped();
    const now = this.#o.now();
    let expiresAt = answer.expiresAt;
    if (expiresAt !== null && (!isTimeOrNull(expiresAt) || expiresAt - this.#o.expiryMarginMs <= now)) {
      // Due already when stated (a short lifetime, a skewed clock or a misdeclared unit): renewal waits for an "expired" answer.
      this.#event('login_expiry_unusable', { stated: iso(expiresAt), margin_ms: this.#o.expiryMarginMs });
      expiresAt = null;
    }
    this.#store.set({ v: 1, binding: this.#store.binding, token: answer.token, expires_at: expiresAt, obtained_at: now, unconfirmed: true, cooldown_until: null, stopped: false, failed_at: null, failure: null });
    this.#o.redactor.addSent(answer.token);
    this.#event('login_ok', { expires_at: iso(expiresAt) });
    await this.#store.persist();
    return answer.token;
  }

  async #failed(error: unknown): Promise<never> {
    const now = this.#o.now();
    const known = error instanceof ConnectorError ? error : null;
    const code = known === null ? 'LOGIN_FAILED' : String(known.detail.envelope_code ?? known.detail.cause ?? known.detail.status ?? known.code);
    const failure = `LOGIN_FAILED:${code}`;
    const message = known?.message ?? '登录失败';
    const layer: ErrorLayer = known?.layer ?? 'transport';
    if (known?.detail.delivered === false) {
      const until = now + this.#o.cooldownMs;
      this.#store.set({ ...this.#store.state, cooldown_until: until, failed_at: now, failure });
      this.#event('login_failed', { code, delivered: false, cooldown_until: iso(until) });
      await this.#store.persist();
      throw new ConnectorError('LOGIN_FAILED', `${message}；登录请求没有送达来源，冷却到 ${iso(until)}，之后再试一次`, { layer, detail: { cooldown_until: iso(until), code } });
    }
    this.#store.generation += 1;
    this.#store.set({ ...this.#store.state, stopped: true, cooldown_until: null, failed_at: now, failure });
    this.#event('login_failed', { code, delivered: known?.detail.delivered ?? null, stopped: true });
    this.#event('login_stopped', { failure });
    await this.#store.persist();
    throw new ConnectorError('LOGIN_FAILED', `${message}；不再重试，管理员重新设置凭据或重置登录之前停止`, { layer, detail: { stopped: true, code } });
  }

  #event(event: string, detail: Record<string, unknown>): void {
    emit(this.#o.log, this.#o.redactor, this.#o.now, this.#o.resource, event, detail);
  }
}

export interface StaticCredentialOptions {
  resource: string;
  /** Credential name of the profile. */
  credential: string;
  /** Its vault entry. */
  entry: string;
  header: { name: string; scheme: 'raw' | 'bearer' };
  sessionEntry: string;
  binding: string;
  vault: Vault;
  now: () => number;
  redactor: Redactor;
  log?: ConnectorLog;
}

/** One header value to send, and what to report back when the request was answered. */
export interface StaticHeader {
  name: string;
  value: string;
  /** Called exactly once: `accepted` when the source judged the credential good enough to answer otherwise than 401. */
  settle(accepted: boolean): void;
}

export class StaticCredential {
  readonly #o: StaticCredentialOptions;
  readonly #store: SessionStore;
  /** A request carrying the value was answered with something other than a refusal (in this process). */
  #accepted = false;
  /** While not accepted, the one request in flight with the value; others wait for its answer. */
  #probe: Promise<void> | null = null;
  #primed = false;

  constructor(options: StaticCredentialOptions) {
    this.#o = options;
    this.#store = new SessionStore(options.sessionEntry, options.binding, options.vault, () => this.#event('session_store_failed', {}));
  }

  get binding(): string {
    return this.#store.binding;
  }

  /** Makes the value known to the redactor without sending anything. */
  async prime(): Promise<void> {
    if (this.#primed) return;
    const value = await this.#o.vault.getText(this.#o.entry);
    if (value === null || value === '') return;
    this.#o.redactor.addSent(value);
    this.#o.redactor.addSent(this.#headerValue(value));
    this.#primed = true;
  }

  /** The header to send, unless the credential is stopped or missing. Until one answer accepted it, one caller at a time. */
  async acquire(): Promise<StaticHeader> {
    for (;;) {
      await this.#store.ready();
      const s = this.#store.state;
      if (s.stopped) throw this.#stoppedError(s);
      if (this.#accepted || this.#probe === null) break;
      await this.#probe;
    }
    let release: (() => void) | null = null;
    if (!this.#accepted) this.#probe = new Promise<void>((resolve) => (release = resolve));
    const done = (accepted: boolean) => {
      if (accepted) this.#accepted = true;
      if (release !== null) {
        this.#probe = null;
        (release as () => void)();
        release = null;
      }
    };
    let value: string | null;
    try {
      value = await this.#o.vault.getText(this.#o.entry);
    } catch (error) {
      done(false);
      throw error;
    }
    if (value === null || value === '') {
      done(false);
      throw new ConnectorError('CREDENTIAL_MISSING', `资源 ${this.#o.resource} 的凭据 ${this.#o.credential} 还没有设置`, { detail: { credential: this.#o.credential } });
    }
    const header = this.#headerValue(value);
    this.#o.redactor.addSent(value);
    this.#o.redactor.addSent(header);
    let settled = false;
    return {
      name: this.#o.header.name,
      value: header,
      settle: (accepted) => {
        if (settled) return;
        settled = true;
        done(accepted);
      },
    };
  }

  /** The source refused the value (401 or an envelope "expired" code): stop until an admin acts, then release any waiter. */
  async refused(error: ConnectorError, header: StaticHeader): Promise<never> {
    const status = error.detail.status;
    const code = typeof status === 'number' && status !== 200 ? `HTTP_${status}` : String(error.detail.envelope_code ?? error.code);
    const failure = `CREDENTIAL_REFUSED:${code}`;
    this.#store.generation += 1;
    this.#store.set({ ...this.#store.state, stopped: true, failed_at: this.#o.now(), failure });
    header.settle(false);
    this.#event('credential_refused', { credential: this.#o.credential, code });
    this.#event('login_stopped', { failure });
    await this.#store.persist();
    throw new ConnectorError('CREDENTIAL_REFUSED', `来源拒绝了凭据 ${this.#o.credential}（${code}）；不再发送，管理员重新设置凭据或重置之前停止`, {
      layer: error.layer,
      detail: { stopped: true, code },
    });
  }

  /** Ends a stop (an admin set the credential again or reset it). */
  async reset(): Promise<void> {
    this.#accepted = false;
    this.#primed = false;
    await this.#store.clear();
  }

  async status(): Promise<LoginStatus> {
    await this.#store.ready();
    return this.#store.status();
  }

  #headerValue(value: string): string {
    return this.#o.header.scheme === 'bearer' ? `Bearer ${value}` : value;
  }

  #stoppedError(s: SessionState): ConnectorError {
    return new ConnectorError('CREDENTIAL_REFUSED', `来源拒绝了凭据 ${this.#o.credential}（上次：${s.failure ?? '拒绝'}）；管理员重新设置凭据或重置之前不再发送`, {
      layer: 'transport',
      detail: { stopped: true, failure: s.failure },
    });
  }

  #event(event: string, detail: Record<string, unknown>): void {
    emit(this.#o.log, this.#o.redactor, this.#o.now, this.#o.resource, event, detail);
  }
}
