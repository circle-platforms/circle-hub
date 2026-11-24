import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MemberExternalIdentityAudit } from '../../contracts/src/resources.ts';
import { DEFAULT_LIMITS } from '../config/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { AccessError, FileKeyProvider, VaultError, sha256Hex } from './api.ts';
import { openRecords } from './index.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

async function setup(t: { after(fn: () => unknown): void }, prefix: string) {
  const dbName = `${prefix}_${randomBytes(4).toString('hex')}`;
  const database = await postgres.createDatabase(dbName);
  const dataDir = await mkdtemp(join(tmpdir(), `circle-hub-${prefix}-`));
  const keyProvider = new FileKeyProvider(join(dataDir, 'test-vault.key'));
  await keyProvider.initKey();
  const kit = await openRecords({ database, dataDir, logDir: join(dataDir, 'logs'), limits: { ...DEFAULT_LIMITS } }, { keyProvider });
  t.after(async () => {
    await kit.close();
    await rm(dataDir, { recursive: true, force: true });
    await postgres.dropDatabase(dbName);
  });
  const { user: adminUser } = await kit.principals.bootstrapAdmin('身份管理员');
  const admin = { id: adminUser.id, name: adminUser.name, role: adminUser.role };
  return { kit, admin, dataDir, keyProvider };
}

async function identityAuditRecords(kit: Awaited<ReturnType<typeof openRecords>>, memberId?: string) {
  const page = memberId
    ? await kit.store.find({ kind: 'action', key: 'member.external_identity.member', value: memberId, limit: 50 })
    : await kit.store.list({ kind: 'action', limit: 50 });
  return page.items
    .filter((item) => item.schema === 'member-external-identity@1')
    .map((item) => MemberExternalIdentityAudit.parse(item.body));
}

test('H1: bindExternalIdentity records member-external-identity@1 with hashed issuer/subject and unbindExternalIdentity frees identity for rebind', async (t) => {
  const { kit, admin } = await setup(t, 'h1_manual');
  const alice = await kit.principals.createUser(admin, '外部绑定甲');
  const bob = await kit.principals.createUser(admin, '外部绑定乙');
  const issuer = 'https://work.example.invalid/tenant-a';
  const subject = 'raw-ext-subject-alpha';

  await kit.principals.bindExternalIdentity({ id: alice.id, name: alice.name, role: alice.role }, issuer, subject);
  assert.deepEqual(await kit.principals.externalIdentities(alice.id), [issuer]);

  // Non-admin cannot unbind another member.
  await assert.rejects(
    kit.principals.unbindExternalIdentity({ id: bob.id, name: bob.name, role: bob.role }, alice.id),
    AccessError,
  );

  // Admin unbinds alice manually -> row removed, audit appended with sha256 digests, bob can bind immediately.
  const removed = await kit.principals.unbindExternalIdentity(admin, alice.id, issuer);
  assert.equal(removed, 1);
  assert.equal(await kit.principals.externalMember(issuer, subject), null);
  assert.deepEqual(await kit.principals.externalIdentities(alice.id), []);

  await kit.principals.bindExternalIdentity({ id: bob.id, name: bob.name, role: bob.role }, issuer, subject);
  assert.equal((await kit.principals.externalMember(issuer, subject))?.id, bob.id);

  const audits = await identityAuditRecords(kit, alice.id);
  assert.equal(audits.length, 2);
  assert.equal(audits[0].action, 'bind');
  assert.notEqual(audits[0].issuer, sha256Hex(issuer));
  assert.notEqual(audits[0].subject, sha256Hex(subject));
  assert.match(audits[0].issuer, /^[0-9a-f]{64}$/);
  assert.match(audits[0].subject, /^[0-9a-f]{64}$/);
  assert.equal(audits[0].reason, undefined);
  assert.equal(audits[1].action, 'unbind');
  assert.equal(audits[1].issuer, audits[0].issuer);
  assert.equal(audits[1].subject, audits[0].subject);
  assert.equal(audits[1].reason, 'manual');
  assert.equal(audits[1].by, admin.id);
  const bobAudits = await identityAuditRecords(kit, bob.id);
  assert.equal(bobAudits.length, 1);
  assert.equal(bobAudits[0].issuer, audits[0].issuer);
  assert.equal(bobAudits[0].subject, audits[0].subject);
  assert.ok(!JSON.stringify(audits).includes(subject));
  assert.ok(!JSON.stringify(audits).includes(issuer));
});

