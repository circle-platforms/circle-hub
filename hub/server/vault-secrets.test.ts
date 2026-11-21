import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { cp, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { FileVault } from '../records/vault.ts';
import { RecordVariables, type VariablePorts } from '../records/variables.ts';
import { namedSecretCommand, type VariableCommandSession } from './variables.ts';
import type { RecordsKit, Principal } from '../records/api.ts';

let pg: TemporaryPostgres;
before(async () => { pg = await startPostgres(); });
after(() => pg?.stop());
function session(kit: RecordsKit, by: Principal, value: string, lines: string[]): VariableCommandSession {
    return { ctx: { io: { cwd: '.' } }, options: { readSecret: async () => value }, records: async () => kit, admin: async () => by,
        hub: async () => ({ registry: { variableDeclarations: async () => [] }, packs: { pack: async () => null } as any }),
        out: line => { lines.push(line); }, err: line => { lines.push(line); } };
}

test('secret set before any deployment definition writes vault metadata and a value-free audit only', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
    const value = randomBytes(24).toString('base64url'), lines: string[] = [];
    const s = session(kit, admin, value, lines);
    assert.equal(await namedSecretCommand(s, ['set', '--name', 'DEMO_KEY', '--reason', '合成先设置']), 0);
    const material = (await kit.variables.readSecrets([{ name: 'DEMO_KEY' }]))[0];
    assert.ok(material.value === value);
    assert.equal(material.version, 1);
    assert.equal(material.metadata.set_by, admin.id);
    assert.ok(!('consumers' in material.metadata));
    assert.ok(!('decision' in material));
    const audit = await kit.authorizations.resourceConfig('secret:DEMO_KEY');
    assert.ok(audit?.body.bound);
    const bytes = await kit.objects.get(audit!.body.bound!);
    const object = JSON.parse(Buffer.from(bytes!).toString());
    assert.deepEqual(Object.keys(object).sort(), ['at', 'by', 'name']);
    assert.equal(object.by, admin.id);
    assert.equal(object.name, 'DEMO_KEY');
    await namedSecretCommand(s, ['list']);
    await namedSecretCommand(s, ['show', '--name', 'DEMO_KEY', '--history']);
    const digest = createHash('sha512').update(value).digest('base64');
    const surfaces = [lines.join('\n'), JSON.stringify(audit), Buffer.from(bytes!).toString()];
    assert.ok(surfaces.every(surface => !surface.includes(value) && !surface.includes(digest)));
    assert.ok(!lines.some(line => line.includes('使用者')));
});

test('new-format vault and key copied unchanged to a genuinely fresh database need no recognition or reentry', async t => {
    const source = await openTestRecords({ postgres: pg }), target = await openTestRecords({ postgres: pg });
    t.after(() => source.close()); t.after(() => target.close());
    const sourceAdmin = (await source.principals.bootstrapAdmin('合成原管理员')).user;
    const targetAdmin = (await target.principals.bootstrapAdmin('合成新管理员')).user;
    const value = randomBytes(24).toString('base64url'), lines: string[] = [];
    await namedSecretCommand(session(source, sourceAdmin, value, lines), ['set', '--name', 'DEMO_KEY', '--reason', '合成原设置']);
    await cp(join(source.dataDir, 'vault'), join(target.dataDir, 'vault'), { recursive: true });
    await cp(join(source.dataDir, 'test-vault.key'), join(target.dataDir, 'test-vault.key'));
    const path = join(target.dataDir, 'vault', 'metadata', 'secret.demo_key.sealed');
    const before = createHash('sha256').update(await readFile(path)).digest('hex');
    assert.equal(await target.authorizations.resourceConfig('secret:DEMO_KEY'), null);
    const forbidden = new Proxy({}, { get() { throw new Error('不得从新记录库取密钥'); } });
    const variables = new RecordVariables({ vault: target.vault, store: forbidden, objects: forbidden, database: forbidden, authorizations: forbidden, principals: forbidden } as unknown as VariablePorts);
    assert.ok((await variables.readSecrets([{ name: 'DEMO_KEY' }]))[0].value === value);
    assert.equal((await target.variables.listSecrets(targetAdmin))[0].set_by, sourceAdmin.id);
    assert.ok(sourceAdmin.id !== targetAdmin.id);
    assert.equal(await target.authorizations.resourceConfig('secret:DEMO_KEY'), null);
    const after = createHash('sha256').update(await readFile(path)).digest('hex');
    assert.equal(after, before);
});

