import { verifiedRecord } from './store.ts';
// Team tables are projections; verified authorization decisions and their bound definition bytes are authoritative.
import { TeamId, UserId, PackId } from '../../contracts/api.ts';
import type { Authorizations, AuthorizationRecord, ObjectStore, Principal, Principals, RecordStore, Transaction, User } from './api.ts';
import { canonicalBytes } from './canonical.ts';
import { iso, type Database, type Row } from './db.ts';
import { AccessError, ConflictError, IntegrityError } from './errors.ts';
import { newId } from './ids.ts';
import { isAdmin } from './permissions.ts';
import { isPermissionRole } from '../../contracts/generated/vocabulary.ts';

export type { Team } from './team-definitions.ts';
import { readTeamDefinitions, type Team } from './team-definitions.ts';
export interface TeamRow extends Team { member_count:number; pack_count:number; resource_count:number; changed_at:string }
export interface TeamMember { team: string; user: User; added_at: string; added_by: string }
export interface TeamAssignments { packs: AuthorizationRecord[]; resources: AuthorizationRecord[] }
export interface Teams {
  list(by: Principal): Promise<TeamRow[]>;
  get(by: Principal, id: string): Promise<Team | null>;
  members(by: Principal, id: string): Promise<TeamMember[]>;
  assignments(by: Principal, id: string): Promise<TeamAssignments>;
  memberships(by: Principal, userId?: string): Promise<Team[]>;
  membershipsMany(by: Principal, userIds: readonly string[]): Promise<Map<string,Team[]>>;
  create(by: Principal, name: string): Promise<Team>;
  delete(by: Principal, id: string): Promise<Team>;
  add(by: Principal, id: string, userId: string): Promise<TeamMember>;
  remove(by: Principal, id: string, userId: string): Promise<boolean>;
}
const NAME = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,98}[^\s\p{Cc}])?$/u;

function account(row: Row): User {
  if (!isPermissionRole(row.role)) throw new IntegrityError('用户角色不在词表里');
  return { id: String(row.id), name: String(row.name), role: row.role, disabled: row.disabled === true,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at), deleted_at: row.deleted_at ? iso(row.deleted_at) : null };
}

export class PgTeams implements Teams {
  readonly db: Database;
  readonly store: RecordStore;
  readonly objects: ObjectStore;
  readonly principals: Principals;
  readonly authorizations: Authorizations;
  readonly now: () => Date;
  constructor(db: Database, store: RecordStore, objects: ObjectStore,
    principals: Principals, authorizations: Authorizations, now: () => Date) {
    this.db=db;this.store=store;this.objects=objects;this.principals=principals;this.authorizations=authorizations;this.now=now;
  }

