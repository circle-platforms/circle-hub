// Wiring of the connectors: the resource registry, one runtime per enabled resource (HttpSource, and the LoginManager or
// StaticCredential of the resource), the read engine, and the two ports of hub/ports.ts this package provides:
// ExternalReaderPort (accepts, read) and ResourceCatalogPort. A resource uses the system pack version and digest its
// configuration binds, nothing else. The credential handling of a resource is kept while what its session depends on (the
// binding: origins, plaintext declarations, pack version and digest, credentials and their rules) stays the same.
// The reader never throws and never says more to its caller than ok or not: the reason of a failure is for the admin log.
import { callPackFunction, osIsolationAvailable, type SandboxLimits } from '../rules/api.ts';
import { createDefaultRegistry, type ParserRegistry } from '../refs/api.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, PacksPort, ResourceCatalogPort, ResourceListing } from '../ports.ts';
import { canonicalBytes, sha256Hex, type Principal, type RecordsKit } from '../records/api.ts';
import type { ReadDeclaration } from '../../contracts/src/resources.ts';
import { ConnectorError, asConnectorError } from './errors.ts';
import { HttpSource, type ConnectorLog, type FetchLike } from './http.ts';
import { LoginManager, StaticCredential, type LoginStatus } from './login.ts';
import { ProfileCache, type LoadedProfile } from './profiles.ts';
import { ReadEngine, parseExternal, type PackFunctionRunner, type ReadArgs, type ReadOutcome, type ResourceRuntime } from './read.ts';
import { Redactor } from './redact.ts';
import { ResourceRegistry, sessionEntry, type AddResourceInput, type ResourceDescription, type ResourceState, type UpdateResourceInput } from './resources.ts';
import { compileRoutes } from './routes.ts';
import type { ResourceRecord } from '../../contracts/src/resources.ts';

export interface ConnectorsOptions {
  records: Pick<RecordsKit, 'store' | 'objects' | 'artifacts' | 'vault' | 'principals' | 'authorizations'>;
  /** Provided by runs: published packs (the system pack of each resource). */
  packs: PacksPort;
  /** Injectable for tests; default the global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  /** Admin log sink. Every string it receives has been redacted. */
  log?: ConnectorLog;
  sandbox?: {
    /** Default true; synthetic test environments without sandbox-exec may pass false (see hub/rules). */
    requireOsIsolation?: boolean;
    plan?: Partial<SandboxLimits>;
    project?: Partial<SandboxLimits>;
  };
  /** Replaces the sandbox call (tests wrap the real one). */
  callFunction?: PackFunctionRunner;
  parsers?: ParserRegistry;
  login?: {
    /** No login is attempted for this long after one that never reached the source, default 30 minutes. */
    cooldownMs?: number;
    /** A token whose known expiry is closer than this is renewed before use, default 1 minute. */
    expiryMarginMs?: number;
  };
  /** Nested reads (folder trees, for example) are served from memory this long, default 1 hour. */
  nestedCacheMs?: number;
  /** Bytes of stored artifacts the nested-read cache keeps at most, default 64 MiB. */
  nestedCacheBytes?: number;
  /** The resource list is reused this long before the records are read again, default 5 s. */
  resourceCacheMs?: number;
}

export interface ResourceAdmin {
  addResource(by: Principal, input: AddResourceInput): Promise<ResourceRecord>;
  updateResource(by: Principal, id: string, changes: UpdateResourceInput): Promise<ResourceRecord>;
  /** Admins get addresses and plaintext declarations; any other valid account the rows without them. */
  listResources(by: Principal): Promise<ResourceListing[]>;
  /**
   * Admins only: one resource, enabled or not, with the name, vault entry and digest rule of every credential it declares
   * and whether a value is set (never a value). Needs neither the system pack nor the vault key. Null for an id that is not
   * a resource.
   */
  describe(by: Principal, id: string): Promise<ResourceDescription | null>;
  setCredential(by: Principal, id: string, name: string, value: string): Promise<void>;
  /**
   * Admins only: several credentials of one resource in one call. Every value is checked before any is stored, and the
   * session is forgotten once, after the last (as setCredential does for one): a login that takes a user name and a
   * password needs both changed before a running Hub ends its stop, or a read in between logs in with half of them.
   */
  setCredentials(by: Principal, id: string, values: Readonly<Record<string, string>>): Promise<void>;
  disable(by: Principal, id: string, note?: string | null): Promise<void>;
  enable(by: Principal, id: string, note?: string | null): Promise<void>;
  /**
   * Admins only: whether a token is cached, its expiry, a cool-down and whether logins are stopped (never the token), after
   * reading the session entry again (a reset another process made shows at once).
   */
  loginStatus(by: Principal, id: string): Promise<LoginStatus | null>;
  /**
   * Admins only: ends a stop (or cool-down) of the login or the static credential of a resource without changing the
   * credential, so the next read that needs it makes one attempt. Setting a credential does the same. Either removes the
   * session entry, so a running Hub in another process ends the stop it holds at its next read that needs the credential.
   */
  resetLogin(by: Principal, id: string, note?: string | null): Promise<void>;
}

