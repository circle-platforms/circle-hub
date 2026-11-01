// A read-only trial of a system pack with a configuration that is not saved: the console's 测试连接 before a business system
// is connected. The typed base URLs and credential values reach one HttpSource and nothing else: no resource, no secret, no
// session entry, no object, no record (a login that failed leaves its digest, never its values, in the vault entry
// TRIAL_LOGIN_STOPS). The configuration is checked by the rules of a saved resource (resource@1 and the
// pack's roles and credentials). The login exchange, when the pack declares one, is sent at most once and never repeated
// after a failure; the same values that failed are not sent again by any later trial, after a restart too, since an
// account may lock after repeated failures. Then every route a request can be made on without arguments (a literal path, no required
// query member, no body) is requested once, in the declared order, with the credential where its role carries it, until
// TRIAL_ROUTES routes or TRIAL_DEADLINE_MS; the answer is interpreted as a read interprets it (status, envelope, JSON) and
// dropped. A redirect is never followed: on a route declared with same-origin hops its result is unknown, on any other it
// is the refusal a read meets. A route that needs arguments is reported as not tried: no argument is invented. The report names routes, statuses, codes, sizes and times, never a body,
// a header value, a host or a credential; the admin log events pass the redactor.
import { createHash } from 'node:crypto';
import type { Environment } from '../../contracts/generated/vocabulary.ts';
import { ResourceRecord, type HttpMethod, type RouteDeclaration, type SystemProfile } from '../../contracts/src/resources.ts';
import { canonicalBytes, type RecordStore, type Vault } from '../records/api.ts';
import { CONNECTOR_ERRORS, ConnectorError, isConnectorErrorCode } from './errors.ts';
import { HttpSource, type ConnectorLog, type FetchLike } from './http.ts';
import { fillTemplate } from './login.ts';
import type { LoadedProfile } from './profiles.ts';
import type { Redactor } from './redact.ts';
import { declaredCredentials, profileProblem, storedCredential } from './resources.ts';

/** Routes one trial requests at most; the rest are reported as not tried. */
export const TRIAL_ROUTES = 20;
/** After this long no further route is requested; the rest are reported as not tried. */
export const TRIAL_DEADLINE_MS = 60_000;
/** The vault entry that keeps the digests of the trial logins that failed (`circle-hub secret list` names it). */
export const TRIAL_LOGIN_STOPS = 'login-stop.trial';
/** Digests kept; past it the oldest goes, one at a time (the list is never cleared). */
const REMEMBERED_FAILURES = 10_000;
const DIGEST = /^[0-9a-f]{64}$/;

/** The logins that failed in earlier trials, by digest: the same values are never sent again. */
export interface FailedLogins {
  /** Rejects when the record of failures cannot be read. */
  has(key: string): Promise<boolean>;
  /** False when only this process remembers it: the vault could not be written. */
  add(key: string): Promise<boolean>;
}

/**
 * The failed trial logins, sealed in the vault entry TRIAL_LOGIN_STOPS so that a restart does not forget them: digests of
 * the pack, the login origin and path and the filled body, never the values. Writers take the store's lock on the entry
 * (as CredentialStop does); what this process could not write it still remembers.
 */
export class TrialLoginStops implements FailedLogins {
  readonly #store: Pick<RecordStore, 'withTransaction' | 'lock'>;
  readonly #vault: Pick<Vault, 'getText' | 'put'>;
  readonly #memory = new Set<string>();
  constructor(store: Pick<RecordStore, 'withTransaction' | 'lock'>, vault: Pick<Vault, 'getText' | 'put'>) {
    this.#store = store;
    this.#vault = vault;
  }

