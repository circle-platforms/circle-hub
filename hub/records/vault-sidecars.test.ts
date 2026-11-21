import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile, rm, utimes, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultReadinessError } from './errors.ts';
import { FileKeyProvider, FileVault } from './vault.ts';
import { RecordVariables, type VariablePorts } from './variables.ts';
import { newId } from './ids.ts';
import type { SecretSidecar } from '../../contracts/src/variables.ts';

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'hub-v1-sidecar-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = new FileKeyProvider(join(root, 'scratch.key'));
    const vault = new FileVault(join(root, 'vault'), provider);
    await vault.initKey();
    const by = newId('usr'), at = '2026-11-13T07:00:00.000Z';
    const sealed = async (name: string, value: string, version: number, current: boolean, suffix: string): Promise<SecretSidecar> => {
        const entry = 'secret.' + name.toLowerCase() + '.' + suffix.repeat(24);
        await vault.put(entry, value);
        const bytes = await readFile(join(root, 'vault', entry + '.sealed'));
        return { metadata: { schema: 'secret@1', name, entry: 'secret.' + name.toLowerCase(), version, digest_rule: 'plain', length: [...value].length, set_by: by, set_at: at, revoked: false },
            sealed_entry: entry, sealed_sha256: createHash('sha256').update(bytes).digest('hex'), current };
    };
    return { root, provider, vault, by, at, sealed };
}
const secret = () => randomBytes(24).toString('base64url');

test('unchanged legacy v1 ciphertext and authenticated sidecars copy to a fresh root and read without a records port', async t => {
    const f = await fixture(t), value = secret();
    const sidecar = await f.sealed('DEMO_KEY', value, 7, true, 'a');
    const original = await readFile(join(f.root, 'vault', sidecar.sealed_entry + '.sealed'));
    await f.vault.writeSecretMetadata({ name: sidecar.metadata.name, versions: [sidecar] });
    assert.ok((await readFile(join(f.root, 'vault', sidecar.sealed_entry + '.sealed'))).equals(original));
    const target = join(f.root, 'copy'); await mkdir(target);
    await cp(join(f.root, 'vault'), join(target, 'vault'), { recursive: true });
    await cp(join(f.root, 'scratch.key'), join(target, 'scratch.key'));
    const copied = new FileVault(join(target, 'vault'), new FileKeyProvider(join(target, 'scratch.key')));
    const forbidden = new Proxy({}, { get() { throw new Error('不得读取旧记录库或当前记录库'); } });
    const variables = new RecordVariables({ vault: copied, store: forbidden, database: forbidden, authorizations: forbidden, principals: forbidden, objects: forbidden } as unknown as VariablePorts);
    const [material] = await variables.readSecrets([{ name: 'DEMO_KEY' }]);
    assert.ok(material.value === value);
    assert.equal(material.version, 7);
    assert.equal(material.metadata.set_by, f.by);
    assert.equal(material.metadata.set_at, f.at);
    assert.equal(await copied.has('secret.demo_key'), false);
    assert.ok((await readFile(join(target, 'vault', sidecar.sealed_entry + '.sealed'))).equals(original));
    const verified = await copied.verify();
    assert.equal(verified.failed, 0);
    assert.equal(verified.unknown, false);
});

test('the authenticated current flag selects the exact old version independently of file timestamps', async t => {
    const f = await fixture(t), first = secret(), second = secret();
    const old = await f.sealed('DEMO_KEY', first, 2, false, 'a');
    const current = await f.sealed('DEMO_KEY', second, 3, true, 'b');
    const earlier = new Date('2020-01-01T00:00:00Z');
    await utimes(join(f.root, 'vault', current.sealed_entry + '.sealed'), earlier, earlier);
    await f.vault.writeSecretMetadata({ name: 'DEMO_KEY', versions: [old, current] });
    assert.ok((await f.vault.readSecret('DEMO_KEY'))?.value === second);
    assert.deepEqual((await f.vault.secretHistory('DEMO_KEY')).map(m => m.version), [3, 2]);
    const recent = await f.vault.recentSecrets();
    assert.ok(recent.some(m => m.value === first) && recent.some(m => m.value === second));
    await new FileVault(join(f.root, 'vault', 'metadata'), f.provider).put('secret.demo_key', JSON.stringify({ name: 'DEMO_KEY', versions: [{ ...old, current: true }, current] }));
    await assert.rejects(f.vault.readSecret('DEMO_KEY'), error => error instanceof VaultReadinessError && error.issues.some(issue => issue.missing.includes('current')));
});

test('unknown original setter and time remain unknown and do not become the importing administrator', async t => {
    const f = await fixture(t), value = secret();
    const sidecar = await f.sealed('DEMO_KEY', value, 4, true, 'a');
    sidecar.metadata.set_by = null; sidecar.metadata.set_at = null;
    await f.vault.writeSecretMetadata({ name: sidecar.metadata.name, versions: [sidecar] });
    const material = await f.vault.readSecret('DEMO_KEY');
    assert.ok(material?.value === value);
    assert.equal(material?.metadata.set_by, null);
    assert.equal(material?.metadata.set_at, null);
});

