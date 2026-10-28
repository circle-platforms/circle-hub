import {defaultParsers} from '../../refs/api.ts';
import { createRequestService } from '../../requests/api.ts';
// The pack registry (T01 T02 B04 R01): publication by the owner of a pack id holding a publish right, the publish check,
// content-addressed storage of every file, assignment of workflow packs to users, activation of product packs for the whole
// Hub, withdrawal by an admin through the authorization chain, listings, and extraction into read-only directories.
//
// A version is published when a publication (authorization record, B04) binds its pack digest; the pack_version record
// holds its manifest and publish-check report, and is written before the publication, so a version becomes visible at
// once when its publication commits. A record without a publication is never shown.
//
// Two active product packs never claim one product line id or one name: every version that is not withdrawn can become the
// version in use (a withdrawal falls back to the next one), so activation and the publication of a version of an active
// product pack compare every such version with every such version of the other active product packs. The in-process lock
// serializes this inside one process; across processes the check runs again after the decision, which is undone on a
// collision.
import { extname } from 'node:path';
import { labelOf, type PackKind } from '../../../contracts/generated/vocabulary.ts';
import type { ProductDeclaration } from '../../../contracts/src/product.ts';
import {
  AccessError,
  ConflictError,
  IntegrityError,
  RecordsError,
  WHOLE_HUB,
  isSha256,
  canonicalize,
  type Transaction,
  type AuthorizationRecord,
  type Page,
  type Principal,
  type RecordsKit,
  type StoredRecord,
} from '../../records/api.ts';
import type { SandboxOptions } from '../../rules/api.ts';
import type { PackHandle } from '../../ports.ts';
import { manifestDigest, readPackDirectory } from './directory.ts';
import { Extractor, type Extraction, type StagedTree, type TamperEvent } from './extract.ts';
import type { ImportPolicy } from './imports.ts';
import { packJsonReader, parseDeclarations } from './load.ts';
import { problem } from './problems.ts';
import { needsSandbox, refusalsOf, runPublishCheck } from './samples.ts';
import type {
  AssignmentInfo,
  PackDeclarations,
  PackInfo,
  PackLimits,
  PackProblem,
  PackVersionBody,
  PackVersionInfo,
  ProductDeclarations,
  PublishOutcome,
  PublishReport,
} from './types.ts';
import { validatePack, versionProblems } from './validate.ts';
import { compareVersions, packVersionKey, parsePackRef } from './versions.ts';

export const PACK_VERSION_SCHEMA = 'pack_version@1';

export type RegistryRecords = Pick<RecordsKit, 'store' | 'objects' | 'authorizations' | 'principals'>;

export interface PackRegistryOptions {
  records: RegistryRecords;
  /** Trusted deployment-name check; called under the variable-name lock in the publication transaction. */
  variableNameAvailable?: (name: string, tx: Transaction) => Promise<boolean>;
  /** Absolute directory for extracted packs (created 0700). */
  extractDir: string;
  /** Clock for pack_version records; default the system clock. */
  now?: () => Date;
  /** Sandbox options for samples that exercise pack functions (requireOsIsolation). */
  sandbox?: SandboxOptions;
  limits?: Partial<PackLimits>;
  /** Import policy of the static scan; default the sandbox's. */
  policy?: ImportPolicy;
  /**
   * For the admin log: the error behind an unknown sample outcome, and a product name or line id that several active product
   * packs claim (context `packs.product_ambiguous`; the lookup answers null).
   */
  onError?: (error: unknown, context: string) => void;
  /** An extracted tree that did not match its digests (it was moved aside and rebuilt), for the admin log. */
  onTamper?: (event: TamperEvent) => void;
}

/** A published version opened for use: its handle on the verified extracted directory, its declarations, readJson. */
export interface OpenedPack {
  info: PackVersionInfo;
  handle: PackHandle;
  declarations: PackDeclarations;
  readJson(path: string): unknown;
}

export interface ActiveProduct {
  info: PackVersionInfo;
  product: ProductDeclaration;
}

