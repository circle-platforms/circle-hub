// Resource administration (D01 R[6], D07 resources, B04 resource configuration). A resource is a deployment instance of a
// system pack: its definition (resource@1) is stored as content-addressed canonical JSON in the object store and put in
// force by a resource_config authorization bound to that digest; every change is a new definition and a new decision, and a
// disable is the revocation of the configuration. Only admins decide; only admins see addresses and plaintext declarations.
// The definition binds one published system pack version and its content digest (B04 R[1]): `id` is resolved to the version
// current when the admin decides, and a newer version takes effect only through an update. Credentials use
// named versions enrolled for this resource and destination. The definition records the wire rule; a named version records
// its storage rule. Updates preserve shared material. Legacy owned entries migrate explicitly, and metadata never reads values.
import { VariableName, referencesIn, secretNameOf } from '../../contracts/src/variables.ts';
import { createHash } from 'node:crypto';
import { EnvironmentSchema, type Environment, type PermissionKind } from '../../contracts/generated/vocabulary.ts';
import type { DigestRule } from '../../contracts/generated/vocabulary.ts';
import { ResourceId, ResourceRecord, type ResourceLimits, type SystemProfile } from '../../contracts/src/resources.ts';
import type { ResourceListing } from '../ports.ts';
import {
  WHOLE_HUB,
  canonicalBytes,
  newId,
  scanForCredentials,
  type AuthorizationRecord,
  type Authorizations,
  type ObjectStore,
  type Page,
  type RecordStore,
  type Transaction,
  type Principal,
  type Principals,
  type User,
  type Vault,
  type RecordVariables,
  type PreparedSecrets,
  type SecretWrite,
} from '../records/api.ts';
import { ConnectorError } from './errors.ts';
import type { ConnectorLog } from './http.ts';
import type { ProfileCache } from './profiles.ts';
import type { Redactor } from './redact.ts';

const CONFIGURATION_QUEUES=new WeakMap<RecordStore,Promise<void>>();

export interface AddResourceInput {
  /** `id` or `id@x.y.z` of a published system pack; the definition binds the exact version (and digest) current now. */
  system_pack: string;
  credentials?: Record<string, string>;
  unset_settings?: string[];
  name: string;
  environment: Environment;
  /** Role of the system pack -> base URL (`http(s)://host[:port][/path]`, no trailing slash). */
  origins: Record<string, string>;
  /** Origins (scheme://host[:port]) whose plain HTTP may carry credentials. */
  allow_plaintext?: string[];
  /** Non-secret deployment values for the read functions (root ids to read, for example). */
  settings?: Record<string, unknown>;
  limits?: ResourceLimits;
  note?: string | null;
}

export type UpdateResourceInput = Partial<Omit<AddResourceInput, 'note'>> & { note?: string | null };

/** One credential reference: required wire rule, actual named storage metadata and presence, never material. */
export interface CredentialDescription {
  name: string;
  entry: string;
  digest: DigestRule;
  stored_digest?: DigestRule;
  revoked?: boolean;
  set: boolean;
  version?: number;
  length?: number;
  registered?: boolean;
}

/** One resource as admins see it: the admins' listing row (addresses included) and every credential its definition declares, by name. */
export interface ResourceDescription extends ResourceListing {
  credentials: CredentialDescription[];
}

export interface ResourceState {
  resource: ResourceRecord;
  enabled: boolean;
  /** Digest of the authorization record of the configuration in force, or of the revocation when disabled. */
  decision: string;
  /** Digest of the definition (the bound of the configuration). */
  bound: string;
}

export interface ResourceRegistryOptions {
  store: RecordStore;
  objects: ObjectStore;
  variables: RecordVariables;
  authorizations: Authorizations;
  principals: Principals;
  vault: Vault;
  profiles: ProfileCache;
  redactor: Redactor;
  now: () => Date;
  log?: ConnectorLog;
  /**
   * Called when an administrator resets login: the session is forgotten and its vault entry
   * removed, which another process (the running Hub) reads as the end of its stop. A removal that fails reaches the admin.
   */
  onCredentialChange?: (resource: string) => Promise<void>;
  /** How long the list of resources is reused before the records are read again, default 5 s. */
  cacheMs?: number;
}

const PERMISSION: PermissionKind = 'resource_config';

