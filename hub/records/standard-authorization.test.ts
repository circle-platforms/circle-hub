// The stores of the MCP standard authorization (decision 125, migration 7): invitation codes kept as their SHA-256, valid a
// day and used once; registered clients with a bounded registration rate; tokens that name the client they went to; and
// revocation by a token's value (RFC 7009).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import type { TestRecordsKit } from '../testing/records.ts';
import { INVITATION_TTL_MS, normalizeInvitation, type Principal } from './api.ts';
import { sha256Hex } from './digest.ts';
import { AccessError, ConflictError, LimitError } from './errors.ts';

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
const LOOPBACK = ['http://127.0.0.1:43123/callback'];

test('an invitation is issued by an administrator, shown once, kept as its SHA-256 and used once', async (t) => {
  let clock = Date.parse('2026-11-01T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(clock) });
  t.after(() => kit.close());
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('管理员')).user);
  const member = await kit.principals.createUser(admin, '成员');
  await assert.rejects(kit.principals.invite(asPrincipal(member), member.id), AccessError, 'members cannot invite');
  const issued = await kit.principals.invite(admin, member.id);
  assert.match(issued.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(issued.user, member.id);
  assert.equal(issued.created_by, admin.id);
  assert.equal(Date.parse(issued.expires_at) - Date.parse(issued.created_at), INVITATION_TTL_MS);
  const stored = await rows(kit, 'SELECT * FROM invitations');
  assert.equal(JSON.stringify(stored).includes(issued.code), false);
  assert.equal(JSON.stringify(stored).includes(normalizeInvitation(issued.code)), false);
  assert.equal(stored[0].sha256, sha256Hex(normalizeInvitation(issued.code)));

  // Typed in lower case, with spaces instead of dashes, it is the same code.
  const typed = issued.code.toLowerCase().replaceAll('-', ' ');
  const checked = await kit.principals.checkInvitation(typed);
  assert.ok(checked.ok);
  assert.equal(checked.user.id, member.id);
  assert.equal(checked.invitation, issued.id);
  assert.deepEqual(await kit.principals.checkInvitation('AAAA-BBBB-CCCC'), { ok: false, reason: 'absent' });
  assert.deepEqual(await kit.principals.checkInvitation('x'.repeat(65)), { ok: false, reason: 'absent' });

  const client = await kit.principals.registerClient('MacBook 上的 Circle', LOOPBACK);
  // Two authorizations racing for one invitation: exactly one gets it.
  const taken = await Promise.all([kit.principals.takeInvitation(issued.id, client.id), kit.principals.takeInvitation(issued.id, client.id)]);
  assert.equal(taken.filter((user) => user?.id === member.id).length, 1);
  assert.equal(taken.filter((user) => user === null).length, 1);
  assert.deepEqual(await kit.principals.checkInvitation(issued.code), { ok: false, reason: 'used' });
  const [listed] = await kit.principals.invitations(member.id);
  assert.equal(listed.used_by_client, client.id);
  assert.equal(listed.used_at, new Date(clock).toISOString());
  assert.ok(!('code' in listed), 'a listed invitation has no code');
  assert.equal(await kit.principals.takeInvitation('inv_x', client.id), null);
  assert.equal(await kit.principals.takeInvitation(issued.id, 'cli_x'), null);
});

test('an expired invitation, or one whose account was disabled, cannot be used', async (t) => {
  let clock = Date.parse('2026-11-01T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(clock) });
  t.after(() => kit.close());
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('管理员')).user);
  const member = await kit.principals.createUser(admin, '成员');
  const client = await kit.principals.registerClient('Circle', LOOPBACK);
  const late = await kit.principals.invite(admin, member.id);
  clock += INVITATION_TTL_MS;
  assert.deepEqual(await kit.principals.checkInvitation(late.code), { ok: false, reason: 'expired' });
  assert.equal(await kit.principals.takeInvitation(late.id, client.id), null);

  const fresh = await kit.principals.invite(admin, member.id);
  await kit.principals.setDisabled(admin, member.id, true);
  assert.deepEqual(await kit.principals.checkInvitation(fresh.code), { ok: false, reason: 'disabled' });
  assert.equal(await kit.principals.takeInvitation(fresh.id, client.id), null);
  const [kept] = await kit.principals.invitations(member.id);
  assert.equal(kept.id, fresh.id);
  assert.equal(kept.used_at, null, 'refusing a disabled account leaves the invitation unused');
  await assert.rejects(kit.principals.invite(admin, member.id), ConflictError, 'a disabled account is not invited');
});