  async #decisions(query: { subject?: string; object?: string }, tx?: Transaction): Promise<AuthorizationRecord[]> {
    const latest = new Map<string, AuthorizationRecord>();
    let cursor: string | null = null;
    do {
      const key = query.subject !== undefined ? 'authz.subject' : 'authz.object';
      const value = 'assign|' + (query.subject ?? query.object);
      const page = await this.store.find<AuthorizationRecord['body']>({ kind: 'authorization', key, value, limit: 500, cursor }, tx);
      for (const row of page.items) latest.set(row.body.subject + '\0' + row.body.object, row);
      cursor = page.next;
    } while (cursor !== null);
    return [...latest.values()];
  }
  #active(row: AuthorizationRecord): boolean {
    return !row.body.revoked && (row.body.expires_at === null || Date.parse(row.body.expires_at) > this.now().getTime());
  }
  #all(tx?: Transaction): Promise<Team[]> { return readTeamDefinitions(this.store,this.objects,this.now,tx); }
  async #reader(by: Principal, adminOnly = false): Promise<User> {
    const user = await this.principals.get(by.id);
    if (!user || user.disabled || user.deleted_at || adminOnly && !isAdmin(user)) throw new AccessError('对象不存在或无权读取');
    return user;
  }
  async #memberships(user: string, tx?: Transaction): Promise<Team[]> {
    const memberships = new Set((await this.#decisions({ subject: user }, tx)).filter(row => this.#active(row) && TeamId.safeParse(row.body.object).success).map(row => row.body.object));
    return (await this.#all(tx)).filter(team => memberships.has(team.id));
  }
  async list(by: Principal): Promise<TeamRow[]> {
    const user = await this.#reader(by);
    const teams=isAdmin(user)?await this.#all():await this.#memberships(user.id);
    if(!teams.length)return [];
    const ids=teams.map(team=>team.id);
    const rows=(await this.db.query(`SELECT DISTINCT ON ((r.body::jsonb)->>'permission',(r.body::jsonb)->>'subject',(r.body::jsonb)->>'object') r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
      FROM record_index i JOIN records r ON r.digest=i.digest WHERE r.kind='authorization' AND i.key IN ('authz.object-any','authz.subject-any') AND i.value=ANY($1::text[])
      ORDER BY (r.body::jsonb)->>'permission',(r.body::jsonb)->>'subject',(r.body::jsonb)->>'object',r.seq DESC`,[ids])).rows.map(row=>verifiedRecord<AuthorizationRecord['body']>(row));
    const members=[...new Set(rows.filter(row=>row.body.permission==='assign'&&ids.includes(row.body.object)&&UserId.safeParse(row.body.subject).success&&this.#active(row)).map(row=>row.body.subject))];
    const enabled=new Set((await this.principals.some(members)).filter(user=>!user.disabled&&!user.deleted_at).map(user=>user.id));
    return teams.map(team=>{
      const related=rows.filter(row=>row.body.subject===team.id||row.body.object===team.id),active=related.filter(row=>this.#active(row));
      return {...team,member_count:active.filter(row=>row.body.permission==='assign'&&row.body.object===team.id&&enabled.has(row.body.subject)).length,
        pack_count:active.filter(row=>row.body.permission==='assign'&&row.body.subject===team.id&&PackId.safeParse(row.body.object).success).length,
        resource_count:active.filter(row=>row.body.permission==='resource_assign'&&row.body.subject===team.id).length,
        changed_at:related.reduce((at,row)=>row.body.decided_at>at?row.body.decided_at:at,team.created_at)};
    });
  }
  async get(by: Principal, id: string): Promise<Team | null> {
    if (!TeamId.safeParse(id).success) return null;
    return (await this.list(by)).find(team => team.id === id) ?? null;
  }
  async memberships(by: Principal, userId = by.id): Promise<Team[]> {
    const actor = await this.#reader(by);
    if (userId !== actor.id && !isAdmin(actor)) throw new AccessError('只有管理员可以查看别人的团队');
    const target = await this.principals.get(userId);
    return !target || target.disabled || target.deleted_at ? [] : this.#memberships(userId);
  }
  async membershipsMany(by: Principal, userIds: readonly string[]): Promise<Map<string,Team[]>> {
    const actor=await this.#reader(by),ids=[...new Set(userIds)];
    if(!isAdmin(actor)&&ids.some(id=>id!==actor.id))throw new AccessError('只有管理员可以查看别人的团队');
    const out=new Map(ids.map(id=>[id,[] as Team[]]));if(!ids.length)return out;
    const accounts=await this.principals.some(ids),enabled=new Set(accounts.filter(user=>!user.disabled&&!user.deleted_at).map(user=>user.id));
    const teams=new Map((await this.#all()).map(team=>[team.id,team]));
    const rows=(await this.db.query(`SELECT DISTINCT ON ((r.body::jsonb)->>'subject',(r.body::jsonb)->>'object') r.seq,r.id,r.digest,r.kind,r.schema,r.provenance,r.created_at,r.body
      FROM record_index i JOIN records r ON r.digest=i.digest WHERE i.key='authz.subject' AND i.value=ANY($1::text[]) AND r.kind='authorization'
      ORDER BY (r.body::jsonb)->>'subject',(r.body::jsonb)->>'object',r.seq DESC`,[ids.map(id=>'assign|'+id)])).rows;
    for(const row of rows){const decision=verifiedRecord<AuthorizationRecord['body']>(row),team=teams.get(decision.body.object);if(team&&enabled.has(decision.body.subject)&&this.#active(decision))out.get(decision.body.subject)!.push(team);}
    for(const values of out.values())values.sort((a,b)=>a.id.localeCompare(b.id));return out;
  }
  async members(by: Principal, id: string): Promise<TeamMember[]> {
    await this.#reader(by, true);
    if (!(await this.#all()).some(team => team.id === id)) throw new ConflictError('没有这个团队');
    const rows = (await this.#decisions({ object: id })).filter(row => UserId.safeParse(row.body.subject).success && this.#active(row));
    const users = new Map((await this.principals.some(rows.map(row => row.body.subject))).map(user => [user.id, user]));
    return rows.flatMap(row => { const user = users.get(row.body.subject); return user && !user.deleted_at ? [{ team: id, user, added_at: row.body.decided_at, added_by: row.body.decided_by }] : []; });
  }
  async assignments(by: Principal, id: string): Promise<TeamAssignments> {
    await this.#reader(by, true);
    if (!(await this.#all()).some(team => team.id === id)) throw new ConflictError('没有这个团队');
    const latest = new Map<string, AuthorizationRecord>();
    let cursor: string | null = null;
    do {
      const page = await this.authorizations.history({ subject: id, limit: 500, cursor, newestFirst: false });
      for (const row of page.items) latest.set(row.body.permission + '\0' + row.body.object, row);
      cursor = page.next;
    } while (cursor !== null);
    const rows = [...latest.values()].filter(row => this.#active(row));
    return { packs: rows.filter(row => row.body.permission === 'assign'), resources: rows.filter(row => row.body.permission === 'resource_assign') };
  }
  /** Every mutation takes user rows in ID order, then the team lock, then authorization decision locks. */
  async #writer(by: Principal, tx: Transaction, userId?: string, enabled = false): Promise<User | null> {
    const ids = [...new Set(userId ? [by.id, userId] : [by.id])].sort();
    const rows = (await this.db.query('SELECT * FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [ids], tx)).rows;
    const actor = rows.find(row => row.id === by.id);
    if (!actor || actor.disabled || actor.deleted_at || !isAdmin(account(actor))) throw new AccessError('只有启用的管理员可以管理团队');
    if (userId === undefined) return null;
    const target = rows.find(row => row.id === userId);
    if (!target || target.deleted_at || enabled && target.disabled) throw new ConflictError('成员不存在或未启用');
    return account(target);
  }
  async #locked(id: string, tx: Transaction): Promise<Team> {
    TeamId.parse(id);
    await this.store.lock('teams.id:' + id, tx);
    const team = (await this.#all(tx)).find(team => team.id === id);
    if (!team) throw new ConflictError('没有这个团队');
    if (!(await this.db.query('SELECT 1 FROM teams WHERE id=$1 FOR UPDATE', [id], tx)).rowCount) throw new IntegrityError('团队投影缺失');
    return team;
  }
  async create(by: Principal, name: string): Promise<Team> {
    if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('团队名是1至100个字符，不能含控制字符或首尾空格');
    return this.store.withTransaction(async tx => {
      await this.#writer(by, tx);
      await this.store.lock('teams.name:' + name, tx);
      if ((await this.#all(tx)).some(team => team.name === name)) throw new ConflictError('团队名已经存在');
      const id = newId('tm'), definition = await this.objects.put(canonicalBytes({ id, name }), 'application/json', tx);
      const decision = await this.authorizations.grant(by, { permission: 'assign', subject: '*', object: id, bound: definition.sha256 }, tx);
      await this.db.query('INSERT INTO teams(id,name,created_at,created_by) VALUES($1,$2,$3,$4)', [id, name, decision.body.decided_at, by.id], tx);
      return { id, name, created_at: decision.body.decided_at, created_by: by.id, deleted_at: null };
    });
  }
  async delete(by: Principal, id: string): Promise<Team> {
    return this.store.withTransaction(async tx => {
      await this.#writer(by, tx);
      const team = await this.#locked(id, tx);
      const related=new Map<string,AuthorizationRecord>();
      for(const key of ['authz.object-any','authz.subject-any']){
        let cursor:string|null=null;
        do{const page=await this.store.find<AuthorizationRecord['body']>({kind:'authorization',key,value:id,limit:500,cursor},tx);
          for(const row of page.items)related.set(row.body.permission+'\0'+row.body.subject+'\0'+row.body.object,row);cursor=page.next;
        }while(cursor!==null);
      }
      for(const row of related.values()){
        const body=row.body;
        const membership=body.permission==='assign'&&body.object===id&&UserId.safeParse(body.subject).success;
        const assignment=body.subject===id&&(body.permission==='resource_assign'||body.permission==='assign'&&PackId.safeParse(body.object).success);
        if(this.#active(row)&&(membership||assignment))await this.authorizations.revoke(by,{permission:body.permission,subject:body.subject,object:body.object,note:body.note},tx);
      }
      const decision = await this.authorizations.revoke(by, { permission: 'assign', subject: '*', object: id }, tx);
      await this.db.query('DELETE FROM team_members WHERE team_id=$1', [id], tx);
      await this.db.query('UPDATE teams SET deleted_at=$2 WHERE id=$1', [id, decision.body.decided_at], tx);
      return { ...team, deleted_at: decision.body.decided_at };
    });
  }
  async add(by: Principal, id: string, userId: string): Promise<TeamMember> {
    UserId.parse(userId);
    return this.store.withTransaction(async tx => {
      const user = (await this.#writer(by, tx, userId, true))!;
      await this.#locked(id, tx);
      const decision = await this.authorizations.grant(by, { permission: 'assign', subject: userId, object: id }, tx);
      await this.db.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2',[id,userId],tx);
      await this.db.query('INSERT INTO team_members(team_id,user_id,added_at,added_by) VALUES($1,$2,$3,$4)', [id, userId, decision.body.decided_at, by.id], tx);
      return { team: id, user, added_at: decision.body.decided_at, added_by: by.id };
    });
  }
  async remove(by: Principal, id: string, userId: string): Promise<boolean> {
    UserId.parse(userId);
    return this.store.withTransaction(async tx => {
      await this.#writer(by, tx, userId);
      await this.#locked(id, tx);
      const previous = (await this.#decisions({ subject: userId }, tx)).find(row => row.body.object === id);
      if (!previous || !this.#active(previous)) return false;
      await this.authorizations.revoke(by, { permission: 'assign', subject: userId, object: id }, tx);
      await this.db.query('DELETE FROM team_members WHERE team_id=$1 AND user_id=$2', [id, userId], tx);
      return true;
    });
  }
}
