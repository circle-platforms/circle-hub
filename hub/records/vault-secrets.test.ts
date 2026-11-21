import { VaultReadinessError } from './errors.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeyProvider, FileVault } from './vault.ts';
import { RecordVariables, type VariablePorts } from './variables.ts';
import { newId } from './ids.ts';

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-named-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = new FileKeyProvider(join(root, 'scratch.key'));
    const vault = new FileVault(join(root, 'vault'), provider);
    await vault.initKey();
    const by = newId('usr'), at = '2026-11-13T07:00:00.000Z';
    return { root, provider, vault, by, at };
}
const value = () => randomBytes(24).toString('base64url');

test('named vault values and authenticated complete metadata survive an unchanged vault/key copy', async t => {
    const f = await fixture(t), secret = value();
    const metadata = await f.vault.putSecret({ name: 'DEMO_PASSWORD', value: secret, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    assert.equal(metadata.version, 1);
    assert.equal(metadata.set_by, f.by);
    assert.equal(metadata.set_at, f.at);
    assert.ok(!JSON.stringify(metadata).includes(secret));
    const target = join(f.root, 'copy');
    await mkdir(target);
    await cp(join(f.root, 'vault'), join(target, 'vault'), { recursive: true });
    await cp(join(f.root, 'scratch.key'), join(target, 'scratch.key'));
    const copied = new FileVault(join(target, 'vault'), new FileKeyProvider(join(target, 'scratch.key')));
    const before = createHash('sha256').update(await readFile(join(target, 'vault', 'metadata', 'secret.demo_password.sealed'))).digest('hex');
    assert.deepEqual(await copied.secretMetadata('DEMO_PASSWORD'), metadata);
    assert.ok((await copied.readSecret('DEMO_PASSWORD'))?.value === secret);
    const after = createHash('sha256').update(await readFile(join(target, 'vault', 'metadata', 'secret.demo_password.sealed'))).digest('hex');
    assert.equal(after, before);
    assert.ok(!(await readFile(join(target, 'vault', 'metadata', 'secret.demo_password.sealed'), 'utf8')).includes(secret));
    const readOnlyPorts = new Proxy({}, { get() { throw new Error('不得读取记录库'); } });
    const variables = new RecordVariables({ vault: copied, store: readOnlyPorts, objects: readOnlyPorts, database: readOnlyPorts, authorizations: readOnlyPorts, principals: readOnlyPorts } as unknown as VariablePorts);
    assert.ok((await variables.readSecrets([{ name: 'DEMO_PASSWORD' }]))[0].value === secret);
    assert.ok((await variables.recentSecrets())[0].value === secret);
    await assert.rejects(variables.readSecrets([{ name: 'DEMO_MISSING' }]), /名字不存在/);
});

test('rotation is serialized across vault instances and keeps the current and previous values with full version history', async t => {
    const f = await fixture(t), other = new FileVault(join(f.root, 'vault'), f.provider);
    const secrets = Array.from({ length: 5 }, value);
    const results = await Promise.all(secrets.map((secret, index) => (index % 2 ? other : f.vault).putSecret({ name: 'DEMO_KEY', value: secret, digest_rule: 'plain', set_by: f.by, set_at: f.at })));
    assert.deepEqual(results.map(m => m.version), [1, 2, 3, 4, 5]);
    assert.equal((await f.vault.secretHistory('DEMO_KEY')).length, 5);
    const recent = await other.recentSecrets();
    assert.equal(recent.length, 2);
    assert.ok(recent.some(m => m.value === secrets[3]));
    assert.ok(recent.some(m => m.value === secrets[4]));
    assert.ok((await f.vault.readSecret('DEMO_KEY'))?.value === secrets[4]);
});

test('revocation is stored by the vault and deletes retained material without losing who and when', async t => {
    const f = await fixture(t), secret = value();
    await f.vault.putSecret({ name: 'DEMO_KEY', value: secret, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    const revoked = await f.vault.unsetSecret('DEMO_KEY', f.by, '2026-11-13T07:01:00.000Z');
    assert.ok(revoked.revoked);
    assert.equal(revoked.version, 1);
    assert.equal(await f.vault.readSecret('DEMO_KEY'), null);
    assert.equal((await f.vault.recentSecrets()).length, 0);
    assert.equal((await f.vault.list()).filter(entry => entry.startsWith('secret.demo_key.')).length, 0);
    assert.equal(revoked.set_by, f.by);
    assert.equal(revoked.set_at, f.at);
    const restored = await f.vault.putSecret({ name: 'DEMO_KEY', value: value(), digest_rule: 'plain', set_by: f.by, set_at: f.at });
    assert.equal(restored.version, 2);
});

test('old ciphertext stays unreadable without facts and explicit same-name set archives it without guessing an old version', async t => {
    const f = await fixture(t), secret = value(), replacement = value();
    const originals = [];
    for (const suffix of ['a'.repeat(24), 'b'.repeat(24)]) {
        const entry = 'secret.demo_key.' + suffix;
        await f.vault.put(entry, secret);
        originals.push({ entry, bytes: await readFile(join(f.root, 'vault', entry + '.sealed')) });
    }
    await assert.rejects(f.vault.readSecret('DEMO_KEY'), error => error instanceof Error && /缺少认证元数据/.test(error.message) && !error.message.includes(secret));
    const reset = await f.vault.putSecret({ name: 'DEMO_KEY', value: replacement, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    assert.equal(reset.version, 1);
    assert.equal(reset.archive?.previous_version, null);
    assert.equal(reset.archive?.entries.length, 2);
    for (const original of originals) {
        const row = reset.archive!.entries.find(item => item.entry === original.entry + '.sealed')!;
        assert.ok((await readFile(join(f.root, 'vault', row.archived_entry))).equals(original.bytes));
        assert.equal(await f.vault.has(original.entry), false);
    }
    assert.ok((await f.vault.readSecret('DEMO_KEY'))?.value === replacement);
});

test('wrong scratch keys, altered metadata and malformed payloads fail without raw values or JSON snippets', async t => {
    const f = await fixture(t), secret = value();
    await f.vault.putSecret({ name: 'DEMO_KEY', value: secret, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    const path = join(f.root, 'vault', 'metadata', 'secret.demo_key.sealed');
    const bytes = await readFile(path), sealed = JSON.parse(bytes.toString());
    sealed.data = sealed.data.slice(0, -4) + 'AAAA';
    await writeFile(path, JSON.stringify(sealed));
    await assert.rejects(f.vault.readSecret('DEMO_KEY'), error => error instanceof Error && !error.message.includes(secret));
    await writeFile(path, bytes);
    await new FileVault(join(f.root, 'vault', 'metadata'), f.provider).put('secret.demo_bad', '{"bad":"' + secret);
    await assert.rejects(f.vault.readSecret('DEMO_BAD'), error => error instanceof VaultReadinessError && error.issues.some(issue => issue.missing.includes('metadata')) && !error.adminMessage.includes(secret));
    await writeFile(join(f.root, 'scratch.key'), randomBytes(32));
    await assert.rejects(f.vault.readSecret('DEMO_KEY'), error => error instanceof Error && !error.message.includes(secret));
});
