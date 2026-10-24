// Forward-only migrator (adapted from the earlier storage migrator). Applied migrations never change: each is checksummed,
// and an unknown applied version, a gap or a checksum mismatch refuses to start. To change the schema, append a migration.
// Two roles: the owner applies migrations; the runtime role gets only SELECT and INSERT on the history tables (and the
// column UPDATEs the mutable tables need), so the running Hub cannot alter, disable the triggers of, or delete history.
import type { Database, PgTransaction } from './db.ts';
import { sha256Hex } from './digest.ts';
import { MigrationError } from './errors.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Arbitrary constant: the advisory lock that serializes migrators of one database. */
const MIGRATION_LOCK = 7_301_562_001;

const APPEND_ONLY = (table: string) => `
CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hub_append_only();
CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION hub_append_only();`;

const V1_RECORDS = `
CREATE FUNCTION hub_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'append-only table %: % rejected', TG_TABLE_NAME, TG_OP USING ERRCODE = 'HU001';
END
$fn$;

CREATE TABLE records (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE CHECK (id ~ '^rcd_[0-9a-z]{26}$'),
  digest text NOT NULL UNIQUE CHECK (digest ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{0,39}$'),
  schema text NOT NULL CHECK (schema ~ '^[a-z][a-z0-9_-]*@[0-9]+$'),
  provenance text NOT NULL CHECK (provenance ~ '^[a-z][a-z_]{0,39}$'),
  created_at timestamptz NOT NULL,
  body text NOT NULL,
  size integer NOT NULL CHECK (size >= 0)
);
CREATE INDEX records_kind_seq ON records (kind, seq);
${APPEND_ONLY('records')}

CREATE TABLE record_index (
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.-]{0,99}$'),
  value text NOT NULL CHECK (octet_length(value) <= 1000),
  digest text NOT NULL REFERENCES records (digest),
  record_seq bigint NOT NULL,
  PRIMARY KEY (key, value, digest)
);
CREATE INDEX record_index_lookup ON record_index (key, value, record_seq);
${APPEND_ONLY('record_index')}

CREATE TABLE objects (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size bigint NOT NULL CHECK (size >= 0),
  media_type text NOT NULL CHECK (length(media_type) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL
);
${APPEND_ONLY('objects')}

CREATE TABLE users (
  id text PRIMARY KEY CHECK (id ~ '^usr_[0-9a-z]{26}$'),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  role text NOT NULL CHECK (role ~ '^[a-z_]{1,40}$'),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE user_history (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id),
  name text NOT NULL,
  role text NOT NULL,
  disabled boolean NOT NULL,
  changed_by text REFERENCES users (id),
  changed_at timestamptz NOT NULL
);
CREATE INDEX user_history_user ON user_history (user_id, seq);
${APPEND_ONLY('user_history')}

CREATE TABLE tokens (
  id text PRIMARY KEY CHECK (id ~ '^tok_[0-9a-z]{26}$'),
  user_id text NOT NULL REFERENCES users (id),
  sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK (length(label) <= 100),
  created_at timestamptz NOT NULL,
  created_by text REFERENCES users (id),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by text REFERENCES users (id)
);
CREATE INDEX tokens_user ON tokens (user_id);

CREATE TABLE pointers (
  name text PRIMARY KEY CHECK (name ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  target text NOT NULL CHECK (target ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL CHECK (version >= 1),
  moved_at timestamptz NOT NULL,
  action_digest text NOT NULL REFERENCES records (digest)
);

CREATE TABLE call_logs (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  digest text NOT NULL UNIQUE REFERENCES records (digest),
  at timestamptz NOT NULL,
  trace_id text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  span_id text NOT NULL CHECK (span_id ~ '^[0-9a-f]{16}$'),
  user_id text,
  session_id text,
  tool text NOT NULL,
  run_id text,
  args_digest text NOT NULL CHECK (args_digest ~ '^[0-9a-f]{64}$'),
  args_size bigint NOT NULL CHECK (args_size >= 0),
  args_preview text CHECK (octet_length(args_preview) <= 1024),
  call_result text NOT NULL,
  acceptance text,
  error_code text,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0)
);
CREATE INDEX call_logs_user_seq ON call_logs (user_id, seq);
CREATE INDEX call_logs_run_seq ON call_logs (run_id, seq);
CREATE INDEX call_logs_at ON call_logs (at);
${APPEND_ONLY('call_logs')}

-- Real reasons behind neutral answers (D05 R[3]), for admins only. Outside the call_log record, so no digest a user sees covers them.
CREATE TABLE call_notes (
  digest text PRIMARY KEY REFERENCES call_logs (digest),
  note text NOT NULL CHECK (length(note) BETWEEN 1 AND 2000),
  at timestamptz NOT NULL
);
${APPEND_ONLY('call_notes')}
`;

