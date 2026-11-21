// A request-scoped view of an authenticated reader's permissions, captured in one database statement.
import { AsyncLocalStorage } from 'node:async_hooks';
import { TeamId } from '../../contracts/api.ts';
import { PackId } from '../../contracts/src/common.ts';
import { isPermissionRole } from '../../contracts/generated/vocabulary.ts';
import { step } from './trace-usage.ts';
import type { AuthorizationBody, AuthorizationRecord, Principal, User, Transaction } from './api.ts';
import { iso, type Database } from './db.ts';
import { digestOf } from './digest.ts';
import { verifiedRecord } from './store.ts';
import { readScopeValue, withReadRetirement } from './read-scope.ts';

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
  teams(): string[] {
    if (!this.user || this.user.disabled || this.user.deleted_at) return [];
    return [...this.#grants.values()].filter(row => row.body.permission === 'assign' && row.body.subject === this.user!.id && TeamId.safeParse(row.body.object).success && this.enabled(row) && this.enabled(this.latest('assign','*',row.body.object))).map(row => row.body.object).sort();
  }
  canUse(pack: string): boolean {
    if (!this.user || this.user.disabled || this.user.deleted_at || !PackId.safeParse(pack).success) return false;
    return [this.user.id,...this.teams()].some(subject => this.enabled(this.latest('assign',subject,pack)));
  }
  packs(): string[] {
    if (!this.user || this.user.disabled || this.user.deleted_at) return [];
    const subjects = new Set([this.user.id,...this.teams()]);
    return [...new Set([...this.#grants.values()].filter(row => row.body.permission === 'assign' && subjects.has(row.body.subject) && PackId.safeParse(row.body.object).success && this.enabled(row)).map(row => row.body.object))].sort();
  }
  packSources(): Array<{pack:string;via:'user'|{team:string}}> {
    if(!this.user||this.user.disabled||this.user.deleted_at)return [];
    const teams=new Set(this.teams());
    return [...this.#grants.values()].filter(row=>row.body.permission==='assign'&&PackId.safeParse(row.body.object).success&&this.enabled(row)&&(row.body.subject===this.user!.id||teams.has(row.body.subject)))
      .map(row=>({pack:row.body.object,via:row.body.subject===this.user!.id?'user' as const:{team:row.body.subject}}))
      .sort((a,b)=>a.pack.localeCompare(b.pack)||JSON.stringify(a.via).localeCompare(JSON.stringify(b.via)));
  }
  canUseResource(resource: string): boolean {
    if (!this.user || this.user.disabled || this.user.deleted_at) return false;
    return [this.user.id,...this.teams(),'*'].some(subject => subject !== this.user!.id && this.enabled(this.latest('resource_assign',subject,resource)));
  }
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

export async function capturePermissionSnapshots(db: Database, userIds: readonly string[], at: Date, tx?: Transaction): Promise<Map<string, RequestPermissions>> {
  const ids = [...new Set(userIds)];
  const snapshots = new Map(ids.map(id => [id,new RequestPermissions(id,null,at,[])]));
  if (!ids.length) return snapshots;
  const rows = await db.query(`WITH accounts AS (
    SELECT * FROM users WHERE id=ANY($1::text[])
  ), direct AS (
    SELECT DISTINCT ON (u.id,(r.body::jsonb)->>'object') u.id AS reader,r.body
    FROM accounts u JOIN record_index i ON i.key='authz.subject' AND i.value='assign|'||u.id
    JOIN records r ON r.digest=i.digest AND r.kind='authorization'
    ORDER BY u.id,(r.body::jsonb)->>'object',i.record_seq DESC
  ), registrations AS (
    SELECT DISTINCT ON ((r.body::jsonb)->>'object') r.body FROM record_index i JOIN records r ON r.digest=i.digest
    WHERE i.key='authz.subject' AND i.value='assign|*' AND r.kind='authorization'
    ORDER BY (r.body::jsonb)->>'object',i.record_seq DESC
  ), team_ids AS (
    SELECT d.reader,(d.body::jsonb)->>'object' AS team FROM direct d JOIN registrations t ON (d.body::jsonb)->>'object'=(t.body::jsonb)->>'object'
    WHERE (d.body::jsonb)->>'revoked'='false' AND (t.body::jsonb)->>'revoked'='false'
      AND ((d.body::jsonb)->>'expires_at' IS NULL OR ((d.body::jsonb)->>'expires_at')::timestamptz>$2)
      AND ((t.body::jsonb)->>'expires_at' IS NULL OR ((t.body::jsonb)->>'expires_at')::timestamptz>$2)
  ), team_assignments AS (
    SELECT DISTINCT ON (t.reader,(r.body::jsonb)->>'subject',(r.body::jsonb)->>'object') t.reader,r.body
    FROM team_ids t JOIN record_index i ON i.key='authz.subject' AND i.value='assign|'||t.team
    JOIN records r ON r.digest=i.digest AND r.kind='authorization'
    ORDER BY t.reader,(r.body::jsonb)->>'subject',(r.body::jsonb)->>'object',i.record_seq DESC
  ), assigned AS (
    SELECT * FROM direct UNION ALL SELECT * FROM team_assignments
  ), subjects AS (
    SELECT id AS reader,id AS value FROM accounts UNION SELECT reader,team FROM team_ids
    UNION SELECT id,'*' FROM accounts UNION SELECT reader,'pack_users:'||((body::jsonb)->>'object') FROM assigned
  ), grants AS (
    SELECT DISTINCT ON (s.reader,(r.body::jsonb)->>'permission',(r.body::jsonb)->>'subject',(r.body::jsonb)->>'object')
      s.reader,r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
    FROM subjects s JOIN record_index i ON i.key='authz.subject-any' AND i.value=s.value
    JOIN records r ON r.digest=i.digest AND r.kind='authorization'
    ORDER BY s.reader,(r.body::jsonb)->>'permission',(r.body::jsonb)->>'subject',(r.body::jsonb)->>'object',i.record_seq DESC
  ) SELECT u.id AS user_id,u.name AS user_name,u.role AS user_role,u.disabled AS user_disabled,u.deleted_at AS user_deleted_at,
      u.created_at AS user_created_at,u.updated_at AS user_updated_at,grants.*
    FROM accounts u LEFT JOIN grants ON grants.reader=u.id`, [ids,at.toISOString()],tx);
  const grouped = new Map<string, typeof rows.rows>();
  for (const row of rows.rows) { const id=String(row.user_id); const group=grouped.get(id)??[];group.push(row);grouped.set(id,group); }
  for (const [id,group] of grouped) {
    const first=group[0];
    if (!isPermissionRole(first.user_role)) throw new Error('用户角色不在词表里');
    const user:User={id,name:String(first.user_name),role:first.user_role,disabled:first.user_disabled===true,deleted_at:first.user_deleted_at?iso(first.user_deleted_at):null,created_at:iso(first.user_created_at),updated_at:iso(first.user_updated_at)};
    const grants=group.filter(row=>row.digest!==null).map(row=>verifiedRecord<AuthorizationBody>(row));
    snapshots.set(id,new RequestPermissions(id,user,at,grants));
  }
  return snapshots;
}
export async function captureRequestPermissions(db: Database, principal: Principal, at: Date, tx?: Transaction): Promise<RequestPermissions> {
  return (await capturePermissionSnapshots(db,[principal.id],at,tx)).get(principal.id)!;
}

/** Keep a snapshot only for the request; detached background work reverts to current permissions after it ends. */
export async function withRequestPermissions<T>(source: {capturePermissionSnapshot?: (principal: Principal) => Promise<RequestPermissions>} | undefined, principal: Principal, run: () => Promise<T>): Promise<T> {
  if (requestPermissions(principal.id) || !source?.capturePermissionSnapshot) return run();
  // Calls inside one outer read scope (one console page, one tool call) share the snapshot taken at its first permission check.
  const read = source.capturePermissionSnapshot.bind(source);
  const capture = (who: Principal) => step('check-permission', () => read(who), { type: 'guardrail' });
  const shared = readScopeValue(source, principal.id, () => capture(principal), pending => { void pending.then(snapshot => { snapshot.active = false; snapshot.cache.clear(); }, () => {}); });
  if (shared) {
    const snapshot = await shared;
    if (snapshot.active) return withReadRetirement(() => { snapshot.cache.clear(); snapshot.cacheBytes = 0; }, () => storage.run(snapshot, run));
  }
  const snapshot = await capture(principal);
  return withReadRetirement(() => { snapshot.cache.clear(); snapshot.cacheBytes = 0; }, () => storage.run(snapshot, async () => { try { return await run(); } finally { snapshot.active = false; snapshot.cache.clear(); } }));
}

/** Reuse successful source reads only inside the request, retaining at most 64 MiB of raw bytes. */
export async function requestRead<T>(user: string, key: string, load: () => Promise<T>, size: (value:T) => number): Promise<T> {
  const snapshot = requestPermissions(user);
  if (!snapshot) return load();
  const found = snapshot.cache.get(key); if (found) return found as Promise<T>;
  const pending = load(); snapshot.cache.set(key,pending);
  try {
    const value = await pending;
    if (snapshot.cache.get(key) !== pending) return value;
    const bytes = size(value);
    if (!snapshot.active || value === null || bytes < 0 || snapshot.cacheBytes + bytes > 64*1024*1024) snapshot.cache.delete(key);
    else snapshot.cacheBytes += bytes;
    return value;
  } catch (error) { if (snapshot.cache.get(key) === pending) snapshot.cache.delete(key); throw error; }
}
