// Resource administration (D01 R[6], D07 resources, B04 resource configuration). A resource is a deployment instance of a
// system pack: its definition (resource@1) is stored as content-addressed canonical JSON in the object store and put in
// force by a resource_config authorization bound to that digest; every change is a new definition and a new decision, and a
// disable is the revocation of the configuration. Only admins decide; only admins see addresses and plaintext declarations.
// The definition binds one published system pack version and its content digest (B04 R[1]): `id` is resolved to the version
// current when the admin decides, and a newer version takes effect only through an update. Credentials go into the vault
// entries the definition names, each under the digest rule the definition records; a password is kept only as the digest
// its system requires. An update drops the stored values of credentials that are no longer declared or whose rule changed.
import { createHash } from 'node:crypto';
import { EnvironmentSchema, type Environment, type PermissionKind } from '../../contracts/generated/vocabulary.ts';
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
  type Principal,
  type Principals,
  type User,
  type Vault,
} from '../records/api.ts';
import { ConnectorError } from './errors.ts';
import type { ConnectorLog } from './http.ts';
import type { ProfileCache } from './profiles.ts';
import type { Redactor } from './redact.ts';

export interface AddResourceInput {
  /** `id` or `id@x.y.z` of a published system pack; the definition binds the exact version (and digest) current now. */
  system_pack: string;
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

export interface ResourceState {
  resource: ResourceRecord;
  enabled: boolean;
  /** Digest of the authorization record of the configuration in force, or of the revocation when disabled. */
  decision: string;
  /** Digest of the definition (the bound of the configuration). */
  bound: string;
}

export interface ResourceRegistryOptions {
  objects: ObjectStore;
  authorizations: Authorizations;
  principals: Principals;
  vault: Vault;
  profiles: ProfileCache;
  redactor: Redactor;
  now: () => Date;
  log?: ConnectorLog;
  /** Called after a credential of a resource changed (the login manager forgets its token and cool-down). */
  onCredentialChange?: (resource: string) => Promise<void>;
  /** How long the list of resources is reused before the records are read again, default 5 s. */
  cacheMs?: number;
}

const PERMISSION: PermissionKind = 'resource_config';
const MAX_SECRET_CHARS = 4096;

/** Vault entry of a credential of a resource. */
export function credentialEntry(resource: string, name: string): string {
  return `connector.${resource}.${name}`;
}

/** Vault entry of the token cache and cool-down of a resource. */
export function sessionEntry(resource: string): string {
  return `connector.${resource}.session`;
}

/** Credential names a profile declares, with their digest rule. */
export function declaredCredentials(profile: SystemProfile): { name: string; digest: 'plain' | 'sha512_base64' }[] {
  if (profile.auth.kind === 'none') return [];
  if (profile.auth.kind === 'static_header') return [{ name: profile.auth.credential, digest: 'plain' }];
  return profile.auth.credentials.map((c) => ({ name: c.name, digest: c.digest }));
}

/** What the vault keeps for a credential under its digest rule: the value, or Base64(SHA-512(UTF-8 of the value)). */
export function storedCredential(value: string, digest: 'plain' | 'sha512_base64'): string {
  return digest === 'sha512_base64' ? createHash('sha512').update(value, 'utf8').digest('base64') : value;
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

  constructor(options: ResourceRegistryOptions) {
    this.#o = options;
  }

  invalidate(): void {
    this.#cache = null;
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
        credentials: Object.fromEntries(declared.map((c) => [c.name, credentialEntry(id, c.name)])),
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
   * A new definition for an enabled resource (same id, same vault entries for the credentials that stay). `system_pack`
   * given as `id` binds the latest published version now; left out, the bound version stays. A credential that is no
   * longer declared, or whose digest rule changed, loses its stored value (it is set again with setCredential).
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
    const { note, ...rest } = changes;
    const record = this.#validated(
      {
        ...current,
        ...rest,
        system_pack: bound.system_pack,
        system_pack_digest: bound.system_pack_digest,
        schema: 'resource@1',
        id: current.id,
        credentials: Object.fromEntries(declared.map((c) => [c.name, current.credentials[c.name] ?? credentialEntry(current.id, c.name)])),
        credential_digests: Object.fromEntries(declared.map((c) => [c.name, c.digest])),
        created_by: current.created_by,
        created_at: current.created_at,
      },
      bound.profile,
    );
    // A value kept under another digest rule, or for a credential the pack no longer declares, is never sent again.
    for (const [name, entry] of Object.entries(current.credentials)) {
      const rule = record.credential_digests[name];
      const why = rule === undefined ? 'undeclared' : rule !== current.credential_digests[name] ? 'digest_rule_changed' : null;
      if (why === null) continue;
      await this.#o.vault.remove(entry);
      this.#event('credential_dropped', { resource: id, credential: name, why });
    }
    await this.#configure(admin, record, note ?? null);
    this.#event('resource_updated', { resource: id, system_pack: record.system_pack });
    return record;
  }

