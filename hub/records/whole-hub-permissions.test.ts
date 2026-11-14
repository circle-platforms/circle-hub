import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { artifactShareKey, withRequestPermissions } from './api.ts';

test('whole-Hub workflow grants reach fresh and request snapshots without restoring expired or revoked grants', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const member = await kit.principals.createUser(admin, 'synthetic-member');
    const pack = 'synthetic-global-workflow';
    const input = { permission: 'assign' as const, subject: '*', object: pack };
    await kit.authorizations.grant(admin, input);
    assert.equal(await kit.authorizations.canUse(member.id, pack), true);
    assert.deepEqual(await kit.authorizations.packsFor(member.id), [pack]);
    assert.ok(kit.authorizations.packsForMany, 'the production multi-account snapshot port is required');
    assert.deepEqual((await kit.authorizations.packsForMany([member.id])).get(member.id), [pack]);
    assert.ok(kit.artifacts.capturePermissionSnapshot, 'the production permission snapshot port is required');
    const snapshot = await kit.artifacts.capturePermissionSnapshot(member);
    assert.equal(snapshot.canUse(pack), true);
    await withRequestPermissions(kit.artifacts, member, async () => {
      assert.equal(await kit.authorizations.canUse(member.id, pack), true);
    });
    await kit.authorizations.grant(admin, { ...input, expiresAt: '2000-01-01T00:00:00.000Z' });
    assert.equal(await kit.authorizations.canUse(member.id, pack), false);
    await kit.authorizations.grant(admin, input);
    await kit.authorizations.revoke(admin, input);
    assert.equal(await kit.authorizations.canUse(member.id, pack), false);
    await kit.authorizations.grant(admin, input);
    await kit.principals.setDisabled(admin, member.id, true);
    assert.deepEqual(await kit.authorizations.packsFor(member.id), []);
  } finally { await kit.close(); }
});

test('whole-Hub workflow membership supplies the exact pack audience and revocation removes it', async () => {
  const kit = await openTestRecords();
  try {
    const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
    const owner = await kit.principals.createUser(admin, 'synthetic-owner');
    const member = await kit.principals.createUser(admin, 'synthetic-member');
    const pack = 'synthetic-global-workflow';
    const artifact = await kit.artifacts.ingest({ bytes: Buffer.from('synthetic shared source'), mediaType: 'text/plain', origin: { upload: { session: 'synthetic' } }, author: { user: owner.id }, provenanceType: 'declared', visibility: { readers: [owner.id], admins: true, packs: [], shareable: true } });
    await kit.authorizations.share(admin, artifactShareKey(artifact), { kind: 'pack_users', pack });
    const input = { permission: 'assign' as const, subject: '*', object: pack };
    await kit.authorizations.grant(admin, input);
    assert.ok((await kit.artifacts.source(member, artifact.body.sha256, { consumer: 'model' }))?.bytes);
    await kit.authorizations.revoke(admin, input);
    assert.equal(await kit.artifacts.source(member, artifact.body.sha256, { consumer: 'model' }), null);
  } finally { await kit.close(); }
});