export interface PackRegistry {
  readonly extractDir: string;
  /** Publishes the pack in `directory` for its owner (T02); every refusal comes back as problems, never half a publication. */
  publish(owner: Principal, directory: string, options?:{answerRequests?:readonly string[]}): Promise<PublishOutcome>;
  /**
   * Admin: withdraws a published version (R01 R[1], T02 R[4]); existing runs keep it, new runs cannot use it (T02 R[6]). For
   * anyone else absent and forbidden are the same AccessError. Refused (ConflictError with the fix) when the version is the
   * one in use of an active product pack and the version that would take its place claims a name or line id of another one.
   */
  retire(by: Principal, packId: string, version: string, note?: string | null): Promise<AuthorizationRecord>;
  /** Admin: assigns a workflow pack to a user; WHOLE_HUB as the user activates a product pack. */
  assign(by: Principal, userId: string, packId: string, options?: { expiresAt?: string | null; note?: string | null }): Promise<AuthorizationRecord>;
  unassign(by: Principal, userId: string, packId: string, note?: string | null): Promise<AuthorizationRecord>;
  /** Admin: a product pack is inert until it is assigned to the whole Hub; names colliding with an active one are refused. */
  activate(by: Principal, packId: string, note?: string | null): Promise<AuthorizationRecord>;
  install(by: Principal, ref: string, note?: string | null): Promise<AuthorizationRecord>;
  uninstall(by: Principal, packId: string, note?: string | null): Promise<AuthorizationRecord>;
  installedSkills(): Promise<OpenedPack[]>;
  deactivate(by: Principal, packId: string, note?: string | null): Promise<AuthorizationRecord>;
  isActive(packId: string): Promise<boolean>;
  listPacks(): Promise<PackInfo[]>;
  getPack(packId: string): Promise<PackInfo | null>;
  /** A published version, withdrawn or not; null when never published. */
  getVersion(packId: string, version: string): Promise<PackVersionInfo | null>;
  /** The highest version (semantic version order) that is not withdrawn. */
  latestVersion(packId: string): Promise<PackVersionInfo | null>;
  /** `id` (latest) or `id@x.y.z`, only when published and not withdrawn. */
  resolve(ref: string): Promise<PackVersionInfo | null>;
  /** The version a pack digest names, when it was ever published (withdrawn ones included). */
  byDigest(digest: string): Promise<PackVersionInfo | null>;
  /** Publications with their sample counts, newest first. */
  publications(packId?: string): Promise<PackVersionInfo[]>;
  /** Admins see every assignment, a user only their own. */
  assignments(by: Principal): Promise<AssignmentInfo[]>;
  usersOf(packId: string): Promise<string[]>;
  packsFor(userId: string): Promise<string[]>;
  canUse(userId: string, packId: string): Promise<boolean>;
  /** Every active product pack in the version it is used in (the highest that is not withdrawn). */
  activeProducts(): Promise<ActiveProduct[]>;
  /** Permanent declarations, including withdrawn versions; only committed publications claim names. */
  variableDeclarations(tx?: Transaction): Promise<Array<{pack:string;version:string;product:ProductDeclaration}>>;
  /**
   * The active product pack that declares this name (NFC, case-insensitive) or this product line id; null when none, and
   * null when several do (reported to onError: the registry refuses such states, so one slipped past it).
   */
  productNamed(name: string): Promise<ActiveProduct | null>;
  productWithId(id: string): Promise<ActiveProduct | null>;
  /** Declarations of a version ever published, parsed from verified objects. */
  declarations(digest: string): Promise<PackDeclarations | null>;
  /** A version ever published, extracted and verified for this use. */
  open(digest: string): Promise<OpenedPack | null>;
  /**
   * The absolute read-only directory <extractDir>/<digest> (directories 0500, files 0400) of a pack version that has a
   * pack_version record, verified against the object digests on every call. Unknown digests are a ConflictError.
   */
  extractPack(digest: string): Promise<string>;
  /** The account as stored now: null when absent or disabled; its current role. */
  account(principal: Principal): Promise<Principal | null>;
}

const PRODUCTS_LOCK = '#products';
const DECLARATION_FILES: Readonly<Record<PackKind, readonly string[]>> = {
  workflow: ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'knowledge.json', 'SKILL.md'],
  product: ['product.json'],
  system: ['system.json'],
  skill: ['skill.json', 'SKILL.md', 'workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'knowledge.json', 'ledger.json'],
};
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.ts': 'text/x-typescript',
  '.mts': 'text/x-typescript',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
};

const mediaTypeOf = (path: string): string => MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
/** Product names compare as ProductDeclaration compares them: NFC, lower case. */
export const productNameKey = (name: string): string => name.normalize('NFC').toLowerCase();

async function allPages<T>(fetch: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await fetch(cursor);
    out.push(...page.items);
    cursor = page.next;
  } while (cursor !== null);
  return out;
}

interface Publication {
  owner: string;
  digest: string;
  /** The first publication decision: when and by which record the version was published. */
  grant: AuthorizationRecord;
  withdrawn: boolean;
  withdrawnAt: string | null;
}

/** A product pack version that is, or can become, the version in use: what it claims. */
interface Claim {
  id: string;
  version: string;
  product: ProductDeclaration;
  /** The version in use: the highest that is not withdrawn (for a version being published: once it is). */
  inUse: boolean;
}

/** Where a collision is found, for its fix. */
type CollisionAt = 'activate' | 'publish' | 'retire';

