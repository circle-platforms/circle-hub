// Users and long-lived revocable tokens (R01; adapted from the earlier hashed-token auth). A token is 32 random bytes shown
// once; only its SHA-256 is stored. Every change to a user is recorded as an append-only snapshot in user_history.
// The MCP standard authorization (decision 78) adds the clients that registered themselves and the invitation codes an
// administrator issues: a code is twelve characters shown once, kept as its SHA-256, valid INVITATION_TTL_MS and used once,
// by the client it authorized; a token issued through the authorization names its client.
import { randomBytes } from 'node:crypto';
import { isPermissionRole, labelOf } from '../../contracts/generated/vocabulary.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { InvitationCheck, InvitationInfo, IssuedInvitation, IssuedToken, OAuthClient, Principal, Principals, TokenInfo, User, UserChange } from './api.ts';
import { iso, isoOrNull } from './db.ts';
import type { Database, PgTransaction, Row } from './db.ts';
import { sha256Hex } from './digest.ts';
import { AccessError, ConflictError, IntegrityError, LimitError } from './errors.ts';
import { newId } from './ids.ts';
import { hashPassword, initialPassword, matchesPassword } from './password.ts';

const ADMIN: PermissionRole = 'admin';
const USER: PermissionRole = 'user';
/** Serializes every change to the set of active admins, and the first-admin bootstrap. */
const ADMIN_SET_LOCK = 7_301_562_002;
/** Serializes client registrations, so their rate bound holds under concurrency. */
const CLIENT_LOCK = 7_301_562_003;
const BEARER = /^Bearer[ \t]+([A-Za-z0-9_-]{43})[ \t]*$/i;
const USER_ID = /^usr_[0-9a-z]{26}$/;
const TOKEN_ID = /^tok_[0-9a-z]{26}$/;
const NAME = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,98}[^\s\p{Cc}])?$/u;
/** last_used_at is refreshed at most once a minute per token. */
const LAST_USED_STEP_MS = 60_000;
export const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const INVITATION_ID = /^inv_[0-9a-z]{26}$/;
const CLIENT_ID = /^cli_[0-9a-z]{26}$/;
/** Crockford base32 without I, L, O and U: easy to read out and type. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE = /^[0-9A-HJKMNP-TV-Z]{12}$/;
/** Registrations are open to anyone who reaches the Hub, so their rate is bounded: at most CLIENT_BURST per window. */
const CLIENT_BURST = 100;
const CLIENT_WINDOW_MS = 10 * 60 * 1000;
/** A client that obtained no token and used no invitation within this time is removed at a later registration. */
const UNUSED_CLIENT_MS = 24 * 60 * 60 * 1000;