test('H1: setDisabled(true) deletes external_member_identities, records disabled audit, frees identity, and re-enabling does not restore binding', async (t) => {
  const { kit, admin } = await setup(t, 'h1_disable');
  const alice = await kit.principals.createUser(admin, '停用解绑甲');
  const charlie = await kit.principals.createUser(admin, '接替成员丙');
  const issuer = 'https://work.example.invalid/tenant-b';
  const subject = 'raw-ext-subject-bravo';

  await kit.principals.bindExternalIdentity({ id: alice.id, name: alice.name, role: alice.role }, issuer, subject);
  await kit.principals.setDisabled(admin, alice.id, true);

  assert.equal(await kit.principals.externalMember(issuer, subject), null);
  assert.deepEqual(await kit.principals.externalIdentities(alice.id), []);

  // Re-enabling alice must NOT bring back the old external binding.
  await kit.principals.setDisabled(admin, alice.id, false);
  assert.equal(await kit.principals.externalMember(issuer, subject), null);

  // Another active member can bind the same external identity immediately.
  await kit.principals.bindExternalIdentity({ id: charlie.id, name: charlie.name, role: charlie.role }, issuer, subject);
  assert.equal((await kit.principals.externalMember(issuer, subject))?.id, charlie.id);

  const audits = await identityAuditRecords(kit, alice.id);
  assert.deepEqual(
    audits.map((a) => [a.action, a.reason]),
    [
      ['bind', undefined],
      ['unbind', 'disabled'],
    ],
  );
});

test('H1: member deletion finish() deletes external_member_identities, records deleted audit, and allows a same-name replacement account to bind immediately', async (t) => {
  const { kit, admin } = await setup(t, 'h1_delete');
  const original = await kit.principals.createUser(admin, '同名重绑成员');
  const issuer = 'https://work.example.invalid/tenant-c';
  const subject = 'raw-ext-subject-charlie';

  await kit.principals.bindExternalIdentity(
    { id: original.id, name: original.name, role: original.role },
    issuer,
    subject,
  );

  const preview = await kit.memberDeletions!.preview(admin, original.id);
  const { randomUUID } = await import('node:crypto');
  const intent = await kit.memberDeletions!.prepare(admin, { ...preview, operation_id: randomUUID() });
  await kit.memberDeletions!.finish(admin, original.id, intent.operation_id);

  assert.equal(await kit.principals.externalMember(issuer, subject), null);
  assert.deepEqual(await kit.principals.externalIdentities(original.id), []);

  // Newly created account reusing the exact same username can bind immediately.
  const replacement = await kit.principals.createUser(admin, '同名重绑成员');
  assert.notEqual(replacement.id, original.id);
  await kit.principals.bindExternalIdentity(
    { id: replacement.id, name: replacement.name, role: replacement.role },
    issuer,
    subject,
  );
  assert.equal((await kit.principals.externalMember(issuer, subject))?.id, replacement.id);

  const audits = await identityAuditRecords(kit, original.id);
  assert.deepEqual(
    audits.map((a) => [a.action, a.reason]),
    [
      ['bind', undefined],
      ['unbind', 'deleted'],
    ],
  );
  const originalBind = audits.find((a) => a.action === 'bind')!;
  const originalUnbind = audits.find((a) => a.action === 'unbind')!;
  assert.notEqual(originalBind.issuer, sha256Hex(issuer));
  assert.notEqual(originalBind.subject, sha256Hex(subject));
  assert.equal(originalUnbind.issuer, originalBind.issuer);
  assert.equal(originalUnbind.subject, originalBind.subject);
});