class Registry implements PackRegistry {
  readonly extractDir: string;
  readonly #records: RegistryRecords;
  readonly #now: () => Date;
  readonly #options: PackRegistryOptions;
  readonly #extractor: Extractor;
  readonly #recordCache = new Map<string, StoredRecord<PackVersionBody>>();
  readonly #declarationCache = new Map<string, PackDeclarations>();
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: PackRegistryOptions) {
    this.#options = options;
    this.#records = options.records;
    this.#now = options.now ?? (() => new Date());
    this.#extractor = new Extractor({ root: options.extractDir, onTamper: options.onTamper });
    this.extractDir = this.#extractor.root;
  }

  // ---------------------------------------------------------------- accounts and locks

  async account(principal: Principal): Promise<Principal | null> {
    if (typeof principal?.id !== 'string') return null;
    const user = await this.#records.principals.get(principal.id);
    if (user === null || user.disabled) return null;
    return { id: user.id, name: user.name, role: user.role };
  }

  async #exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => current);
    this.#locks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(key) === chained) this.#locks.delete(key);
    }
  }

  async #admin(by: Principal, message: string): Promise<Principal> {
    const account = await this.account(by);
    if (account === null || account.role !== 'admin') throw new AccessError(message);
    return account;
  }

  /** To the admin log; the log never changes what happens. */
  #report(error: unknown, context: string): void {
    try {
      this.#options.onError?.(error, context);
    } catch {
      // ignored
    }
  }

  // ---------------------------------------------------------------- records and publications

  #checked(record: StoredRecord<PackVersionBody>): StoredRecord<PackVersionBody> {
    const body = record.body;
    if (record.schema !== PACK_VERSION_SCHEMA || !isSha256(body?.digest) || manifestDigest(body.manifest) !== body.digest || body.manifest.id !== body.pack || body.manifest.version !== body.version) {
      throw new IntegrityError('包版本记录与它的清单不符', { detail: { record: record.digest } });
    }
    return record;
  }

  async #recordByDigest(digest: string): Promise<StoredRecord<PackVersionBody> | null> {
    if (!isSha256(digest)) return null;
    const cached = this.#recordCache.get(digest);
    if (cached !== undefined) return cached;
    const page = await this.#records.store.find<PackVersionBody>({ key: 'pack.digest', value: digest, kind: 'pack_version', limit: 1 });
    const record = page.items[0];
    if (record === undefined) return null;
    this.#recordCache.set(digest, this.#checked(record));
    return record;
  }

  async #packIds(): Promise<string[]> {
    const records = await allPages((cursor) => this.#records.store.list<PackVersionBody>({ kind: 'pack_version', limit: 500, cursor }));
    return [...new Set(records.map((r) => r.body.pack))].sort();
  }

  /**
   * Every version of a pack id by the owner's publish decisions, in one query: the first grant of `id@x.y.z` names its
   * content, the latest decision says whether it still stands (the rule of Authorizations.isPublished: the owner's latest
   * decision, not revoked, not expired, bound to that content). Selecting a version for use asks isPublished again.
   */
  async #publications(packId: string): Promise<Map<string, Publication>> {
    const out = new Map<string, Publication>();
    if (parsePackRef(packId) === null) return out;
    const authorizations = this.#records.authorizations;
    const owner = await authorizations.ownerOf(packId);
    if (owner === null) return out;
    const decisions = await allPages((cursor) => authorizations.history({ permission: 'publish', subject: owner, newestFirst: false, limit: 500, cursor }));
    const byVersion = new Map<string, AuthorizationRecord[]>();
    for (const decision of decisions) {
      const ref = parsePackRef(decision.body.object);
      if (ref === null || ref.id !== packId || ref.version === null) continue;
      const list = byVersion.get(ref.version) ?? [];
      list.push(decision);
      byVersion.set(ref.version, list);
    }
    const now = this.#now().getTime();
    for (const [version, list] of byVersion) {
      const grant = list.find((d) => !d.body.revoked && d.body.bound !== null);
      if (grant === undefined) continue;
      const latest = list[list.length - 1].body;
      const active = !latest.revoked && latest.bound === grant.body.bound && (latest.expires_at === null || Date.parse(latest.expires_at) > now);
      out.set(version, {
        owner,
        digest: grant.body.bound as string,
        grant,
        withdrawn: !active,
        withdrawnAt: active ? null : latest.revoked ? latest.decided_at : latest.expires_at,
      });
    }
    return out;
  }

  async #versionInfo(packId: string, version: string, publication: Publication): Promise<PackVersionInfo | null> {
    const record = await this.#recordByDigest(publication.digest);
    if (record === null || record.body.pack !== packId || record.body.version !== version) return null;
    return this.#info(record, publication);
  }

  #info(record: StoredRecord<PackVersionBody>, publication: Publication): PackVersionInfo {
    const b = record.body;
    return {
      id: b.pack,
      version: b.version,
      kind: b.kind,
      title: b.title,
      description: b.description,
      digest: b.digest,
      owner: publication.owner,
      // The publication decides who published; the record keeps who first ran the publish check.
      publisher: publication.grant.body.decided_by,
      published_at: publication.grant.body.decided_at,
      withdrawn: publication.withdrawn,
      withdrawn_at: publication.withdrawnAt,
      record: record.digest,
      publication: publication.grant.digest,
      samples: { ...b.report.samples.sources },
      report: b.report,
      manifest: b.manifest,
    };
  }

  async getVersion(packId: string, version: string): Promise<PackVersionInfo | null> {
    const ref = parsePackRef(`${packId}@${version}`);
    if (ref === null || ref.id !== packId) return null;
    const publication = (await this.#publications(packId)).get(version);
    return publication === undefined ? null : this.#versionInfo(packId, version, publication);
  }

  async #versions(packId: string): Promise<PackVersionInfo[]> {
    const publications = await this.#publications(packId);
    const infos = await Promise.all([...publications].map(([version, publication]) => this.#versionInfo(packId, version, publication)));
    return infos.filter((i): i is PackVersionInfo => i !== null).sort((a, b) => compareVersions(b.version, a.version));
  }

  async latestVersion(packId: string): Promise<PackVersionInfo | null> {
    return (await this.#versions(packId)).find((v) => !v.withdrawn) ?? null;
  }

  async resolve(ref: string): Promise<PackVersionInfo | null> {
    const parsed = parsePackRef(ref);
    if (parsed === null) return null;
    const info = parsed.version === null ? await this.latestVersion(parsed.id) : await this.getVersion(parsed.id, parsed.version);
    if (info === null || info.withdrawn) return null;
    // The version selected for use is confirmed with the publication itself (B04 R[1], R[2]).
    return (await this.#records.authorizations.isPublished(packVersionKey(info.id, info.version), info.digest)) ? info : null;
  }

  async byDigest(digest: string): Promise<PackVersionInfo | null> {
    const record = await this.#recordByDigest(digest);
    if (record === null) return null;
    const publication = (await this.#publications(record.body.pack)).get(record.body.version);
    if (publication === undefined || publication.digest !== digest) return null;
    return this.#info(record, publication);
  }

  async getPack(packId: string): Promise<PackInfo | null> {
    const versions = await this.#versions(packId);
    if (versions.length === 0) return null;
    const kind = versions[0].kind;
    return {
      id: packId,
      kind,
      owner: versions[0].owner,
      active: (kind === 'product'||kind==='skill') && (await this.#records.authorizations.isActive('assign', WHOLE_HUB, packId)),
      latest: versions.find((v) => !v.withdrawn)?.version ?? null,
      versions,
    };
  }

  async listPacks(): Promise<PackInfo[]> {
    const packs = await Promise.all((await this.#packIds()).map((id) => this.getPack(id)));
    return packs.filter((p): p is PackInfo => p !== null);
  }

  async publications(packId?: string): Promise<PackVersionInfo[]> {
    const ids = packId === undefined ? await this.#packIds() : [packId];
    const all = (await Promise.all(ids.map((id) => this.#versions(id)))).flat();
    return all.sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0));
  }

  // ---------------------------------------------------------------- assignment and activation

  async isActive(packId: string): Promise<boolean> {
    if (!(await this.#records.authorizations.isActive('assign', WHOLE_HUB, packId))) return false;
    return (await this.latestVersion(packId))?.kind === 'product';
  }

  async #kindOf(packId: string): Promise<PackKind | null> {
    return (await this.#versions(packId))[0]?.kind ?? null;
  }

  async assign(by: Principal, userId: string, packId: string, options: { expiresAt?: string | null; note?: string | null } = {}): Promise<AuthorizationRecord> {
    if (userId === WHOLE_HUB) return this.activate(by, packId, options.note);
    await this.#admin(by, '只有管理员可以分配包');
    const kind = await this.#kindOf(packId);
    if (kind === 'skill') throw new ConflictError('通用技能包由管理员安装，不按用户分配', { fix: '用 pack install 安装技能包' });
    if (kind === null) throw new ConflictError(`没有发布过包 ${packId}`, { fix: '先发布这个包，再分配' });
    const label = labelOf('pack_kind', kind);
    if (kind === 'system') throw new ConflictError(`${packId} 是${label}；${label}由管理员实例化为资源，不分配给用户（T01 R[3]）`, { fix: `在资源配置里实例化这个${label}` });
    if (kind === 'product') throw new ConflictError(`${packId} 是${label}；${label}不分配给单个用户，而是对整个 Hub 启用`, { fix: `用 activate 启用这个${label}` });
    return this.#records.authorizations.assign(by, userId, packId, options);
  }

  async unassign(by: Principal, userId: string, packId: string, note?: string | null): Promise<AuthorizationRecord> {
    if (userId === WHOLE_HUB) return this.deactivate(by, packId, note);
    return this.#records.authorizations.unassign(by, userId, packId, note);
  }

  async variableDeclarations(tx?: Transaction): Promise<Array<{pack:string;version:string;product:ProductDeclaration}>> {
    const decisions = await allPages(cursor => this.#records.store.find<AuthorizationRecord['body']>({kind:'authorization',key:'authz.permission',value:'publish',newestFirst:false,limit:500,cursor},tx));
    const out: Array<{pack:string;version:string;product:ProductDeclaration}>=[];
    const seen=new Set<string>();
    for(const row of decisions){
      if(row.body.revoked || !row.body.bound || seen.has(row.body.object))continue;
      seen.add(row.body.object);
      const records=await this.#records.store.find<PackVersionBody>({kind:'pack_version',key:'pack.digest',value:row.body.bound,limit:1},tx);
      const record=records.items[0];
      if(!record || record.body.kind!=='product')continue;
      const declarations=await this.declarations(row.body.bound);
      if(declarations?.kind==='product' && declarations.product.variables?.length)out.push({pack:record.body.pack,version:record.body.version,product:declarations.product});
    }
    return out;
  }

  async activeProducts(): Promise<ActiveProduct[]> {
    const ids = await this.#records.authorizations.packsFor(WHOLE_HUB);
    const out: ActiveProduct[] = [];
    for (const id of ids) {
      const info = await this.latestVersion(id);
      if (info === null || info.kind !== 'product') continue;
      const declarations = await this.declarations(info.digest);
      if (declarations?.kind === 'product') out.push({ info, product: declarations.product });
    }
    return out;
  }

  #unique(hits: readonly ActiveProduct[], what: string): ActiveProduct | null {
    if (hits.length <= 1) return hits[0] ?? null;
    const refs = hits.map((h) => packVersionKey(h.info.id, h.info.version));
    this.#report(new ConflictError(`${what} 同时属于启用中的${labelOf('pack_kind', 'product')} ${refs.join('、')}；查找按没有这个产品回答`, { fix: '停用其中一个', detail: { packs: refs } }), 'packs.product_ambiguous');
    return null;
  }

  async productNamed(name: string): Promise<ActiveProduct | null> {
    if (typeof name !== 'string' || name.trim() === '') return null;
    const key = productNameKey(name);
    return this.#unique((await this.activeProducts()).filter((a) => a.product.names.some((n) => productNameKey(n) === key)), `产品名 ${name}`);
  }

  async productWithId(id: string): Promise<ActiveProduct | null> {
    if (typeof id !== 'string' || id === '') return null;
    return this.#unique((await this.activeProducts()).filter((a) => a.product.id === id), `产品线号 ${id}`);
  }

  /** What the versions of a pack that are not withdrawn claim, highest (the one in use) first; empty for other kinds. */
  async #claims(packId: string): Promise<Claim[]> {
    const out: Claim[] = [];
    for (const info of (await this.#versions(packId)).filter((v) => !v.withdrawn)) {
      if (info.kind !== 'product') return [];
      const declarations = await this.declarations(info.digest);
      if (declarations?.kind === 'product') out.push({ id: info.id, version: info.version, product: declarations.product, inUse: out.length === 0 });
    }
    return out;
  }

  /** What every active product pack other than `except` claims, in every version not withdrawn (`inUse` only: the ones in use). */
  async #activeClaims(except: string, inUse = false): Promise<Claim[]> {
    const out: Claim[] = [];
    for (const id of await this.#records.authorizations.packsFor(WHOLE_HUB)) {
      if (id !== except) out.push(...(await this.#claims(id)).filter((c) => !inUse || c.inUse));
    }
    return out;
  }

  /** Product line ids and names (NFC, lower case, as ProductDeclaration compares them) that claims share with other packs' claims. */
  #collisions(mine: readonly Claim[], others: readonly Claim[], at: CollisionAt): PackProblem[] {
    const out: PackProblem[] = [];
    const ref = (c: Claim): string => `${packVersionKey(c.id, c.version)}${c.inUse ? '' : '（未下架的旧版本，下架在用版本后会成为在用版本）'}`;
    for (const m of mine) {
      for (const o of others) {
        if (o.id === m.id) continue;
        const fix =
          at === 'publish'
            ? `换一个产品名（或产品线号）后发布，或者请管理员先停用 ${o.id}${o.inUse ? '' : `、下架 ${packVersionKey(o.id, o.version)}`}`
            : at === 'retire'
              ? `先停用 ${m.id} 或 ${o.id}，再下架这一版`
              : `先停用 ${o.id}，${m.inUse && o.inUse ? '' : '或者下架撞名的旧版本，'}或者改名后发布新版本`;
        if (o.product.id === m.product.id) {
          out.push(problem('product.id_collision', 'product.json', `${ref(m)} 的产品线号 ${m.product.id} 已经属于启用中的${labelOf('pack_kind', 'product')} ${ref(o)}`, fix, { field: '/id' }));
        }
        const theirs = new Map(o.product.names.map((n) => [productNameKey(n), n]));
        m.product.names.forEach((name, i) => {
          const hit = theirs.get(productNameKey(name));
          if (hit !== undefined) {
            out.push(problem('product.name_collision', 'product.json', `${ref(m)} 的产品名 ${name} 与启用中的${labelOf('pack_kind', 'product')} ${ref(o)} 的产品名 ${hit} 相同（不分大小写）`, fix, { field: `/names/${i}` }));
          }
        });
      }
    }
    return out;
  }

  #collisionError(collisions: readonly PackProblem[], lead = ''): ConflictError {
    return new ConflictError(`${lead}${collisions.map((c) => c.message).join('；')}`, { fix: collisions[0].fix, detail: { problems: collisions } });
  }

  async activate(by: Principal, packId: string, note?: string | null): Promise<AuthorizationRecord> {
    const product = labelOf('pack_kind', 'product');
    await this.#admin(by, `只有管理员可以启用${product}`);
    return this.#exclusive(PRODUCTS_LOCK, async () => {
      const info = await this.latestVersion(packId);
      if (info === null) throw new ConflictError(`包 ${packId} 没有可用的版本`, { fix: `先发布这个${product}` });
      if (info.kind !== 'product') {
        throw new ConflictError(`${packId} 是${labelOf('pack_kind', info.kind)}；只有${product}对整个 Hub 启用`, { fix: `${labelOf('pack_kind', 'workflow')}分配给用户；${labelOf('pack_kind', 'system')}实例化为资源` });
      }
      const before = this.#collisions(await this.#claims(packId), await this.#activeClaims(packId), 'activate');
      if (before.length > 0) throw this.#collisionError(before);
      const granted = await this.#records.authorizations.grant(by, { permission: 'assign', subject: WHOLE_HUB, object: packId, note });
      // Another Hub process may have activated a colliding pack or published a colliding version meanwhile: checked again
      // with this activation in place, and undone on a collision (at least one of two racing decisions sees the other).
      const after = this.#collisions(await this.#claims(packId), await this.#activeClaims(packId), 'activate');
      if (after.length > 0) {
        await this.#records.authorizations.revoke(by, { permission: 'assign', subject: WHOLE_HUB, object: packId, note: '启用的同时另一个决定造成撞名，启用撤回' });
        throw this.#collisionError(after, '启用的同时出现了撞名，启用已撤回：');
      }
      return granted;
    });
  }

  async install(by: Principal, ref: string, note?: string | null): Promise<AuthorizationRecord> {
    await this.#admin(by, '只有管理员可以安装通用技能包');
    if(parsePackRef(ref)?.version==null)throw new ConflictError('安装必须指定技能包精确版本',{fix:'使用 pack install <技能包@版本>'});
    const info = await this.resolve(ref);
    if (info?.kind !== 'skill') throw new ConflictError('没有可安装的通用技能包版本', { fix: '先发布 kind=skill 的包，再按精确版本安装' });
    return this.#records.store.withTransaction(async tx=>{
      await this.#records.store.lock('skills.install',tx);
      const opened=await this.open(info.digest);
      if(opened?.declarations.kind!=='skill')throw new ConflictError('技能包不可读取');
      const installed=await this.installedSkills();
      if(installed.length>=64&&!installed.some(pack=>pack.info.id===info.id))throw new ConflictError('安装技能包超过运行锁的 64 包上限',{fix:'先卸载不再需要的技能包，再安装'});
      const occupied=new Set([...defaultParsers().map(p=>p.id+'@'+p.version),...(await this.installedSkills()).filter(p=>p.info.id!==info.id).flatMap(p=>p.declarations.kind==='skill'?p.declarations.skill.parsers.map(row=>row.parser):[])]);
      for(const parser of opened.declarations.skill.parsers)if(occupied.has(parser.parser))throw new ConflictError('已安装技能包重复声明解析器 '+parser.parser,{fix:'先卸载冲突技能包，再安装唯一声明者'});
      for(const dep of opened.info.manifest.dependencies??[])if(!(await this.installedSkills()).some(p=>p.info.id===dep.pack&&(dep.version===undefined||dep.version===p.info.version)))throw new ConflictError('缺少技能包依赖 '+dep.pack,{fix:'先安装声明的依赖版本'});
      return this.#records.authorizations.grant(by,{permission:'assign',subject:WHOLE_HUB,object:info.id,bound:info.digest,note},tx);
    });
  }

  async uninstall(by: Principal, packId: string, note?: string | null): Promise<AuthorizationRecord> {
    await this.#admin(by,'只有管理员可以卸载通用技能包');
    if(await this.#kindOf(packId)!=='skill')throw new ConflictError('这不是通用技能包',{fix:'指定已发布的通用技能包'});
    return this.#records.authorizations.revoke(by,{permission:'assign',subject:WHOLE_HUB,object:packId,note});
  }

  async installedSkills(): Promise<OpenedPack[]> {
    const out:OpenedPack[]=[];
    for(const id of await this.#records.authorizations.packsFor(WHOLE_HUB)){
      const decision=await this.#records.authorizations.latest('assign',WHOLE_HUB,id);
      if(!decision||decision.body.revoked||!decision.body.bound)continue;
      const info=await this.byDigest(decision.body.bound);
      if(!info||info.kind!=='skill'||info.withdrawn)continue;
      const opened=await this.open(info.digest);if(opened)out.push(opened);
    }
    return out;
  }

  async deactivate(by: Principal, packId: string, note?: string | null): Promise<AuthorizationRecord> {
    return this.#records.authorizations.revoke(by, { permission: 'assign', subject: WHOLE_HUB, object: packId, note });
  }

  async assignments(by: Principal): Promise<AssignmentInfo[]> {
    const account = await this.account(by);
    if (account === null) return [];
    const authorizations = this.#records.authorizations;
    const out: AssignmentInfo[] = [];
    for (const pack of await this.#packIds()) {
      const users = account.role === 'admin' ? await authorizations.usersOf(pack) : (await authorizations.canUse(account.id, pack)) ? [account.id] : [];
      for (const user of users) {
        if (user === WHOLE_HUB) continue;
        const record = await authorizations.latest('assign', user, pack);
        if (record === null) continue;
        out.push({ user, pack, decided_by: record.body.decided_by, decided_at: record.body.decided_at, expires_at: record.body.expires_at, record: record.digest });
      }
    }
    return out;
  }

  async usersOf(packId: string): Promise<string[]> {
    return (await this.#records.authorizations.usersOf(packId)).filter((u) => u !== WHOLE_HUB);
  }

  packsFor(userId: string): Promise<string[]> {
    return this.#records.authorizations.packsFor(userId);
  }

  async canUse(userId: string, packId: string): Promise<boolean> {
    if(await this.#kindOf(packId)==='skill'){const user=await this.#records.principals.get(userId);return !!user&&!user.disabled&&(await this.installedSkills()).some(p=>p.info.id===packId);}
    return this.#records.authorizations.canUse(userId, packId);
  }

  async retire(by: Principal, packId: string, version: string, note?: string | null): Promise<AuthorizationRecord> {
    // The right first: whoever may not withdraw learns nothing about which versions exist.
    await this.#admin(by, '只有管理员可以下架包或版本（R01 R[1]、T02 R[4]）');
    const info = await this.getVersion(packId, version);
    const key = packVersionKey(packId, version);
    if (info === null || info.withdrawn) throw new ConflictError(`没有已发布的 ${key}`, { fix: '核对包号和版本' });
    const withdraw = (): Promise<AuthorizationRecord> => this.#records.authorizations.revoke(by, { permission: 'publish', subject: info.owner, object: key, note });
    if (info.kind !== 'product') return withdraw();
    return this.#exclusive(PRODUCTS_LOCK, async () => {
      // Withdrawing the version in use of an active product pack puts the next one in use: it must not claim what another
      // active product pack uses.
      const claims = await this.#claims(packId);
      if (claims[0]?.version === version && claims.length > 1 && (await this.#records.authorizations.isActive('assign', WHOLE_HUB, packId))) {
        const next: Claim = { ...claims[1], inUse: true };
        const collisions = this.#collisions([next], await this.#activeClaims(packId, true), 'retire');
        if (collisions.length > 0) throw this.#collisionError(collisions, `下架 ${key} 之后 ${packVersionKey(packId, next.version)} 会成为在用版本：`);
      }
      return withdraw();
    });
  }

  // ---------------------------------------------------------------- reading published versions

  async declarations(digest: string): Promise<PackDeclarations | null> {
    const cached = this.#declarationCache.get(digest);
    if (cached !== undefined) return cached;
    const record = await this.#recordByDigest(digest);
    if (record === null) return null;
    const files = new Map<string, Uint8Array>();
    for (const entry of record.body.manifest.files) {
      if (!DECLARATION_FILES[record.body.kind].includes(entry.path)) continue;
      const bytes = await this.#records.objects.get(entry.sha256);
      if (bytes === null) throw new IntegrityError(`包文件 ${entry.path} 的原件缺失；请从备份恢复`, { detail: { digest, path: entry.path } });
      files.set(entry.path, bytes);
    }
    const declarations = parseDeclarations(record.body.kind, files);
    this.#declarationCache.set(digest, declarations);
    return declarations;
  }

  async #extraction(record: StoredRecord<PackVersionBody>): Promise<Extraction> {
    const objects = this.#records.objects;
    return this.#extractor.extract(record.body.digest, async () => ({ manifest: record.body.manifest, read: (sha256) => objects.get(sha256) }));
  }

  async extractPack(digest: string): Promise<string> {
    const record = await this.#recordByDigest(digest);
    if (record === null) throw new ConflictError('没有这个包版本', { detail: { digest } });
    return (await this.#extraction(record)).directory;
  }

  async open(digest: string): Promise<OpenedPack | null> {
    const info = await this.byDigest(digest);
    if (info === null) return null;
    const record = (await this.#recordByDigest(digest)) as StoredRecord<PackVersionBody>;
    const extraction = await this.#extraction(record);
    const declarations = (await this.declarations(digest)) as PackDeclarations;
    return {
      info,
      handle: { id: info.id, version: info.version, digest, kind: info.kind, directory: extraction.directory },
      declarations,
      readJson: packJsonReader(extraction.directory, record.body.manifest, digest),
    };
  }

  // ---------------------------------------------------------------- publication

  async publish(owner: Principal, directory: string, options:{answerRequests?:readonly string[]}={}): Promise<PublishOutcome> {
    const refuse = (problems: PackProblem[], report: PublishReport | null = null): PublishOutcome => ({ ok: false, problems, report });
    const account = await this.account(owner);
    if (account === null) return refuse([problem('publish.account', '.', '发布人不是有效的 Hub 账号（不存在或已停用）', '用有效的账号发布')]);
    if (!(await this.#records.authorizations.canPublish(account.id))) return refuse([problem('publish.no_right', '.', `${account.name} 没有发布权`, '请管理员授予发布权（B04）')]);
    const read = await readPackDirectory(directory, { limits: this.#options.limits });
    if (!read.ok) return refuse(read.problems);
    const { manifest, digest } = read.pack;
    const answers=[...new Set(options.answerRequests??[])];
    const requests=createRequestService(this.#records,this.#now);
    const outcome=await this.#exclusive(manifest.id, async ():Promise<PublishOutcome> => {
      const authorizations = this.#records.authorizations;
      const currentOwner = await authorizations.ownerOf(manifest.id);
      if (currentOwner !== null && currentOwner !== account.id) {
        return refuse([problem('publish.not_owner', 'pack.json', `包 ${manifest.id} 的所有者是另一位用户；新版本只能由包的所有者发布（T02 R[4]）`, '用自己的包号发布，或者请所有者发布新版本', { field: '/id' })]);
      }
      const earlier = await this.getVersion(manifest.id, manifest.version);
      for(const id of answers){
        const request=await requests.inspect(id);
        const previous=request?.pack_digest?await this.byDigest(request.pack_digest):null;
        if(!request||request.kind!=='repair'||request.audience!==account.id||!previous||previous.id!==manifest.id||previous.owner!==account.id||request.pack_digest===digest||request.answered_by!==null&&request.answered_by!==earlier?.record)return refuse([problem('publish.answer_request','pack.json','指定请求对发布人不可用，或不属于这个包的待修复版本','给出发给本包作者的修复请求摘要；重试已有作答时使用相同版本')]);
      }

      if (earlier !== null) {
        if (earlier.digest === digest && !earlier.withdrawn) return { ok: true, created: false, version: earlier, report: earlier.report };
        if (earlier.withdrawn) return refuse([problem('publish.version_withdrawn', 'pack.json', `${packVersionKey(manifest.id, manifest.version)} 已经下架；下架的版本号不再使用`, '改大版本号后发布新版本', { field: '/version' })]);
        return refuse([problem('publish.version_reused', 'pack.json', `${packVersionKey(manifest.id, manifest.version)} 已经以另一份内容发布过；发布过的版本不再改变`, '改大版本号后发布', { field: '/version' })]);
      }
      const decided = await authorizations.history({ permission: 'publish', object: packVersionKey(manifest.id, manifest.version), limit: 1 });
      if (decided.items.length > 0) {
        return refuse([problem('publish.version_reused', 'pack.json', `${packVersionKey(manifest.id, manifest.version)} 已经有发布决定；版本号不再使用`, '改大版本号后发布', { field: '/version' })]);
      }
      const kind = await this.#kindOf(manifest.id);
      if (kind !== null && kind !== manifest.kind) {
        return refuse([problem('publish.kind_changed', 'pack.json', `包 ${manifest.id} 已发布的版本是${labelOf('pack_kind', kind)}，这一版写的是${labelOf('pack_kind', manifest.kind)}`, '种类不能改；换一个包号发布', { field: '/kind' })]);
      }
      const validation = await validatePack(read.pack, { policy: this.#options.policy });
      if (!validation.ok) return refuse(validation.problems);
      // validatePack refuses these too; nothing below may run for a version no reference can name.
      const unnamable = versionProblems(manifest);
      if (unnamable.length > 0) return refuse(unnamable);
      const pack = validation.pack;

      let staged: StagedTree | null = null;
      try {
        if (needsSandbox(pack)) staged = await this.#extractor.stage(digest, read.pack.manifestBytes, read.pack.files.map((f) => ({ path: f.path, bytes: f.bytes })));
        const report = await runPublishCheck({ pack, packDir: staged?.directory ?? null, sandbox: this.#options.sandbox, onError: this.#options.onError });
        report.warnings.unshift(...pack.warnings);
        const refusals = refusalsOf(report, pack);
        if (refusals.length > 0) return refuse(refusals, report);

        const store = async (): Promise<PublishOutcome> => {
          // Immutable bytes may precede the decision. Name ownership and publication become visible together.
          const product = pack.declarations.kind==='product' ? pack.declarations.product : null;
          const committed = await this.#records.store.withTransaction(async tx => {
          if(product){
            if(product.variables?.length && !this.#options.variableNameAvailable)return refuse([problem('variables.port_missing','product.json','产品变量的部署名字核对端口未接线','请管理员修正装配端口后重新发布')],report);
            await this.#records.store.lock('pack-products',tx);
            for(const name of [...(product.variables??[])].map(v=>v.name).sort())await this.#records.store.lock('variable-name:'+name,tx);
            const previous=await this.variableDeclarations(tx);
            for(const variable of product.variables??[]){
              const claims=previous.filter(p=>p.product.variables?.some(v=>v.name===variable.name));
              if(claims.some(c=>c.pack!==manifest.id) || (claims.length===0 && !(await this.#options.variableNameAvailable?.(variable.name,tx)))) return refuse([problem('variables.unavailable','product.json','名字不可用','换一个变量名字')],report);
              if(claims.some(c=>c.product.variables?.some(v=>v.name===variable.name && canonicalize(v.schema)!==canonicalize(variable.schema)))) return refuse([problem('variables.schema_changed','product.json',`变量 ${variable.name} 的模式和已发布版本不同`,'模式要改请换一个变量名字')],report);
            }
          }
          for (const file of read.pack.files) await this.#records.objects.put(file.bytes, mediaTypeOf(file.path));
          await this.#records.objects.put(read.pack.manifestBytes, 'application/json');
          const body: PackVersionBody = {
            pack: manifest.id,
            version: manifest.version,
            kind: manifest.kind,
            digest,
            title: manifest.title,
            description: manifest.description,
            manifest,
            publisher: account.id,
            report,
          };
          if ((await this.#recordByDigest(digest)) === null) {
            await this.#records.store.put<PackVersionBody>({
              kind: 'pack_version',
              schema: PACK_VERSION_SCHEMA,
              provenance: 'declared',
              body,
              created_at: this.#now().toISOString(),
              index: [
                { key: 'pack.id', value: manifest.id },
                { key: 'pack.version', value: packVersionKey(manifest.id, manifest.version) },
                { key: 'pack.digest', value: digest },
                { key: 'pack.kind', value: manifest.kind },
              ],
            });
          }
          try {
            await authorizations.grant(owner, { permission: 'publish', subject: account.id, object: packVersionKey(manifest.id, manifest.version), bound: digest }, tx);
          } catch (error) {
            if (error instanceof RecordsError && !(error instanceof IntegrityError)) return refuse([problem('publish.refused', 'pack.json', `发布被拒绝：${error.message}`, error.fix ?? '核对发布权和包的所有者')], report);
            throw error;
          }
          return null;
          });
          if(committed!==null)return committed;
          if(staged!==null){await staged.promote();staged=null;}
          const version=await this.getVersion(manifest.id,manifest.version);
          if(version===null)throw new IntegrityError('发布之后读不到这个版本');
          return {ok:true,created:true,version,report};
        };

        if (manifest.kind !== 'product') return await store();
        // A version of an active product pack can become the version in use whatever its number (a withdrawal falls back
        // to it), so it must claim nothing another active product pack claims in any version that is not withdrawn.
        const product = (pack.declarations as ProductDeclarations).product;
        return await this.#exclusive(PRODUCTS_LOCK, async () => {
          const latest = (await this.#claims(manifest.id))[0];
          const claim: Claim = { id: manifest.id, version: manifest.version, product, inUse: latest === undefined || compareVersions(manifest.version, latest.version) > 0 };
          const colliding = async (): Promise<PackProblem[]> =>
            (await authorizations.isActive('assign', WHOLE_HUB, manifest.id)) ? this.#collisions([claim], await this.#activeClaims(manifest.id), 'publish') : [];
          const before = await colliding();
          if (before.length > 0) return refuse(before, report);
          const outcome = await store();
          if (!outcome.ok || !outcome.created) return outcome;
          // As for activation: another Hub process may have activated a colliding pack (or this one) meanwhile. The owner's
          // publication is then withdrawn again, and its version number stays used.
          const after = await colliding();
          if (after.length === 0) return outcome;
          const key = packVersionKey(manifest.id, manifest.version);
          await authorizations.revoke(owner, { permission: 'publish', subject: account.id, object: key, note: '发布的同时另一个决定造成撞名，发布撤回' });
          return refuse(
            [...after, problem('publish.withdrawn', 'pack.json', `${key} 发布的同时出现了撞名，发布已撤回；这个版本号不再使用`, '改掉撞名的产品名或产品线号，用更大的版本号发布', { field: '/version' })],
            report,
          );
        });
      } finally {
        if (staged !== null) await (staged as StagedTree).discard();
      }
    });
    if(outcome.ok)try{for(const id of answers)await requests.answer(id,outcome.version.record);}
    catch(error){this.#report(error,'request answer after publication');throw new RecordsError('包版本已发布，但请求作答尚未全部保存',{cause:error,fix:error instanceof RecordsError&&error.fix?error.fix:'对同一目录和版本原样重试 pack publish，并保留全部 --answer-request 参数；不会重新发布版本'});}
    return outcome;
  }
}

export function createPackRegistry(options: PackRegistryOptions): PackRegistry {
  return new Registry(options);
}
