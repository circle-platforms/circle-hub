// Authorization records (B04): publish-right grants, pack assignment and removal, resource configuration, sharing, and the
// publish records of pack owners. Each decision is an append-only `authorization@1` record; the latest record per
// (permission, subject, object) wins. Every decision names the record it follows (`supersedes`), so it is a distinct record
// even when it repeats an earlier one in the same millisecond. A permission is not evidence, and a passed check is not a
// permission (B04 R[0]).
import { PackId, PackVersion, UserId } from '../../contracts/src/common.ts';
import type { RunRecord } from '../../contracts/src/run.ts';
import { isPermissionKind, isShareAudience } from '../../contracts/generated/vocabulary.ts';
import type { PermissionKind, PermissionRole } from '../../contracts/generated/vocabulary.ts';
import type {
  ShareAudienceInput,
  PackShareAudience,
  AuthorizationBody,
  AuthorizationInput,
  AuthorizationRecord,
  Authorizations,
  IndexEntry,
  Page,
  PageQuery,
  Principal,
  RecordStore,
  Transaction,
} from './api.ts';
import { RECORD_SCHEMAS, WHOLE_HUB } from './constants.ts';
import { normalizeTime } from './db.ts';
import type { Database } from './db.ts';
import { digestOf, isSha256 } from './digest.ts';
import { verifiedRecord } from './store.ts';
import { AccessError, ConflictError, IntegrityError } from './errors.ts';