/** Vault entry of a credential of a resource. */
export function credentialEntry(resource: string, name: string): string {
  return `connector.${resource}.${name}`;
}

/** Vault entry of the token cache and cool-down of a resource. */
export function sessionEntry(resource: string): string {
  return `connector.${resource}.session`;
}

/** Credential names a profile declares, with their digest rule. */
export function declaredCredentials(profile: SystemProfile): { name: string; digest: DigestRule }[] {
  if (profile.auth.kind === 'none') return [];
  if (profile.auth.kind === 'static_header') return [{ name: profile.auth.credential, digest: 'plain' }];
  return profile.auth.credentials.map((c) => ({ name: c.name, digest: c.digest }));
}

/** What the vault keeps for a credential under its digest rule: the value, or Base64(SHA-512(UTF-8 of the value)). */
export function storedCredential(value: string, digest: DigestRule): string {
  return digest === 'sha512_base64' ? createHash('sha512').update(value, 'utf8').digest('base64') : value;
}

/** The system error code of a vault failure (EACCES, say), never its message, which may name a path. */
function systemCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : '密钥库错误';
}

function issues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .slice(0, 4)
    .map((issue) => `/${issue.path.map(String).join('/')}: ${issue.message}`)
    .join('; ');
}

/** The definition fits the profile: an address for every role it declares and no other, the credentials it declares. */
export function profileProblem(resource: ResourceRecord, profile: SystemProfile): string | null {
  const roles = new Set(profile.roles.map((r) => r.name));
  for (const role of roles) if (!Object.hasOwn(resource.origins, role)) return `系统包声明了角色 ${role}，资源没有给它地址`;
  for (const role of Object.keys(resource.origins)) if (!roles.has(role)) return `系统包没有角色 ${role}`;
  const declared = declaredCredentials(profile);
  const names = declared.map((c) => c.name).sort();
  const given = Object.keys(resource.credentials).sort();
  if (names.join('\n') !== given.join('\n')) return `凭据项 ${given.join('、') || '无'} 与系统包声明的 ${names.join('、') || '无'} 不一致`;
  for (const c of declared) if (resource.credential_digests[c.name] !== c.digest) return `凭据 ${c.name} 的摘要规则与系统包声明的不一致`;
  return null;
}

export class ResourceRegistry {
  readonly #o: ResourceRegistryOptions;
  #cache: { at: number; states: ResourceState[] } | null = null;
  #loading: Promise<ResourceState[]> | null = null;
  #generation=0;

  constructor(options: ResourceRegistryOptions) {
    this.#o = options;
  }

  invalidate(): void {
    this.#cache = null;
    this.#loading=null;
    this.#generation++;
  }

