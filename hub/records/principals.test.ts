import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { TestRecordsKit } from '../testing/records.ts';
import type { Principal } from './api.ts';
import { sha256Hex } from './digest.ts';
import { AccessError, ConflictError } from './errors.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

async function rows(kit: TestRecordsKit, text: string): Promise<Record<string, unknown>[]> {
  const client = new pg.Client({ ...kit.database, ssl: false });
  await client.connect();
  try {
    return (await client.query(text)).rows;
  } finally {
    await client.end();
  }
}

const asPrincipal = (user: { id: string; name: string; role: 'user' | 'admin' }): Principal => ({ id: user.id, name: user.name, role: user.role });

test('the first admin is bootstrapped exactly once, also under concurrent attempts', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const results = await Promise.allSettled([kit.principals.bootstrapAdmin('甲'), kit.principals.bootstrapAdmin('乙'), kit.principals.bootstrapAdmin('丙')]);
  const won = results.filter((result) => result.status === 'fulfilled');
  assert.equal(won.length, 1);
  for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof ConflictError);
  const { user, token } = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof kit.principals.bootstrapAdmin>>>).value;
  assert.equal(user.role, 'admin');
  assert.match(user.id, /^usr_[0-9a-z]{26}$/);
  assert.match(token.id, /^tok_[0-9a-z]{26}$/);
  assert.match(token.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await kit.principals.authenticate(`Bearer ${token.token}`), { id: user.id, name: user.name, role: 'admin' });
  await assert.rejects(kit.principals.bootstrapAdmin('丁'), ConflictError);
  assert.equal((await kit.principals.list()).length, 1);
});

test('token lifecycle: shown once, only its SHA-256 stored, last use recorded, revocation ends it', async (t) => {
  let clock = Date.parse('2026-10-21T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(clock) });
  t.after(() => kit.close());
  const { user: adminUser } = await kit.principals.bootstrapAdmin('管理员');
  const admin = asPrincipal(adminUser);
  const member = await kit.principals.createUser(admin, '成员');
  const issued = await kit.principals.issueToken(admin, member.id, 'Circle 笔记本');
  assert.equal(issued.user, member.id);
  const stored = await rows(kit, 'SELECT * FROM tokens');
  assert.equal(JSON.stringify(stored).includes(issued.token), false);
  assert.equal(stored.some((row) => row.sha256 === sha256Hex(issued.token)), true);
  const listed = await kit.principals.tokens(member.id);
  assert.deepEqual(listed.map((info) => [info.id, info.label, info.last_used_at, info.revoked_at, info.created_by]), [[issued.id, 'Circle 笔记本', null, null, adminUser.id]]);
  assert.equal(JSON.stringify(listed).includes(issued.token), false);

  assert.deepEqual(await kit.principals.authenticate(`Bearer ${issued.token}`), { id: member.id, name: '成员', role: 'user' });
  assert.equal((await kit.principals.tokens(member.id))[0].last_used_at, '2026-10-21T08:00:00.000Z');
  clock += 30_000;
  await kit.principals.authenticate(`bearer ${issued.token} `);
  assert.equal((await kit.principals.tokens(member.id))[0].last_used_at, '2026-10-21T08:00:00.000Z');
  clock += 31_000;
  await kit.principals.authenticate(`Bearer ${issued.token}`);
  assert.equal((await kit.principals.tokens(member.id))[0].last_used_at, '2026-10-21T08:01:01.000Z');

  for (const header of [undefined, null, '', 'Bearer', `Basic ${issued.token}`, issued.token, `Bearer ${issued.token}x`, `Bearer ${issued.token.slice(1)}`, `Bearer  ${'A'.repeat(43)}`, `Bearer ${issued.token}\nX: y`]) {
    assert.equal(await kit.principals.authenticate(header), null, String(header));
  }
  assert.equal(await kit.principals.revokeToken(asPrincipal(member), issued.id), true);
  assert.equal(await kit.principals.authenticate(`Bearer ${issued.token}`), null);
  assert.equal(await kit.principals.revokeToken(admin, issued.id), false);
  assert.ok((await kit.principals.tokens(member.id))[0].revoked_at);
});

test('a disabled user cannot authenticate or act; re-enabling restores the same tokens', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { user: adminUser } = await kit.principals.bootstrapAdmin('管理员');
  const admin = asPrincipal(adminUser);
  const member = await kit.principals.createUser(admin, '成员');
  const { token } = await kit.principals.issueToken(admin, member.id);
  await kit.principals.setDisabled(admin, member.id, true);
  assert.equal(await kit.principals.authenticate(`Bearer ${token}`), null);
  await assert.rejects(kit.principals.issueToken(asPrincipal(member), member.id), AccessError);
  await assert.rejects(kit.principals.issueToken(admin, member.id), ConflictError);
  await kit.principals.setDisabled(admin, member.id, false);
  assert.equal((await kit.principals.authenticate(`Bearer ${token}`))?.id, member.id);
});

