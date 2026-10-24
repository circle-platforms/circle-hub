// The credential handling of one resource (D01 R[9]): LoginManager (login_token) and StaticCredential (static_header).
// - State lives in memory and, sealed, in the vault entry `connector.<resource>.session`, bound to what the session depends on
//   (origins, plaintext declarations, system pack version and digest, credentials and their digest rules): a stored session
//   of another binding is not used, so a token or a stop never carries over to another configuration.
// - The entry is what processes share (the running Hub and the CLI). Every write stores a new generation. Before this process
//   refuses (a stop, a cool-down), before it logs in, before it records a stop, a failed login or a confirmation, and in
//   status(), it reads the entry again: when another process removed it (`secret set`, `resource reset-login`) or stored a
//   generation this one did not write, the state a restart would load replaces the one in memory. Nothing else ends a stop:
//   not time, not a re-read of an unchanged entry, not an entry of another binding.
// - A login is marked in the entry (until its timeout) the moment it is decided; another process that needs a login while
//   the mark stands waits for that login's result instead of sending the same credentials. A decision that a reset or an
//   adopted change overtakes before the login is sent sends nothing.
// - A login happens when there is no token, when the token's known expiry is closer than the margin (an expiry the login
//   answer states is used only when it lies beyond the margin; otherwise it is unknown), or after an explicit "expired"
//   answer to a request that carried a confirmed token. Concurrent callers share one login: once the entry has been read
//   again, the decision to log in starts the login at once, so no second login can slip in while the vault is written.
// - A token is unconfirmed from the login that produced it until a request carrying it gets an answer that is not
//   "expired", whoever sent it. An "expired" answer to an unconfirmed token is a refusal: no second login.
// - A failed login is never retried. When the source answered (an envelope code, an HTTP status, no usable token), when the
//   outcome is unknown (a timeout, a connection lost after the request left) or when a fresh token was refused, logins STOP
//   until an admin sets a credential or resets the login (or the binding changes). Only a login that provably never reached
//   the source (no connection, no TLS session) starts a timed cool-down, after which one attempt is made again.
// - A static credential answered with 401 or an envelope "expired" code stops in the same way; until a request carrying the
//   stored value has been answered otherwise, one request at a time carries it, so a wrong value is refused once, not once
//   per request.
// - The exchange is never stored as a source and never logged; log events carry the outcome and the envelope code only.
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
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
  /**
   * The writer has a login in flight until this time (epoch milliseconds): another process that needs a login waits for its
   * result instead of sending the same credentials. Absent from entries written before it existed.
   */
  login_until: number | null;
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
/** The generation stored with every write of a session entry. */
const GENERATION = /^[A-Za-z0-9_-]{16,64}$/;
/** Generations of its own writes a store remembers (a write that reported a failure may still have landed). */
const OWN_GENERATIONS = 32;
/** A login's mark stands this long past its timeout (the answer still has to be judged and stored). */
const LOGIN_MARK_SLACK_MS = 5_000;
/** A mark is written again when the login gets its request slot only if the wait for the slot took at least this long. */
const LOGIN_MARK_RENEW_MS = 1_000;
/**
 * The longest a mark can stand: the longest timeout a resource or a login may declare (contracts/src/resources.ts, 300 s)
 * plus the slack. A mark further away is not a login in flight (a corrupt or misdated entry) and is not waited for.
 */
const LOGIN_MARK_MAX_MS = 300_000 + LOGIN_MARK_SLACK_MS;
/** How often a process waiting for another process's login reads the entry again. */
const LOGIN_WAIT_POLL_MS = 100;

function emptyState(binding: string): SessionState {
  return { v: 1, binding, token: null, expires_at: null, obtained_at: null, unconfirmed: false, cooldown_until: null, stopped: false, failed_at: null, failure: null, login_until: null };
}

function newGeneration(): string {
  return randomBytes(12).toString('base64url');
}

/** What identifies a stored entry: null for none, its generation, or the digest of its text when it has none (older entries). */
export function markOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as { generation?: unknown } | null;
    if (typeof value?.generation === 'string' && GENERATION.test(value.generation)) return value.generation;
  } catch {
    // Not JSON: identified by its digest.
  }
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function isTimeOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIME);
}

