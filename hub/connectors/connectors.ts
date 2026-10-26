// Wiring of the connectors: the resource registry, one runtime per enabled resource (HttpSource, and the LoginManager or
// StaticCredential of the resource), the read engine, and the two ports of hub/ports.ts this package provides:
// ExternalReaderPort (accepts, read) and ResourceCatalogPort. A resource uses the system pack version and digest its
// configuration binds, nothing else. The credential handling of a resource is kept while what its session depends on (the
// binding: origins, plaintext declarations, pack version and digest, credentials and their rules) stays the same.
// The reader never throws and never says more to its caller than ok or not: the reason of a failure is for the admin log.
import { secretNameOf } from '../../contracts/src/variables.ts';
import { CredentialStop } from './credential-stop.ts';
import { callPackFunction, osIsolationAvailable, type SandboxLimits } from '../rules/api.ts';
import { createDefaultRegistry, type ParserRegistry } from '../refs/api.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, PacksPort, ResourceCatalogPort, ResourceListing } from '../ports.ts';
import { canonicalBytes, sha256Hex, type Principal, type RecordsKit } from '../records/api.ts';
import type { ReadDeclaration } from '../../contracts/src/resources.ts';
import { CONNECTOR_ERRORS, ConnectorError, asConnectorError } from './errors.ts';
import { HttpSource, type ConnectorLog, type FetchLike } from './http.ts';
import { LoginManager, StaticCredential, type LoginStatus } from './login.ts';
import { ProfileCache, type LoadedProfile } from './profiles.ts';
import { ReadEngine, externalRoutingType, externalSizeReason, parseExternal, type PackFunctionRunner, type ReadArgs, type ReadOutcome, type ResourceRuntime } from './read.ts';
import { Redactor } from './redact.ts';
import { ResourceRegistry, sessionEntry, resourceConsumer, storedCredential, type AddResourceInput, type ResourceDescription, type ResourceState, type UpdateResourceInput } from './resources.ts';
import { compileRoutes } from './routes.ts';
import type { ResourceRecord } from '../../contracts/src/resources.ts';

export interface ConnectorsOptions {
  records: Pick<RecordsKit, 'store' | 'objects' | 'artifacts' | 'vault' | 'principals' | 'authorizations' | 'variables'>;
  /** Provided by runs: published packs (the system pack of each resource). */
  packs: PacksPort;
  /** Injectable for tests; default the global fetch. */
  fetch?: FetchLike;
  readRetrySleep?:(ms:number)=>Promise<void>;
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
   * Admins only: one resource, enabled or not, with each named reference, wire rule and current storage metadata
   * and whether an entry is present (never a value). Needs neither the system pack nor the vault key. Null for an id that is not
   * a resource.
   */
  describe(by: Principal, id: string): Promise<ResourceDescription | null>;
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
  redactor: Redactor;
  primeSecrets():Promise<void>;
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
    store: records.store,
    objects: records.objects,
    variables: records.variables,
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