test('role changes are recorded, only admins manage users, and the last active admin stays', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { user: adminUser } = await kit.principals.bootstrapAdmin('管理员');
  const admin = asPrincipal(adminUser);
  const member = await kit.principals.createUser(admin, '成员');
  const memberPrincipal = asPrincipal(member);
  await assert.rejects(kit.principals.createUser(memberPrincipal, '冒名'), AccessError);
  await assert.rejects(kit.principals.setRole(memberPrincipal, member.id, 'admin'), AccessError);
  await assert.rejects(kit.principals.issueToken(memberPrincipal, adminUser.id), AccessError);
  await assert.rejects(kit.principals.setRole(admin, adminUser.id, 'user'), ConflictError);
  await assert.rejects(kit.principals.setDisabled(admin, adminUser.id, true), ConflictError);
  const promoted = await kit.principals.setRole(admin, member.id, 'admin');
  assert.equal(promoted.role, 'admin');
  assert.equal((await kit.principals.authenticate(`Bearer ${(await kit.principals.issueToken(admin, member.id)).token}`))?.role, 'admin');
  // With a second admin, the first may step down.
  const stepped = await kit.principals.setRole(asPrincipal(promoted), adminUser.id, 'user');
  assert.equal(stepped.role, 'user');
  assert.deepEqual(
    (await kit.principals.history(member.id)).map((change) => [change.role, change.disabled, change.changed_by]),
    [['user', false, adminUser.id], ['admin', false, adminUser.id]],
  );
  assert.deepEqual(
    (await kit.principals.history(adminUser.id)).map((change) => [change.role, change.changed_by]),
    [['admin', null], ['user', member.id]],
  );
  // The demoted account's own Principal no longer carries admin power: its current role decides.
  await assert.rejects(kit.principals.createUser(admin, '再来一个'), AccessError);
  // Unchanged values write no history.
  await kit.principals.setRole(asPrincipal(promoted), member.id, 'admin');
  assert.equal((await kit.principals.history(member.id)).length, 2);
  // A user issues and revokes their own tokens, and cannot see or revoke anyone else's.
  const own = await kit.principals.issueToken(asPrincipal(stepped), adminUser.id, '自己');
  const others = await kit.principals.issueToken(asPrincipal(promoted), member.id);
  assert.equal(await kit.principals.revokeToken(asPrincipal(stepped), others.id), false);
  assert.equal((await kit.principals.authenticate(`Bearer ${others.token}`))?.id, member.id);
  assert.equal(await kit.principals.revokeToken(asPrincipal(stepped), own.id), true);
});

test('names are validated and unique; lookups never throw on bad input', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const { user: adminUser } = await kit.principals.bootstrapAdmin('管理员');
  const admin = asPrincipal(adminUser);
  await assert.rejects(kit.principals.createUser(admin, '管理员'), ConflictError);
  for (const name of ['', ' lead', 'trail ', `tab${String.fromCharCode(9)}x`, 'x'.repeat(101)]) await assert.rejects(kit.principals.createUser(admin, name), TypeError, JSON.stringify(name));
  await assert.rejects(kit.principals.createUser(admin, 'ok', 'owner' as never), TypeError);
  assert.equal(await kit.principals.get('usr_nope'), null);
  assert.equal(await kit.principals.findByName('nobody'), null);
  assert.equal((await kit.principals.findByName('管理员'))?.id, adminUser.id);
  assert.deepEqual(await kit.principals.history('bad'), []);
  assert.deepEqual(await kit.principals.tokens('bad'), []);
  assert.equal(await kit.principals.revokeToken(admin, 'tok_bad'), false);
  await assert.rejects(kit.principals.createUser({ id: 'usr_00000000000000000000000000', name: 'ghost', role: 'admin' }, 'x'), AccessError);
});