/** Upper case without the dashes and spaces typed between the groups; O, I and L read as the digits they look like. */
export function normalizeInvitation(text: string): string {
  return text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

/** Twelve characters in three groups (60 bits): 32 divides 256, so every character is uniform. */
function invitationCode(): string {
  const plain = [...randomBytes(12)].map((byte) => CODE_ALPHABET[byte % 32]).join('');
  return `${plain.slice(0, 4)}-${plain.slice(4, 8)}-${plain.slice(8)}`;
}

function userOf(row: Row): User {
  if (!isPermissionRole(row.role)) throw new IntegrityError('用户角色不在词表里', { detail: { user: row.id } });
  return {
    id: String(row.id),
    name: String(row.name),
    role: row.role,
    disabled: row.disabled === true,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function tokenOf(row: Row): TokenInfo {
  return {
    id: String(row.id),
    user: String(row.user_id),
    label: String(row.label),
    client: row.client_id === null || row.client_id === undefined ? null : String(row.client_id),
    created_at: iso(row.created_at),
    created_by: row.created_by === null ? null : String(row.created_by),
    last_used_at: isoOrNull(row.last_used_at),
    revoked_at: isoOrNull(row.revoked_at),
  };
}

function invitationOf(row: Row): InvitationInfo {
  return {
    id: String(row.id),
    user: String(row.user_id),
    created_at: iso(row.created_at),
    created_by: String(row.created_by),
    expires_at: iso(row.expires_at),
    used_at: isoOrNull(row.used_at),
    used_by_client: row.used_by_client === null ? null : String(row.used_by_client),
  };
}

function clientOf(row: Row): OAuthClient {
  return { id: String(row.id), name: String(row.name), redirect_uris: (row.redirect_uris as unknown[]).map(String), created_at: iso(row.created_at) };
}

function validName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('user names are 1 to 100 characters without control characters or surrounding spaces');
  return name;
}

function validRole(role: unknown): PermissionRole {
  if (!isPermissionRole(role)) throw new TypeError(`unknown role ${JSON.stringify(role)}`);
  return role;
}

export class PgPrincipals implements Principals {
  readonly #db: Database;
  readonly #now: () => Date;

  constructor(db: Database, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  async bootstrapAdmin(name: string, credential?: { password: string; mustChange: boolean }): Promise<{ user: User; token: IssuedToken }> {
    const clean = validName(name);
    const hash = credential ? await hashPassword(credential.password) : null;
    return this.#db.transaction(async (tx) => {
      await this.#db.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_SET_LOCK], tx);
      const admins = await this.#db.query('SELECT 1 FROM users WHERE role = $1 LIMIT 1', [ADMIN], tx);
      if ((admins.rowCount ?? 0) > 0) throw new ConflictError('已经有管理员；第一位管理员只能引导一次，之后由管理员添加用户');
      const user = await this.#insertUser(tx, clean, ADMIN, null, hash, credential?.mustChange);
      const token = await this.#issue(tx, user.id, '引导', null);
      return { user, token };
    });
  }

  async createUser(by: Principal, name: string, role: PermissionRole = USER, credential?: { password: string; mustChange: boolean }): Promise<User> {
    const clean = validName(name);
    const wanted = validRole(role);
    const hash = credential ? await hashPassword(credential.password) : null;
    return this.#db.transaction(async (tx) => {
      await this.#decider(tx, by, true);
      return this.#insertUser(tx, clean, wanted, by.id, hash, credential?.mustChange);
    });
  }

  async passwordState(userId: string): Promise<{ configured: boolean; mustChange: boolean; revision: number }> {
    const row = (await this.#db.query('SELECT password_hash IS NOT NULL AS configured, password_must_change, password_revision FROM users WHERE id = $1', [userId])).rows[0];
    return {configured: row?.configured === true, mustChange: row?.password_must_change === true, revision: Number(row?.password_revision ?? 0)};
  }

  async verifyPassword(name: string, password: string): Promise<{ user: User; revision: number; mustChange: boolean } | null> {
    const row = typeof name === 'string' && NAME.test(name) ? (await this.#db.query('SELECT * FROM users WHERE name = $1', [name])).rows[0] : undefined;
    const matches = await matchesPassword(password, row?.password_hash === undefined || row.password_hash === null ? null : String(row.password_hash));
    if (!matches || row === undefined || row.disabled) return null;
    return {user:userOf(row),revision:Number(row.password_revision),mustChange:row.password_must_change === true};
  }

  async openConsoleSession(userId: string, revision: number): Promise<IssuedToken | null> {
    return this.#db.transaction(async tx => {
      const row = (await this.#db.query('SELECT * FROM users WHERE id = $1 FOR SHARE', [userId], tx)).rows[0];
      if (!row || row.disabled || row.password_hash === null || Number(row.password_revision) !== revision) return null;
      const token = await this.#issue(tx,userId,'控制台登录',userId,null,true);
      return token;
    });
  }

  async resetPassword(by: Principal, userId: string): Promise<string> {
    const password=initialPassword(), hash=await hashPassword(password);
    await this.#db.transaction(async tx => {
      await this.#decider(tx,by,true);
      await this.#locked(tx,userId);
      await this.#replacePassword(tx,by,userId,hash,true);
    });
    return password;
  }

  async changePassword(by: Principal, current: string, next: string): Promise<boolean> {
    const found=await this.#db.query('SELECT password_hash, password_revision FROM users WHERE id = $1 AND NOT disabled',[by.id]);
    const row=found.rows[0];
    if (!row || !await matchesPassword(current,row.password_hash === null ? null : String(row.password_hash)) || next === current) return false;
    const hash=await hashPassword(next);
    return this.#db.transaction(async tx => {
      await this.#decider(tx,by,false);
      const locked=(await this.#db.query('SELECT password_revision FROM users WHERE id = $1 FOR UPDATE',[by.id],tx)).rows[0];
      if (Number(locked?.password_revision) !== Number(row.password_revision)) return false;
      await this.#replacePassword(tx,by,by.id,hash,false);
      return true;
    });
  }

  async #replacePassword(tx: PgTransaction, by: Principal, userId: string, hash: string, mustChange: boolean): Promise<void> {
    const at=this.#now().toISOString();
    const row=(await this.#db.query('UPDATE users SET password_hash=$2, password_must_change=$3, password_revision=password_revision+1, updated_at=$4 WHERE id=$1 RETURNING *',[userId,hash,mustChange,at],tx)).rows[0];
    await this.#db.query('UPDATE tokens SET revoked_at=$2, revoked_by=$1 WHERE user_id=$3 AND console_session AND revoked_at IS NULL',[by.id,at,userId],tx);
    await this.#db.query('INSERT INTO user_history (user_id,name,role,disabled,changed_by,changed_at,password_changed) VALUES ($1,$2,$3,$4,$5,$6,true)',[userId,row.name,row.role,row.disabled,by.id,at],tx);
  }

  async setRole(by: Principal, userId: string, role: PermissionRole): Promise<User> {
    const wanted = validRole(role);
    return this.#db.transaction(async (tx) => {
      await this.#db.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_SET_LOCK], tx);
      await this.#decider(tx, by, true);
      const current = await this.#locked(tx, userId);
      if (current.role === wanted) return current;
      if (current.role === ADMIN && !current.disabled) await this.#keepAnAdmin(tx, current.id);
      return this.#update(tx, current, { role: wanted, disabled: current.disabled }, by.id);
    });
  }

  async setDisabled(by: Principal, userId: string, disabled: boolean): Promise<User> {
    if (typeof disabled !== 'boolean') throw new TypeError('disabled must be a boolean');
    return this.#db.transaction(async (tx) => {
      await this.#db.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_SET_LOCK], tx);
      await this.#decider(tx, by, true);
      const current = await this.#locked(tx, userId);
      if (current.disabled === disabled) return current;
      if (disabled && current.role === ADMIN) await this.#keepAnAdmin(tx, current.id);
      return this.#update(tx, current, { role: current.role, disabled }, by.id);
    });
  }

  async get(userId: string): Promise<User | null> {
    if (typeof userId !== 'string' || !USER_ID.test(userId)) return null;
    const row = (await this.#db.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    return row === undefined ? null : userOf(row);
  }

  async findByName(name: string): Promise<User | null> {
    if (typeof name !== 'string') return null;
    const row = (await this.#db.query('SELECT * FROM users WHERE name = $1', [name])).rows[0];
    return row === undefined ? null : userOf(row);
  }

  async list(): Promise<User[]> {
    return (await this.#db.query('SELECT * FROM users ORDER BY created_at, id')).rows.map(userOf);
  }

  async history(userId: string): Promise<UserChange[]> {
    if (typeof userId !== 'string' || !USER_ID.test(userId)) return [];
    const rows = (await this.#db.query('SELECT * FROM user_history WHERE user_id = $1 ORDER BY seq', [userId])).rows;
    return rows.map((row) => ({
      user: String(row.user_id),
      name: String(row.name),
      role: validRole(row.role),
      disabled: row.disabled === true,
      changed_by: row.changed_by === null ? null : String(row.changed_by),
      changed_at: iso(row.changed_at),
      ...(row.password_changed === true ? {password_changed:true as const} : {}),
    }));
  }

  async issueToken(by: Principal, userId: string, label = '', client?: string): Promise<IssuedToken> {
    // Characters are code points, as PostgreSQL's length() and the name checks count them.
    if (typeof label !== 'string' || [...label].length > 100 || /\p{Cc}/u.test(label)) throw new TypeError('token labels are at most 100 characters without control characters');
    if (client !== undefined && (typeof client !== 'string' || !CLIENT_ID.test(client))) throw new TypeError('client ids are cli_<ULID>');
    return this.#db.transaction(async (tx) => {
      const decider = await this.#decider(tx, by, false);
      if (decider.role !== ADMIN && decider.id !== userId) throw new AccessError('只有管理员可以为别人签发令牌');
      const target = await this.#locked(tx, userId);
      if (target.disabled) throw new ConflictError(`用户${labelOf('account_status','disabled')}，不能签发令牌`);
      if (client !== undefined && (await this.#db.query('SELECT 1 FROM oauth_clients WHERE id = $1', [client], tx)).rowCount === 0) throw new ConflictError('没有这个客户端');
      return this.#issue(tx, target.id, label, decider.id, client ?? null);
    });
  }

  async revokeToken(by: Principal, tokenId: string): Promise<boolean> {
    if (typeof tokenId !== 'string' || !TOKEN_ID.test(tokenId)) return false;
    return this.#db.transaction(async (tx) => {
      const decider = await this.#decider(tx, by, false);
      const row = (await this.#db.query('SELECT user_id FROM tokens WHERE id = $1 FOR UPDATE', [tokenId], tx)).rows[0];
      // Someone else's token looks exactly like an absent one.
      if (row === undefined || (decider.role !== ADMIN && row.user_id !== decider.id)) return false;
      const result = await this.#db.query(
        'UPDATE tokens SET revoked_at = $2, revoked_by = $3 WHERE id = $1 AND revoked_at IS NULL',
        [tokenId, this.#now().toISOString(), decider.id],
        tx,
      );
      return result.rowCount === 1;
    });
  }

  async revokeTokenValue(token: string): Promise<boolean> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const result = await this.#db.query(
      'UPDATE tokens SET revoked_at = $2, revoked_by = user_id WHERE sha256 = $1 AND revoked_at IS NULL',
      [sha256Hex(token), this.#now().toISOString()],
    );
    return result.rowCount === 1;
  }

  async tokens(userId: string): Promise<TokenInfo[]> {
    if (typeof userId !== 'string' || !USER_ID.test(userId)) return [];
    const rows = (await this.#db.query('SELECT id, user_id, label, client_id, created_at, created_by, last_used_at, revoked_at FROM tokens WHERE user_id = $1 AND NOT console_session ORDER BY created_at DESC, id DESC', [userId])).rows;
    return rows.map(tokenOf);
  }

  async invite(by: Principal, userId: string): Promise<IssuedInvitation> {
    return this.#db.transaction(async (tx) => {
      const decider = await this.#decider(tx, by, true);
      const target = await this.#locked(tx, userId);
      if (target.disabled) throw new ConflictError(`用户${labelOf('account_status','disabled')}，不能邀请`);
      const code = invitationCode();
      const at = this.#now();
      const row = (
        await this.#db.query(
          'INSERT INTO invitations (id, user_id, sha256, created_at, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
          [newId('inv'), target.id, sha256Hex(normalizeInvitation(code)), at.toISOString(), decider.id, new Date(at.getTime() + INVITATION_TTL_MS).toISOString()],
          tx,
        )
      ).rows[0];
      return { ...invitationOf(row), code };
    });
  }

  async checkInvitation(code: string): Promise<InvitationCheck> {
    const plain = typeof code === 'string' && code.length <= 64 ? normalizeInvitation(code) : '';
    if (!CODE.test(plain)) return { ok: false, reason: 'absent' };
    const row = (await this.#db.query('SELECT id, user_id, expires_at, used_at FROM invitations WHERE sha256 = $1', [sha256Hex(plain)])).rows[0];
    if (row === undefined) return { ok: false, reason: 'absent' };
    if (row.used_at !== null) return { ok: false, reason: 'used' };
    if (new Date(row.expires_at as string).getTime() <= this.#now().getTime()) return { ok: false, reason: 'expired' };
    const user = await this.get(String(row.user_id));
    if (user === null || user.disabled) return { ok: false, reason: 'disabled' };
    return { ok: true, invitation: String(row.id), user, expires_at: iso(row.expires_at) };
  }

  async takeInvitation(invitationId: string, clientId: string): Promise<User | null> {
    if (typeof invitationId !== 'string' || !INVITATION_ID.test(invitationId) || typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) return null;
    return this.#db.transaction(async (tx) => {
      const at = this.#now().toISOString();
      const taken = (
        await this.#db.query(
          'UPDATE invitations SET used_at = $3, used_by_client = $2 WHERE id = $1 AND used_at IS NULL AND expires_at > $3 RETURNING user_id',
          [invitationId, clientId, at],
          tx,
        )
      ).rows[0];
      if (taken === undefined) return null;
      const user = await this.#locked(tx, String(taken.user_id));
      // A disabled account leaves the invitation unused: the update is rolled back with the transaction.
      if (user.disabled) throw new ConflictError(`用户${labelOf('account_status','disabled')}`);
      return user;
    }).catch((error: unknown) => {
      if (error instanceof ConflictError) return null;
      throw error;
    });
  }

  async invitations(userId: string): Promise<InvitationInfo[]> {
    if (typeof userId !== 'string' || !USER_ID.test(userId)) return [];
    return (await this.#db.query('SELECT * FROM invitations WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [userId])).rows.map(invitationOf);
  }

  async registerClient(name: string, redirectUris: readonly string[]): Promise<OAuthClient> {
    if (typeof name !== 'string' || !NAME.test(name)) throw new TypeError('client names are 1 to 100 characters without control characters or surrounding spaces');
    if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 10 || redirectUris.some((uri) => typeof uri !== 'string' || uri.length > 2000)) {
      throw new TypeError('a client has 1 to 10 redirect URIs of at most 2000 characters');
    }
    return this.#db.transaction(async (tx) => {
      await this.#db.query('SELECT pg_advisory_xact_lock($1)', [CLIENT_LOCK], tx);
      const at = this.#now();
      // Registrations cost nothing, so the ones that never led anywhere do not stay: a bounded batch per registration.
      await this.#db.query(
        `DELETE FROM oauth_clients WHERE id IN (
           SELECT c.id FROM oauth_clients c
            WHERE c.created_at < $1
              AND NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id = c.id)
              AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.used_by_client = c.id)
            ORDER BY c.created_at LIMIT 100)`,
        [new Date(at.getTime() - UNUSED_CLIENT_MS).toISOString()],
        tx,
      );
      const recent = (await this.#db.query('SELECT count(*)::int AS n FROM oauth_clients WHERE created_at > $1', [new Date(at.getTime() - CLIENT_WINDOW_MS).toISOString()], tx)).rows[0];
      if (Number(recent.n) >= CLIENT_BURST) throw new LimitError('最近登记的客户端太多，请稍后再登记');
      const row = (
        await this.#db.query('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES ($1, $2, $3, $4) RETURNING *', [newId('cli'), name, [...redirectUris], at.toISOString()], tx)
      ).rows[0];
      return clientOf(row);
    });
  }

  async client(clientId: string): Promise<OAuthClient | null> {
    if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) return null;
    const row = (await this.#db.query('SELECT * FROM oauth_clients WHERE id = $1', [clientId])).rows[0];
    return row === undefined ? null : clientOf(row);
  }

  async authenticate(authorization: string | null | undefined): Promise<Principal | null> {
    if (typeof authorization !== 'string' || authorization.length > 200) return null;
    const match = BEARER.exec(authorization);
    if (match === null) return null;
    const row = (
      await this.#db.query(
        `SELECT t.id AS token_id, u.id, u.name, u.role FROM tokens t JOIN users u ON u.id = t.user_id
          WHERE t.sha256 = $1 AND t.revoked_at IS NULL AND NOT u.disabled AND (t.expires_at IS NULL OR t.expires_at > $2)`,
        [sha256Hex(match[1]),this.#now().toISOString()],
      )
    ).rows[0];
    if (row === undefined || !isPermissionRole(row.role)) return null;
    const now = this.#now();
    await this.#db.query('UPDATE tokens SET last_used_at = $2 WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < $3)', [
      row.token_id,
      now.toISOString(),
      new Date(now.getTime() - LAST_USED_STEP_MS).toISOString(),
    ]);
    return { id: String(row.id), name: String(row.name), role: row.role };
  }

  /** The acting account as stored now: it must exist and be enabled, and be an admin when `adminOnly`. */
  async #decider(tx: PgTransaction, by: Principal, adminOnly: boolean): Promise<User> {
    const id = typeof by?.id === 'string' && USER_ID.test(by.id) ? by.id : null;
    const row = id === null ? undefined : (await this.#db.query('SELECT * FROM users WHERE id = $1', [id], tx)).rows[0];
    const user = row === undefined ? null : userOf(row);
    if (user === null || user.disabled) throw new AccessError('操作人不是有效的 Hub 账号');
    if (adminOnly && user.role !== ADMIN) throw new AccessError('只有管理员可以管理用户和角色');
    return user;
  }

  async #locked(tx: PgTransaction, userId: string): Promise<User> {
    const row = typeof userId === 'string' && USER_ID.test(userId) ? (await this.#db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId], tx)).rows[0] : undefined;
    if (row === undefined) throw new ConflictError('没有这个用户');
    return userOf(row);
  }

  async #keepAnAdmin(tx: PgTransaction, leaving: string): Promise<void> {
    const others = await this.#db.query('SELECT 1 FROM users WHERE role = $1 AND NOT disabled AND id <> $2 LIMIT 1', [ADMIN, leaving], tx);
    if ((others.rowCount ?? 0) === 0) throw new ConflictError('这是最后一位启用中的管理员，不能撤下或停用');
  }

  async #insertUser(tx: PgTransaction, name: string, role: PermissionRole, by: string | null, hash: string | null = null, mustChange = false): Promise<User> {
    const at = this.#now().toISOString();
    const id = newId('usr');
    const inserted = await this.#db.query(
      'INSERT INTO users (id, name, role, disabled, created_at, updated_at, password_hash, password_must_change, password_revision) VALUES ($1, $2, $3, false, $4, $4, $5, $6, $7) ON CONFLICT (name) DO NOTHING RETURNING *',
      [id, name, role, at, hash, mustChange, hash === null ? 0 : 1],
      tx,
    );
    if (inserted.rows[0] === undefined) throw new ConflictError('用户名已经存在');
    await this.#snapshot(tx, id, name, role, false, by, at);
    return userOf(inserted.rows[0]);
  }

  async #update(tx: PgTransaction, current: User, next: { role: PermissionRole; disabled: boolean }, by: string): Promise<User> {
    const at = this.#now().toISOString();
    const row = (
      await this.#db.query('UPDATE users SET role = $2, disabled = $3, updated_at = $4 WHERE id = $1 RETURNING *', [current.id, next.role, next.disabled, at], tx)
    ).rows[0];
    await this.#snapshot(tx, current.id, current.name, next.role, next.disabled, by, at);
    return userOf(row);
  }

  async #snapshot(tx: PgTransaction, userId: string, name: string, role: PermissionRole, disabled: boolean, by: string | null, at: string): Promise<void> {
    await this.#db.query(
      'INSERT INTO user_history (user_id, name, role, disabled, changed_by, changed_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, name, role, disabled, by, at],
      tx,
    );
  }

  async #issue(tx: PgTransaction, userId: string, label: string, by: string | null, client: string | null = null, consoleSession = false): Promise<IssuedToken> {
    const token = randomBytes(32).toString('base64url');
    const id = newId('tok');
    const at = this.#now().toISOString();
    await this.#db.query(
      'INSERT INTO tokens (id, user_id, sha256, label, created_at, created_by, client_id, console_session, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, userId, sha256Hex(token), label, at, by, client, consoleSession, consoleSession ? new Date(this.#now().getTime()+12*60*60*1000).toISOString() : null],
      tx,
    );
    return { id, user: userId, token, label, created_at: at };
  }
}
