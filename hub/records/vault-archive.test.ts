import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { FileVault, FileKeyProvider } from './vault.ts';
import { VaultReadinessError } from './errors.ts';
import type { VaultArchiveEntry } from './api.ts';
import { RecordVariables, type VariablePorts } from './variables.ts';
import { newId } from './ids.ts';

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'hub-archive-set-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = new FileKeyProvider(join(root, 'scratch.key'));
    const vault = new FileVault(join(root, 'vault'), provider); await vault.initKey();
    const by = newId('usr'), at = '2026-11-13T09:45:00.000Z';
    const original = async (name: string) => {
        const entry = 'secret.' + name.toLowerCase() + '.' + randomBytes(12).toString('hex');
        await vault.put(entry, randomBytes(24).toString('base64url'));
        return { entry, bytes: await readFile(join(root, 'vault', entry + '.sealed')) };
    };
    return { root, provider, vault, by, at, original };
}
const secret = () => randomBytes(24).toString('base64url');

test('same-name set archives all unverified ciphertext without inventing its old version and publishes a new cipher identity', async t => {
    const f = await fixture(t), value = secret();
    const first = await f.original('MY_KEY'), second = await f.original('MY_KEY');
    const foreign = await f.original('OTHER_KEY');
    const result = await f.vault.putSecret({ name: 'MY_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    assert.equal(result.version, 1);
    assert.equal(result.archive?.previous_version, null);
    assert.equal(result.archive?.new_version, 1);
    assert.equal(result.archive?.name, 'MY_KEY');
    assert.equal(result.archive?.by, f.by);
    assert.equal(result.archive?.at, f.at);
    assert.equal(result.archive?.entries.length, 2);
    for (const original of [first, second]) {
        const archived: VaultArchiveEntry = result.archive!.entries.find(entry => entry.entry === original.entry + '.sealed')!;
        assert.ok(archived);
        assert.equal(archived.sealed_sha256, createHash('sha256').update(original.bytes).digest('hex'));
        assert.ok((await readFile(join(f.root, 'vault', archived.archived_entry))).equals(original.bytes));
        assert.equal(await f.vault.has(original.entry), false);
    }
    assert.ok((await readFile(join(f.root, 'vault', foreign.entry + '.sealed'))).equals(foreign.bytes));
    assert.ok((await f.vault.readSecret('MY_KEY'))?.value === value);
    assert.equal((await f.vault.recentSecrets(['MY_KEY'])).length, 1);
    await assert.rejects(f.vault.recentSecrets(), error => error instanceof VaultReadinessError && error.issues.some(issue => issue.name === 'OTHER_KEY'));
    const receipt = JSON.parse(await readFile(join(f.root, 'vault', result.archive!.directory, 'receipt.json'), 'utf8'));
    assert.equal(receipt.operation, '归档后重新设置');
    assert.equal(receipt.completed, true);
    assert.ok(!JSON.stringify({ result, receipt }).includes(value));
});

test('a partial archive move failure restores every same-name active byte and does not publish metadata', async t => {
    const f = await fixture(t), first = await f.original('MY_KEY'), second = await f.original('MY_KEY');
    let moves = 0;
    const broken = new FileVault(join(f.root, 'vault'), f.provider, async (from, to) => { if (++moves === 2) throw new Error('synthetic move refusal'); await rename(from, to); });
    await assert.rejects(broken.putSecret({ name: 'MY_KEY', value: secret(), digest_rule: 'plain', set_by: f.by, set_at: f.at }), /已恢复同名原active文件/);
    for (const original of [first, second]) assert.ok((await readFile(join(f.root, 'vault', original.entry + '.sealed'))).equals(original.bytes));
    await assert.rejects(f.vault.readSecret('MY_KEY'), error => error instanceof VaultReadinessError && error.issues.some(issue => issue.missing.includes('metadata')));
    const directories = await readdir(join(f.root, 'vault', 'archive'));
    const receipt = JSON.parse(await readFile(join(f.root, 'vault', 'archive', directories[0], 'receipt.json'), 'utf8'));
    assert.equal(receipt.completed, false);
    assert.equal(receipt.restored, true);
});

test('a new-seal failure restores the original active files and keeps the failed attempt visibly unsuccessful', async t => {
    const f = await fixture(t), original = await f.original('MY_KEY'), value = secret();
    const put = f.vault.put.bind(f.vault);
    f.vault.put = async (entry, bytes) => { if (entry.startsWith('secret.my_key.')) throw new Error('synthetic seal failure'); return put(entry, bytes); };
    await assert.rejects(f.vault.putSecret({ name: 'MY_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at }), error => error instanceof Error && error.message.includes('已恢复同名原active文件') && !error.message.includes(value));
    assert.ok((await readFile(join(f.root, 'vault', original.entry + '.sealed'))).equals(original.bytes));
    assert.equal((await f.vault.list()).filter(entry => entry.startsWith('secret.my_key.')).length, 1);
});

test('archive receipts are bound into the existing safe configuration audit and contain no material', async t => {
    const f = await fixture(t), original = await f.original('MY_KEY'), value = secret();
    const admin = { id: f.by, role: 'admin', disabled: false };
    const objects = new Map<string, Uint8Array>(); const audits: any[] = [];
    const ports = {
        vault: f.vault, now: () => new Date(f.at), database: {}, principals: { get: async () => admin },
        store: { lock: async () => {}, find: async () => ({ items: [], next: null }), withTransaction: async (fn: any) => fn({}) },
        objects: { put: async (bytes: Uint8Array) => { const sha256 = createHash('sha256').update(bytes).digest('hex'); objects.set(sha256, bytes); return { sha256 }; } },
        authorizations: { configureResourceInTransaction: async (by: any, name: string, bound: string, reason: string) => { audits.push({ by: by.id, name, bound, reason }); } },
    } as unknown as VariablePorts;
    const variables = new RecordVariables(ports);
    await variables.setSecrets(admin as any, [{ name: 'MY_KEY', value }], '合成归档后重设');
    assert.equal(audits.length, 1);
    const body = JSON.parse(Buffer.from(objects.get(audits[0].bound)!).toString());
    assert.equal(body.operation, '归档后重新设置');
    assert.equal(body.archive.by, f.by);
    assert.equal(body.archive.name, 'MY_KEY');
    assert.equal(body.archive.entries[0].sealed_sha256, createHash('sha256').update(original.bytes).digest('hex'));
    assert.ok(!JSON.stringify({ body, audits }).includes(value));
});

test('a metadata publication failure after sealing restores active bytes and never claims a completed archive', async t => {
    const f = await fixture(t), original = await f.original('MY_KEY'), value = secret();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(f.root, 'vault', 'metadata'), { mode: 0o700 });
    await writeFile(join(f.root, 'vault', 'metadata', 'key-check'), 'synthetic invalid key check');
    await assert.rejects(f.vault.putSecret({ name: 'MY_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at }), /已恢复同名原active文件/);
    assert.ok((await readFile(join(f.root, 'vault', original.entry + '.sealed'))).equals(original.bytes));
    assert.equal((await f.vault.list()).filter(entry => entry.startsWith('secret.my_key.')).length, 1);
    const directories = await readdir(join(f.root, 'vault', 'archive'));
    const receipt = JSON.parse(await readFile(join(f.root, 'vault', 'archive', directories[0], 'receipt.json'), 'utf8'));
    assert.equal(receipt.completed, false);
    assert.equal(receipt.restored, true);
    assert.ok(!JSON.stringify(receipt).includes(value));
});


test('retry after a published value and unfinished receipt does not archive that new value again', async t => {
    const f = await fixture(t), original = await f.original('MY_KEY'), value = secret();
    const { writeFile } = await import('node:fs/promises');
    let writes = 0;
    const interrupted = new FileVault(join(f.root, 'vault'), f.provider, rename, async (file, bytes, options) => { if (++writes === 2) throw new Error('synthetic receipt marker failure'); await writeFile(file, bytes, options); });
    await assert.rejects(interrupted.putSecret({ name: 'MY_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at }), /新值与认证元数据已发布.*不得视为成功/);
    const published = await f.vault.readSecret('MY_KEY');
    assert.ok(published?.value === value && published.version === 1);
    const active = (await f.vault.list()).find(entry => entry.startsWith('secret.my_key.'))!;
    const activeBytes = await readFile(join(f.root, 'vault', active + '.sealed'));
    const retry = await f.vault.putSecret({ name: 'MY_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at });
    assert.equal(retry.version, 2);
    assert.equal(retry.archive, undefined);
    const directories = await readdir(join(f.root, 'vault', 'archive'));
    assert.equal(directories.length, 1);
    assert.ok((await readFile(join(f.root, 'vault', active + '.sealed'))).equals(activeBytes));
    const receipt = JSON.parse(await readFile(join(f.root, 'vault', 'archive', directories[0], 'receipt.json'), 'utf8'));
    assert.equal(receipt.completed, false);
    assert.ok((await readFile(join(f.root, 'vault', receipt.entries[0].archived_entry))).equals(original.bytes));
    assert.ok(!JSON.stringify({ receipt, retry }).includes(value));
});

test('a metadata write that publishes then throws removes its new index and restores all original active ciphertext', async t => {
    const f = await fixture(t), original = await f.original('MY_KEY'), value = secret();
    const put = FileVault.prototype.put;
    let wrote = false;
    FileVault.prototype.put = async function (entry, bytes) {
        await put.call(this, entry, bytes);
        if (this.directory === join(f.root, 'vault', 'metadata')) {
            wrote = (await readFile(join(this.directory, entry + '.sealed'))).length > 0;
            throw new Error('synthetic failure after metadata publication');
        }
    };
    try {
        await assert.rejects(f.vault.putSecret({ name: 'MY_KEY', value, digest_rule: 'plain', set_by: f.by, set_at: f.at }), /已恢复同名原active文件/);
    } finally { FileVault.prototype.put = put; }
    assert.ok(wrote);
    assert.ok((await readFile(join(f.root, 'vault', original.entry + '.sealed'))).equals(original.bytes));
    assert.equal(await new FileVault(join(f.root, 'vault', 'metadata'), f.provider).has('secret.my_key'), false);
    await assert.rejects(f.vault.readSecret('MY_KEY'), error => error instanceof VaultReadinessError && error.issues.some(issue => issue.missing.includes('metadata')));
});

test('a late metadata publication failure restores the exact untrusted metadata identity when it was archived', async t => {
    const f = await fixture(t), original = await f.original('MY_KEY');
    const metadata = new FileVault(join(f.root, 'vault', 'metadata'), f.provider);
    await metadata.put('secret.my_key', '{"incomplete":true}');
    const path = join(f.root, 'vault', 'metadata', 'secret.my_key.sealed');
    const oldMetadata = await readFile(path);
    const put = FileVault.prototype.put; let wrote = false;
    FileVault.prototype.put = async function (entry, bytes) {
        await put.call(this, entry, bytes);
        if (this.directory === metadata.directory) { wrote = true; throw new Error('synthetic fsync failure after publication'); }
    };
    try {
        await assert.rejects(f.vault.putSecret({ name: 'MY_KEY', value: secret(), digest_rule: 'plain', set_by: f.by, set_at: f.at }), /已恢复同名原active文件/);
    } finally { FileVault.prototype.put = put; }
    assert.ok(wrote);
    assert.ok((await readFile(path)).equals(oldMetadata));
    assert.ok((await readFile(join(f.root, 'vault', original.entry + '.sealed'))).equals(original.bytes));
});
