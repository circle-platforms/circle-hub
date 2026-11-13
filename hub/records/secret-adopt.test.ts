import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { FileVault, FileKeyProvider } from './vault.ts';
import { RecordVariables, type VariablePorts } from './variables.ts';
import { newId } from './ids.ts';
import type { DigestRule } from '../../contracts/generated/vocabulary.ts';

async function fixture(t: TestContext) {
    const dir = await mkdtemp(join(tmpdir(), 'hub-adopt-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const keyPath = join(dir, 'scratch.key');
    const vault = new FileVault(join(dir, 'vault'), new FileKeyProvider(keyPath));
    await vault.initKey();
    const admin = { id: newId('usr'), role: 'admin', disabled: false };
    const rows: any[] = [], objects = new Map<string, Uint8Array>();
    const store = {
        lock: async () => {},
        withTransaction: async (run: (tx: any) => Promise<any>) => run({}),
        find: async (query: any) => ({ items: rows.filter(row => query.key !== 'authz.key' || query.value === `resource_config|*|${row.body.object}`).slice().reverse(), next: null }),
    };
    const authorizations = {
        configureResourceInTransaction: async (by: any, object: string, bound: string, note: string) => {
            const row = { digest: randomBytes(32).toString('hex'), body: { object, bound, note, decided_by: by.id, revoked: false } };
            rows.push(row); return row;
        },
        resourceConfigs: async (names: string[]) => new Map(names.flatMap(name => { const row = rows.findLast(row => row.body.object === name); return row ? [[name, row]] : []; })),
    };
    const ports = {
        vault, store, authorizations, principals: { get: async () => admin }, database: {},
        objects: {
            put: async (bytes: Uint8Array) => { const sha256 = createHash('sha256').update(bytes).digest('hex'); objects.set(sha256, bytes); return { sha256 }; },
            get: async (digest: string) => objects.get(digest) ?? null,
        },
    } as unknown as VariablePorts;
    const variables = new RecordVariables(ports);
    const consumer = { definition: newId('res'), item: 'password', sends_to: 'a'.repeat(64) };
    const entry = (name: string) => `secret.${name.toLowerCase()}.${randomBytes(12).toString('hex')}`;
    return { dir, keyPath, vault, variables, admin: admin as any, rows, objects, consumer, entry };
}

test('adoption registers a new version with current consumers and authenticates the stored digest rule', async t => {
    const f = await fixture(t), value = randomBytes(24).toString('base64url');
    const entry = f.entry('DEMO_KEY');
    await f.vault.put(entry, value, 'plain');
    const adopted = await f.variables.adoptSecret(f.admin, 'DEMO_KEY', [f.consumer], ['sha512_base64'], '合成认领');
    assert.equal(adopted.version, 1);
    assert.ok(adopted.definition?.schema === 'secret@1' && adopted.definition.digest_rule === 'plain');
    assert.ok(f.rows[0].body.note.includes('沿用密钥库里已封存的值'));
    assert.ok(f.rows[0].body.decided_by === f.admin.id);
    const material = await f.variables.readSecrets([{ name: 'DEMO_KEY', consumer: f.consumer }]);
    assert.ok(material[0].value === value);
    assert.ok(!JSON.stringify(f.rows).includes(value));
    assert.ok([...f.objects.values()].every(bytes => !Buffer.from(bytes).toString().includes(value)));
    const next = { ...f.consumer, definition: newId('res') };
    const second = await f.variables.adoptSecret(f.admin, 'DEMO_KEY', [next], ['sha512_base64'], '合成重新绑定');
    assert.equal(second.version, 2);
    await assert.rejects(f.variables.readSecrets([{ name: 'DEMO_KEY', consumer: f.consumer }]), /未登记使用者/);
    assert.ok((await f.variables.readSecrets([{ name: 'DEMO_KEY', consumer: next }]))[0].value === value);
});

test('old sealed files use the exact definition rule without hashing an already stored digest again', async t => {
    const f = await fixture(t), value = createHash('sha512').update(randomBytes(24)).digest('base64');
    await f.vault.put(f.entry('DEMO_KEY'), value);
    const row = await f.variables.adoptSecret(f.admin, 'DEMO_KEY', [f.consumer], ['sha512_base64'], '合成旧封存');
    assert.ok(row.definition?.schema === 'secret@1' && row.definition.digest_rule === 'sha512_base64');
    assert.ok((await f.variables.readSecrets([{ name: 'DEMO_KEY', consumer: f.consumer }]))[0].value === value);
});

test('missing value, missing consumer and a wrong scratch master key fail without revealing values or raw causes', async t => {
    const f = await fixture(t), value = randomBytes(24).toString('base64url');
    const adopt = (name: string, consumers = [f.consumer]) => f.variables.adoptSecret(f.admin, name, consumers, ['plain'], '合成错误');
    await assert.rejects(adopt('DEMO_MISSING'), /没有这个名字的封存值/);
    await f.vault.put(f.entry('DEMO_UNUSED'), value);
    await assert.rejects(adopt('DEMO_UNUSED', []), /没有当前资源或执行器定义/);
    await writeFile(f.keyPath, randomBytes(32));
    await assert.rejects(adopt('DEMO_UNUSED'), error => error instanceof Error && /当前主密钥无法解开/.test(error.message) && !error.message.includes(value));
    assert.equal(f.rows.length, 0);
});

test('ambiguous versions, conflicting old rules and digest-only values required as plain fail explicitly', async t => {
    const f = await fixture(t), value = randomBytes(24).toString('base64url');
    await f.vault.put(f.entry('DEMO_MANY'), value);
    await f.vault.put(f.entry('DEMO_MANY'), value + 'different');
    await assert.rejects(f.variables.adoptSecret(f.admin, 'DEMO_MANY', [f.consumer], ['plain'], '合成多版'), /多个封存版本无法确认/);
    await f.vault.put(f.entry('DEMO_OLD'), value);
    await assert.rejects(f.variables.adoptSecret(f.admin, 'DEMO_OLD', [f.consumer], ['plain', 'sha512_base64'], '合成冲突'), /声明不一致/);
    await f.vault.put(f.entry('DEMO_DIGEST'), value, 'sha512_base64');
    await assert.rejects(f.variables.adoptSecret(f.admin, 'DEMO_DIGEST', [f.consumer], ['plain'], '合成不合'), /需要原值/);
    assert.equal(f.rows.length, 0);
});

test('metadata is authenticated and returns no value; reasons cannot persist the adopted value', async t => {
    const f = await fixture(t), value = randomBytes(24).toString('base64url'), entry = f.entry('DEMO_KEY');
    await f.vault.put(entry, value, 'plain');
    const metadata = await f.vault.metadata(entry);
    assert.deepEqual(metadata, { digest_rule: 'plain' });
    assert.ok(!JSON.stringify(metadata).includes(value));
    await assert.rejects(f.variables.adoptSecret(f.admin, 'DEMO_KEY', [f.consumer], ['plain'], value), error => error instanceof Error && !error.message.includes(value));
    const path = join(f.dir, 'vault', entry + '.sealed');
    const sealed = JSON.parse(await readFile(path, 'utf8'));
    sealed.digest_rule = 'sha512_base64' satisfies DigestRule;
    await writeFile(path, JSON.stringify(sealed));
    await assert.rejects(f.vault.metadata(entry), error => error instanceof Error && !error.message.includes(value));
    await assert.rejects(f.vault.getText(entry), error => error instanceof Error && !error.message.includes(value));
    assert.equal(f.rows.length, 0);
});

test('identical unbound versions can be adopted but different authenticated rules remain ambiguous', async t => {
    const f = await fixture(t), value = randomBytes(24).toString('base64url');
    await f.vault.put(f.entry('DEMO_SAME'), value, 'plain');
    await f.vault.put(f.entry('DEMO_SAME'), value, 'plain');
    const row = await f.variables.adoptSecret(f.admin, 'DEMO_SAME', [f.consumer], ['plain'], '合成同值');
    assert.equal(row.version, 1);
    assert.ok((await f.variables.readSecrets([{ name: 'DEMO_SAME', consumer: f.consumer }]))[0].value === value);
    await f.vault.put(f.entry('DEMO_RULES'), value, 'plain');
    await f.vault.put(f.entry('DEMO_RULES'), value, 'sha512_base64');
    await assert.rejects(f.variables.adoptSecret(f.admin, 'DEMO_RULES', [f.consumer], ['plain'], '合成不同规则'), /多个封存版本无法确认/);
});

test('a current exact binding wins over a different unbound sealed version', async t => {
    const f = await fixture(t), value = randomBytes(24).toString('base64url');
    await f.variables.setSecrets(f.admin, [{ name: 'DEMO_KEY', value, consumers: [f.consumer] }], '合成设置');
    await f.vault.put(f.entry('DEMO_KEY'), value + 'different', 'plain');
    const row = await f.variables.adoptSecret(f.admin, 'DEMO_KEY', [f.consumer], ['plain'], '合成准确绑定');
    assert.equal(row.version, 2);
    assert.ok((await f.variables.readSecrets([{ name: 'DEMO_KEY', consumer: f.consumer }]))[0].value === value);
});