const V2_LEASES = `
-- The lease table (D04 R[0]): one row per key, the fencing token monotonic per row. Expiry is decided by the
-- database clock; an expired or released row is taken over in place (UPDATE ... WHERE expires_at <= now() OR
-- released_at IS NOT NULL), never deleted, so the token never repeats for a key.
CREATE TABLE leases (
  key text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  lease_id text NOT NULL CHECK (lease_id ~ '^lse_[0-9a-z]{26}$'),
  run_id text NOT NULL CHECK (run_id ~ '^run_[0-9a-z]{26}$'),
  user_id text NOT NULL CHECK (user_id ~ '^usr_[0-9a-z]{26}$'),
  token bigint NOT NULL CHECK (token >= 1),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz
);
CREATE INDEX leases_prefix ON leases (key);
`;

const V3_RECORD_KEYS = `
CREATE TABLE record_keys (
  kind text NOT NULL,
  key text NOT NULL CHECK (octet_length(key) BETWEEN 1 AND 1000),
  digest text NOT NULL REFERENCES records(digest),
  PRIMARY KEY (kind, key)
);
${APPEND_ONLY('record_keys')}
`;

const V6_CALL_REASONS = `
-- Full private reasons stay outside the call record and its public digest; call_notes remains the bounded summary.
CREATE TABLE call_reasons (
  digest text NOT NULL REFERENCES call_logs (digest),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  note text NOT NULL CHECK (length(note) >= 1),
  at timestamptz NOT NULL,
  PRIMARY KEY (digest, ordinal)
);
${APPEND_ONLY('call_reasons')}
`;

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'records', sql: V1_RECORDS },
  { version: 2, name: 'leases', sql: V2_LEASES },
  { version: 3, name: 'record_keys', sql: V3_RECORD_KEYS },
  { version: 4, name: 'unbounded_leases', sql: 'ALTER TABLE leases ALTER COLUMN expires_at DROP NOT NULL;' },
  { version: 5, name: 'lease_registrations', sql: `CREATE TABLE lease_registrations (
    prefix text PRIMARY KEY CHECK (right(prefix, 1) = '/'),
    owner text NOT NULL,
    registered_at timestamptz NOT NULL
  );` },
  { version: 6, name: 'call_reasons', sql: V6_CALL_REASONS },
]);

/** Tables and what the runtime role may do with them; nothing else (no DELETE, no TRUNCATE, no DDL, not the owner). */
export const RUNTIME_GRANTS: Readonly<Record<string, string>> = Object.freeze({
  schema_migrations: 'SELECT',
  records: 'SELECT, INSERT',
  record_index: 'SELECT, INSERT',
  record_keys: 'SELECT, INSERT',
  objects: 'SELECT, INSERT',
  user_history: 'SELECT, INSERT',
  call_logs: 'SELECT, INSERT',
  call_notes: 'SELECT, INSERT',
  call_reasons: 'SELECT, INSERT',
  users: 'SELECT, INSERT, UPDATE (role, disabled, updated_at)',
  tokens: 'SELECT, INSERT, UPDATE (last_used_at, revoked_at, revoked_by)',
  pointers: 'SELECT, INSERT, UPDATE (target, version, moved_at, action_digest)',
  lease_registrations: 'SELECT, INSERT, UPDATE, DELETE',
  leases: 'SELECT, INSERT, UPDATE (lease_id, run_id, user_id, token, acquired_at, expires_at, released_at)',
});

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

export function migrationChecksum(migration: Migration): string {
  return sha256Hex(migration.sql);
}

function checkList(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1 || !/^[a-z][a-z0-9_]{0,62}$/.test(migration.name) || migration.sql.trim() === '') {
      throw new TypeError(`migration list must be versions 1..n in order with names; problem at index ${index}`);
    }
  });
}

/**
 * Gives `role` exactly RUNTIME_GRANTS (after revoking everything else it had on these tables). Run as the owner, after
 * migrate(); repeatable. The runtime role must not own the tables: an owner can always disable triggers.
 */