test('missing names and absent legacy metadata return truthful errors with no raw values', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
    const value = randomBytes(24).toString('base64url'), lines: string[] = [];
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_MISSING' }]), /名字不存在/);
    await kit.vault.put('secret.demo_old.' + 'a'.repeat(24), value);
    await assert.rejects(namedSecretCommand(session(kit, admin, value, lines), ['show', '--name', 'DEMO_OLD']), error => error instanceof Error && /缺少认证元数据/.test(error.message) && !error.message.includes(value));
    await assert.rejects(namedSecretCommand(session(kit, admin, value, lines), ['adopt', '--name', 'DEMO_OLD', '--reason', '合成']), error => error instanceof Error && !error.message.includes(value));
    assert.ok(!lines.join('\n').includes(value));
});

test('revocation comes from the vault and an unrelated database audit cannot reactivate or replace material', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
    const value = randomBytes(24).toString('base64url'), lines: string[] = [];
    const s = session(kit, admin, value, lines);
    await namedSecretCommand(s, ['set', '--name', 'DEMO_KEY', '--reason', '合成设置']);
    await namedSecretCommand(s, ['unset', '--name', 'DEMO_KEY', '--reason', '合成撤回']);
    await assert.rejects(kit.variables.readSecrets([{ name: 'DEMO_KEY' }]), /已撤回/);
    assert.ok((await kit.variables.secretHistory(admin, 'DEMO_KEY'))[0].revoked);
    assert.ok(!lines.join('\n').includes(value));
});

test('legacy v1 ciphertext plus authenticated sourced metadata works after an unchanged copy into a fresh records database', async t => {
    const source = await openTestRecords({ postgres: pg }), target = await openTestRecords({ postgres: pg });
    t.after(() => source.close()); t.after(() => target.close());
    const sourceAdmin = (await source.principals.bootstrapAdmin('合成原管理员')).user;
    const targetAdmin = (await target.principals.bootstrapAdmin('合成新管理员')).user;
    const value = randomBytes(24).toString('base64url');
    const oldEntry = 'secret.demo_key.' + 'a'.repeat(24);
    await source.vault.put(oldEntry, value);
    // These are synthetic old-format facts, authored in the source database rather than guessed by the reader.
    const legacy = { schema: 'secret@1', name: 'DEMO_KEY', entry: oldEntry, digest_rule: 'plain', length: [...value].length, consumers: [{ definition: 'res_' + '0'.repeat(26), item: 'password', sends_to: 'a'.repeat(64) }] };
    const object = await source.objects.put(Buffer.from(JSON.stringify(legacy)), 'application/json');
    const decision = await source.authorizations.configureResource(sourceAdmin, 'secret:DEMO_KEY', object.sha256, '合成旧版设置');
    const original = await readFile(join(source.dataDir, 'vault', oldEntry + '.sealed'));
    await (source.vault as FileVault).writeSecretMetadata({ name: 'DEMO_KEY', versions: [{ metadata: { schema: 'secret@1', name: 'DEMO_KEY', entry: 'secret.demo_key', version: 1,
        digest_rule: 'plain', length: legacy.length, set_by: decision.body.decided_by, set_at: decision.body.decided_at, revoked: false },
        sealed_entry: oldEntry, sealed_sha256: createHash('sha256').update(original).digest('hex'), current: true }] });
    assert.ok((await readFile(join(source.dataDir, 'vault', oldEntry + '.sealed'))).equals(original));
    await cp(join(source.dataDir, 'vault'), join(target.dataDir, 'vault'), { recursive: true });
    await cp(join(source.dataDir, 'test-vault.key'), join(target.dataDir, 'test-vault.key'));
    assert.equal(await target.authorizations.resourceConfig('secret:DEMO_KEY'), null);
    const [material] = await target.variables.readSecrets([{ name: 'DEMO_KEY' }]);
    assert.ok(material.value === value);
    assert.equal(material.metadata.set_by, sourceAdmin.id);
    assert.ok(material.metadata.set_by !== targetAdmin.id);
    assert.equal(material.metadata.set_at, decision.body.decided_at);
    assert.equal(await target.vault.has('secret.demo_key'), false);
    assert.equal(await target.authorizations.resourceConfig('secret:DEMO_KEY'), null);
    assert.ok((await readFile(join(target.dataDir, 'vault', oldEntry + '.sealed'))).equals(original));
});
