// Model 38, R01 R[12] (decision 136 ⑫): every token and invitation issuance, use and revocation appends exactly one
// token_issuance record in the transaction of its row change, never holds replayable material, and stays append-only.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { TestRecordsKit } from '../testing/records.ts';
import { normalizeInvitation, type Principal } from './api.ts';
import { Database, createPool } from './db.ts';
import { sha256Hex } from './digest.ts';
import { grantRuntime } from './migrations.ts';
import { PgPrincipals } from './principals.ts';
import { appendTokenIssuance } from './token-issuance.ts';
import { TokenIssuanceBody } from '../../contracts/src/tokens.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });

const PASSWORD = 'Synthetic-member-password-71!';
const LOOPBACK = ['http://127.0.0.1:43123/callback'];
const asPrincipal = (user: { id: string; name: string; role: 'user' | 'admin' }): Principal => ({ id: user.id, name: user.name, role: user.role });

async function world(t: { after(fn: () => unknown): void }) {
  let clock = Date.parse('2026-11-04T08:00:00.000Z');
  const now = () => new Date(clock);
  const kit = await openTestRecords({ postgres, now });
  t.after(() => kit.close());
  const db = new Database(createPool(kit.database));
  t.after(() => db.end());
  const tick = () => { clock += 1000; };
  return { kit, db, tick, now };
}

async function records(kit: TestRecordsKit): Promise<TokenIssuanceBody[]> {
  const items = [];
  let cursor: string | null | undefined;
  do {
    const page = await kit.store.list<TokenIssuanceBody>({ kind: 'token_issuance', cursor: cursor ?? undefined, limit: 100 });
    items.push(...page.items);
    cursor = page.next;
  } while (cursor);
  for (const item of items) assert.equal(item.schema, 'token-issuance@1');
  return items.map((item) => TokenIssuanceBody.parse(item.body));
}

/** Every stored byte of the records, their index and their unique keys, to search for replayable material. */
async function storedText(db: Database): Promise<string> {
  const rows = [
    ...(await db.query("SELECT * FROM records WHERE kind = 'token_issuance'")).rows,
    ...(await db.query("SELECT i.* FROM record_index i JOIN records r ON r.digest = i.digest WHERE r.kind = 'token_issuance'")).rows,
    ...(await db.query("SELECT * FROM record_keys WHERE kind = 'token_issuance'")).rows,
  ];
  return JSON.stringify(rows);
}

function assertNoSecret(text: string, secrets: readonly string[]): void {
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'a token_issuance record holds replayable material');
}

