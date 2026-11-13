import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { FileKeyProvider, FileVault } from './vault.ts';
import { VaultReadinessError } from './errors.ts';
import { RecordVariables, type VariablePorts } from './variables.ts';
import { newId } from './ids.ts';
import type { SecretMetadataFile } from '../../contracts/src/variables.ts';

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'hub-vault-readiness-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = new FileKeyProvider(join(root, 'scratch.key'));
    const vault = new FileVault(join(root, 'vault'), provider);
    await vault.initKey();
    const by = newId('usr'), at = '2026-11-13T08:00:00.000Z';
    const forbidden = new Proxy({}, { get() { throw new Error('不得从记录库补事实'); } });
    const variables = new RecordVariables({ vault, store: forbidden, objects: forbidden, database: forbidden, principals: forbidden, authorizations: forbidden } as unknown as VariablePorts);
    const metadata = new FileVault(join(root, 'vault', 'metadata'), provider);
    const raw = async (name: string, value: string, version: number) => {
        const entry = 'secret.' + name.toLowerCase() + '.' + randomBytes(12).toString('hex');
        await vault.put(entry, value);
        const cipher = await readFile(join(root, 'vault', entry + '.sealed'));
        return { metadata: { schema: 'secret@1' as const, name, entry: 'secret.' + name.toLowerCase(), version, digest_rule: 'plain' as const, length: [...value].length, set_by: by, set_at: at, revoked: false }, sealed_entry: entry, sealed_sha256: createHash('sha256').update(cipher).digest('hex'), current: true };
    };
    return { root, provider, vault, variables, metadata, by, at, raw };
}
const value = () => randomBytes(24).toString('base64url');
function privateError(error: unknown, secrets: readonly string[]): error is VaultReadinessError {
    return error instanceof VaultReadinessError && secrets.every(secret => !error.message.includes(secret) && !error.adminMessage.includes(secret) && !JSON.stringify(error).includes(secret)) && !Object.hasOwn(error, 'cause');
}