test('a replaced old ciphertext is refused even when the same master key opens it and its length is unchanged', async t => {
    const f = await fixture(t), value = secret(), replacement = secret();
    const sidecar = await f.sealed('DEMO_KEY', value, 1, true, 'a');
    await f.vault.writeSecretMetadata({ name: sidecar.metadata.name, versions: [sidecar] });
    await f.vault.put(sidecar.sealed_entry, replacement);
    await assert.rejects(f.vault.readSecret('DEMO_KEY'), error => error instanceof Error && /密文字节与认证身份不符/.test(error.message) && !error.message.includes(value) && !error.message.includes(replacement));
});

test('unauthenticated sidecars, missing current facts and exact-name mismatches never produce material', async t => {
    const f = await fixture(t), value = secret();
    const sidecar = await f.sealed('DEMO_KEY', value, 1, true, 'a');
    const metadataVault = new FileVault(join(f.root, 'vault', 'metadata'), f.provider);
    await metadataVault.put('secret.demo_key', JSON.stringify({ name: 'DEMO_KEY', versions: [{ ...sidecar, current: false }] }));
    await assert.rejects(f.vault.readSecret('DEMO_KEY'), error => error instanceof VaultReadinessError && error.issues.some(issue => issue.missing.includes('current')));
    await assert.rejects(f.vault.writeSecretMetadata({ name: 'DEMO_KEY', versions: [{ ...sidecar, sealed_entry: 'secret.demo_other.' + 'a'.repeat(24) }] }), /密钥元数据缺少/);
    await f.vault.writeSecretMetadata({ name: 'DEMO_KEY', versions: [sidecar] });
    const filename = 'secret.demo_key.sealed';
    const path = join(f.root, 'vault', 'metadata', filename);
    const payload = JSON.parse(await readFile(path, 'utf8'));
    payload.data = payload.data.slice(0, -4) + 'AAAA';
    await writeFile(path, JSON.stringify(payload));
    await assert.rejects(f.vault.readSecret('DEMO_KEY'), error => error instanceof Error && /元数据无法认证/.test(error.message) && !error.message.includes(value));
});

test('an authenticated revocation prevents old material from reviving and subsequent writes continue the sourced version', async t => {
    const f = await fixture(t), value = secret(), next = secret();
    const sidecar = await f.sealed('DEMO_KEY', value, 7, true, 'a');
    await f.vault.writeSecretMetadata({ name: 'DEMO_KEY', versions: [{ ...sidecar, metadata: { ...sidecar.metadata, revoked: true }, sealed_sha256: null }] });
    assert.equal(await f.vault.readSecret('DEMO_KEY'), null);
    assert.equal((await f.vault.recentSecrets()).length, 0);
    const metadata = await f.vault.putSecret({ name: 'DEMO_KEY', value: next, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    assert.equal(metadata.version, 8);
    assert.ok((await f.vault.readSecret('DEMO_KEY'))?.value === next);
});

test('a new setting continues the authenticated old version and retains the exact prior value for redaction', async t => {
    const f = await fixture(t), value = secret(), next = secret();
    const sidecar = await f.sealed('DEMO_KEY', value, 7, true, 'a');
    await f.vault.writeSecretMetadata({ name: sidecar.metadata.name, versions: [sidecar] });
    const original = await readFile(join(f.root, 'vault', sidecar.sealed_entry + '.sealed'));
    const metadata = await f.vault.putSecret({ name: 'DEMO_KEY', value: next, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    assert.equal(metadata.version, 8);
    assert.ok((await f.vault.readSecret('DEMO_KEY'))?.value === next);
    const recent = await f.vault.recentSecrets();
    assert.equal(recent.length, 2);
    assert.ok(recent.some(m => m.version === 7 && m.value === value));
    assert.ok(recent.some(m => m.version === 8 && m.value === next));
    assert.ok((await readFile(join(f.root, 'vault', sidecar.sealed_entry + '.sealed'))).equals(original));
});

test('a failed initial metadata publication removes only the newly staged ciphertext and remains retryable', async t => {
    const f = await fixture(t), value = secret();
    const directory = join(f.root, 'vault', 'metadata');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'key-check'), 'synthetic-invalid-check');
    await assert.rejects(f.vault.putSecret({ name: 'DEMO_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at }), error => error instanceof Error && !error.message.includes(value));
    assert.equal((await f.vault.list()).filter(entry => entry.startsWith('secret.demo_key.')).length, 0);
    await rm(join(directory, 'key-check'));
    const metadata = await f.vault.putSecret({ name: 'DEMO_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    assert.equal(metadata.version, 1);
    assert.ok((await f.vault.readSecret('DEMO_KEY'))?.value === value);
});

test('JSON-looking secret text remains opaque value text and is never treated as a metadata or value container', async t => {
    const f = await fixture(t), value = JSON.stringify({ name: 'DEMO_KEY', versions: [{ value: secret() }] });
    await f.vault.putSecret({ name: 'DEMO_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    const material = await f.vault.readSecret('DEMO_KEY');
    assert.ok(material?.value === value);
    const metadataVault = new FileVault(join(f.root, 'vault', 'metadata'), f.provider);
    const index = JSON.parse((await metadataVault.getText('secret.demo_key'))!);
    assert.ok(!JSON.stringify(index).includes(value));
    assert.ok(index.versions.every((row: any) => !('value' in row) && !('value' in row.metadata)));
    assert.ok((await f.vault.getText(index.versions[0].sealed_entry)) === value);
});