  async function runtimeOf(state: ResourceState, loaded: Awaited<ReturnType<ProfileCache['load']>>, context?: ExternalReadContext): Promise<ResourceRuntime> {
    for (const material of await records.variables.recentSecrets()) redactor.add(material.value);
    const resolved = await records.variables.resolveVariables(state.resource.settings,state.resource.id,context?.variables);
    resolved.uses=resolved.uses.map(u=>({...u,at:u.at.replace('#/','#/settings/')}));
    const original = state.resource;
    const requests = Object.entries(original.credentials).map(([item,entry])=>{
      const name=secretNameOf(entry);
      if(!name)throw new ConnectorError('CREDENTIAL_MISSING',`资源 ${original.id} 的凭据还是旧写法：用 circle-hub resource update ${original.id} --credential ${item}=<密钥名> 改成引用，原值会迁移过去`);
      return {name,consumer:resourceConsumer(original,item)};
    });
    let materials;
    try {materials=await records.variables.readSecrets(requests);}catch(error) {throw new ConnectorError('CREDENTIAL_MISSING',error instanceof Error ? error.message : '密钥未设置；请 secret set');}
    const values=new Map<string,string>();
    for(const [index,item] of Object.keys(original.credentials).entries()) {
      const m=materials[index],rule=original.credential_digests[item];
      if(m.metadata.digest_rule!=='plain'&&m.metadata.digest_rule!==rule)throw new ConnectorError('CREDENTIAL_MISSING',`密钥 ${m.name} 的摘要规则不合：换一个名字并 secret set`);
      const value=m.metadata.digest_rule===rule?m.value:storedCredential(m.value,rule);
      redactor.addSent(value);values.set(original.credentials[item]+'#'+item,value);
    }
    const gate=materials.length?new CredentialStop(records.store,records.vault,materials.map(m=>m.decision),materials.map(m=>m.name),original.id):null;
    const epoch=await gate?.epoch() ?? '';
    const dependencies=[...resolved.uses.map(u=>u.decision),...materials.map(m=>m.decision)];
    const vault=new Proxy(records.vault,{get(target,key){if(key==='getText')return async (entry:string)=>values.has(entry)?values.get(entry)!:target.getText(entry);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    const credentials=Object.fromEntries(Object.entries(original.credentials).map(([item,entry])=>[item,entry+'#'+item]));
    state={...state,resource:{...original,settings:resolved.value as Record<string,unknown>}};
    const key = `${state.bound}|${state.decision}|${loaded.pack.digest}|${dependencies.join("|")}|${epoch}`;
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
        dependencies, epoch,
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
                credentials,
                sessionEntry: sessionEntry(resource.id),
                binding,
                vault,
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
                entry: credentials[auth.credential],
                header: auth.header,
                sessionEntry: sessionEntry(resource.id),
                binding,
                vault,
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
      variables:[...resolved.uses,...materials.map((m,i)=>({at:resource.id+'#/credentials/'+Object.keys(original.credentials)[i].replaceAll('~','~0').replaceAll('/','~1'),name:m.name,decision:m.decision}))],
      dependencies,
      gate,
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
  async function resolve(type: string, context?: ExternalReadContext): Promise<{ runtime: ResourceRuntime; read: ReadDeclaration }[]> {
    registry.invalidate();
    const out: { runtime: ResourceRuntime; read: ReadDeclaration }[] = [];
    for (const state of await registry.states()) {
      if (!state.enabled) continue;
      let loaded;
      try {
        loaded = await loadBound(state);
      } catch(error) {
        const failed=asConnectorError(error,'PACK_UNAVAILABLE');
        const reason=redactor.text(`资源 ${state.resource.id} 的绑定不可读：${failed.code}：${failed.message}；缺少原包的核验结果，请管理员恢复原包或重新配置`);
        event('resource_binding_failed',{resource:state.resource.id,code:failed.code,reason});
        context?.adminNote?.(reason);
        continue;
      }
      const read = loaded.profile.reads.find((r) => r.external === type);
      if (read !== undefined) out.push({ runtime: await runtimeOf(state, loaded, context), read });
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
    readRetrySleep:options.readRetrySleep,
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
    async accepts(id: string,context?:ExternalReadContext): Promise<boolean> {
      try {
        const type = typeof id === 'string' ? externalRoutingType(id) : null;
        if (type === null) return false;
        registry.invalidate();
        for(const state of await registry.states()) if(state.enabled) {
          try {if((await loadBound(state)).profile.reads.some(r=>r.external===type))return true;}
          catch(error){
            const failed=asConnectorError(error,'PACK_UNAVAILABLE');
            const reason=redactor.text(`资源 ${state.resource.id} 的绑定不可读：${failed.code}：${failed.message}；缺少原包的核验结果，请管理员恢复原包或重新配置`);
            event('resource_binding_failed',{resource:state.resource.id,code:failed.code,reason});
            context?.adminNote?.(reason);
          }
        }
        return false;
      } catch (error) {
        event('accepts_failed', { reason: asConnectorError(error, 'RESOURCE_UNAVAILABLE').message });
        return false;
      }
    },
    async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
      const shown = typeof id === 'string' ? id : String(id);
      try {
        context={...context,variables:context.variables??await records.variables.snapshot()};
        const sizeReason = typeof id === 'string' ? externalSizeReason(id) : null;
        if (sizeReason !== null) {
          const account = await records.principals.get(context.principal.id);
          return { ok: false, id: shown, reason: sizeReason,
            ...(account !== null && !account.disabled ? { inputError: {message:sizeReason,fix:'缩短读取键后重读'} } : {}) };
        }
        const subject = typeof id === 'string' ? parseExternal(id) : null;
        if (subject === null) return { ok: false, id: shown, reason: `${redactor.text(shown)} 不是外部对象标识` };
        const candidates = await resolve(`${subject.system}:${subject.type}`,context);
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
        if(!outcome.ok && outcome.disclosable===true && !outcome.retry) {
          const fixes:Partial<Record<typeof outcome.code,string>>={
            ROUTE_REFUSED:'缺少符合路由声明的读取请求；由系统包负责人修复规划，按允许路由重读',
            ORIGIN_REFUSED:'规划链接不在允许的同源范围；由资源管理员核对地址声明或系统包负责人修复规划后重读',
            PLAINTEXT_REFUSED:'本地传输策略拒绝经明文发送凭据；由资源管理员核对 HTTPS 与地址声明后重读',
            SOURCE_HTTP_STATUS:'来源明确以非成功 HTTP 状态作答；由资源管理员核对路由、参数与系统状态后重读',
            SOURCE_ENVELOPE_ERROR:'来源在应答信封中明确报错；由资源管理员核对参数与系统状态后重读',
            STORE_FAILED:'缺少已保存并可回读的来源原件；由 Hub 管理员修复对象存储，必要时从备份恢复后重读',
            SOURCE_MALFORMED:'缺少符合声明格式的应答；由资源管理员核对应答格式与路由声明，修复后重读',
            PROJECTION_FAILED:'缺少符合投影契约的出件；由系统包负责人核对投影输入、输出与回读，修复后重读',
            PLAN_INVALID:'缺少符合契约的完整读取计划；由系统包负责人核对规划函数与路由，修复后重读',
            FUNCTION_FAILED:'缺少包函数的成功出件；由系统包负责人修复函数后重读',
            SOURCE_ABSENT:'未读到要求的锁定修订；由资源管理员核对对象修订后重读，需要改修订时开始新运行',
          };
          const fix=fixes[outcome.code];
          if(fix)return {ok:false,id:subject.id,manifest:outcome.manifest,reason:`${outcome.code}：${outcome.reason}`,inputError:{code:'SOURCE_READ_FAILED',message:outcome.code==='SOURCE_ABSENT'?'未读到要求的锁定修订':outcome.code==='SOURCE_HTTP_STATUS'?(outcome.message??CONNECTOR_ERRORS[outcome.code]):CONNECTOR_ERRORS[outcome.code],fix}};
        }
        if(!outcome.ok && outcome.disclosable===true && (outcome.code==='READ_LIMIT' || outcome.code==='RESPONSE_TOO_LARGE'))return {ok:false,id:subject.id,manifest:outcome.manifest,reason:`${outcome.code}：${outcome.reason}`,inputError:{code:'SOURCE_READ_LIMIT',message:outcome.reason,fix:'由资源管理员调整声明或缩小读取范围后重新完整读取'}};
        if(!outcome.ok && outcome.disclosable===true && outcome.redirect) {
          const observation=outcome.redirect;
          const message=`来源明确给出 HTTP ${observation.status} 重定向，Location：${observation.location??(observation.location_redacted?'不可安全回显，请管理员核对原来源响应':'来源没有给出')}；本次没有跟随该地址`;
          return {ok:false,id:subject.id,manifest:outcome.manifest,reason:`${outcome.code}：${outcome.reason}`,redirect:observation,inputError:{code:'SOURCE_REDIRECT_REFUSED',message,fix:'由资源管理员核对来源给出的 Location 与路由声明，修复配置后按原对象重读'}};
        }
        if (!outcome.ok) return { ok: false, id: subject.id, manifest:outcome.manifest, reason: `${outcome.code}：${outcome.reason}`,...(outcome.disclosable!==false && outcome.retry?{retry:outcome.retry}:{}) };
        return { ok: true, id: subject.id, revision: outcome.revision, artifacts: outcome.artifacts, manifest: outcome.manifest,coverage:outcome.coverage,...(outcome.absent?{absent:outcome.absent}:{}) };
      } catch (error) {
        const failure = asConnectorError(error, 'STORE_FAILED');
        event('read_failed',{reason:failure.message});
        return { ok: false, id: shown, reason: `${failure.code}：${redactor.text(failure.message)}` };
      }
    },
  };

  async function resourceList(by:Principal):Promise<ResourceListing[]> {
    const rows=await registry.list(by);
    const user=await records.principals.get(by.id);
    if(user?.role!=='admin' || user.disabled)return rows;
    for(const row of rows) {
      const state=await registry.get(row.id);
      if(!state)continue;
      try {await loadBound(state);}
      catch(error) {
        const failed=asConnectorError(error,'PACK_UNAVAILABLE');
        row.binding_error={code:failed.code,message:redactor.text(failed.message),fix:'缺少绑定原包的核验结果；请管理员恢复原包或重新配置该资源'};
      }
    }
    return rows;
  }

  const catalog: ResourceCatalogPort = {
    async list(user: Principal): Promise<ResourceListing[]> {
      try {
        const viewer = typeof user?.id === 'string' ? await records.principals.get(user.id) : null;
        if (viewer === null || viewer.disabled || viewer.role !== 'admin') return [];
        return await resourceList(viewer);
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
    listResources: (by) => resourceList(by),
    describe: (by, id) => registry.describe(by, id),
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
      const runtime = await runtimeOf(state, await loadBound(state));
      const status=(await (runtime.login ?? runtime.credential)?.status())??null;
      const shared=await runtime.gate?.status();
      return status&&shared?.stopped?{...status,stopped:true,cooldownUntil:null,failure:status.failure??shared.code??'LOGIN_FAILED'}:status;
    },
    resetLogin: async (by,id,note)=>{
      const actual=await records.principals.get(by.id);if(!actual||actual.disabled||actual.role!=='admin')throw new ConnectorError('ACCESS_DENIED');
      registry.invalidate();const state=await registry.get(id);
      if(state) { const defs=await records.variables.list(by);const names=Object.values(state.resource.credentials).map(secretNameOf).filter((name):name is string=>name!==null);const decisions=names.map(name=>defs.find(d=>d.kind==='secret'&&d.name===name&&d.definition)?.decision.digest).filter((v):v is string=>!!v);
      if(decisions.length)await new CredentialStop(records.store,records.vault,decisions,names,id).reset(); }
      await registry.resetLogin(by,id,note);
    },
  };

  return {
    redactor,
    async primeSecrets(){for(const material of await records.variables.recentSecrets())redactor.add(material.value);},
    reader,
    catalog,
    admin,
    async executeRead(resource: string, readName: string, args: ReadArgs, context: ExternalReadContext): Promise<ReadOutcome> {
      const external = `${String(resource)}/${String(readName)}`;
      try {
        context={...context,variables:context.variables??await records.variables.snapshot()};
        registry.invalidate();
        const state = await registry.get(resource);
        if (state === null || !state.enabled) return { ok: false, external, code: 'RESOURCE_UNAVAILABLE', reason: `资源 ${redactor.text(String(resource))} 不存在或已停用`, manifest: null };
        const loaded = await loadBound(state);
        const read = loaded.profile.reads.find((r) => r.name === readName);
        if (read === undefined) return { ok: false, external, code: 'READ_UNDECLARED', reason: `系统包没有读取 ${redactor.text(String(readName))}`, manifest: null };
        return await engine.execute(await runtimeOf(state, loaded, context), read, args, context);
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
