// A request-scoped view of an authenticated reader's permissions, captured in one database statement.
import { AsyncLocalStorage } from 'node:async_hooks';
import { PackId } from '../../contracts/src/common.ts';
import { isPermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { AuthorizationBody, AuthorizationRecord, Principal, User } from './api.ts';
import { iso, type Database } from './db.ts';
import { digestOf } from './digest.ts';
import { verifiedRecord } from './store.ts';

export class RequestPermissions {
  active = true;
  readonly cache = new Map<string, Promise<unknown>>();
  cacheBytes = 0;
  readonly #grants = new Map<string, AuthorizationRecord>();
  readonly principalId: string;
  readonly user: User | null;
  readonly at: Date;
  constructor(principalId: string, user: User | null, at: Date, grants: readonly AuthorizationRecord[]) {
    this.principalId = principalId; this.user = user; this.at = at;
    for (const record of grants) this.#grants.set(this.key(record.body.permission, record.body.subject, record.body.object), record);
  }
  private key(permission: string, subject: string, object: string) { return `${permission}\0${subject}\0${object}`; }
  latest(permission: string, subject: string, object: string): AuthorizationRecord | null { return this.#grants.get(this.key(permission,subject,object)) ?? null; }
  enabled(record: AuthorizationRecord | null): boolean { return record !== null && !record.body.revoked && (record.body.expires_at === null || Date.parse(record.body.expires_at) > this.at.getTime()); }
  canUse(pack: string): boolean { return this.user !== null && !this.user.disabled && this.enabled(this.latest('assign',this.user.id,pack)); }
  packs(): string[] { return this.user === null || this.user.disabled ? [] : [...new Set([...this.#grants.values()].filter(row => row.body.permission === 'assign' && row.body.subject === this.user!.id && this.enabled(row)).map(row => row.body.object))].sort(); }
  shared(object: string, expectedPack?: string): boolean {
    if (!this.user || this.user.disabled) return false;
    const production = object.startsWith('production:') ? object.slice('production:'.length) : null;
    if (production !== null && !PackId.safeParse(production).success) return false;
    const valid = (row: AuthorizationRecord | null) => this.enabled(row) && (production === null || row!.body.bound === digestOf({pack:production,accepted_producer:'fact'}));
    const direct = this.latest('share',this.user.id,object);
    if (valid(direct) && (direct!.body.share_audience === undefined || direct!.body.share_audience === 'user')) return true;
    for (const row of this.#grants.values()) {
      const body = row.body;
      if (body.permission !== 'share' || body.object !== object || body.share_audience !== 'pack_users' || !body.subject.startsWith('pack_users:') || !valid(row)) continue;
      const pack = body.subject.slice('pack_users:'.length);
      if (PackId.safeParse(pack).success && (expectedPack === undefined || expectedPack === pack) && this.canUse(pack)) return true;
    }
    return false;
  }
  runShared(run: {run:string;pack:string;requirements:readonly {accepted_producer:string}[]}): boolean {
    const pack = run.pack.slice(0,run.pack.lastIndexOf('@'));
    if (!PackId.safeParse(pack).success) return false;
    return this.shared(run.run,pack) || run.requirements.length > 0 && run.requirements.every(r => r.accepted_producer === 'fact') && this.canUse(pack) && this.shared(`production:${pack}`,pack);
  }
}

const storage = new AsyncLocalStorage<RequestPermissions>();
export function requestPermissions(user: string): RequestPermissions | null {
  const snapshot = storage.getStore();
  return snapshot?.active && snapshot.principalId === user ? snapshot : null;
}

/** Fetches a consistent user and latest direct/pack-audience decisions as one PostgreSQL snapshot. */
export async function captureRequestPermissions(db: Database, principal: Principal, at: Date): Promise<RequestPermissions> {
  const rows = await db.query(`WITH assigned AS (
    SELECT DISTINCT ON ((r.body::jsonb)->>'object') r.body
    FROM record_index i JOIN records r ON r.digest=i.digest
    WHERE i.key='authz.subject' AND i.value=$2 AND r.kind='authorization'
    ORDER BY (r.body::jsonb)->>'object', i.record_seq DESC
  ), subjects AS (
    SELECT $1::text AS value UNION SELECT 'pack_users:' || ((body::jsonb)->>'object') FROM assigned
  ), grants AS (
    SELECT DISTINCT ON ((r.body::jsonb)->>'permission',(r.body::jsonb)->>'subject',(r.body::jsonb)->>'object')
      r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
    FROM record_index i JOIN records r ON r.digest=i.digest
    WHERE i.key='authz.subject-any' AND i.value IN (SELECT value FROM subjects) AND r.kind='authorization'
    ORDER BY (r.body::jsonb)->>'permission',(r.body::jsonb)->>'subject',(r.body::jsonb)->>'object',i.record_seq DESC
  ) SELECT u.id AS user_id,u.name AS user_name,u.role AS user_role,u.disabled AS user_disabled,
      u.created_at AS user_created_at,u.updated_at AS user_updated_at,grants.*
    FROM users u LEFT JOIN grants ON true WHERE u.id=$1`, [principal.id, `assign|${principal.id}`]);
  const first = rows.rows[0];
  if (!first) return new RequestPermissions(principal.id,null,at,[]);
  if (!isPermissionRole(first.user_role)) throw new Error('用户角色不在词表里');
  const user: User = { id:String(first.user_id),name:String(first.user_name),role:first.user_role,disabled:first.user_disabled===true,created_at:iso(first.user_created_at),updated_at:iso(first.user_updated_at) };
  const grants = rows.rows.filter(row => row.digest !== null).map(row => verifiedRecord<AuthorizationBody>(row));
  return new RequestPermissions(principal.id,user,at,grants);
}

/** Keep a snapshot only for the request; detached background work reverts to current permissions after it ends. */
export async function withRequestPermissions<T>(source: {capturePermissionSnapshot?: (principal: Principal) => Promise<RequestPermissions>} | undefined, principal: Principal, run: () => Promise<T>): Promise<T> {
  if (requestPermissions(principal.id) || !source?.capturePermissionSnapshot) return run();
  const snapshot = await source.capturePermissionSnapshot(principal);
  return storage.run(snapshot, async () => { try { return await run(); } finally { snapshot.active = false; snapshot.cache.clear(); } });
}

/** Reuse successful source reads only inside the request, retaining at most 64 MiB of raw bytes. */
export async function requestRead<T>(user: string, key: string, load: () => Promise<T>, size: (value:T) => number): Promise<T> {
  const snapshot = requestPermissions(user);
  if (!snapshot) return load();
  const found = snapshot.cache.get(key); if (found) return found as Promise<T>;
  const pending = load(); snapshot.cache.set(key,pending);
  try {
    const value = await pending, bytes = size(value);
    if (!snapshot.active || value === null || bytes < 0 || snapshot.cacheBytes + bytes > 64*1024*1024) snapshot.cache.delete(key);
    else snapshot.cacheBytes += bytes;
    return value;
  } catch (error) { snapshot.cache.delete(key); throw error; }
}