function iso(value: number | null): string | null {
  return value === null || !isTimeOrNull(value) ? null : new Date(value).toISOString();
}

/** The state an entry holds for this binding; null when there is none, it is of another binding or it does not parse. */
function parseState(text: string | null, binding: string): SessionState | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<SessionState>;
    const loginUntil = value?.login_until === undefined ? null : value.login_until;
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
      (value.failure === null || typeof value.failure === 'string') &&
      isTimeOrNull(loginUntil)
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
        login_until: loginUntil,
      };
    }
  } catch {
    // An unreadable entry holds no session for this binding; the next save overwrites it.
  }
  return null;
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

/**
 * The session entry of one resource: loaded once, changed in memory first, written to the vault in order under a new
 * generation each time, and read again (`refresh`) where another process's change must count.
 */
export class SessionStore {
  readonly #entry: string;
  readonly #binding: string;
  readonly #vault: Vault;
  readonly #failed: () => void;
  #state: SessionState | null = null;
  #loading: Promise<void> | null = null;
  /**
   * A refresh queued whose read has not started: callers join it, since its read comes after their call, unless a reset
   * came in between (its read would come before the reset's removal).
   */
  #refreshQueued: { clears: number; run: Promise<boolean> } | null = null;
  /** This store's vault reads and writes, one after another. */
  #queue: Promise<unknown> = Promise.resolve();
  /** The entry as this process last found or left it (markOf): undefined before the first load, null for no entry. */
  #seen: string | null | undefined = undefined;
  /** Generations this process wrote, newest last. */
  readonly #own: string[] = [];
  /** Resets made here (clear): a refresh asked for before one does not adopt what it reads. */
  #clears = 0;
  /** Incremented by every stop, reset and adopted change: a login or request in flight across one does not record its result. */
  epoch = 0;
  /** Incremented by every reset made here and every removal adopted from another process: an admin's decision. */
  resets = 0;

  constructor(entry: string, binding: string, vault: Vault, failed: () => void) {
    this.#entry = entry;
    this.#binding = binding;
    this.#vault = vault;
    this.#failed = failed;
  }

  get binding(): string {
    return this.#binding;
  }

