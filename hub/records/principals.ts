// Users and long-lived revocable tokens (R01; adapted from the earlier hashed-token auth). A token is 32 random bytes shown
// once; only its SHA-256 is stored. Every change to a user is recorded as an append-only snapshot in user_history.
import { randomBytes } from 'node:crypto';
import { isPermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { PermissionRole } from '../../contracts/generated/vocabulary.ts';
import type { IssuedToken, Principal, Principals, TokenInfo, User, UserChange } from './api.ts';
import { iso, isoOrNull } from './db.ts';
import type { Database, PgTransaction, Row } from './db.ts';
import { sha256Hex } from './digest.ts';
import { AccessError, ConflictError, IntegrityError } from './errors.ts';
import { newId } from './ids.ts';

const ADMIN: PermissionRole = 'admin';
const USER: PermissionRole = 'user';
/** Serializes every change to the set of active admins, and the first-admin bootstrap. */
const ADMIN_SET_LOCK = 7_301_562_002;
const BEARER = /^Bearer[ \t]+([A-Za-z0-9_-]{43})[ \t]*$/i;
const USER_ID = /^usr_[0-9a-z]{26}$/;
const TOKEN_ID = /^tok_[0-9a-z]{26}$/;
const NAME = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,98}[^\s\p{Cc}])?$/u;
/** last_used_at is refreshed at most once a minute per token. */
const LAST_USED_STEP_MS = 60_000;

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
    created_at: iso(row.created_at),
    created_by: row.created_by === null ? null : String(row.created_by),
    last_used_at: isoOrNull(row.last_used_at),
    revoked_at: isoOrNull(row.revoked_at),
  };
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

  async bootstrapAdmin(name: string): Promise<{ user: User; token: IssuedToken }> {
    const clean = validName(name);
    return this.#db.transaction(async (tx) => {
      await this.#db.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_SET_LOCK], tx);
      const admins = await this.#db.query('SELECT 1 FROM users WHERE role = $1 LIMIT 1', [ADMIN], tx);
      if ((admins.rowCount ?? 0) > 0) throw new ConflictError('已经有管理员；第一位管理员只能引导一次，之后由管理员添加用户');
      const user = await this.#insertUser(tx, clean, ADMIN, null);
      const token = await this.#issue(tx, user.id, '引导', null);
      return { user, token };
    });
  }

  async createUser(by: Principal, name: string, role: PermissionRole = USER): Promise<User> {
    const clean = validName(name);
    const wanted = validRole(role);
    return this.#db.transaction(async (tx) => {
      await this.#decider(tx, by, true);
      return this.#insertUser(tx, clean, wanted, by.id);
    });
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
    }));
  }

  async issueToken(by: Principal, userId: string, label = ''): Promise<IssuedToken> {
    if (typeof label !== 'string' || label.length > 100 || /\p{Cc}/u.test(label)) throw new TypeError('token labels are at most 100 characters without control characters');
    return this.#db.transaction(async (tx) => {
      const decider = await this.#decider(tx, by, false);
      if (decider.role !== ADMIN && decider.id !== userId) throw new AccessError('只有管理员可以为别人签发令牌');
      const target = await this.#locked(tx, userId);
      if (target.disabled) throw new ConflictError('用户已停用，不能签发令牌');
      return this.#issue(tx, target.id, label, decider.id);
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

  async tokens(userId: string): Promise<TokenInfo[]> {
    if (typeof userId !== 'string' || !USER_ID.test(userId)) return [];
    const rows = (await this.#db.query('SELECT id, user_id, label, created_at, created_by, last_used_at, revoked_at FROM tokens WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [userId])).rows;
    return rows.map(tokenOf);
  }

  async authenticate(authorization: string | null | undefined): Promise<Principal | null> {
    if (typeof authorization !== 'string' || authorization.length > 200) return null;
    const match = BEARER.exec(authorization);
    if (match === null) return null;
    const row = (
      await this.#db.query(
        `SELECT t.id AS token_id, u.id, u.name, u.role FROM tokens t JOIN users u ON u.id = t.user_id
          WHERE t.sha256 = $1 AND t.revoked_at IS NULL AND NOT u.disabled`,
        [sha256Hex(match[1])],
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

  async #insertUser(tx: PgTransaction, name: string, role: PermissionRole, by: string | null): Promise<User> {
    const at = this.#now().toISOString();
    const id = newId('usr');
    const inserted = await this.#db.query(
      'INSERT INTO users (id, name, role, disabled, created_at, updated_at) VALUES ($1, $2, $3, false, $4, $4) ON CONFLICT (name) DO NOTHING RETURNING *',
      [id, name, role, at],
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

  async #issue(tx: PgTransaction, userId: string, label: string, by: string | null): Promise<IssuedToken> {
    const token = randomBytes(32).toString('base64url');
    const id = newId('tok');
    const at = this.#now().toISOString();
    await this.#db.query(
      'INSERT INTO tokens (id, user_id, sha256, label, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, userId, sha256Hex(token), label, at, by],
      tx,
    );
    return { id, user: userId, token, label, created_at: at };
  }
}