test('each issuance, use and revocation path writes exactly one record with its fields and no token, code or hash', async (t) => {
  const { kit, db, tick } = await world(t);
  const boot = await kit.principals.bootstrapAdmin('合成管理员');
  const admin = asPrincipal(boot.user);
  const member = await kit.principals.createUser(admin, '合成成员', 'user', { password: PASSWORD, mustChange: false });
  const client = await kit.principals.registerClient('合成客户端', LOOPBACK);
  const secrets: string[] = [boot.token.token, sha256Hex(boot.token.token)];
  const expected: TokenIssuanceBody[] = [{ action: 'issue', token: boot.token.id, user: admin.id, by: null, at: boot.token.created_at, label: '引导', client: null, console_session: false, expires_at: null }];
  assert.deepEqual(await records(kit), expected);

  tick();
  const issued = await kit.principals.issueToken(admin, member.id, '合成笔记本');
  secrets.push(issued.token, sha256Hex(issued.token));
  expected.push({ action: 'issue', token: issued.id, user: member.id, by: admin.id, at: issued.created_at, label: '合成笔记本', client: null, console_session: false, expires_at: null });
  assert.deepEqual(await records(kit), expected);

  tick();
  const invitation = await kit.principals.invite(admin, member.id);
  secrets.push(invitation.code, normalizeInvitation(invitation.code), sha256Hex(normalizeInvitation(invitation.code)));
  expected.push({ action: 'issue', invitation: invitation.id, user: member.id, by: admin.id, at: invitation.created_at, expires_at: invitation.expires_at });
  assert.deepEqual(await records(kit), expected);

  tick();
  const usedAt = new Date(Date.parse(invitation.created_at) + 1000).toISOString();
  assert.equal((await kit.principals.takeInvitation(invitation.id, client.id))?.id, member.id);
  expected.push({ action: 'use', invitation: invitation.id, user: member.id, client: client.id, at: usedAt });
  assert.deepEqual(await records(kit), expected);

  tick();
  const authorized = await kit.principals.issueToken(asPrincipal(member), member.id, client.name, client.id);
  secrets.push(authorized.token, sha256Hex(authorized.token));
  expected.push({ action: 'issue', token: authorized.id, user: member.id, by: member.id, at: authorized.created_at, label: client.name, client: client.id, console_session: false, expires_at: null });
  assert.deepEqual(await records(kit), expected);

  tick();
  const verified = await kit.principals.verifyPassword(member.name, PASSWORD);
  assert.ok(verified);
  const session = await kit.principals.openConsoleSession(member.id, verified.revision);
  assert.ok(session);
  secrets.push(session.token, sha256Hex(session.token));
  expected.push({ action: 'issue', token: session.id, user: member.id, by: member.id, at: session.created_at, label: '控制台登录', client: null, console_session: true, expires_at: new Date(Date.parse(session.created_at) + 12 * 60 * 60 * 1000).toISOString() });
  assert.deepEqual(await records(kit), expected);

  tick();
  assert.equal(await kit.principals.revokeToken(admin, issued.id), true);
  const revokedAt = (await kit.principals.tokens(member.id)).find((row) => row.id === issued.id)!.revoked_at!;
  expected.push({ action: 'revoke', token: issued.id, user: member.id, by: admin.id, at: revokedAt });
  assert.deepEqual(await records(kit), expected);

  tick();
  assert.equal(await kit.principals.revokeTokenValue(authorized.token), true);
  const heldAt = (await kit.principals.tokens(member.id)).find((row) => row.id === authorized.id)!.revoked_at!;
  expected.push({ action: 'revoke', token: authorized.id, user: member.id, by: member.id, at: heldAt });
  assert.deepEqual(await records(kit), expected);

  // A password change revokes the account's console sessions: one record each, by the account that changed it.
  tick();
  const second = await kit.principals.openConsoleSession(member.id, verified.revision);
  assert.ok(second);
  secrets.push(second.token, sha256Hex(second.token));
  expected.push({ action: 'issue', token: second.id, user: member.id, by: member.id, at: second.created_at, label: '控制台登录', client: null, console_session: true, expires_at: new Date(Date.parse(second.created_at) + 12 * 60 * 60 * 1000).toISOString() });
  tick();
  assert.equal(await kit.principals.changePassword(asPrincipal(member), PASSWORD, PASSWORD + 'x'), true);
  const changedAt = new Date(Date.parse(second.created_at) + 1000).toISOString();
  for (const id of [session.id, second.id].sort()) expected.push({ action: 'revoke', token: id, user: member.id, by: member.id, at: changedAt });
  assert.deepEqual(await records(kit), expected);

  // An administrator's reset revokes the sessions opened since, by the administrator.
  tick();
  const again = await kit.principals.verifyPassword(member.name, PASSWORD + 'x');
  assert.ok(again);
  const third = await kit.principals.openConsoleSession(member.id, again.revision);
  assert.ok(third);
  secrets.push(third.token, sha256Hex(third.token));
  expected.push({ action: 'issue', token: third.id, user: member.id, by: member.id, at: third.created_at, label: '控制台登录', client: null, console_session: true, expires_at: new Date(Date.parse(third.created_at) + 12 * 60 * 60 * 1000).toISOString() });
  tick();
  await kit.principals.resetPassword(admin, member.id);
  expected.push({ action: 'revoke', token: third.id, user: member.id, by: admin.id, at: new Date(Date.parse(third.created_at) + 1000).toISOString() });
  assert.deepEqual(await records(kit), expected);

  // Exactly one record per row change, findable by the account and by the subject.
  assert.equal((await kit.store.findMany({ key: 'token.issuance.user', values: [member.id], kind: 'token_issuance' })).length, expected.filter((row) => row.user === member.id).length);
  assert.equal((await kit.store.findMany({ key: 'token.issuance.subject', values: [issued.id], kind: 'token_issuance' })).length, 2);
  assert.equal((await kit.store.getByKey<TokenIssuanceBody>('token_issuance', `${invitation.id}:use`))?.body.action, 'use');
  assertNoSecret(await storedText(db), secrets);
});