export interface Connectors {
  reader: ExternalReaderPort;
  catalog: ResourceCatalogPort;
  admin: ResourceAdmin;
  /** One read through one enabled resource by read name (the brief's executeRead). Never throws. */
  executeRead(resource: string, readName: string, args: ReadArgs, reader: ExternalReadContext): Promise<ReadOutcome>;
  /** Forgets cached profiles, resources and nested reads (after a publication or a withdrawal). */
  refresh(): void;
}

const DEFAULT_PLAN_LIMITS: Partial<SandboxLimits> = { timeoutMs: 10_000, outputBytes: 4 * 1024 * 1024, inputBytes: 96 * 1024 * 1024 };
const DEFAULT_PROJECT_LIMITS: Partial<SandboxLimits> = { timeoutMs: 20_000, outputBytes: 48 * 1024 * 1024, inputBytes: 96 * 1024 * 1024 };

export function createConnectors(options: ConnectorsOptions): Connectors {
  const { records } = options;
  const now = options.now ?? (() => new Date());
  const redactor = new Redactor();
  const profiles = new ProfileCache(options.packs, () => now().getTime());
  const runtimes = new Map<string, { key: string; runtime: ResourceRuntime }>();
  /** The credential handling of each resource, kept while its binding stays the same (one per session, never two). */
  const guards = new Map<string, { binding: string; login: LoginManager | null; credential: StaticCredential | null }>();
  const loginOptions = { cooldownMs: 30 * 60_000, expiryMarginMs: 60_000, ...options.login };

  const registry = new ResourceRegistry({
    objects: records.objects,
    authorizations: records.authorizations,
    principals: records.principals,
    vault: records.vault,
    profiles,
    redactor,
    now,
    log: options.log,
    cacheMs: options.resourceCacheMs,
    // The session is forgotten here and its entry removed; another process holding a stop (the running Hub, when this is
    // the CLI) reads the removal as the end of it.
    onCredentialChange: async (resource) => {
      const guard = guards.get(resource);
      if (guard?.login) await guard.login.reset();
      else if (guard?.credential) await guard.credential.reset();
      else await records.vault.remove(sessionEntry(resource));
    },
  });

  /** The profile of the exact pack version a resource binds; other published content under that version is not used. */
  async function loadBound(state: ResourceState): Promise<LoadedProfile> {
    const loaded = await profiles.load(state.resource.system_pack);
    if (loaded.pack.digest !== state.resource.system_pack_digest) {
      throw new ConnectorError('PACK_UNAVAILABLE', `系统包 ${state.resource.system_pack} 现在的内容与资源配置绑定的不同；需要管理员重新配置`, { detail: { pack: state.resource.system_pack } });
    }
    return loaded;
  }

  const callFunction: PackFunctionRunner =
    options.callFunction ??
    (async (target, input, kind) => {
      const limits = kind === 'plan' ? { ...DEFAULT_PLAN_LIMITS, ...options.sandbox?.plan } : { ...DEFAULT_PROJECT_LIMITS, ...options.sandbox?.project };
      const result = await callPackFunction(target, input, limits, { requireOsIsolation: options.sandbox?.requireOsIsolation ?? true });
      return result.output;
    });

  function runtimeOf(state: ResourceState, loaded: Awaited<ReturnType<ProfileCache['load']>>): ResourceRuntime {
    const key = `${state.bound}|${state.decision}|${loaded.pack.digest}`;
    const known = runtimes.get(state.resource.id);
    if (known !== undefined && known.key === key) return known.runtime;
    const { resource } = state;
    const { profile } = loaded;
    const auth = profile.auth;
    const http = new HttpSource({
      resource: resource.id,
      origins: resource.origins,
      allowPlaintext: resource.allow_plaintext,
      routes: profile.routes,
      envelope: profile.envelope ?? null,
      login: auth.kind === 'login_token' ? auth.login : null,
      limits: resource.limits,
      fetch: options.fetch,
      log: options.log,
      redactor,
      now: () => now().getTime(),
    });
    // What the session depends on: a stored token, stop or cool-down never carries over to another binding.
    const binding = sha256Hex(
      canonicalBytes({
        origins: resource.origins,
        allow_plaintext: resource.allow_plaintext,
        system_pack: resource.system_pack,
        system_pack_digest: resource.system_pack_digest,
        credentials: resource.credentials,
        credential_digests: resource.credential_digests,
      }),
    );
    let guard = guards.get(resource.id);
    if (guard === undefined || guard.binding !== binding) {
      guard = {
        binding,
        login:
          auth.kind === 'login_token'
            ? new LoginManager({
                resource: resource.id,
                login: auth.login,
                credentials: resource.credentials,
                sessionEntry: sessionEntry(resource.id),
                binding,
                vault: records.vault,
                http,
                now: () => now().getTime(),
                cooldownMs: loginOptions.cooldownMs,
                expiryMarginMs: loginOptions.expiryMarginMs,
                redactor,
                log: options.log,
              })
            : null,
        credential:
          auth.kind === 'static_header' && resource.credentials[auth.credential] !== undefined
            ? new StaticCredential({
                resource: resource.id,
                credential: auth.credential,
                entry: resource.credentials[auth.credential],
                header: auth.header,
                sessionEntry: sessionEntry(resource.id),
                binding,
                vault: records.vault,
                now: () => now().getTime(),
                redactor,
                log: options.log,
              })
            : null,
      };
      guards.set(resource.id, guard);
    } else {
      // Same session, new transport (limits may have changed).
      guard.login?.useHttp(http);
    }
    const runtime: ResourceRuntime = {
      resource,
      decision: state.decision,
      pack: loaded.pack,
      profile,
      routes: compileRoutes(profile.routes),
      http,
      login: guard.login,
      credential: guard.credential,
    };
    runtimes.set(resource.id, { key, runtime });
    return runtime;
  }

  /** Enabled resources whose system pack declares the external type, with the read that serves it. */
  async function resolve(type: string): Promise<{ runtime: ResourceRuntime; read: ReadDeclaration }[]> {
    const out: { runtime: ResourceRuntime; read: ReadDeclaration }[] = [];
    for (const state of await registry.states()) {
      if (!state.enabled) continue;
      let loaded;
      try {
        loaded = await loadBound(state);
      } catch {
        continue;
      }
      const read = loaded.profile.reads.find((r) => r.external === type);
      if (read !== undefined) out.push({ runtime: runtimeOf(state, loaded), read });
    }
    return out;
  }

  const engine = new ReadEngine({
    store: records.store,
    artifacts: records.artifacts,
    principals: records.principals,
    parsers: options.parsers ?? createDefaultRegistry(),
    callFunction,
    resolve,
    redactor,
    now,
    log: options.log,
    nestedCacheMs: options.nestedCacheMs,
    nestedCacheBytes: options.nestedCacheBytes,
  });

  function event(name: string, detail: Record<string, unknown>): void {
    if (options.log === undefined) return;
    try {
      options.log({ at: now().toISOString(), event: name, resource: typeof detail.resource === 'string' ? detail.resource : null, ...(redactor.value(detail) as Record<string, unknown>) });
    } catch {
      // A failing log sink never fails a read.
    }
  }

  const reader: ExternalReaderPort = {
    async accepts(id: string): Promise<boolean> {
      try {
        const subject = typeof id === 'string' ? parseExternal(id) : null;
        if (subject === null) return false;
        return (await resolve(`${subject.system}:${subject.type}`)).length > 0;
      } catch (error) {
        event('accepts_failed', { reason: asConnectorError(error, 'RESOURCE_UNAVAILABLE').message });
        return false;
      }
    },
    async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
      const shown = typeof id === 'string' ? id : String(id);
      try {
        const subject = typeof id === 'string' ? parseExternal(id) : null;
        if (subject === null) return { ok: false, id: shown, reason: `${redactor.text(shown)} 不是外部对象标识` };
        const candidates = await resolve(`${subject.system}:${subject.type}`);
        if (candidates.length !== 1) {
          const reason =
            candidates.length === 0
              ? `没有启用的资源声明外部类型 ${subject.system}:${subject.type}（或其系统包不可用）`
              : `${candidates.length} 个启用的资源都声明了外部类型 ${subject.system}:${subject.type}：${candidates.map((c) => c.runtime.resource.id).join('、')}`;
          event('read_unresolved', { external: subject.id, reason });
          return { ok: false, id: subject.id, reason };
        }
        const [{ runtime, read }] = candidates;
        const outcome = await engine.top(runtime, read, subject, context);
        if (!outcome.ok) return { ok: false, id: subject.id, reason: `${outcome.code}：${outcome.reason}` };
        return { ok: true, id: subject.id, revision: outcome.revision, artifacts: outcome.artifacts, manifest: outcome.manifest };
      } catch (error) {
        const failure = asConnectorError(error, 'STORE_FAILED');
        return { ok: false, id: shown, reason: `${failure.code}：${redactor.text(failure.message)}` };
      }
    },
  };

  const catalog: ResourceCatalogPort = {
    async list(user: Principal): Promise<ResourceListing[]> {
      try {
        const viewer = typeof user?.id === 'string' ? await records.principals.get(user.id) : null;
        if (viewer === null || viewer.disabled || viewer.role !== 'admin') return [];
        return await registry.list(viewer);
      } catch {
        return [];
      }
    },
  };

  const admin: ResourceAdmin = {
    addResource: (by, input) => registry.add(by, input),
    // Nested reads cached under the old definition are not served after a change (they are keyed by it as well).
    updateResource: async (by, id, changes) => {
      const record = await registry.update(by, id, changes);
      engine.clearCache();
      return record;
    },
    listResources: (by) => registry.list(by),
    describe: (by, id) => registry.describe(by, id),
    setCredential: (by, id, name, value) => registry.setCredential(by, id, name, value),
    setCredentials: (by, id, values) => registry.setCredentials(by, id, values),
    disable: async (by, id, note) => {
      await registry.disable(by, id, note);
      engine.clearCache();
    },
    enable: async (by, id, note) => {
      await registry.enable(by, id, note);
      engine.clearCache();
    },
    async loginStatus(by, id) {
      const viewer = typeof by?.id === 'string' ? await records.principals.get(by.id) : null;
      if (viewer === null || viewer.disabled || viewer.role !== 'admin') throw new ConnectorError('ACCESS_DENIED', '只有管理员能看登录状态');
      const state = await registry.get(id);
      if (state === null) return null;
      const runtime = runtimeOf(state, await loadBound(state));
      return (await (runtime.login ?? runtime.credential)?.status()) ?? null;
    },
    resetLogin: (by, id, note) => registry.resetLogin(by, id, note),
  };

  return {
    reader,
    catalog,
    admin,
    async executeRead(resource: string, readName: string, args: ReadArgs, context: ExternalReadContext): Promise<ReadOutcome> {
      const external = `${String(resource)}/${String(readName)}`;
      try {
        const state = await registry.get(resource);
        if (state === null || !state.enabled) return { ok: false, external, code: 'RESOURCE_UNAVAILABLE', reason: `资源 ${redactor.text(String(resource))} 不存在或已停用`, manifest: null };
        const loaded = await loadBound(state);
        const read = loaded.profile.reads.find((r) => r.name === readName);
        if (read === undefined) return { ok: false, external, code: 'READ_UNDECLARED', reason: `系统包没有读取 ${redactor.text(String(readName))}`, manifest: null };
        return await engine.execute(runtimeOf(state, loaded), read, args, context);
      } catch (error) {
        const failure = asConnectorError(error, 'STORE_FAILED');
        return { ok: false, external, code: failure.code, reason: redactor.text(failure.message), manifest: null };
      }
    },
    refresh(): void {
      profiles.clear();
      registry.invalidate();
      engine.clearCache();
    },
  };
}

/** ExternalReaderPort of hub/ports.ts. */
export function createExternalReader(connectors: Connectors): ExternalReaderPort {
  return connectors.reader;
}

/** ResourceCatalogPort of hub/ports.ts: admins get the listing with origins and plaintext declarations, anyone else nothing. */
export function createResourceCatalog(connectors: Connectors): ResourceCatalogPort {
  return connectors.catalog;
}

/** True where pack functions can run with operating-system isolation (sandbox-exec); tests pass the opposite as requireOsIsolation. */
export { osIsolationAvailable };