  async #read(): Promise<string[]> {
    const text = await this.#vault.getText(TRIAL_LOGIN_STOPS);
    if (text === null) return [];
    const kept: unknown = JSON.parse(text);
    const failed = typeof kept === 'object' && kept !== null && (kept as { v?: unknown }).v === 1 ? (kept as { failed?: unknown }).failed : undefined;
    if (Array.isArray(failed) && failed.every((key) => typeof key === 'string' && DIGEST.test(key))) return failed;
    throw new ConnectorError('STORE_FAILED', '测试连接的登录失败记录不可读');
  }

  async has(key: string): Promise<boolean> {
    return this.#memory.has(key) || (await this.#read()).includes(key);
  }

  async add(key: string): Promise<boolean> {
    this.#memory.add(key);
    try {
      await this.#store.withTransaction(async (tx) => {
        await this.#store.lock(TRIAL_LOGIN_STOPS, tx);
        const failed = (await this.#read()).filter((kept) => kept !== key);
        failed.push(key);
        await this.#vault.put(TRIAL_LOGIN_STOPS, canonicalBytes({ v: 1, failed: failed.slice(-REMEMBERED_FAILURES) }));
      });
      return true;
    } catch {
      return false;
    }
  }
}

export interface SystemTrialInput {
  /** `id` or `id@x.y.z` of a published system pack. */
  system_pack: string;
  environment: Environment;
  /** Role of the system pack -> base URL, as a resource would give them. */
  origins: Record<string, string>;
  /** Origins (scheme://host[:port]) whose plain HTTP may carry credentials. */
  allow_plaintext?: string[];
  /** Credential name of the pack -> the value as typed; never kept. */
  credentials?: Record<string, string>;
}

export interface SystemTrialRoute {
  route: string;
  role: string;
  method: HttpMethod;
  /** The route's path template as the pack declares it. */
  path: string;
  tried: boolean;
  /** Why it was not tried, when it was not. */
  reason: string | null;
  /** Whether the answer was a good one, when tried. */
  ok: boolean | null;
  status: number | null;
  /** The connector code of a failure. */
  code: string | null;
  message: string | null;
  ms: number | null;
  bytes: number | null;
}

export interface SystemTrialReport {
  system_pack: { id: string; version: string; digest: string };
  environment: Environment;
  auth: {
    /** The pack's authentication: none, a static header, or a login exchange. */
    kind: SystemProfile['auth']['kind'];
    /** Whether a login exchange was sent. */
    sent: boolean;
    /** Whether authentication succeeded, as far as the trial knows: null when nothing judged it. */
    ok: boolean | null;
    /** Why no login was sent, or how authentication is checked. */
    reason: string | null;
    code: string | null;
    message: string | null;
    ms: number | null;
  };
  routes: SystemTrialRoute[];
  started_at: string;
  ended_at: string;
  /** Always false: the trial keeps nothing. */
  saved: false;
}

export interface SystemTrialOptions {
  load: (ref: string) => Promise<LoadedProfile>;
  redactor: Redactor;
  now: () => Date;
  fetch?: FetchLike;
  log?: ConnectorLog;
  /** The logins that failed in earlier trials, by digest (TrialLoginStops). */
  failedLogins: FailedLogins;
}

const PLACEHOLDER_RESOURCE = `res_${'0'.repeat(26)}`;
const PLACEHOLDER_USER = `usr_${'0'.repeat(26)}`;
const PLACEHOLDER_SECRET = '${secret:TRIAL}';

function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.slice(0, 3).map((issue) => `/${issue.path.map(String).join('/')}: ${issue.message}`).join('; ');
}

/**
 * What a failure says in the report: its generic text, the HTTP status, a short envelope code and the cause's text, never
 * the error's own message, which may quote what the source answered.
 */
function failure(error: ConnectorError): string {
  const detail = error.detail;
  const parts: string[] = [];
  if (typeof detail.status === 'number') parts.push(`HTTP ${detail.status}`);
  if (typeof detail.envelope_code === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(detail.envelope_code)) parts.push(`信封码 ${detail.envelope_code}`);
  if (isConnectorErrorCode(detail.cause)) parts.push(CONNECTOR_ERRORS[detail.cause]);
  const base = error.code === 'LOGIN_FAILED' ? '登录未成功' : CONNECTOR_ERRORS[error.code];
  return parts.length > 0 ? `${base}（${parts.join('，')}）` : base;
}

/** Whether a request can be made on `route` without arguments: a literal path, no required query member, no body. */
function argumentFree(route: RouteDeclaration): string | null {
  if (/\{[^}]+\}/.test(route.path)) return '路径含参数，试读时没有可用的取值';
  if (route.body !== undefined) return '需要请求体，试读时没有可用的取值';
  const query = route.query as { required?: readonly string[] } | undefined;
  if (query !== undefined && (query.required ?? []).length > 0) return '需要查询参数，试读时没有可用的取值';
  return null;
}