test('a refused or failed change writes no record, and a failing record write undoes the row change', async (t) => {
  const { kit, db, now } = await world(t);
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('合成管理员')).user);
  const member = await kit.principals.createUser(admin, '合成成员');
  const other = await kit.principals.createUser(admin, '合成他人');
  const client = await kit.principals.registerClient('合成客户端', LOOPBACK);
  const token = await kit.principals.issueToken(admin, member.id, '合成');
  const invitation = await kit.principals.invite(admin, member.id);
  const baseline = (await records(kit)).length;

  // Refusals: someone else's token, an unknown or already revoked token, a disabled account, a used invitation.
  assert.equal(await kit.principals.revokeToken(asPrincipal(other), token.id), false);
  await assert.rejects(kit.principals.issueToken(asPrincipal(other), member.id, '越权'));
  assert.equal(await kit.principals.revokeTokenValue(randomBytes(32).toString('base64url')), false);
  assert.equal((await records(kit)).length, baseline);
  assert.equal(await kit.principals.revokeToken(admin, token.id), true);
  assert.equal(await kit.principals.revokeToken(admin, token.id), false);
  assert.equal(await kit.principals.revokeTokenValue(token.token), false);
  assert.equal((await records(kit)).length, baseline + 1);
  await kit.principals.setDisabled(admin, member.id, true);
  await assert.rejects(kit.principals.issueToken(admin, member.id, '停用后'));
  await assert.rejects(kit.principals.invite(admin, member.id));
  assert.equal(await kit.principals.takeInvitation(invitation.id, client.id), null);
  assert.equal((await records(kit)).length, baseline + 1);
  assert.equal((await kit.principals.invitations(member.id))[0].used_at, null);
  await kit.principals.setDisabled(admin, member.id, false);

  // The same transaction: when the record cannot be appended, the token and invitation rows do not change either.
  const sessionUser = await kit.principals.createUser(admin, '合成会话', 'user', { password: PASSWORD, mustChange: false });
  const check = await kit.principals.verifyPassword(sessionUser.name, PASSWORD);
  assert.ok(await kit.principals.openConsoleSession(sessionUser.id, check!.revision));
  const live = await kit.principals.issueToken(admin, member.id, '合成二');
  const tokens = (await db.query('SELECT * FROM tokens ORDER BY id')).rows;
  const invitations = (await db.query('SELECT * FROM invitations ORDER BY id')).rows;
  const users = (await db.query('SELECT * FROM users ORDER BY id')).rows;
  const count = (await records(kit)).length;
  // On the world's clock: on the wall clock the invitation made at the world's time would have
  // expired a day later, and taking it would refuse before it reached the record write.
  const failing = new PgPrincipals(db, now, { put: async () => { throw new Error('synthetic record failure'); } });
  await assert.rejects(failing.issueToken(admin, member.id, '失败'), /synthetic record failure/);
  await assert.rejects(failing.revokeToken(admin, live.id), /synthetic record failure/);
  await assert.rejects(failing.revokeTokenValue(live.token), /synthetic record failure/);
  await assert.rejects(failing.invite(admin, member.id), /synthetic record failure/);
  await assert.rejects(failing.takeInvitation(invitation.id, client.id), /synthetic record failure/);
  await assert.rejects(failing.resetPassword(admin, sessionUser.id), /synthetic record failure/);
  assert.deepEqual((await db.query('SELECT * FROM tokens ORDER BY id')).rows, tokens);
  assert.deepEqual((await db.query('SELECT * FROM invitations ORDER BY id')).rows, invitations);
  assert.deepEqual((await db.query('SELECT * FROM users ORDER BY id')).rows, users, 'the reset that could not record its revocation changed no password');
  assert.equal((await records(kit)).length, count);
});