test('S8: external-identity audit HMAC key derives from keyProvider across reopens without creating keys/', async (t) => {
  const dbName = `s8_keyed_${randomBytes(4).toString('hex')}`;
  const database = await postgres.createDatabase(dbName);
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-s8-'));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
    await postgres.dropDatabase(dbName);
  });

  const issuer = 'https://work.example.invalid/tenant-s8';
  const subject = 'raw-ext-subject-s8';
  const keyProvider = new FileKeyProvider(join(dataDir, 'test-vault.key'));
  await keyProvider.initKey();
  const masterKey = await keyProvider.getKey();
  const expectedKey = createHmac('sha256', masterKey).update('circle-hub:external-identity-audit:v1').digest();

  const kit1 = await openRecords({ database, dataDir, logDir: join(dataDir, 'logs'), limits: { ...DEFAULT_LIMITS } }, { keyProvider });
  const { user: adminUser } = await kit1.principals.bootstrapAdmin('密钥审计管理员');
  const admin = { id: adminUser.id, name: adminUser.name, role: adminUser.role };
  const member = await kit1.principals.createUser(admin, '密钥审计成员');
  await kit1.principals.bindExternalIdentity({ id: member.id, name: member.name, role: member.role }, issuer, subject);
  await kit1.close();

  await assert.rejects(stat(join(dataDir, 'keys')), { code: 'ENOENT' });

  const kit2 = await openRecords({ database, dataDir, logDir: join(dataDir, 'logs'), limits: { ...DEFAULT_LIMITS } }, { keyProvider, migrate: false });
  await kit2.principals.unbindExternalIdentity(admin, member.id, issuer);
  const persistedAudits = await identityAuditRecords(kit2, member.id);
  await kit2.close();
  assert.equal(persistedAudits.length, 2);
  assert.equal(persistedAudits[0].issuer, createHmac('sha256', expectedKey).update(issuer).digest('hex'));
  assert.equal(persistedAudits[0].subject, createHmac('sha256', expectedKey).update(subject).digest('hex'));
  assert.equal(persistedAudits[1].issuer, persistedAudits[0].issuer);
  assert.equal(persistedAudits[1].subject, persistedAudits[0].subject);
  assert.notEqual(persistedAudits[0].issuer, sha256Hex(issuer));
  await assert.rejects(stat(join(dataDir, 'keys')), { code: 'ENOENT' });
});