const ADMIN: PermissionRole = 'admin';
const PUBLISH: PermissionKind = 'publish';
const ASSIGN: PermissionKind = 'assign';
const PUBLISH_RIGHT: PermissionKind = 'publish_right';
const RESOURCE_CONFIG: PermissionKind = 'resource_config';
const SHARE: PermissionKind = 'share';
const TERM = /^(?:\*|[A-Za-z0-9][A-Za-z0-9_.:@/+#=-]{0,299})$/;
/** Advisory lock namespaces (two-key form): one decision at a time per triple, one publication at a time per pack. */
const DECISION_LOCK_SPACE = 730_158;
const PACK_LOCK_SPACE = 730_159;

function isTerm(value: unknown): value is string {
  return typeof value === 'string' && TERM.test(value);
}

function term(value: unknown, field: string): string {
  if (!isTerm(value)) throw new TypeError(`${field} must match ${TERM}`);
  return value;
}

function note(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 500 || /\p{Cc}/u.test(value.replace(/\n/g, ''))) throw new TypeError('notes are at most 500 characters');
  return value;
}

/** The note rule of every decision, for checks that run before a decision is recorded (package-internal). */
export { note as validNote };

function userId(value: unknown): string {
  if (!UserId.safeParse(value).success) throw new TypeError('not a user id');
  return value as string;
}

function packId(value: unknown): string {
  if (!PackId.safeParse(value).success) throw new TypeError('not a pack id');
  return value as string;
}

/** `pack-id@x.y.z`, the object of a publish record; null for anything else. */
function packVersionOf(object: unknown): { pack: string; version: string } | null {
  if (typeof object !== 'string') return null;
  const at = object.lastIndexOf('@');
  if (at <= 0) return null;
  const pack = object.slice(0, at);
  const version = object.slice(at + 1);
  return PackId.safeParse(pack).success && PackVersion.safeParse(version).success ? { pack, version } : null;
}

export class RecordAuthorizations implements Authorizations {
  readonly #db: Database;
  readonly #store: RecordStore;
  readonly #now: () => Date;

  constructor(db: Database, store: RecordStore, now: () => Date) {
    this.#db = db;
    this.#store = store;
    this.#now = now;
  }

  async grant(by: Principal, input: AuthorizationInput, tx?: Transaction): Promise<AuthorizationRecord> {
    return this.#decide(by, input, false, tx);
  }

  async revoke(by: Principal, input: Omit<AuthorizationInput, 'bound' | 'expiresAt'>): Promise<AuthorizationRecord> {
    return this.#decide(by, { ...input, bound: null, expiresAt: null }, true);
  }

  async latest(permission: PermissionKind, subject: string, object: string): Promise<AuthorizationRecord | null> {
    // A query with a malformed term has no answer rather than an error: nothing was ever decided about it.
    if (!isPermissionKind(permission) || !isTerm(subject) || !isTerm(object)) return null;
    return this.#latest(permission, subject, object);
  }

  async isActive(permission: PermissionKind, subject: string, object: string): Promise<boolean> {
    const record = await this.latest(permission, subject, object);
    return record !== null && this.#active(record);
  }

  async history(query: { permission?: PermissionKind; subject?: string; object?: string } & PageQuery): Promise<Page<AuthorizationRecord>> {
    const { permission, subject, object } = query;
    if ((permission !== undefined && !isPermissionKind(permission)) || (subject !== undefined && !isTerm(subject)) || (object !== undefined && !isTerm(object))) {
      return { items: [], next: null };
    }
    const paging = { limit: query.limit, cursor: query.cursor, newestFirst: query.newestFirst ?? true };
    let index: IndexEntry | null = null;
    if (permission !== undefined && subject !== undefined && object !== undefined) index = { key: 'authz.key', value: `${permission}|${subject}|${object}` };
    else if (permission !== undefined && subject !== undefined) index = { key: 'authz.subject', value: `${permission}|${subject}` };
    else if (permission !== undefined && object !== undefined) index = { key: 'authz.object', value: `${permission}|${object}` };
    else if (subject !== undefined) index = { key: 'authz.subject-any', value: subject };
    else if (object !== undefined) index = { key: 'authz.object-any', value: object };
    else if (permission !== undefined) index = { key: 'authz.permission', value: permission };
    if (index === null) return this.#store.list<AuthorizationBody>({ kind: 'authorization', ...paging });
    return this.#store.find<AuthorizationBody>({ ...index, kind: 'authorization', ...paging });
  }

  async assign(by: Principal, user: string, pack: string, options: { expiresAt?: string | null; note?: string | null } = {}): Promise<AuthorizationRecord> {
    await this.#existingUser(userId(user));
    return this.grant(by, { permission: ASSIGN, subject: user, object: packId(pack), expiresAt: options.expiresAt, note: options.note });
  }

  async unassign(by: Principal, user: string, pack: string, reason?: string | null): Promise<AuthorizationRecord> {
    return this.revoke(by, { permission: ASSIGN, subject: userId(user), object: packId(pack), note: reason });
  }

  async grantPublishRight(by: Principal, user: string, reason?: string | null): Promise<AuthorizationRecord> {
    await this.#existingUser(userId(user));
    return this.grant(by, { permission: PUBLISH_RIGHT, subject: user, object: WHOLE_HUB, note: reason });
  }

  async revokePublishRight(by: Principal, user: string, reason?: string | null): Promise<AuthorizationRecord> {
    return this.revoke(by, { permission: PUBLISH_RIGHT, subject: userId(user), object: WHOLE_HUB, note: reason });
  }

  async configureResource(by: Principal, resourceId: string, bound: string, reason?: string | null, tx?: Transaction): Promise<AuthorizationRecord> {
    if (!isSha256(bound)) throw new TypeError('a resource configuration binds the digest of its content');
    return this.#decide(by, { permission: RESOURCE_CONFIG, subject: WHOLE_HUB, object: term(resourceId, 'resource id'), bound, note: reason }, false, tx);
  }

  async configureResourceInTransaction(by: Principal, object: string, bound: string | null, reason: string, tx: Transaction, revoked = false): Promise<AuthorizationRecord> {
    if (!revoked) {
      if (!isSha256(bound)) throw new TypeError('a resource configuration binds the digest of its content');
      return this.configureResource(by,object,bound,reason,tx);
    }
    return this.#decide(by, { permission: RESOURCE_CONFIG, subject: WHOLE_HUB, object: term(object, 'resource id'), bound, note: reason }, true, tx);
  }

  async resourceConfig(resourceId: string): Promise<AuthorizationRecord | null> {
    const record = await this.latest(RESOURCE_CONFIG, WHOLE_HUB, resourceId);
    return record !== null && this.#active(record) ? record : null;
  }

  async resourceConfigs(resourceIds: readonly string[]): Promise<Map<string, AuthorizationRecord>> {
    const ids = [...new Set(resourceIds.filter(isTerm))];
    if (!ids.length) return new Map();
    const keys = ids.map(id => `${RESOURCE_CONFIG}|${WHOLE_HUB}|${id}`);
    const result = await this.#db.query(
      `SELECT DISTINCT ON (i.value) r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
       FROM record_index i JOIN records r ON r.digest=i.digest
       WHERE i.key='authz.key' AND i.value=ANY($1::text[]) AND r.kind='authorization'
       ORDER BY i.value,i.record_seq DESC`,[keys]);
    const out = new Map<string, AuthorizationRecord>();
    for (const row of result.rows) {
      const record = verifiedRecord<AuthorizationBody>(row);
      if (record.body.permission === RESOURCE_CONFIG && record.body.subject === WHOLE_HUB && this.#active(record)) out.set(record.body.object,record);
    }
    return out;
  }

  async share(by: Principal, object: string, audience: ShareAudienceInput, reason?: string | null): Promise<AuthorizationRecord[]> {
    const target = term(object, 'shared object');
    const members = Array.isArray(audience) ? [...new Set(audience.map(userId))].sort() : [packAudienceSubject(audience)];
    if (members.length === 0 || members.length > 500) throw new TypeError('the audience is 1 to 500 users or one pack');
    return this.#store.withTransaction(async tx => {
      const actor = await this.#decider(by, tx);
      if (actor.role !== ADMIN) throw new AccessError('只有管理员可以分享');
      if (Array.isArray(audience)) for (const member of members) await this.#existingUser(member);
      const out: AuthorizationRecord[] = [];
      for (const member of members) out.push(await this.#decide(by, {
        permission: SHARE, subject: member, object: target, note: reason,
        shareAudience: Array.isArray(audience) ? 'user' : audience.kind,
        ...(target.startsWith('production:') ? { bound: productionShareBinding(target.slice('production:'.length)) } : {}),
      }, false, tx));
      return out;
    });
  }

  async unshare(by: Principal, object: string, audience: string | PackShareAudience, reason?: string | null): Promise<AuthorizationRecord> {
    return this.revoke(by, { permission: SHARE, subject: typeof audience === 'string' ? userId(audience) : packAudienceSubject(audience),
      shareAudience: typeof audience === 'string' ? 'user' : audience.kind, object: term(object, 'shared object'), note: reason });
  }

  async shares(by: Principal, object?: string): Promise<AuthorizationRecord[]> {
    return this.#store.withTransaction(async tx => {
      const actor = await this.#decider(by, tx);
      if (actor.role !== ADMIN) throw new AccessError('只有管理员可以列出分享');
      if (object !== undefined) term(object, 'shared object');
      return activeShares(this.#store, object, this.#now());
    });
  }

  async packsFor(user: string): Promise<string[]> {
    if (!isTerm(user)) return [];
    return this.#activeTerms({ key: 'authz.subject', value: `${ASSIGN}|${user}` }, (body) => body.object);
  }

  async canUse(user: string, pack: string): Promise<boolean> {
    return this.isActive(ASSIGN, user, pack);
  }

  async canPublish(user: string): Promise<boolean> {
    return this.isActive(PUBLISH_RIGHT, user, WHOLE_HUB);
  }

  async usersOf(pack: string): Promise<string[]> {
    if (!isTerm(pack)) return [];
    return this.#activeTerms({ key: 'authz.object', value: `${ASSIGN}|${pack}` }, (body) => body.subject);
  }

  async isSharedWith(user: string, object: string): Promise<boolean> {
    return sharedWith(this.#store, user, object, this.#now());
  }

  async ownerOf(pack: string): Promise<string | null> {
    if (!PackId.safeParse(pack).success) return null;
    return this.#ownerOf(pack);
  }

  async publication(packVersion: string): Promise<AuthorizationRecord | null> {
    const parsed = packVersionOf(packVersion);
    if (parsed === null) return null;
    const owner = await this.#ownerOf(parsed.pack);
    if (owner === null) return null;
    const record = await this.#latest(PUBLISH, owner, packVersion);
    return record !== null && this.#active(record) ? record : null;
  }

  async isPublished(packVersion: string, bound?: string): Promise<boolean> {
    const record = await this.publication(packVersion);
    return record !== null && (bound === undefined || record.body.bound === bound);
  }

  #active(record: AuthorizationRecord): boolean {
    const body = record.body;
    return !body.revoked && (body.expires_at === null || Date.parse(body.expires_at) > this.#now().getTime());
  }

  async #latest(permission: PermissionKind, subject: string, object: string, tx?: Transaction): Promise<AuthorizationRecord | null> {
    const page = await this.#store.find<AuthorizationBody>(
      { key: 'authz.key', value: `${permission}|${subject}|${object}`, kind: 'authorization', limit: 1, newestFirst: true },
      tx,
    );
    return page.items[0] ?? null;
  }

  /** The owner of a pack id is the subject of its first publication (R01 R[0]: new versions only by the owner). */
  async #ownerOf(pack: string, tx?: Transaction): Promise<string | null> {
    const first = await this.#store.find<AuthorizationBody>({ key: 'authz.published-pack', value: pack, kind: 'authorization', limit: 1 }, tx);
    return first.items[0]?.body.subject ?? null;
  }

  /** Latest record per triple among all records under one index entry; returns the chosen term of the active ones, sorted. */
  async #activeTerms(index: IndexEntry, pick: (body: AuthorizationBody) => string): Promise<string[]> {
    const latest = new Map<string, AuthorizationRecord>();
    let cursor: string | null = null;
    do {
      const page: Page<AuthorizationRecord> = await this.#store.find<AuthorizationBody>({ ...index, kind: 'authorization', limit: 500, cursor });
      for (const record of page.items) latest.set(`${record.body.permission}|${record.body.subject}|${record.body.object}`, record);
      cursor = page.next;
    } while (cursor !== null);
    return [...latest.values()].filter((record) => this.#active(record)).map((record) => pick(record.body)).sort();
  }

  async #existingUser(id: string): Promise<void> {
    const row = (await this.#db.query('SELECT 1 FROM users WHERE id = $1', [id])).rows[0];
    if (row === undefined) throw new ConflictError('没有这个用户');
  }

  async #decide(by: Principal, input: AuthorizationInput, revoked: boolean, outer?: Transaction): Promise<AuthorizationRecord> {
    if (!isPermissionKind(input.permission)) throw new TypeError(`unknown permission kind ${JSON.stringify(input.permission)}`);
    const permission = input.permission;
    if (input.shareAudience !== undefined && (!isShareAudience(input.shareAudience) || permission !== SHARE)) throw new TypeError('invalid share audience');
    const subject = term(input.subject, 'subject');
    const object = term(input.object, 'object');
    const bound = input.bound ?? null;
    if (bound !== null && !isSha256(bound)) throw new TypeError('bound must be a lowercase hex SHA-256');
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : normalizeTime(input.expiresAt, 'expiresAt');
    const reason = note(input.note);
    const published = permission === PUBLISH ? packVersionOf(object) : null;
    if (permission === PUBLISH && published === null) throw new TypeError('the object of a publish record is pack-id@x.y.z');
    if (permission === PUBLISH && !revoked && bound === null) throw new TypeError('a publication binds the SHA-256 of the exact pack content (B04 R[1])');
    return this.#store.withTransaction(async (tx) => {
      const decider = await this.#decider(by, tx);
      if (published !== null) {
        if (revoked) {
          // The owner withdraws a version, or an admin does (R01 R[1]).
          if (decider.id !== subject && decider.role !== ADMIN) throw new AccessError('只有包的所有者或管理员可以下架');
        } else {
          await this.#checkPublication(decider.id, subject, published.pack, object, bound as string, tx);
        }
      } else if (decider.role !== ADMIN) {
        throw new AccessError('只有管理员可以分配包、授予发布权、配置资源和分享');
      }
      const key = `${permission}|${subject}|${object}`;
      await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [DECISION_LOCK_SPACE, key], tx);
      const previous = await this.#latest(permission, subject, object, tx);
      const decidedAt = this.#now().toISOString();
      const body: AuthorizationBody = {
        ...(permission === SHARE ? { share_audience: input.shareAudience ?? 'user' } : {}),
        permission,
        subject,
        object,
        revoked,
        bound,
        decided_by: decider.id,
        decided_at: decidedAt,
        expires_at: expiresAt,
        note: reason,
        supersedes: previous?.digest ?? null,
      };
      const index: IndexEntry[] = [
        { key: 'authz.key', value: key },
        { key: 'authz.subject', value: `${permission}|${subject}` },
        { key: 'authz.object', value: `${permission}|${object}` },
        { key: 'authz.permission', value: permission },
        { key: 'authz.subject-any', value: subject },
        { key: 'authz.object-any', value: object },
        { key: 'authz.decider', value: decider.id },
        ...(published !== null && !revoked
          ? [
              { key: 'authz.published', value: object },
              { key: 'authz.published-pack', value: published.pack },
            ]
          : []),
      ];
      const stored = await this.#store.put<AuthorizationBody>(
        { kind: 'authorization', schema: RECORD_SCHEMAS.authorization, provenance: 'declared', body, created_at: decidedAt, index },
        tx,
      );
      // Under the lock every decision follows the previous one, so an identical earlier record cannot exist.
      if (!stored.created) throw new IntegrityError('许可决定与一条已有记录完全相同（决定链断了）', { detail: { digest: stored.digest } });
      return stored;
    }, outer);
  }

  /**
   * R01 R[0], B04 F[0]/R[1]: the owner publishes, holding an active publish right; the first publication of a pack id makes
   * its subject the owner, so another account cannot publish versions of it; a version, once published, names one content.
   */
  async #checkPublication(decider: string, subject: string, pack: string, object: string, bound: string, tx: Transaction): Promise<void> {
    if (decider !== subject) throw new AccessError('只有包的所有者可以发布它的版本');
    const right = await this.#latest(PUBLISH_RIGHT, decider, WHOLE_HUB, tx);
    if (right === null || !this.#active(right)) throw new AccessError('没有发布权；发布权由管理员授予');
    await this.#db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [PACK_LOCK_SPACE, pack], tx);
    const owner = await this.#ownerOf(pack, tx);
    if (owner !== null && owner !== decider) throw new AccessError('这个包属于另一位所有者；新版本只能由包的所有者发布');
    const first = await this.#store.find<AuthorizationBody>({ key: 'authz.published', value: object, kind: 'authorization', limit: 1 }, tx);
    const earlier = first.items[0];
    if (earlier !== undefined && earlier.body.bound !== bound) throw new ConflictError('这个版本已经以另一份内容发布过；内容变了请发布新版本');
  }

  /** The decider as stored now: an enabled account (its current role decides, not the one in the token's Principal). */
  async #decider(by: Principal, tx?: Transaction): Promise<{ id: string; role: PermissionRole }> {
    const id = typeof by?.id === 'string' && UserId.safeParse(by.id).success ? by.id : null;
    const row = id === null ? undefined : (await this.#db.query('SELECT id, role, disabled FROM users WHERE id = $1', [id], tx)).rows[0];
    if (row === undefined || row.disabled === true) throw new AccessError('操作人不是有效的 Hub 账号');
    return { id: String(row.id), role: row.role === ADMIN ? ADMIN : 'user' };
  }
}