test('token issuance records are append-only and one action happens once per subject', async (t) => {
  const { kit, db } = await world(t);
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('合成管理员')).user);
  const token = await kit.principals.issueToken(admin, admin.id, '合成');
  const stored = await kit.store.getByKey('token_issuance', `${token.id}:issue`);
  assert.ok(stored);
  await assert.rejects(db.query("UPDATE records SET body = '{}' WHERE digest = $1", [stored.digest]), (error: { code?: string }) => error.code === 'HU001');
  await assert.rejects(db.query('DELETE FROM records WHERE digest = $1', [stored.digest]), (error: { code?: string }) => error.code === 'HU001');
  await assert.rejects(db.query('DELETE FROM record_keys WHERE digest = $1', [stored.digest]), (error: { code?: string }) => error.code === 'HU001');
  const body = { action: 'issue', token: token.id, user: admin.id, by: admin.id, at: '2026-11-04T09:00:00.000Z', label: '合成重写', client: null, console_session: false, expires_at: null } as const;
  await assert.rejects(kit.store.withTransaction((tx) => appendTokenIssuance(kit.store, body, tx)), /已经有记录/);
  assert.deepEqual((await kit.store.getByKey('token_issuance', `${token.id}:issue`))?.digest, stored.digest);
  await assert.rejects(kit.store.withTransaction((tx) => appendTokenIssuance(kit.store, { ...body, sha256: sha256Hex(token.token) } as never, tx)));
});

test('member deletion revokes the live tokens with one record each, naming its operation', async (t) => {
  const { kit, db } = await world(t);
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('合成管理员')).user);
  const member = await kit.principals.createUser(admin, '合成成员', 'user', { password: PASSWORD, mustChange: false });
  const kept = await kit.principals.issueToken(admin, member.id, '合成一');
  const earlier = await kit.principals.issueToken(admin, member.id, '合成二');
  assert.equal(await kit.principals.revokeToken(admin, earlier.id), true);
  const verified = await kit.principals.verifyPassword(member.name, PASSWORD);
  const session = await kit.principals.openConsoleSession(member.id, verified!.revision);
  assert.ok(session);
  const deletions = kit.memberDeletions!;
  const preview = await deletions.preview(admin, member.id);
  const operation = randomUUID();
  const intent = await deletions.prepare(admin, { ...preview, operation_id: operation });
  const revocations = (await records(kit)).filter((row) => row.action === 'revoke' && row.user === member.id);
  assert.deepEqual(revocations.filter((row) => 'member_deletion' in row), [kept.id, session.id].sort().map((token) => ({ action: 'revoke', token, user: member.id, by: admin.id, at: intent.at, member_deletion: operation })));
  assert.equal(revocations.filter((row) => 'token' in row && row.token === earlier.id).length, 1, 'an earlier revocation is not recorded again');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tokens WHERE user_id = $1 AND revoked_at IS NULL', [member.id])).rows[0].n, 0);
  // Repeating the prepared operation and finishing it revoke nothing more and write no further record; the records stay.
  const count = (await records(kit)).length;
  await deletions.prepare(admin, { ...preview, operation_id: operation });
  await deletions.finish(admin, member.id, intent.operation_id);
  assert.equal((await records(kit)).length, count);
  assert.equal((await kit.store.list({ kind: 'member_deletion' })).items.length, 1);
});

test('the runtime role writes the records with its existing grants', async (t) => {
  const { kit, db } = await world(t);
  const role = 'synthetic_tokens_' + randomBytes(4).toString('hex'), password = randomBytes(20).toString('hex');
  await db.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
  await db.query('REVOKE TEMPORARY ON DATABASE "' + kit.database.database + '" FROM PUBLIC');
  await grantRuntime(db, role);
  const runtime = new Database(createPool({ ...kit.database, user: role, password }));
  t.after(() => runtime.end());
  const principals = new PgPrincipals(runtime, () => new Date());
  const admin = asPrincipal((await principals.bootstrapAdmin('合成管理员')).user);
  const member = await principals.createUser(admin, '合成成员');
  const client = await principals.registerClient('合成客户端', LOOPBACK);
  const invitation = await principals.invite(admin, member.id);
  assert.ok(await principals.takeInvitation(invitation.id, client.id));
  const token = await principals.issueToken(asPrincipal(member), member.id, client.name, client.id);
  assert.equal(await principals.revokeToken(admin, token.id), true);
  assert.deepEqual((await records(kit)).map((row) => row.action), ['issue', 'issue', 'use', 'issue', 'revoke']);
});
