// Renaming an account (owner's requirement of 2026-11-04): an administrator renames any account but a deleted member,
// through the runtime role's UPDATE (name) (RUNTIME_GRANTS, migration 25), with a user_history snapshot of the new name.
// Records name accounts by id, so login and lookups follow the new name and nothing else changes. Synthetic names only.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { Principal } from './api.ts';
import { Database, createPool } from './db.ts';
import { AccessError, ConflictError } from './errors.ts';
import { MIGRATIONS, grantRuntime, migrate } from './migrations.ts';
import { PgPrincipals } from './principals.ts';

const PASSWORD = 'synthetic-rename-password';
const asPrincipal = (user: { id: string; name: string; role: 'user' | 'admin' }): Principal => ({ id: user.id, name: user.name, role: user.role });

/** A records kit (owner role) and the principals store over a fresh runtime role granted exactly RUNTIME_GRANTS. */
async function world(t: TestContext) {
  const kit = await openTestRecords();
  t.after(() => kit.close());
  const db = new Database(createPool(kit.database));
  t.after(() => db.end());
  const role = 'synthetic_rename_' + randomBytes(4).toString('hex'), password = randomBytes(20).toString('hex');
  await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await db.query(`REVOKE TEMPORARY ON DATABASE "${kit.database.database}" FROM PUBLIC`);
  await grantRuntime(db, role);
  const rt = new Database(createPool({ ...kit.database, user: role, password }));
  t.after(() => rt.end());
  const runtime = new PgPrincipals(rt, () => new Date());
  const { user, token } = await kit.principals.bootstrapAdmin('synthetic-rename-admin', { password: PASSWORD, mustChange: false });
  return { kit, db, rt, role, runtime, admin: asPrincipal(user), adminToken: token.token };
}

test('an administrator renames an account as the runtime role: history, login, lookups and tokens follow the new name', async (t) => {
  const w = await world(t);
  assert.equal((await w.db.query("SELECT has_column_privilege($1,'public.users','name','UPDATE') AS ok", [w.role])).rows[0].ok, true);
  const member = await w.kit.principals.createUser(w.admin, 'synthetic-old-name', 'user', { password: PASSWORD, mustChange: false });
  const token = await w.kit.principals.issueToken(w.admin, member.id, 'synthetic-device');
  // A disabled account may be renamed; it stays disabled.
  await w.runtime.setDisabled(w.admin, member.id, true);
  const renamed = await w.runtime.rename(w.admin, member.id, 'synthetic-new-name');
  assert.deepEqual({ id: renamed.id, name: renamed.name, role: renamed.role, disabled: renamed.disabled }, { id: member.id, name: 'synthetic-new-name', role: 'user', disabled: true });
  const history = await w.kit.principals.history(member.id);
  assert.equal(history.length, 3);
  assert.deepEqual({ ...history[2], changed_at: undefined }, { user: member.id, name: 'synthetic-new-name', role: 'user', disabled: true, changed_by: w.admin.id, changed_at: undefined });
  assert.equal(history[1].name, 'synthetic-old-name', 'earlier snapshots keep the name they had');
  await w.runtime.setDisabled(w.admin, member.id, false);
  assert.equal(await w.kit.principals.findByName('synthetic-old-name'), null);
  assert.equal((await w.kit.principals.findByName('synthetic-new-name'))?.id, member.id);
  assert.equal(await w.kit.principals.verifyPassword('synthetic-old-name', PASSWORD), null, 'the old name no longer signs in');
  assert.equal((await w.kit.principals.verifyPassword('synthetic-new-name', PASSWORD))?.user.id, member.id, 'the new name signs in with the same password');
  assert.deepEqual(await w.kit.principals.authenticate(`Bearer ${token.token}`), { id: member.id, name: 'synthetic-new-name', role: 'user' }, 'tokens are bound to the id');
  // The owner's case: the first administrator renames itself to the default name, and its own token keeps working.
  const self = await w.runtime.rename(w.admin, w.admin.id, 'admin');
  assert.equal(self.name, 'admin');
  assert.deepEqual(await w.kit.principals.authenticate(`Bearer ${w.adminToken}`), { id: w.admin.id, name: 'admin', role: 'admin' });
  assert.equal((await w.kit.principals.verifyPassword('admin', PASSWORD))?.user.id, w.admin.id);
});