test('F4: absent or failing keyProvider rejects external-identity audit writes with VaultError and never creates keys/', async (t) => {
  const dbName = `f4_nokey_${randomBytes(4).toString('hex')}`;
  const database = await postgres.createDatabase(dbName);
  const setupDir = await mkdtemp(join(tmpdir(), 'circle-hub-f4-setup-'));
  const absentDir = await mkdtemp(join(tmpdir(), 'circle-hub-f4-absent-'));
  const failingDir = await mkdtemp(join(tmpdir(), 'circle-hub-f4-fail-'));
  t.after(async () => {
    await rm(setupDir, { recursive: true, force: true });
    await rm(absentDir, { recursive: true, force: true });
    await rm(failingDir, { recursive: true, force: true });
    await postgres.dropDatabase(dbName);
  });

  const setupKey = new FileKeyProvider(join(setupDir, 'test-vault.key'));
  await setupKey.initKey();
  const kitSetup = await openRecords({ database, dataDir: setupDir, logDir: join(setupDir, 'logs'), limits: { ...DEFAULT_LIMITS } }, { keyProvider: setupKey });
  const { user: adminUser } = await kitSetup.principals.bootstrapAdmin('无密钥审计管理员');
  const admin = { id: adminUser.id, name: adminUser.name, role: adminUser.role };
  const alice = await kitSetup.principals.createUser(admin, '绑定待解甲');
  const bob = await kitSetup.principals.createUser(admin, '绑定待停乙');
  const carol = await kitSetup.principals.createUser(admin, '绑定待删丙');
  const dave = await kitSetup.principals.createUser(admin, '未绑待绑丁');
  const plain = await kitSetup.principals.createUser(admin, '无外绑成员戊');
  const issuer = 'https://work.example.invalid/tenant-f4';
  await kitSetup.principals.bindExternalIdentity({ id: alice.id, name: alice.name, role: alice.role }, issuer, 'sub-alice');
  await kitSetup.principals.bindExternalIdentity({ id: bob.id, name: bob.name, role: bob.role }, issuer, 'sub-bob');
  await kitSetup.principals.bindExternalIdentity({ id: carol.id, name: carol.name, role: carol.role }, issuer, 'sub-carol');
  const carolPreview = await kitSetup.memberDeletions!.preview(admin, carol.id);
  const carolIntent = await kitSetup.memberDeletions!.prepare(admin, { ...carolPreview, operation_id: randomUUID() });
  await kitSetup.close();

  const isUnavailableVaultError = (error: unknown) =>
    error instanceof VaultError && /密钥库主密钥不可用/.test(error.message);

  // 1. No keyProvider: startup and unrelated operations work lazily; all external-identity audit writes fail cleanly.
  const kitAbsent = await openRecords({ database, dataDir: absentDir, logDir: join(absentDir, 'logs'), limits: { ...DEFAULT_LIMITS } }, { migrate: false });
  t.after(() => kitAbsent.close());
  await kitAbsent.principals.setDisabled(admin, plain.id, true);
  assert.equal((await kitAbsent.principals.get(plain.id))?.disabled, true);
  await assert.rejects(
    kitAbsent.principals.bindExternalIdentity({ id: dave.id, name: dave.name, role: dave.role }, issuer, 'sub-dave'),
    isUnavailableVaultError,
  );
  assert.equal(await kitAbsent.principals.externalMember(issuer, 'sub-dave'), null);
  await assert.rejects(kitAbsent.principals.unbindExternalIdentity(admin, alice.id, issuer), isUnavailableVaultError);
  assert.equal((await kitAbsent.principals.externalMember(issuer, 'sub-alice'))?.id, alice.id);
  await assert.rejects(kitAbsent.principals.setDisabled(admin, bob.id, true), isUnavailableVaultError);
  assert.equal((await kitAbsent.principals.get(bob.id))?.disabled, false);
  assert.equal((await kitAbsent.principals.externalMember(issuer, 'sub-bob'))?.id, bob.id);
  await assert.rejects(kitAbsent.memberDeletions!.finish(admin, carol.id, carolIntent.operation_id), isUnavailableVaultError);
  assert.deepEqual(await kitAbsent.principals.externalIdentities(carol.id), [issuer]);
  assert.equal((await kitAbsent.memberDeletions!.status(admin, carol.id))?.result, null);
  await assert.rejects(stat(join(absentDir, 'keys')), { code: 'ENOENT' });

  // 2. Failing keyProvider.getKey(): all four paths fail with VaultError, never create keys/, and recover once key exists.
  const uninitProvider = new FileKeyProvider(join(failingDir, 'missing-vault.key'));
  const kitFailing = await openRecords(
    { database, dataDir: failingDir, logDir: join(failingDir, 'logs'), limits: { ...DEFAULT_LIMITS } },
    { keyProvider: uninitProvider, migrate: false },
  );
  t.after(() => kitFailing.close());
  await assert.rejects(
    kitFailing.principals.bindExternalIdentity({ id: dave.id, name: dave.name, role: dave.role }, issuer, 'sub-dave'),
    isUnavailableVaultError,
  );
  await assert.rejects(kitFailing.principals.unbindExternalIdentity(admin, alice.id, issuer), isUnavailableVaultError);
  await assert.rejects(kitFailing.principals.setDisabled(admin, bob.id, true), isUnavailableVaultError);
  await assert.rejects(kitFailing.memberDeletions!.finish(admin, carol.id, carolIntent.operation_id), isUnavailableVaultError);
  assert.deepEqual(await kitFailing.principals.externalIdentities(carol.id), [issuer]);
  await assert.rejects(stat(join(failingDir, 'keys')), { code: 'ENOENT' });

  await uninitProvider.initKey();
  await kitFailing.principals.bindExternalIdentity({ id: dave.id, name: dave.name, role: dave.role }, issuer, 'sub-dave');
  assert.equal((await kitFailing.principals.externalMember(issuer, 'sub-dave'))?.id, dave.id);
  assert.equal(await kitFailing.principals.unbindExternalIdentity(admin, alice.id, issuer), 1);
  await kitFailing.principals.setDisabled(admin, bob.id, true);
  await kitFailing.memberDeletions!.finish(admin, carol.id, carolIntent.operation_id);
  assert.deepEqual(await kitFailing.principals.externalIdentities(carol.id), []);
  assert.ok((await kitFailing.memberDeletions!.status(admin, carol.id))?.result);
  await assert.rejects(stat(join(failingDir, 'keys')), { code: 'ENOENT' });
});