test('missing metadata reports every exact entry privately and never returns a partial redaction set', async t => {
    const f = await fixture(t), valid = value(), a = value(), b = value(), c = value();
    await f.vault.putSecret({ name: 'VALID_KEY', value: valid, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    const one = await f.raw('PRIVATE_ALPHA', a, 1), two = await f.raw('PRIVATE_ALPHA', b, 2), other = await f.raw('PRIVATE_BETA', c, 1);
    let failure: VaultReadinessError | undefined;
    await assert.rejects(f.variables.recentSecrets(), error => {
        if (!privateError(error, [valid, a, b, c])) return false;
        failure = error;
        return error.issues.length === 3;
    });
    assert.ok(failure);
    assert.deepEqual(failure.issues.map(issue => issue.entry).sort(), [one, two, other].map(row => row.sealed_entry + '.sealed').sort());
    assert.ok(failure.issues.every(issue => issue.missing.includes('metadata') && issue.missing.includes('current') && issue.missing.includes('version') && issue.missing.includes('digest_rule')));
    assert.ok(failure.adminMessage.includes('PRIVATE_ALPHA') && failure.adminMessage.includes('PRIVATE_BETA'));
    assert.ok(failure.issues.every(issue => issue.next_action.includes('vault/metadata/secret.') && issue.next_action.includes('原设置事实')));
    for (const name of ['PRIVATE_ALPHA', 'PRIVATE_BETA']) {
        assert.ok(!failure.message.includes(name));
        assert.ok(!JSON.stringify(failure).includes(name));
    }
    assert.deepEqual(failure.detail, {});
    assert.ok(Object.isFrozen(failure.issues));
    await f.vault.writeSecretMetadata({ name: 'PRIVATE_ALPHA', versions: [{ ...one, current: false }, two] });
    await f.vault.writeSecretMetadata({ name: 'PRIVATE_BETA', versions: [other] });
    const ready = await f.variables.recentSecrets();
    assert.equal(ready.length, 4);
    assert.ok([valid, a, b, c].every(secret => ready.some(material => material.value === secret)));
});

test('authenticated but incomplete metadata identifies current, version and digest_rule without native JSON or values', async t => {
    const f = await fixture(t), secret = value();
    await f.vault.putSecret({ name: 'PRIVATE_SCHEMA', value: secret, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    const base = JSON.parse((await f.metadata.getText('secret.private_schema'))!);
    for (const field of ['current', 'version', 'digest_rule']) {
        const input = structuredClone(base);
        if (field === 'current') delete input.versions[0].current;
        else delete input.versions[0].metadata[field];
        await f.metadata.put('secret.private_schema', JSON.stringify(input));
        await assert.rejects(f.variables.recentSecrets(), error => privateError(error, [secret]) && error.issues.some(issue => issue.name === 'PRIVATE_SCHEMA' && issue.entry === 'metadata/secret.private_schema.sealed' && issue.missing.includes(field)));
    }
    await f.metadata.put('secret.private_schema', '{"broken":"' + secret);
    await assert.rejects(f.variables.recentSecrets(), error => privateError(error, [secret]) && error.issues.some(issue => issue.missing.includes('metadata')) && !error.adminMessage.includes('SyntaxError'));
});

test('missing ciphertext, changed identity, authentication and length failures have separate repair facts', async t => {
    const f = await fixture(t), secret = value();
    const row = await f.raw('PRIVATE_CIPHER', secret, 1);
    const input: SecretMetadataFile = { name: 'PRIVATE_CIPHER', versions: [row] };
    await f.vault.writeSecretMetadata(input);
    const path = join(f.root, 'vault', row.sealed_entry + '.sealed');
    const original = await readFile(path);
    await rm(path);
    await assert.rejects(f.variables.recentSecrets(), error => privateError(error, [secret]) && error.issues.some(issue => issue.entry === row.sealed_entry + '.sealed' && issue.missing.includes('cipher') && issue.reason.includes('不存在') && issue.next_action.includes('备份')));
    await writeFile(path, original, { mode: 0o600 });
    const replacement = value();
    await f.vault.put(row.sealed_entry, replacement);
    await assert.rejects(f.variables.recentSecrets(), error => privateError(error, [secret, replacement]) && error.issues.some(issue => issue.missing.includes('sealed_sha256')));
    await writeFile(path, original);
    const sealed = JSON.parse(original.toString()); sealed.tag = randomBytes(16).toString('base64');
    await writeFile(path, JSON.stringify(sealed));
    const changed = await readFile(path);
    await f.vault.writeSecretMetadata({ name: 'PRIVATE_CIPHER', versions: [{ ...row, sealed_sha256: createHash('sha256').update(changed).digest('hex') }] });
    await assert.rejects(f.variables.recentSecrets(), error => privateError(error, [secret]) && error.issues.some(issue => issue.missing.includes('authentication') && issue.reason.includes('认证失败')));
    await writeFile(path, original);
    await f.vault.writeSecretMetadata({ name: 'PRIVATE_CIPHER', versions: [{ ...row, metadata: { ...row.metadata, length: row.metadata.length + 1 } }] });
    await assert.rejects(f.variables.recentSecrets(), error => privateError(error, [secret]) && error.issues.some(issue => issue.missing.includes('length')));
});

test('dictionary, login state and key-check namespaces remain opaque and are not interpreted as named secrets', async t => {
    const f = await fixture(t);
    const entries = ['masking-dictionary', 'redaction.dictionary', 'connector.' + newId('res') + '.session', 'login-stop.' + 'a'.repeat(64), 'key-check'];
    const snapshots = new Map<string, Buffer>();
    for (const entry of entries) {
        await f.vault.put(entry, new Uint8Array([255, 0, 254, 1]));
        snapshots.set(entry, await readFile(join(f.root, 'vault', entry + '.sealed')));
    }
    const keyCheck = await readFile(join(f.root, 'vault', 'key-check'));
    assert.deepEqual(await f.vault.secretNames(), []);
    assert.deepEqual(await f.variables.recentSecrets(), []);
    for (const [entry, bytes] of snapshots) assert.ok((await readFile(join(f.root, 'vault', entry + '.sealed'))).equals(bytes));
    assert.ok((await readFile(join(f.root, 'vault', 'key-check'))).equals(keyCheck));
});