  /** Runs `task` after every vault operation queued before it; the queue goes on whatever the task does. */
  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Loads the entry once; afterwards `state` is the current state. */
  async ready(): Promise<void> {
    if (this.#state !== null) return;
    this.#loading ??= this.#serial(async () => {
      if (this.#state !== null) return;
      const text = await this.#vault.getText(this.#entry);
      // A reset during the read set the state already; its removal is queued behind this read.
      if (this.#state !== null) return;
      this.#state = parseState(text, this.#binding) ?? emptyState(this.#binding);
      this.#seen = markOf(text);
    }).finally(() => {
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

  /** Writes the state current when the write runs, under a new generation; the last write holds the latest state. */
  persist(): Promise<void> {
    return this.#serial(async () => {
      const generation = newGeneration();
      this.#own.push(generation);
      if (this.#own.length > OWN_GENERATIONS) this.#own.shift();
      try {
        await this.#vault.put(this.#entry, JSON.stringify({ ...(this.#state ?? emptyState(this.#binding)), generation }));
        this.#seen = generation;
      } catch {
        this.#failed();
      }
    });
  }

  /** Forgets everything (an admin set a credential or reset the login). A removal that fails reaches the caller. */
  clear(): Promise<void> {
    this.epoch += 1;
    this.resets += 1;
    this.#clears += 1;
    this.#state = emptyState(this.#binding);
    return this.#serial(async () => {
      try {
        await this.#vault.remove(this.#entry);
      } catch (error) {
        this.#failed();
        throw error;
      }
      this.#seen = null;
    });
  }

  /**
   * Reads the entry again after this store's own reads and writes, with a read that starts after this call (callers that
   * come together share one). When another process removed it or stored a generation this one did not write, the state a
   * restart would load replaces the one in memory and the epoch moves on (an entry of another binding, or one that does not
   * parse, gives no state and takes none away). True when this read did. A vault that cannot be read changes nothing, and
   * neither does a read that a reset made here overtook: the reset wins.
   */
  refresh(): Promise<boolean> {
    const queued = this.#refreshQueued;
    if (queued !== null && queued.clears === this.#clears) return queued.run;
    const clears = this.#clears;
    const run = this.#serial(async () => {
      if (this.#refreshQueued?.run === run) this.#refreshQueued = null;
      if (this.#state === null) return false;
      let text: string | null;
      try {
        text = await this.#vault.getText(this.#entry);
      } catch {
        this.#failed();
        return false;
      }
      // A reset here since this refresh was asked for: what was read comes before the reset's removal.
      if (this.#clears !== clears) return false;
      const mark = markOf(text);
      if (mark !== null && this.#own.includes(mark)) {
        this.#seen = mark;
        return false;
      }
      if (mark === this.#seen) return false;
      this.#seen = mark;
      const stored = text === null ? emptyState(this.#binding) : parseState(text, this.#binding);
      if (stored === null) return false;
      this.epoch += 1;
      if (text === null) this.resets += 1;
      this.#state = stored;
      return true;
    });
    this.#refreshQueued = { clears, run };
    return run;
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

/** How a failed login ended, for its log event and its error. */
interface FailedLogin {
  code: string;
  failure: string;
  message: string;
  layer: ErrorLayer;
  delivered: boolean | null;
}

export class LoginManager {
  readonly #o: LoginManagerOptions;
  readonly #store: SessionStore;
  #http: HttpSource;
  #pending: Promise<string> | null = null;
  /** The wait for another process's login in flight, shared by the callers of this process. */
  #waiting: Promise<void> | null = null;
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
   * Before refusing (a stop, a cool-down) or logging in, the session entry is read again: another process may have reset
   * it, renewed the token or stopped, or have a login in flight, whose result is waited for. `fresh`: the token is
   * unconfirmed, so an "expired" answer to it is a refusal.
   */
  /** Read-only fast path; the caller checks the shared version stop before sending. Never starts a login. */
  async cachedToken():Promise<{token:string;fresh:boolean}|null> {
    await this.#store.ready();const s=this.#store.state;
    return this.#usable(s)&&s.token!==null?{token:s.token,fresh:s.unconfirmed}:null;
  }
  async token(): Promise<{ token: string; fresh: boolean }> {
    await this.#store.ready();
    for (;;) {
      if (this.#pending !== null) return { token: await this.#pending, fresh: true };
      if (!this.#usable(this.#store.state)) {
        await this.#store.refresh();
        if (this.#pending !== null) return { token: await this.#pending, fresh: true };
      }
      const s = this.#store.state;
      this.#refuseStopped(s);
      if (s.token !== null && this.#usable(s)) {
        this.#o.redactor.addSent(s.token);
        return { token: s.token, fresh: s.unconfirmed };
      }
      if (this.#elsewhere(s)) {
        await this.#waitElsewhere();
        continue;
      }
      return { token: await this.#login(s.token === null ? 'no_token' : 'expiry_time'), fresh: true };
    }
  }

  /** A token that may be sent as it is: no stop, no cool-down running, and its known expiry not within the margin. */
  #usable(s: SessionState): boolean {
    if (s.token === null || s.stopped || (s.cooldown_until !== null && this.#o.now() < s.cooldown_until)) return false;
    return !(s.expires_at !== null && s.expires_at - this.#o.expiryMarginMs <= this.#o.now());
  }

  /**
   * Another process marked a login in flight whose time is not up and lies within what a login can take (this process's own
   * mark exists only while #pending).
   */
  #elsewhere(s: SessionState): boolean {
    if (this.#pending !== null || s.login_until === null) return false;
    const left = s.login_until - this.#o.now();
    return left > 0 && left <= LOGIN_MARK_MAX_MS;
  }

  /**
   * Waits for another process's login in flight: until the entry changes (its result, a reset) or the mark's time is up,
   * reading the entry again every LOGIN_WAIT_POLL_MS. Bounded in real time as well, so a clock that stands still cannot keep
   * a read waiting forever. Callers of this process share one wait.
   */
  #waitElsewhere(): Promise<void> {
    this.#waiting ??= (async () => {
      const until = this.#store.state.login_until ?? 0;
      this.#event('login_waiting', { until: iso(until) });
      const deadline = performance.now() + Math.min(LOGIN_MARK_MAX_MS, Math.max(0, until - this.#o.now()));
      while (this.#elsewhere(this.#store.state) && performance.now() < deadline) {
        await sleep(LOGIN_WAIT_POLL_MS);
        await this.#store.refresh();
      }
    })().finally(() => {
      this.#waiting = null;
    });
    return this.#waiting;
  }

  /**
   * A request carrying `token` was answered with something other than "expired": the token is confirmed. The entry is read
   * again before the confirmation is stored, so a stop (or a renewal) another process stored meanwhile is not overwritten.
   */
  async confirmed(token: string): Promise<void> {
    await this.#store.ready();
    if (!this.#confirms(token)) return;
    await this.#store.refresh();
    if (!this.#confirms(token)) return;
    this.#store.set({ ...this.#store.state, unconfirmed: false });
    await this.#store.persist();
  }

  #confirms(token: string): boolean {
    const s = this.#store.state;
    return s.token === token && s.unconfirmed && !s.stopped;
  }

  /**
   * The request that carried `used` was answered "login expired". One login when `used` is the current confirmed token
   * (shared by every caller); the renewed token when another caller, or another process, already renewed it; a stop when
   * `used` was never confirmed (a second login would not help, and failures may lock the account). The session entry is
   * read again first, so a stop another process recorded is not met with a second login, and a login another process has
   * in flight is waited for.
   */
  async expired(used: string): Promise<string> {
    await this.#store.ready();
    for (;;) {
      if (this.#pending !== null) return this.#pending;
      await this.#store.refresh();
      if (this.#pending !== null) return this.#pending;
      const s = this.#store.state;
      if (s.token !== null && s.token !== used && this.#usable(s)) {
        this.#o.redactor.addSent(s.token);
        return s.token;
      }
      if (s.token === used && s.unconfirmed) return this.#stop('TOKEN_REFUSED', '登录后拿到的令牌被判过期；不再登录，管理员重新设置凭据或重置登录之前停止', used);
      if (this.#elsewhere(s)) {
        await this.#waitElsewhere();
        continue;
      }
      return this.#login('expired_answer');
    }
  }

  /**
   * The retry with `token` after a login was answered "expired" too. A token a login produced and nothing confirmed stops
   * the logins; one that was confirmed meanwhile only ends this read (the next read may log in once).
   */
  async refused(token: string): Promise<never> {
    await this.#store.ready();
    const s = this.#store.state;
    if (s.token === token && s.unconfirmed) return this.#stop('TOKEN_REFUSED', '登录后拿到的令牌被判过期；不再登录，管理员重新设置凭据或重置登录之前停止', token);
    if (s.stopped) throw this.#stoppedError(s);
    throw new ConnectorError('SOURCE_LOGIN_EXPIRED', '重新登录后令牌又被判过期；这次读取停下，不再登录', { layer: 'envelope' });
  }

  /** Forgets the token and ends a stop or cool-down (an admin set a credential or reset the login). */
  async reset(): Promise<void> {
    await this.#store.clear();
  }

  /** The state after reading the session entry again: a stop another process ended (the CLI) shows as ended. */
  async status(): Promise<LoginStatus> {
    await this.#store.ready();
    await this.#store.refresh();
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

  /**
   * Stops the logins because `judged`, a token no request confirmed, was answered "expired". Recorded only over the session
   * that holds that token: when it was confirmed, renewed or reset meanwhile (here or in another process), this read ends
   * and nothing is stopped.
   */
  async #stop(failure: string, message: string, judged: string): Promise<never> {
    await this.#store.refresh();
    const s = this.#store.state;
    if (s.token !== judged || !s.unconfirmed) {
      if (s.stopped) throw this.#stoppedError(s);
      throw new ConnectorError('SOURCE_LOGIN_EXPIRED', '令牌被判过期，但会话在此期间已更新或重置；这次读取停下，下一次读取按新的会话进行', { layer: 'envelope' });
    }
    this.#store.epoch += 1;
    this.#store.set({ ...s, token: null, expires_at: null, obtained_at: null, unconfirmed: false, stopped: true, cooldown_until: null, failed_at: this.#o.now(), failure, login_until: null });
    this.#event('login_stopped', { failure });
    await this.#store.persist();
    throw new ConnectorError('LOGIN_FAILED', message, { layer: 'envelope', detail: { stopped: true, code: failure } });
  }

  /** Starts one login, or joins the one in flight. Decides at once: no await before #pending is set. */
  #login(why: string): Promise<string> {
    if (this.#pending !== null) return this.#pending;
    this.#refuseStopped(this.#store.state);
    const pending: Promise<string> = this.#attempt(why, this.#store.epoch, this.#store.resets).finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }

  #dropped(): ConnectorError {
    return new ConnectorError('LOGIN_FAILED', '登录进行中时登录被重置、停止或在别的进程里改过；这次登录的结果不用', { layer: 'transport', detail: { dropped: true } });
  }

  /** The end of a mark written now: the login's timeout and the slack from now. */
  #markTime(): number {
    return this.#o.now() + this.#http.loginTimeoutMs(this.#o.login) + LOGIN_MARK_SLACK_MS;
  }

  async #attempt(why: string, epoch: number, resets: number): Promise<string> {
    // The token being replaced is not used again, whatever happens next. The login is marked in the entry at once: another
    // process that needs a login from now on waits for its result instead of sending the same credentials.
    let mark = this.#markTime();
    this.#store.set({ ...this.#store.state, token: null, expires_at: null, obtained_at: null, unconfirmed: false, login_until: mark });
    await this.#store.persist();
    const values: Record<string, string> = {};
    let body: unknown;
    try {
      for (const [name, entry] of Object.entries(this.#o.credentials)) {
        const value = await this.#o.vault.getText(entry);
        if (value === null || value === '') throw new ConnectorError('CREDENTIAL_MISSING', `资源 ${this.#o.resource} 的凭据 ${name} 还没有设置`, { detail: { credential: name } });
        this.#o.redactor.addSent(value);
        values[name] = value;
      }
      body = fillTemplate(this.#o.login.body, values);
    } catch (error) {
      // Nothing is sent: the mark goes, so that no other process waits for this login.
      await this.#unmark(mark, true);
      throw error;
    }
    const overtaken = new ConnectorError('LOGIN_FAILED', '登录发出之前登录被重置或在别的进程里改过；这次没有登录，下一次读取重新决定', { layer: 'transport', detail: { dropped: true, sent: false } });
    let answer: Awaited<ReturnType<HttpSource['login']>>;
    try {
      answer = await this.#http.login(this.#o.login, body, {
        // The login has its request slot and is sent next.
        sending: async () => {
          // A reset or another process's change since the decision: not sent, and the next read decides again.
          if (this.#store.epoch !== epoch) throw overtaken;
          this.attempts += 1;
          this.#event('login_attempt', { reason: why });
          // A long wait for the slot used up part of the mark: it is written again to cover the exchange.
          const renewed = this.#markTime();
          if (renewed - mark < LOGIN_MARK_RENEW_MS || this.#store.state.login_until !== mark) return;
          mark = renewed;
          this.#store.set({ ...this.#store.state, login_until: mark });
          await this.#store.persist();
        },
      });
    } catch (error) {
      if (error === overtaken || (error instanceof ConnectorError && NOT_SENT.has(error.code))) {
        await this.#unmark(mark, true);
        throw error;
      }
      await this.#unmark(mark, false);
      const failed = this.#failureOf(error);
      await this.#store.refresh();
      const changed = await this.#credentialsChanged(values);
      // Decided after the last await, so nothing that happened during these reads is missed. A failure counts only for the
      // credentials it was tried with: a reset made meanwhile (here, or a removal in another process) or a credential set
      // again since (the CLI's `secret set`) wins over it, and the next read makes the attempt.
      if (changed || this.#store.resets !== resets) {
        this.#event('login_failed', { code: failed.code, delivered: failed.delivered, dropped: true });
        throw this.#dropped();
      }
      return this.#failed(failed);
    }
    await this.#unmark(mark, false);
    if (this.#store.epoch !== epoch) throw this.#dropped();
    const now = this.#o.now();
    let expiresAt = answer.expiresAt;
    if (expiresAt !== null && (!isTimeOrNull(expiresAt) || expiresAt - this.#o.expiryMarginMs <= now)) {
      // Due already when stated (a short lifetime, a skewed clock or a misdeclared unit): renewal waits for an "expired" answer.
      this.#event('login_expiry_unusable', { stated: iso(expiresAt), margin_ms: this.#o.expiryMarginMs });
      expiresAt = null;
    }
    this.#store.set({ ...emptyState(this.#store.binding), token: answer.token, expires_at: expiresAt, obtained_at: now, unconfirmed: true });
    this.#o.redactor.addSent(answer.token);
    this.#event('login_ok', { expires_at: iso(expiresAt) });
    await this.#store.persist();
    return answer.token;
  }

  /**
   * This login's mark leaves memory (and with `store` the entry: nothing was sent, so no other process should wait for it),
   * unless a reset or an adopted state replaced it already. Otherwise the result written next replaces it in the entry.
   */
  async #unmark(mark: number, store: boolean): Promise<void> {
    const s = this.#store.state;
    if (s.login_until !== mark) return;
    this.#store.set({ ...s, login_until: null });
    if (store) await this.#store.persist();
  }

  /** True when a stored credential is no longer the value a login used (a vault that cannot be read: false). */
  async #credentialsChanged(used: Readonly<Record<string, string>>): Promise<boolean> {
    try {
      for (const [name, entry] of Object.entries(this.#o.credentials)) {
        if ((await this.#o.vault.getText(entry)) !== used[name]) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  #failureOf(error: unknown): FailedLogin {
    const known = error instanceof ConnectorError ? error : null;
    const code = known === null ? 'LOGIN_FAILED' : String(known.detail.envelope_code ?? known.detail.cause ?? known.detail.status ?? known.code);
    const delivered = known?.detail.delivered;
    return {
      code,
      failure: `LOGIN_FAILED:${code}`,
      message: known?.message ?? '登录失败',
      layer: known?.layer ?? 'transport',
      delivered: delivered === true || delivered === false ? delivered : null,
    };
  }

  /**
   * Records a failed login over the state current now (no await before the state is set): the state it judged, or what
   * another process stored meanwhile. Another process's usable token is used; another process's stop stands; a login that
   * never reached the source cools down; any other failure stops, over another process's cool-down too.
   */
  async #failed(f: FailedLogin): Promise<string> {
    const now = this.#o.now();
    const s = this.#store.state;
    if (s.token !== null && this.#usable(s)) {
      this.#event('login_failed', { code: f.code, delivered: f.delivered, other_token: true });
      this.#o.redactor.addSent(s.token);
      return s.token;
    }
    if (s.stopped) {
      this.#event('login_failed', { code: f.code, delivered: f.delivered, stopped: true });
      throw new ConnectorError('LOGIN_FAILED', `${f.message}；登录已经停止（${s.failure ?? '失败'}），管理员重新设置凭据或重置登录之前不再登录`, { layer: f.layer, detail: { stopped: true, code: f.code } });
    }
    const cleared = { ...s, token: null, expires_at: null, obtained_at: null, unconfirmed: false, login_until: null, failed_at: now, failure: f.failure };
    if (f.delivered === false) {
      const until = now + this.#o.cooldownMs;
      this.#store.set({ ...cleared, cooldown_until: until });
      this.#event('login_failed', { code: f.code, delivered: false, cooldown_until: iso(until) });
      await this.#store.persist();
      throw new ConnectorError('LOGIN_FAILED', `${f.message}；登录请求没有送达来源，冷却到 ${iso(until)}，之后再试一次`, { layer: f.layer, detail: { cooldown_until: iso(until), code: f.code } });
    }
    this.#store.epoch += 1;
    this.#store.set({ ...cleared, stopped: true, cooldown_until: null });
    this.#event('login_failed', { code: f.code, delivered: f.delivered, stopped: true });
    this.#event('login_stopped', { failure: f.failure });
    await this.#store.persist();
    throw new ConnectorError('LOGIN_FAILED', `${f.message}；不再重试，管理员重新设置凭据或重置登录之前停止`, { layer: f.layer, detail: { stopped: true, code: f.code } });
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
  /**
   * The value a request carrying it was answered with something other than a refusal (in this process), or null. A value set
   * since, here or by the CLI, is not accepted until it is answered.
   */
  #acceptedValue: string | null = null;
  /** While the stored value is not accepted, the one request in flight with it; others wait for its answer. */
  #probe: Promise<void> | null = null;
  #primed = false;
  /**
   * The epoch each header was handed out in and the value it carries: a refusal that arrives after a reset, an adopted change
   * or a new value judged a state that is gone.
   */
  readonly #sent = new WeakMap<StaticHeader, { epoch: number; value: string }>();

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

  /**
   * The header to send, unless the credential is stopped or missing. A value no answer accepted yet (the first one, or one
   * set since, here or by the CLI) goes to one caller at a time. The session entry is read again for every request (the
   * value is read for every request as well): a stop another process recorded is kept instead of sending the refused value
   * once more, and a reset or a new value from the CLI ends a stop here.
   */
  async acquire(): Promise<StaticHeader> {
    let value: string;
    for (;;) {
      await this.#store.ready();
      await this.#refresh();
      const s = this.#store.state;
      if (s.stopped) throw this.#stoppedError(s);
      const stored = await this.#o.vault.getText(this.#o.entry);
      if (stored === null || stored === '') {
        throw new ConnectorError('CREDENTIAL_MISSING', `资源 ${this.#o.resource} 的凭据 ${this.#o.credential} 还没有设置`, { detail: { credential: this.#o.credential } });
      }
      // Stopped while the value was read: decide again. Otherwise an accepted value goes out freely, another one only as
      // the one request in flight with it.
      if (this.#store.state.stopped) continue;
      if (stored === this.#acceptedValue || this.#probe === null) {
        value = stored;
        break;
      }
      await this.#probe;
    }
    const epoch = this.#store.epoch;
    let release: (() => void) | null = null;
    if (value !== this.#acceptedValue) this.#probe = new Promise<void>((resolve) => (release = resolve));
    const done = (accepted: boolean) => {
      // An answer to a value sent before a reset or an adopted change says nothing about the state in force now.
      if (accepted && this.#store.epoch === epoch) this.#acceptedValue = value;
      if (release !== null) {
        this.#probe = null;
        (release as () => void)();
        release = null;
      }
    };
    const headerValue = this.#headerValue(value);
    this.#o.redactor.addSent(value);
    this.#o.redactor.addSent(headerValue);
    let settled = false;
    const header: StaticHeader = {
      name: this.#o.header.name,
      value: headerValue,
      settle: (accepted) => {
        if (settled) return;
        settled = true;
        done(accepted);
      },
    };
    this.#sent.set(header, { epoch, value });
    return header;
  }

  /**
   * The source refused the value (401 or an envelope "expired" code): stop until an admin acts, then release any waiter.
   * Recorded only over the state the value was sent in: when the credential was set again or reset meanwhile (here or in
   * another process), this request fails and nothing is stopped.
   */
  async refused(error: ConnectorError, header: StaticHeader): Promise<never> {
    const status = error.detail.status;
    const code = typeof status === 'number' && status !== 200 ? `HTTP_${status}` : String(error.detail.envelope_code ?? error.code);
    const sent = this.#sent.get(header);
    await this.#refresh();
    const changed = sent !== undefined && (await this.#valueChanged(sent.value));
    // Decided after the last await: a reset or a change adopted during the reads above is not overwritten by this stop.
    if (sent === undefined || changed || sent.epoch !== this.#store.epoch) {
      header.settle(false);
      const s = this.#store.state;
      if (s.stopped) throw this.#stoppedError(s);
      throw new ConnectorError('CREDENTIAL_REFUSED', `来源拒绝了凭据 ${this.#o.credential}（${code}）；请求发出后凭据被重新设置或重置，这次不停止，下一次读取按新的状态`, {
        layer: error.layer,
        detail: { stopped: false, code },
      });
    }
    const failure = `CREDENTIAL_REFUSED:${code}`;
    this.#store.epoch += 1;
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
    this.#acceptedValue = null;
    this.#primed = false;
    await this.#store.clear();
  }

  /** The state after reading the session entry again: a stop another process ended (the CLI) shows as ended. */
  async status(): Promise<LoginStatus> {
    await this.#store.ready();
    await this.#refresh();
    return this.#store.status();
  }

  /** Reads the session entry again; a state another process left starts over: one request at a time until one is answered. */
  async #refresh(): Promise<void> {
    if (await this.#store.refresh()) {
      this.#acceptedValue = null;
      this.#primed = false;
    }
  }

  /** True when the stored value is no longer `value` (a vault that cannot be read: false). */
  async #valueChanged(value: string): Promise<boolean> {
    try {
      return (await this.#o.vault.getText(this.#o.entry)) !== value;
    } catch {
      return false;
    }
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