function packAudienceSubject(audience: PackShareAudience): string {
  if (!audience || audience.kind !== 'pack_users') throw new TypeError('not a pack audience');
  return `pack_users:${packId(audience.pack)}`;
}

/** A policy object binds this pack and the fact-only condition; each run retains its immutable content digest. */
export function productionShareKey(pack: string): string { return `production:${packId(pack)}`; }
export function productionShareBinding(pack: string): string { return digestOf({ pack: packId(pack), accepted_producer: 'fact' }); }
const activeAt = (record: AuthorizationRecord, now: Date): boolean => !record.body.revoked && (record.body.expires_at === null || Date.parse(record.body.expires_at) > now.getTime());

async function activeShares(store: RecordStore, object: string | undefined, now: Date): Promise<AuthorizationRecord[]> {
  const latest = new Map<string, AuthorizationRecord>();
  let cursor: string | null = null;
  do {
    const page: Page<AuthorizationRecord> = await store.find<AuthorizationBody>({ kind: 'authorization',
      key: object === undefined ? 'authz.permission' : 'authz.object', value: object === undefined ? SHARE : `${SHARE}|${object}`,
      newestFirst: true, limit: 500, cursor });
    for (const record of page.items) {
      const key = `${record.body.subject}|${record.body.object}`;
      if (!latest.has(key)) latest.set(key, record);
    }
    cursor = page.next;
  } while (cursor !== null);
  return [...latest.values()].filter(record => record.body.permission === SHARE && activeAt(record, now)).sort((a,b) => a.body.object.localeCompare(b.body.object) || a.body.subject.localeCompare(b.body.subject));
}