test('clients register with a bounded rate, and a token names the client it was issued to', async (t) => {
  let clock = Date.parse('2026-11-01T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(clock) });
  t.after(() => kit.close());
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('管理员')).user);
  const member = await kit.principals.createUser(admin, '成员');
  await assert.rejects(kit.principals.registerClient(' ', LOOPBACK), TypeError);
  await assert.rejects(kit.principals.registerClient('Circle', []), TypeError);
  await assert.rejects(kit.principals.registerClient('Circle', [`http://127.0.0.1/${'x'.repeat(2000)}`]), TypeError);
  const first = await kit.principals.registerClient('Circle', LOOPBACK);
  assert.match(first.id, /^cli_[0-9a-z]{26}$/);
  assert.deepEqual(await kit.principals.client(first.id), first);
  assert.equal(await kit.principals.client('cli_missing'), null);
  for (let i = 1; i < 100; i++) await kit.principals.registerClient(`Circle ${i}`, LOOPBACK);
  await assert.rejects(kit.principals.registerClient('one too many', LOOPBACK), LimitError);
  clock += 10 * 60 * 1000 + 1;
  await kit.principals.registerClient('after the window', LOOPBACK);

  const issued = await kit.principals.issueToken(asPrincipal(member), member.id, first.name, first.id);
  const [listed] = await kit.principals.tokens(member.id);
  assert.equal(listed.id, issued.id);
  assert.equal(listed.client, first.id);
  assert.equal(listed.label, 'Circle');
  const direct = await kit.principals.issueToken(admin, member.id, 'manual');
  assert.equal((await kit.principals.tokens(member.id)).find((token) => token.id === direct.id)?.client, null);
  await assert.rejects(kit.principals.issueToken(admin, member.id, 'x', 'cli_bad'), TypeError);
  await assert.rejects(kit.principals.issueToken(admin, member.id, 'x', `cli_${'0'.repeat(26)}`), ConflictError);
});

test('a client that led to no token within a day is removed at a later registration; a used one stays', async (t) => {
  let clock = Date.parse('2026-11-01T08:00:00.000Z');
  const kit = await openTestRecords({ postgres, now: () => new Date(clock) });
  t.after(() => kit.close());
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('管理员')).user);
  const member = await kit.principals.createUser(admin, '成员');
  const unused = await kit.principals.registerClient('unused', LOOPBACK);
  const tokened = await kit.principals.registerClient('tokened', LOOPBACK);
  const invited = await kit.principals.registerClient('invited', LOOPBACK);
  await kit.principals.issueToken(asPrincipal(member), member.id, 'x', tokened.id);
  const invitation = await kit.principals.invite(admin, member.id);
  await kit.principals.takeInvitation(invitation.id, invited.id);
  clock += 24 * 60 * 60 * 1000 + 1;
  await kit.principals.registerClient('later', LOOPBACK);
  assert.equal(await kit.principals.client(unused.id), null);
  assert.notEqual(await kit.principals.client(tokened.id), null);
  assert.notEqual(await kit.principals.client(invited.id), null);
});

test('a token label is a hundred characters counted as code points', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('管理员')).user);
  const label = '\u{1F600}'.repeat(100);
  assert.equal((await kit.principals.issueToken(admin, admin.id, label)).label, label);
  await assert.rejects(kit.principals.issueToken(admin, admin.id, `${label}x`), TypeError);
});

test('whoever holds a token may revoke it by its value; it then stops authenticating', async (t) => {
  const kit = await openTestRecords({ postgres });
  t.after(() => kit.close());
  const admin = asPrincipal((await kit.principals.bootstrapAdmin('管理员')).user);
  const member = await kit.principals.createUser(admin, '成员');
  const issued = await kit.principals.issueToken(admin, member.id, 'Circle');
  assert.equal(await kit.principals.revokeTokenValue('not a token'), false);
  assert.equal(await kit.principals.revokeTokenValue(issued.token), true);
  assert.equal(await kit.principals.revokeTokenValue(issued.token), false, 'already revoked');
  assert.equal(await kit.principals.authenticate(`Bearer ${issued.token}`), null);
  const [row] = await rows(kit, `SELECT revoked_by FROM tokens WHERE id = '${issued.id}'`);
  assert.equal(row.revoked_by, member.id, 'revoked by the account the token belongs to');
});