  /** Ends a stop or cool-down of the resource's login or static credential (admins only); the credential stays as it is. */
  async resetLogin(by: Principal, id: string, note?: string | null): Promise<void> {
    const admin = await this.#admin(by);
    await this.#state(id);
    await this.#o.onCredentialChange?.(id);
    this.#event('login_reset', { resource: id, by: admin.id, ...(typeof note === 'string' && note !== '' ? { note: note.slice(0, 200) } : {}) });
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
    await this.#o.authorizations.configureResource(admin, id, state.bound, note ?? null);
    this.invalidate();
    this.#event('resource_enabled', { resource: id });
  }

  /**
   * Sets one credential of a resource in its vault entry. A credential the profile digests (sha512_base64) is kept only as
   * that digest. The value is never logged, returned or stored anywhere else.
   */
  async setCredential(by: Principal, id: string, name: string, value: string): Promise<void> {
    await this.#admin(by);
    const state = await this.#state(id);
    // The definition says which credentials exist and under which rule each is kept.
    const entry = Object.hasOwn(state.resource.credentials, String(name)) ? state.resource.credentials[name] : undefined;
    const digest = Object.hasOwn(state.resource.credential_digests, String(name)) ? state.resource.credential_digests[name] : undefined;
    if (entry === undefined || digest === undefined) throw new ConnectorError('RESOURCE_INVALID', `资源 ${id} 没有凭据项 ${String(name)}`, { detail: { resource: id } });
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SECRET_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new ConnectorError('RESOURCE_INVALID', `凭据 ${name} 必须是 1 到 ${MAX_SECRET_CHARS} 个字符、不含控制字符的文本`, { detail: { resource: id } });
    }
    this.#o.redactor.add(value);
    const stored = storedCredential(value, digest);
    this.#o.redactor.add(stored);
    await this.#o.vault.put(entry, stored);
    await this.#o.onCredentialChange?.(id);
    this.#event('credential_set', { resource: id, credential: name, digest });
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
    const ttl = this.#o.cacheMs ?? 5_000;
    const now = Date.now();
    if (this.#cache !== null && now - this.#cache.at < ttl) return this.#cache.states;
    this.#loading ??= this.#read().finally(() => {
      this.#loading = null;
    });
    const states = await this.#loading;
    this.#cache = { at: Date.now(), states };
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

  async #read(): Promise<ResourceState[]> {
    const latest = new Map<string, AuthorizationRecord>();
    const definition = new Map<string, AuthorizationRecord>();
    let cursor: string | null = null;
    do {
      const page = await this.#o.authorizations.history({ permission: PERMISSION, newestFirst: true, limit: 500, cursor });
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
    const scan = scanForCredentials(canonicalBytes(parsed.data.settings));
    if (scan.findings.length > 0) throw new ConnectorError('RESOURCE_INVALID', '设置里像是有凭据；凭据只经 setCredential 进密钥库', { detail: { findings: scan.findings.length } });
    return parsed.data;
  }

  async #configure(admin: User, record: ResourceRecord, note: string | null): Promise<void> {
    const bytes = canonicalBytes(record);
    const stored = await this.#o.objects.put(bytes, 'application/json');
    await this.#o.authorizations.configureResource(admin, record.id, stored.sha256, note);
    this.invalidate();
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