test('rename refuses an unchanged name, a live account\'s name, a deleted member, an unknown account, a non-administrator and a malformed name; a deleted member\'s name is free', async (t) => {
  const w = await world(t);
  const member = await w.kit.principals.createUser(w.admin, 'synthetic-member');
  const peer = await w.kit.principals.createUser(w.admin, 'synthetic-peer');
  const gone = await w.kit.principals.createUser(w.admin, 'synthetic-deleted');
  const preview = await w.kit.memberDeletions!.preview(w.admin, gone.id);
  await w.kit.memberDeletions!.prepare(w.admin, { ...preview, operation_id: randomUUID() });
  assert.ok((await w.kit.principals.get(gone.id))?.deleted_at);
  const before = Number((await w.db.query('SELECT count(*)::int AS n FROM user_history')).rows[0].n);
  await assert.rejects(w.runtime.rename(w.admin, member.id, 'synthetic-member'), (error: unknown) => error instanceof ConflictError && /相同/.test(error.message));
  await assert.rejects(w.runtime.rename(w.admin, member.id, 'synthetic-peer'), (error: unknown) => error instanceof ConflictError && /已经存在/.test(error.message));
  await assert.rejects(w.runtime.rename(w.admin, gone.id, 'synthetic-revived'), ConflictError);
  await assert.rejects(w.runtime.rename(w.admin, 'usr_00000000000000000000000000', 'synthetic-nobody'), (error: unknown) => error instanceof ConflictError && /没有这个用户/.test(error.message));
  await assert.rejects(w.runtime.rename(asPrincipal(peer), member.id, 'synthetic-by-peer'), AccessError);
  for (const bad of ['', ' synthetic-space', 'synthetic\u0007bell', 'x'.repeat(101)]) await assert.rejects(w.runtime.rename(w.admin, member.id, bad), TypeError);
  // Concurrent renames to one name: one wins, the other is refused by the unique name, not by a raw driver error.
  const raced = await Promise.allSettled([w.runtime.rename(w.admin, member.id, 'synthetic-raced'), w.runtime.rename(w.admin, peer.id, 'synthetic-raced')]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of raced) if (result.status === 'rejected') assert.ok(result.reason instanceof ConflictError, String(result.reason));
  assert.equal((await w.db.query('SELECT count(*)::int AS n FROM user_history')).rows[0].n, before + 1, 'refusals append nothing');
  // Like createUser (users_live_name, migration 19), a live account may take the name a deleted member had.
  const reused = await w.runtime.rename(w.admin, member.id, 'synthetic-deleted');
  assert.equal(reused.name, 'synthetic-deleted');
  assert.equal((await w.kit.principals.get(gone.id))?.name, 'synthetic-deleted', 'the tombstone keeps its own name');
  assert.equal((await w.kit.principals.findByName('synthetic-deleted'))?.id, reused.id, 'lookups by name find the live account');
  // The tombstone trigger of migration 23 keeps a deleted member's name even against the runtime role's grant.
  await assert.rejects(w.rt.query('UPDATE users SET name=$2 WHERE id=$1', [gone.id, 'synthetic-forced']), (error: any) => error.code === 'HU001');
});

test('migration 25 gives UPDATE (name) to the roles that hold the earlier users column UPDATEs, and to nobody else', async (t) => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const db = new Database(createPool(await pg.createDatabase(undefined, { empty: true })));
  t.after(() => db.end());
  await migrate(db, MIGRATIONS.slice(0, 24));
  const suffix = randomBytes(4).toString('hex'), runtime = `synthetic_before_${suffix}`, reader = `synthetic_reader_${suffix}`;
  await db.query(`CREATE ROLE ${runtime} NOLOGIN`);
  await db.query(`CREATE ROLE ${reader} NOLOGIN`);
  // The users grant of RUNTIME_GRANTS before this migration.
  await db.query(`GRANT SELECT, INSERT, UPDATE (role, disabled, updated_at, password_hash, password_must_change, password_revision) ON users TO ${runtime}`);
  await db.query(`GRANT SELECT ON users TO ${reader}`);
  const may = async (role: string) => (await db.query("SELECT has_column_privilege($1,'public.users','name','UPDATE') AS ok", [role])).rows[0].ok;
  assert.equal(await may(runtime), false);
  assert.deepEqual(await migrate(db), MIGRATIONS.slice(24).map((migration) => migration.version));
  assert.equal(MIGRATIONS[24].version, 25);
  assert.equal(await may(runtime), true);
  assert.equal(await may(reader), false);
  assert.equal((await db.query("SELECT has_column_privilege('public','public.users','name','UPDATE') AS ok")).rows[0].ok, false);
});