  /** The exact published version a reference names now (`id` resolves to the latest), with its digest and profile. */
  async #bind(ref: string): Promise<{ system_pack: string; system_pack_digest: string; profile: SystemProfile }> {
    const loaded = await this.#o.profiles.load(ref);
    const id = ref.includes('@') ? ref.slice(0, ref.indexOf('@')) : ref;
    if (loaded.pack.id !== id) throw new ConnectorError('PACK_UNAVAILABLE', `系统包 ${ref} 不可用（取回的是另一个包）`, { detail: { pack: ref } });
    return { system_pack: `${loaded.pack.id}@${loaded.pack.version}`, system_pack_digest: loaded.pack.digest, profile: loaded.profile };
  }

  async add(by: Principal, input: AddResourceInput): Promise<ResourceRecord> {
    const admin = await this.#admin(by);
    const bound = await this.#bind(String(input?.system_pack));
    const declared = declaredCredentials(bound.profile);
    const id = newId('res');
    const record = this.#validated(
      {
        schema: 'resource@1',
        id,
        system_pack: bound.system_pack,
        system_pack_digest: bound.system_pack_digest,
        name: input.name,
        environment: input.environment,
        origins: input.origins,
        allow_plaintext: input.allow_plaintext ?? [],
        credentials: this.#credentials(declared, input.credentials ?? {}),
        credential_digests: Object.fromEntries(declared.map((c) => [c.name, c.digest])),
        settings: input.settings ?? {},
        ...(input.limits === undefined ? {} : { limits: input.limits }),
        created_by: admin.id,
        created_at: this.#o.now().toISOString(),
      },
      bound.profile,
    );
    await this.#configure(admin, record, input.note ?? null);
    this.#event('resource_added', { resource: id, system_pack: record.system_pack, environment: record.environment });
    return record;
  }

  /**
   * A new definition for an enabled resource, preserving unchanged named references. `system_pack`
   * given as `id` binds the latest published version now; left out, the bound version stays. Shared named values are
   * preserved when a declaration changes; legacy owned entries are retired only after the configuration commits.
   */
  async update(by: Principal, id: string, changes: UpdateResourceInput): Promise<ResourceRecord> {
    const admin = await this.#admin(by);
    const state = await this.#state(id);
    if (!state.enabled) throw new ConnectorError('RESOURCE_INVALID', `资源 ${id} 已停用；先启用再修改`, { detail: { resource: id } });
    const current = state.resource;
    const bound = await this.#bind(changes.system_pack ?? current.system_pack);
    if (changes.system_pack === undefined && bound.system_pack_digest !== current.system_pack_digest) {
      throw new ConnectorError('PACK_UNAVAILABLE', `系统包 ${current.system_pack} 现在的内容与资源配置绑定的不同；修改时请重新指定系统包`, { detail: { pack: current.system_pack } });
    }
    const declared = declaredCredentials(bound.profile);
    const { note, credentials: given, unset_settings, ...rest } = changes;
    const settings = {...current.settings, ...changes.settings};
    for (const key of unset_settings ?? []) delete settings[key];
    let allowPlaintext = changes.allow_plaintext;
    if (changes.origins !== undefined && allowPlaintext === undefined) {
      const kept = new Set<string>();
      for (const [role, oldUrl] of Object.entries(current.origins)) {
        try {
          const oldOrigin = new URL(oldUrl).origin;
          if (current.allow_plaintext.includes(oldOrigin)) {
            if (changes.origins[role] === oldUrl) {
              kept.add(oldOrigin);
            }
          }
        } catch {}
      }
      allowPlaintext = [...kept];
    }
    const record = this.#validated(
      {
        ...current,
        ...rest,
        allow_plaintext: allowPlaintext ?? current.allow_plaintext,
        settings,
        system_pack: bound.system_pack,
        system_pack_digest: bound.system_pack_digest,
        schema: 'resource@1',
        id: current.id,
        credentials: this.#credentials(declared, given ?? {}, current.credentials),
        credential_digests: Object.fromEntries(declared.map((c) => [c.name, c.digest])),
        created_by: current.created_by,
        created_at: current.created_at,
      },
      bound.profile,
    );
    const migrating = Object.keys(record.credentials).filter(name => current.credentials[name] === credentialEntry(id,name) && secretNameOf(record.credentials[name]));
    if (migrating.length && (canonicalBytes(current.origins).toString() !== canonicalBytes(record.origins).toString() || canonicalBytes(current.allow_plaintext).toString() !== canonicalBytes(record.allow_plaintext).toString()))
      throw new ConnectorError('RESOURCE_INVALID','迁移凭据和改地址须分开做：先迁移，再改地址并重新输入密钥');
    const writes: SecretWrite[] = [];
    const expectedSecrets=new Map<string,string|null>();
    for (const item of migrating) {
      const value = await this.#o.vault.getText(current.credentials[item]);
      if (value === null) continue;
      const name = secretNameOf(record.credentials[item])!;
      const previous = (await this.#o.variables.list(by)).find(v => v.kind === 'secret' && v.name === name && v.definition !== null);
      expectedSecrets.set(name,previous?.decision.digest??null);
      let consumers = [resourceConsumer(record,item)];
      let keptValue=value,keptRule=current.credential_digests[item];
      if (previous?.definition && previous.definition.schema === 'secret@1') {
        const metadata = previous.definition;
        const old = await this.#o.vault.getText(metadata.entry);
        if(old===null || [...old].length!==metadata.length)throw new ConnectorError('RESOURCE_INVALID','已有密钥条目不可用或长度不合登记：先 secret set 重新输入后迁移');
        let incoming=value,existing=old;
        if(current.credential_digests[item]==='sha512_base64'&&metadata.digest_rule==='plain'){
          existing=storedCredential(old,'sha512_base64');keptValue=old;keptRule='plain';
        } else if(current.credential_digests[item]==='plain'&&metadata.digest_rule==='sha512_base64')incoming=storedCredential(value,'sha512_base64');
        if(incoming!==existing)throw new ConnectorError('RESOURCE_INVALID','迁移的值与已有密钥不同：换一个名字');
        consumers = [...metadata.consumers.filter(c => !(c.definition === id && c.item === item)),resourceConsumer(record,item)];
      }
      writes.push({name,value:keptValue,digest_rule:keptRule,alreadyStored:true,short:true,consumers});
    }
    if (new Set(writes.map(v=>v.name)).size !== writes.length) throw new ConnectorError('RESOURCE_INVALID','一次迁移的凭据项须使用不同名字');
    const prepared = writes.length ? await this.#o.variables.prepareSecrets(admin,writes,`从资源 ${id} 的凭据项迁移来`) : undefined;
    await this.#configure(admin, record, note ?? null, prepared,expectedSecrets);
    try {
      for (const [name,entry] of Object.entries(current.credentials))
        if(entry===credentialEntry(id,name) && (record.credentials[name]!==entry || current.credential_digests[name]!==record.credential_digests[name]))await this.#o.vault.remove(entry);
      // A failed post-commit deletion is retried by the same update, even after the definition already uses a name.
      for(const item of Object.keys(changes.credentials??{}))if(secretNameOf(record.credentials[item]??''))await this.#o.vault.remove(credentialEntry(id,item));
      for(const name of new Set(Object.values(record.credentials).map(secretNameOf).filter((v):v is string=>v!==null)))await this.#o.variables.cleanupSecret(name);
    }catch(error){throw new ConnectorError('STORE_FAILED',`资源 ${id} 的新定义${writes.length?'与迁移密钥决定':''}已提交，旧条目清理未完成；管理员修复密钥库权限后重跑同一 resource update 清理，不重新输入值`,{cause:error});}
    this.#event('resource_updated', { resource: id, system_pack: record.system_pack });
    return record;
  }

  /**
   * Ends a stop or cool-down of the resource's login or static credential (admins only); the credential stays as it is.
   * From any process: the session entry is removed, and a running Hub that holds the stop ends it at its next decision.
   */
  async resetLogin(by: Principal, id: string, note?: string | null): Promise<void> {
    const admin = await this.#admin(by);
    await this.#state(id);
    await this.#forgetSession(id, `资源 ${id} 的登录状态没能从密钥库清除`);
    this.#event('login_reset', { resource: id, by: admin.id, ...(typeof note === 'string' && note !== '' ? { note: note.slice(0, 200) } : {}) });
  }

  /**
   * Forgets the session of a resource (onCredentialChange). A vault that cannot remove the entry is the admin's error: other
   * processes (the running Hub) would not see the change. The message names the system error code, never a path.
   */
  async #forgetSession(id: string, what: string): Promise<void> {
    try {
      await this.#o.onCredentialChange?.(id);
    } catch (error) {
      const why = systemCode(error);
      this.#event('session_reset_failed', { resource: id, why });
      throw new ConnectorError('STORE_FAILED', `${what}（${why}）：别的进程（正在运行的 Hub）看不到这次变化；请再重置一次登录`, { detail: { resource: id }, cause: error });
    }
  }

  async disable(by: Principal, id: string, note?: string | null): Promise<void> {
    const admin = await this.#admin(by);
    const state = await this.#state(id);
    if (!state.enabled) return;
    await this.#o.authorizations.revoke(admin, { permission: PERMISSION, subject: WHOLE_HUB, object: id, note: note ?? null });
    this.invalidate();
    this.#event('resource_disabled', { resource: id });
  }

  async enable(by: Principal, id: string, note?: string | null): Promise<void> {
    const admin = await this.#admin(by);
    const state = await this.#state(id);
    if (state.enabled) return;
    await this.#configure(admin, state.resource, note ?? null);
    this.invalidate();
    this.#event('resource_enabled', { resource: id });
  }

  /**
   * One resource for admins, enabled or not, read anew: the listing row and the credentials its definition declares (names,
   * vault entries, digest rules, whether a value is set). It needs neither the system pack nor the vault key and never
   * reads a value. Null when the id is not a resource.
   */
  async describe(by: Principal, id: string): Promise<ResourceDescription | null> {
    await this.#admin(by);
    this.invalidate();
    const state = await this.get(String(id));
    if (state === null) return null;
    const { resource } = state;
    const credentials: CredentialDescription[] = [];
    const versions=await this.#o.variables.list(by);
    for (const name of Object.keys(resource.credentials).sort()) {
      const entry = resource.credentials[name];
      const ref = secretNameOf(entry);
      const version = ref ? versions.find(v=>v.kind === 'secret' && v.name === ref) : undefined;
      const metadata = version?.definition?.schema === 'secret@1' ? version.definition : null;
      credentials.push({name,entry,digest:resource.credential_digests[name],set: metadata ? await this.#o.vault.has(metadata.entry) : ref ? false : await this.#o.vault.has(entry),...(version?{version:version.version,revoked:version.decision.body.revoked}:{}),...(metadata ? {stored_digest:metadata.digest_rule,length:metadata.length,registered:metadata.consumers.some(c=>canonicalBytes(c).toString()===canonicalBytes(resourceConsumer(resource,name)).toString())} : {})});
    }
    return { ...listing(state, true), credentials };
  }

  /** Admins: every resource with addresses; any other valid account: the same rows without addresses. */
  async list(by: Principal): Promise<ResourceListing[]> {
    const viewer = await this.#viewer(by);
    if (viewer === null) return [];
    const admin = viewer.role === 'admin';
    return (await this.states()).map((state) => listing(state, admin));
  }

  /** Every resource, enabled or not, by name (no access check: for the connectors themselves). */
  async states(): Promise<ResourceState[]> {
    const ttl=this.#o.cacheMs??5000,now=Date.now(),generation=this.#generation;
    if(this.#cache!==null&&now-this.#cache.at<ttl)return this.#cache.states;
    if(this.#loading===null){
      const loading:Promise<ResourceState[]>=this.#read().finally(()=>{if(this.#loading===loading)this.#loading=null;});
      this.#loading=loading;
    }
    const states=await this.#loading;
    // An invalidated in-flight reader keeps its own snapshot, but never supplies or overwrites the new generation.
    if(generation===this.#generation)this.#cache={at:Date.now(),states};
    return states;
  }

  async get(id: string): Promise<ResourceState | null> {
    return (await this.states()).find((state) => state.resource.id === id) ?? null;
  }

  async #state(id: string): Promise<ResourceState> {
    this.invalidate();
    const state = await this.get(String(id));
    if (state === null) throw new ConnectorError('RESOURCE_INVALID', `没有资源 ${String(id)}`, { detail: { resource: String(id) } });
    return state;
  }

  async #read(tx?:Transaction): Promise<ResourceState[]> {
    const latest = new Map<string, AuthorizationRecord>();
    const definition = new Map<string, AuthorizationRecord>();
    let cursor: string | null = null;
    do {
      const page:Page<AuthorizationRecord> = tx ? await this.#o.store.find<AuthorizationRecord['body']>({kind:'authorization',key:'authz.permission',value:PERMISSION,newestFirst:true,limit:500,cursor},tx) : await this.#o.authorizations.history({ permission: PERMISSION, newestFirst: true, limit: 500, cursor });
      for (const record of page.items) {
        const id = record.body.object;
        // Other resource configurations (an accepted credential scan, for example) share the permission kind.
        if (record.body.subject !== WHOLE_HUB || !ResourceId.safeParse(id).success) continue;
        if (!latest.has(id)) latest.set(id, record);
        if (!definition.has(id) && !record.body.revoked && record.body.bound !== null) definition.set(id, record);
      }
      cursor = page.next;
    } while (cursor !== null);
    const now = this.#o.now().getTime();
    const states: ResourceState[] = [];
    for (const [id, decision] of latest) {
      const defined = definition.get(id);
      if (defined === undefined || defined.body.bound === null) continue;
      const resource = await this.#definition(defined.body.bound);
      if (resource === null || resource.id !== id) {
        this.#event('resource_unreadable', { resource: id });
        continue;
      }
      const expired = decision.body.expires_at !== null && Date.parse(decision.body.expires_at) <= now;
      states.push({ resource, enabled: !decision.body.revoked && !expired, decision: decision.digest, bound: defined.body.bound });
    }
    return states.sort((a, b) => a.resource.name.localeCompare(b.resource.name) || a.resource.id.localeCompare(b.resource.id));
  }

  async #definition(bound: string): Promise<ResourceRecord | null> {
    const bytes = await this.#o.objects.get(bound);
    if (bytes === null) return null;
    try {
      const parsed = ResourceRecord.safeParse(JSON.parse(Buffer.from(bytes).toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  #validated(candidate: unknown, profile: SystemProfile): ResourceRecord {
    const parsed = ResourceRecord.safeParse(candidate);
    if (!parsed.success) throw new ConnectorError('RESOURCE_INVALID', `资源配置不符合 resource@1：${issues(parsed.error)}`);
    if (!EnvironmentSchema.safeParse(parsed.data.environment).success) throw new ConnectorError('RESOURCE_INVALID', '环境类别无效');
    const problem = profileProblem(parsed.data, profile);
    if (problem !== null) throw new ConnectorError('RESOURCE_INVALID', problem);
    for (const ref of referencesIn(parsed.data)) {
      if (ref.at.startsWith('/settings/') && ref.kind === 'var') continue;
      if (ref.at.startsWith('/credentials/') && ref.kind === 'secret') continue;
      throw new ConnectorError('RESOURCE_INVALID','设置只能引用普通变量；密钥只能用于凭据项，地址不许引用');
    }
    const scan = scanForCredentials(canonicalBytes(parsed.data.settings));
    if (scan.findings.length > 0) throw new ConnectorError('RESOURCE_INVALID', '设置里像是有凭据；凭据只经 circle-hub secret set --name <名字> 进密钥库', { detail: { findings: scan.findings.length } });
    return parsed.data;
  }

  #credentials(declared: {name:string}[], given: Record<string,string>, previous: Record<string,string> = {}): Record<string,string> {
    for (const key of Object.keys(given)) if (!declared.some(c=>c.name===key)) throw new ConnectorError('RESOURCE_INVALID','凭据项不在系统包声明中');
    return Object.fromEntries(declared.map(c=>{
      if (given[c.name] !== undefined) {
        const parsed = VariableName.safeParse(given[c.name]);
        if (!parsed.success) throw new ConnectorError('RESOURCE_INVALID','凭据项的密钥名字不合规则');
        return [c.name,'${secret:'+parsed.data+'}'];
      }
      if (previous[c.name]) return [c.name,previous[c.name]];
      throw new ConnectorError('RESOURCE_INVALID',`凭据项 ${c.name} 缺少密钥名字：用 --credential <凭据项>=<密钥名>`);
    }));
  }
  async #configure(admin: User, record: ResourceRecord, note: string | null, prepared?: PreparedSecrets, expectedSecrets=new Map<string,string|null>()): Promise<void> {
    const refs = referencesIn(record.settings);
    const snapshot = await this.#o.variables.snapshot();
    const resolved = await this.#o.variables.resolveVariables(record.settings,record.id,snapshot);
    if (Buffer.byteLength(JSON.stringify(resolved.value),'utf8') > 65536) throw new ConnectorError('RESOURCE_INVALID','解析后的设置超过 64 KiB');
    const stored = await this.#o.objects.put(canonicalBytes(record), 'application/json');
    const bound=await this.#o.profiles.load(record.system_pack);
    if(bound.pack.digest!==record.system_pack_digest)throw new ConnectorError('PACK_UNAVAILABLE','缺少资源绑定的原包；请管理员恢复原包或重新配置后启用');
    await this.#configuration(async tx => {
      await this.#unique(record,bound.profile,tx);
      await this.#o.variables.lockNames([...refs.map(r=>r.name),...(prepared?.items.map(i=>i.name)??[])],tx);
      for (const ref of refs) {
        const rows = await this.#o.store.find<AuthorizationRecord['body']>({key:'authz.key',value:`resource_config|${WHOLE_HUB}|var:${ref.name}`,kind:'authorization',newestFirst:true,limit:1},tx);
        if (rows.items[0]?.body.revoked || rows.items[0]?.digest !== snapshot.get(ref.name)) throw new ConnectorError('RESOURCE_INVALID',`变量 ${ref.name} 已变：先 var set，再重做配置`);
      }
      for(const [name,expected] of expectedSecrets) {
        const rows=await this.#o.store.find<AuthorizationRecord['body']>({key:'authz.key',value:`resource_config|${WHOLE_HUB}|secret:${name}`,kind:'authorization',newestFirst:true,limit:1},tx);
        const current=rows.items[0];
        if((!current||current.body.revoked?null:current.digest)!==expected)throw new ConnectorError('RESOURCE_INVALID','迁移期间密钥版本已变：核对现有名字后重新运行 update');
      }
      if (prepared) await this.#o.variables.commitSecrets(admin,prepared,tx);
      await this.#o.authorizations.configureResourceInTransaction(admin,record.id,stored.sha256,note ?? '',tx);
    });
    this.invalidate();
  }

  async #configuration<T>(work:(tx:Transaction)=>Promise<T>):Promise<T> {
    // One waiter per pool holds a SQL connection; other callers wait without reserving a connection.
    const before=CONFIGURATION_QUEUES.get(this.#o.store)??Promise.resolve();
    let release!:()=>void;
    const waiting=new Promise<void>(resolve=>{release=resolve;});
    CONFIGURATION_QUEUES.set(this.#o.store,waiting);
    await before;
    try {
      return await this.#o.store.withTransaction(async tx=>{
        await this.#o.store.lock('connectors.resource-configurations',tx);
        return work(tx);
      });
    } finally {this.invalidate();release();if(CONFIGURATION_QUEUES.get(this.#o.store)===waiting)CONFIGURATION_QUEUES.delete(this.#o.store);}
  }

  async #unique(resource:ResourceRecord,profile:SystemProfile,tx:Transaction):Promise<void> {
    const types=new Set(profile.reads.map(read=>read.external));
    for(const state of await this.#read(tx)) {
      if(!state.enabled || state.resource.id===resource.id || state.resource.environment!==resource.environment)continue;
      let loaded;
      try {
        loaded=await this.#o.profiles.load(state.resource.system_pack);
        if(loaded.pack.digest!==state.resource.system_pack_digest)throw new Error('bound pack differs');
      } catch(error) {
        throw new ConnectorError('RESOURCE_INVALID',`缺少已启用资源 ${state.resource.id} 的绑定读取类型；请管理员恢复原包或停用它后再配置`,{cause:error});
      }
      const overlap=loaded.profile.reads.map(read=>read.external).filter(type=>types.has(type));
      if(overlap.length)throw new ConnectorError('RESOURCE_INVALID',`环境 ${resource.environment} 的外部类型 ${overlap.join('、')} 已由资源 ${state.resource.id} 启用；停用冲突资源或选择其他环境后再配置`);
    }
  }

  async #viewer(by: Principal): Promise<User | null> {
    if (typeof by?.id !== 'string') return null;
    const user = await this.#o.principals.get(by.id);
    return user === null || user.disabled ? null : user;
  }

  async #admin(by: Principal): Promise<User> {
    const user = await this.#viewer(by);
    if (user === null || user.role !== 'admin') throw new ConnectorError('ACCESS_DENIED', '只有管理员能配置资源和凭据');
    return user;
  }

  #event(event: string, detail: Record<string, unknown>): void {
    if (this.#o.log === undefined) return;
    try {
      this.#o.log({ at: this.#o.now().toISOString(), event, resource: typeof detail.resource === 'string' ? detail.resource : null, ...(this.#o.redactor.value(detail) as Record<string, unknown>) });
    } catch {
      // A failing log sink never fails an administration call.
    }
  }
}

/** The listing row of a resource; addresses and plaintext declarations for admins only. */
export function listing(state: ResourceState, admin: boolean): ResourceListing {
  const { resource } = state;
  const row: ResourceListing = { id: resource.id, system_pack: resource.system_pack, name: resource.name, environment: resource.environment, enabled: state.enabled };
  if (admin) {
    row.origins = { ...resource.origins };
    row.allow_plaintext = [...resource.allow_plaintext];
  }
  return row;
}

/** Identity and exact destination enrollment; no secret material. */
export function resourceConsumer(resource: ResourceRecord, item: string) {
  return {definition:resource.id,item,sends_to:createHash('sha256').update(canonicalBytes({origins:resource.origins,allow_plaintext:[...resource.allow_plaintext].sort()})).digest('hex')};
}