/** Runs one trial. The caller has checked that `by` is an administrator. */
export async function trialSystem(options: SystemTrialOptions, input: SystemTrialInput, by: string): Promise<SystemTrialReport> {
  const started = options.now();
  const loaded = await options.load(String(input?.system_pack));
  const { pack, profile } = loaded;
  const declared = declaredCredentials(profile);
  const parsed = ResourceRecord.safeParse({
    schema: 'resource@1',
    id: PLACEHOLDER_RESOURCE,
    system_pack: `${pack.id}@${pack.version}`,
    system_pack_digest: pack.digest,
    name: '试读',
    environment: input.environment,
    origins: input.origins,
    allow_plaintext: input.allow_plaintext ?? [],
    credentials: Object.fromEntries(declared.map((c) => [c.name, PLACEHOLDER_SECRET])),
    credential_digests: Object.fromEntries(declared.map((c) => [c.name, c.digest])),
    settings: {},
    created_by: /^usr_[0-9a-z]{26}$/.test(by) ? by : PLACEHOLDER_USER,
    created_at: started.toISOString(),
  });
  if (!parsed.success) throw new ConnectorError('RESOURCE_INVALID', `试读配置不符合资源的规则：${issuesOf(parsed.error)}`);
  const problem = profileProblem(parsed.data, profile);
  if (problem !== null) throw new ConnectorError('RESOURCE_INVALID', problem);
  const typed = input.credentials ?? {};
  for (const name of Object.keys(typed)) {
    if (!declared.some((c) => c.name === name)) throw new ConnectorError('RESOURCE_INVALID', `系统包没有声明凭据 ${name}`);
  }
  // Every value the trial may send is masked in whatever this process logs from now on.
  const values: Record<string, string> = {};
  for (const credential of declared) {
    const value = typed[credential.name];
    if (typeof value !== 'string' || value === '') continue;
    options.redactor.add(value);
    values[credential.name] = storedCredential(value, credential.digest);
    options.redactor.addSent(values[credential.name]);
  }
  const auth = profile.auth;
  const event = (name: string, detail: Record<string, unknown>) => {
    if (options.log === undefined) return;
    try {
      options.log({ at: options.now().toISOString(), event: name, resource: null, ...(options.redactor.value(detail) as Record<string, unknown>) });
    } catch {
      // A failing log sink never fails a trial.
    }
  };
  event('resource_trial', { system_pack: `${pack.id}@${pack.version}`, environment: input.environment });
  const http = new HttpSource({
    resource: 'trial',
    origins: parsed.data.origins,
    allowPlaintext: parsed.data.allow_plaintext,
    routes: profile.routes,
    envelope: profile.envelope ?? null,
    login: auth.kind === 'login_token' ? auth.login : null,
    fetch: options.fetch,
    log: options.log,
    redactor: options.redactor,
    now: () => options.now().getTime(),
  });

  const report: SystemTrialReport['auth'] = { kind: auth.kind, sent: false, ok: null, reason: null, code: null, message: null, ms: null };
  let header: { name: string; value: string } | null = null;
  let carriers = new Set<string>();
  if (auth.kind === 'none') {
    report.reason = '系统包声明不需要认证';
  } else if (auth.kind === 'static_header') {
    carriers = new Set(auth.roles);
    const value = values[auth.credential];
    if (value === undefined) report.reason = `凭据 ${auth.credential} 未填写，带凭据的接口未试读`;
    else {
      header = { name: auth.header.name, value: auth.header.scheme === 'bearer' ? `Bearer ${value}` : value };
      report.reason = '固定凭据随第一个带凭据的接口一并检验';
    }
  } else {
    carriers = new Set(auth.roles);
    const missing = declared.filter((c) => values[c.name] === undefined).map((c) => c.name);
    if (missing.length > 0) {
      report.reason = `凭据 ${missing.join('、')} 未填写，未登录`;
    } else {
      const body = fillTemplate(auth.login.body, values);
      const key = createHash('sha256').update(canonicalBytes({ pack: pack.id, origin: parsed.data.origins[auth.login.role], path: auth.login.path, body })).digest('hex');
      // A record of failures that cannot be read may hold these very values: the login is not sent.
      const failedBefore = await options.failedLogins.has(key).catch(() => null);
      if (failedBefore !== false) {
        report.reason = failedBefore === true ? '同样的凭据此前登录失败，未再次发送；更正凭据后再试' : '登录失败记录不可读，未登录';
      } else {
        const sentAt = options.now().getTime();
        try {
          const answer = await http.login(auth.login, body);
          report.sent = true;
          report.ok = true;
          header = { name: auth.header.name, value: auth.header.scheme === 'bearer' ? `Bearer ${answer.token}` : answer.token };
        } catch (error) {
          if (!(error instanceof ConnectorError)) throw error;
          // ORIGIN_REFUSED and PLAINTEXT_REFUSED come before any I/O: nothing was sent.
          const sent = error.code === 'LOGIN_FAILED';
          report.sent = sent;
          report.ok = false;
          report.code = error.code;
          report.message = failure(error);
          // A login the source may have judged is never sent again with the same values; one that provably never reached
          // the source (no connection) may be.
          if (sent && error.detail.delivered !== false && !(await options.failedLogins.add(key))) event('resource_trial_failure_unkept', {});
        }
        report.ms = options.now().getTime() - sentAt;
      }
    }
  }

  const routes: SystemTrialRoute[] = [];
  let tried = 0;
  for (const route of profile.routes) {
    const row: SystemTrialRoute = { route: route.id, role: route.role, method: route.method, path: route.path, tried: false, reason: null, ok: null, status: null, code: null, message: null, ms: null, bytes: null };
    routes.push(row);
    const needs = argumentFree(route);
    if (needs !== null) {
      row.reason = needs;
      continue;
    }
    const carries = carriers.has(route.role);
    if (carries && header === null) {
      row.reason = auth.kind === 'login_token' ? '需要登录，登录未成功或未发送' : '需要凭据，凭据未填写';
      continue;
    }
    if (tried >= TRIAL_ROUTES) {
      row.reason = `每次测试最多试读 ${TRIAL_ROUTES} 个接口`;
      continue;
    }
    if (options.now().getTime() - started.getTime() >= TRIAL_DEADLINE_MS) {
      row.reason = `测试已用时超过 ${TRIAL_DEADLINE_MS / 1000} 秒，其余接口未试读`;
      continue;
    }
    tried += 1;
    row.tried = true;
    const sentAt = options.now().getTime();
    try {
      // No `received` hook: the answer is interpreted in memory and dropped, never stored.
      const reply = await http.request({ route: route.id, method: route.method, path: route.path, query: {}, credential: carries ? header : null });
      row.ok = true;
      row.status = reply.status;
      row.bytes = reply.bytes.byteLength;
      row.ms = reply.endedAt - reply.startedAt;
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      row.code = error.code;
      row.status = typeof error.detail.status === 'number' ? error.detail.status : null;
      row.ms = options.now().getTime() - sentAt;
      // A read plans the hop of a route declared with same-origin redirects; the trial does not, so it cannot tell.
      const declaredHop = error.code === 'SOURCE_REDIRECT_REFUSED' && route.redirects !== undefined;
      row.ok = declaredHop ? null : false;
      row.message = declaredHop ? `应答要求同源跳转${row.status === null ? '' : `（HTTP ${row.status}）`}，试读不跟随跳转` : failure(error);
      // A static credential the source refused is checked by this route: the trial says so.
      if (auth.kind === 'static_header' && carries && (error.code === 'CREDENTIAL_REFUSED' || error.code === 'SOURCE_LOGIN_EXPIRED')) report.ok = false;
    }
    if (auth.kind === 'static_header' && carries && row.ok === true && report.ok === null) report.ok = true;
  }
  const ended = options.now();
  event('resource_trial_done', { system_pack: `${pack.id}@${pack.version}`, login: report.ok, tried, routes: routes.length });
  return {
    system_pack: { id: pack.id, version: pack.version, digest: pack.digest },
    environment: input.environment,
    auth: report,
    routes,
    started_at: started.toISOString(),
    ended_at: ended.toISOString(),
    saved: false,
  };
}