export async function grantRuntime(db: Database, role: string, tx?: PgTransaction): Promise<void> {
  if (typeof role !== 'string' || !ROLE.test(role)) throw new TypeError('runtime role names are lowercase letters, digits and underscores');
  await db.transaction(async (t) => {
    const owner = (await db.query<{ owns: boolean }>(`SELECT pg_get_userbyid(relowner) = $1 AS owns FROM pg_class WHERE relname = 'records' AND relkind = 'r'`, [role], t)).rows[0];
    if (owner === undefined) throw new MigrationError('还没有应用迁移，不能授权运行角色');
    if (owner.owns) throw new MigrationError(`运行角色 ${role} 拥有这些表，能关掉只追加的触发器；请让另一个角色执行迁移`);
    for (const [table, privileges] of Object.entries(RUNTIME_GRANTS)) {
      await db.query(`REVOKE ALL ON TABLE ${table} FROM "${role}"`, [], t);
      await db.query(`GRANT ${privileges} ON TABLE ${table} TO "${role}"`, [], t);
    }
  }, tx);
}

/** For a process that does not migrate (the runtime role): refuses to start unless exactly this program's migrations are applied. */
export async function verifyMigrations(db: Database, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  checkList(migrations);
  const exists = (await db.query<{ t: string | null }>("SELECT to_regclass('schema_migrations')::text AS t")).rows[0];
  const applied =
    exists?.t === null || exists === undefined ? [] : (await db.query<{ version: number; name: string; sha256: string }>('SELECT version, name, sha256 FROM schema_migrations ORDER BY version')).rows;
  const unknown = applied.filter((row) => !migrations.some((migration) => migration.version === row.version));
  if (unknown.length > 0) {
    throw new MigrationError(`数据库里有本程序不认识的迁移（版本 ${unknown.map((row) => row.version).join('、')}），可能来自更新的 Hub；拒绝启动`, {
      detail: { versions: unknown.map((row) => row.version) },
    });
  }
  for (const migration of migrations) {
    const row = applied.find((candidate) => candidate.version === migration.version);
    if (row === undefined) {
      throw new MigrationError(`迁移 ${migration.version}（${migration.name}）还没有应用；请先由拥有表的角色执行迁移，拒绝启动`, { detail: { version: migration.version } });
    }
    if (row.sha256 !== migrationChecksum(migration) || row.name !== migration.name) {
      throw new MigrationError(`已应用的迁移 ${migration.version}（${row.name}）的校验和与本程序不符；已应用的迁移不能修改，拒绝启动`, {
        detail: { version: migration.version },
      });
    }
  }
}

/** Applies pending migrations in one transaction under an advisory lock. Returns the versions applied by this call. */
export async function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): Promise<number[]> {
  checkList(migrations);
  return db.transaction(async (tx) => {
    await db.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK], tx);
    // Only the journal bootstrap is conditional; everything else is versioned and checksummed.
    await db.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version integer PRIMARY KEY, name text NOT NULL, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
      [],
      tx,
    );
    const applied = (await db.query<{ version: number; name: string; sha256: string }>('SELECT version, name, sha256 FROM schema_migrations ORDER BY version', [], tx)).rows;
    const unknown = applied.filter((row) => !migrations.some((migration) => migration.version === row.version));
    if (unknown.length > 0) {
      throw new MigrationError(
        `数据库里有本程序不认识的迁移（版本 ${unknown.map((row) => row.version).join('、')}），可能来自更新的 Hub；拒绝启动`,
        { detail: { versions: unknown.map((row) => row.version) } },
      );
    }
    const highest = applied.reduce((max, row) => Math.max(max, row.version), 0);
    const done: number[] = [];
    for (const migration of migrations) {
      const old = applied.find((row) => row.version === migration.version);
      const checksum = migrationChecksum(migration);
      if (old !== undefined) {
        if (old.sha256 !== checksum || old.name !== migration.name) {
          throw new MigrationError(`已应用的迁移 ${migration.version}（${old.name}）的校验和与本程序不符；已应用的迁移不能修改，拒绝启动`, {
            detail: { version: migration.version },
          });
        }
        continue;
      }
      if (migration.version < highest) {
        throw new MigrationError(`迁移 ${migration.version} 没有应用，但更高的版本已经应用；只能向前迁移，拒绝启动`, {
          detail: { version: migration.version },
        });
      }
      await db.query(migration.sql, [], tx);
      await db.query('INSERT INTO schema_migrations (version, name, sha256) VALUES ($1, $2, $3)', [migration.version, migration.name, checksum], tx);
      done.push(migration.version);
    }
    return done;
  });
}