/** Read-only authorization view for readers that have a record store, never a database or a decision capability. */
export async function sharedWith(store: RecordStore, user: string, object: string, now = new Date(), expectedPack?: string): Promise<boolean> {
  if (!UserId.safeParse(user).success || !isTerm(object)) return false;
  for (const share of await activeShares(store, object, now)) {
    const body = share.body;
    if (object.startsWith('production:')) {
      const target = object.slice('production:'.length);
      if (!PackId.safeParse(target).success || body.bound !== productionShareBinding(target)) continue;
    }
    if ((body.share_audience === undefined || body.share_audience === 'user') && body.subject === user) return true;
    if (body.share_audience === 'pack_users' && body.subject.startsWith('pack_users:')) {
      const pack = body.subject.slice('pack_users:'.length);
      if (!PackId.safeParse(pack).success || expectedPack !== undefined && pack !== expectedPack) continue;
      const assignment = (await store.find<AuthorizationBody>({ kind:'authorization', key:'authz.key', value:`assign|${user}|${pack}`, newestFirst:true, limit:1 })).items[0];
      if (assignment && activeAt(assignment, now)) return true;
    }
  }
  return false;
}

/** Sharing is based on frozen requirements, never the currently installed workflow version. */
export async function runIsSharedWith(store: RecordStore, user: string, run: Pick<RunRecord, 'run'|'pack'|'requirements'>, now = new Date()): Promise<boolean> {
  const pack = run.pack.slice(0, run.pack.lastIndexOf('@'));
  if (!PackId.safeParse(pack).success) return false;
  if (await sharedWith(store, user, run.run, now, pack)) return true;
  if (!PackId.safeParse(pack).success || !run.requirements.length || !run.requirements.every(r => r.accepted_producer === 'fact')) return false;
  const assignment = (await store.find<AuthorizationBody>({kind:'authorization',key:'authz.key',value:`assign|${user}|${pack}`,newestFirst:true,limit:1})).items[0];
  return !!assignment && activeAt(assignment,now) && sharedWith(store,user,productionShareKey(pack),now,pack);
}
