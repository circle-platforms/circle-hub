import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords } from '../testing/records.ts';
import { openConnectorKit } from '../connectors/testing/kit.ts';
import { startAgileStub, agileFixture } from '../connectors/testing/agile.ts';
import { FileVault } from '../records/vault.ts';
import { canonicalBytes, newId, type Principal, type RecordsKit } from '../records/api.ts';
import { namedSecretCommand, type VariableCommandSession } from './variables.ts';

let pg: TemporaryPostgres;
before(async () => { pg = await startPostgres(); });
after(() => pg?.stop());
const entry = (name: string) => `secret.${name.toLowerCase()}.${randomBytes(12).toString('hex')}`;
function session(kit: RecordsKit, admin: Principal, lines: string[], packs: any = { pack: async () => null }): VariableCommandSession {
    return { ctx: { io: { cwd: '.' } }, options: { readSecret: async () => { throw new Error('不得读标准输入'); } },
        records: async () => kit, admin: async () => admin,
        hub: async () => ({ packs, registry: { variableDeclarations: async () => [] } }),
        out: line => { lines.push(line); }, err: line => { lines.push(line); } };
}
async function reference(kit: RecordsKit, admin: Principal, name: string, rule = 'plain') {
    const id = newId('res');
    const body = { schema: 'resource@1', id, enabled: true, origins: { api: 'https://192.0.2.10' }, allow_plaintext: [],
        credentials: { password: '${secret:' + name + '}' }, credential_digests: { password: rule } };
    const object = await kit.objects.put(canonicalBytes(body), 'application/json');
    await kit.authorizations.configureResource(admin, id, object.sha256, '合成引用');
    return id;
}

test('adopt after a records rebuild enables an actual synthetic resource read without reentering credentials', { timeout: 60000 }, async t => {
    const k = await openConnectorKit(pg);
    t.after(() => k.close());
    const value = randomBytes(24).toString('base64url');
    const digest = createHash('sha512').update(value).digest('base64');
    const stub = await startAgileStub(agileFixture('synthetic-document', { password: value }));
    t.after(() => stub.close());
    const resource = await k.connectors.admin.addResource(k.admin, { system_pack: 'agile-test', name: 'DEMO_ADOPT', environment: 'test',
        origins: { 'agile-api': stub.origin, 'agile-oauth': stub.origin }, allow_plaintext: [stub.origin],
        credentials: { username: 'DEMO_USER', password: 'DEMO_PASSWORD' } });
    await k.records.authorizations.assignResource(k.admin, resource.id, '*');
    // Restored sealed files have no secret decisions in this fresh scratch database.
    const vault = k.records.vault as FileVault;
    await vault.put(entry('DEMO_USER'), 'reader');
    await vault.put(entry('DEMO_PASSWORD'), digest, 'sha512_base64');
    const lines: string[] = [], s = session(k.records, k.admin, lines, k.packs);
    assert.equal(await namedSecretCommand(s, ['adopt', '--all', '--reason', '合成重建后认领']), 0);
    const result = await k.connectors.executeRead(resource.id, 'tree', { id: '7714' }, { principal: k.user, purpose: 'DEMO_ADOPT' });
    assert.ok(result.ok);
    assert.equal(stub.logins, 1);
    const versions = await k.records.variables.history(k.admin, 'secret', 'DEMO_PASSWORD');
    assert.equal(versions.length, 1);
    assert.ok(versions[0].definition?.schema === 'secret@1' && versions[0].definition.digest_rule === 'sha512_base64');
    assert.ok(versions[0].decision.body.decided_by === k.admin.id);
    assert.ok(versions[0].decision.body.note?.includes('沿用密钥库里已封存的值'));
    const surfaces = [lines.join('\n'), JSON.stringify(k.log), JSON.stringify(result), ...(await k.allObjects()).map(bytes => bytes.toString())];
    for (const secret of [value, digest]) assert.ok(surfaces.every(surface => !surface.includes(secret)));
});

test('adopt --all reports missing values and unreferenced names individually while registering valid names', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
    const value = randomBytes(24).toString('base64url'), lines: string[] = [];
    await reference(kit, admin, 'DEMO_GOOD');
    await reference(kit, admin, 'DEMO_MISSING');
    await kit.vault.put(entry('DEMO_GOOD'), value);
    await kit.vault.put(entry('DEMO_UNUSED'), value);
    const s = session(kit, admin, lines);
    assert.equal(await namedSecretCommand(s, ['adopt', '--all', '--reason', '合成逐项']), 1);
    assert.ok(lines.some(line => line.includes('DEMO_GOOD') && line.includes('沿用密钥库')));
    assert.ok(lines.some(line => line.includes('DEMO_MISSING') && line.includes('没有这个名字的封存值')));
    assert.ok(lines.some(line => line.includes('DEMO_UNUSED') && line.includes('没有当前资源或执行器定义')));
    assert.ok(!lines.join('\n').includes(value));
    assert.equal((await kit.variables.history(admin, 'secret', 'DEMO_GOOD')).length, 1);
    assert.equal((await kit.variables.history(admin, 'secret', 'DEMO_MISSING')).length, 0);
    assert.equal((await kit.variables.history(admin, 'secret', 'DEMO_UNUSED')).length, 0);
});

test('an unreadable scratch seal reports a safe per-name error and never registers success', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
    const value = randomBytes(24).toString('base64url'), lines: string[] = [];
    await reference(kit, admin, 'DEMO_KEY');
    await kit.vault.put(entry('DEMO_KEY'), value);
    await writeFile(join(kit.dataDir, 'test-vault.key'), randomBytes(32));
    assert.equal(await namedSecretCommand(session(kit, admin, lines), ['adopt', '--name', 'DEMO_KEY', '--reason', '合成坏密钥']), 1);
    assert.ok(lines.some(line => line.includes('当前主密钥无法解开')));
    assert.ok(!lines.join('\n').includes(value));
    assert.equal((await kit.variables.history(admin, 'secret', 'DEMO_KEY')).length, 0);
});

test('adopt validates its exclusive selection and leaves secret set input behavior unchanged', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user, lines: string[] = [];
    const s = session(kit, admin, lines);
    for (const flags of [[], ['--all', '--name', 'DEMO_KEY'], ['--name', 'DEMO_KEY', '--name', 'DEMO_OTHER']])
        await assert.rejects(namedSecretCommand(s, ['adopt', ...flags, '--reason', '合成用法']), /恰好指定/);
    await reference(kit, admin, 'DEMO_KEY');
    const value = randomBytes(24).toString('base64url');
    let reads = 0;
    s.options.readSecret = async () => { reads++; return value; };
    assert.equal(await namedSecretCommand(s, ['set', '--name', 'DEMO_KEY', '--reason', '合成设置']), 0);
    assert.equal(reads, 1);
    assert.equal(await namedSecretCommand(s, ['adopt', '--name', 'DEMO_KEY', '--reason', '合成认领']), 0);
    assert.equal(reads, 1);
    const history = await kit.variables.history(admin, 'secret', 'DEMO_KEY');
    assert.equal(history.length, 2);
    assert.ok(!lines.join('\n').includes(value));
});

test('adopt binds executor credentials to the current definition and reports no secret value', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
    const id = newId('exe'), value = randomBytes(24).toString('base64url'), lines: string[] = [];
    const body = { id, enabled: true, endpoint: 'https://192.0.2.10', ca: { kind: 'system' }, credential: '${secret:DEMO_EXECUTOR}' };
    const object = await kit.objects.put(canonicalBytes(body), 'application/json');
    await kit.authorizations.configureResource(admin, 'executor.' + id, object.sha256, '合成执行器');
    await kit.vault.put(entry('DEMO_EXECUTOR'), value);
    assert.equal(await namedSecretCommand(session(kit, admin, lines), ['adopt', '--name', 'DEMO_EXECUTOR', '--reason', '合成执行器认领']), 0);
    const { deploymentDefinitions, consumersOf } = await import('./variables.ts');
    const [consumer] = consumersOf(await deploymentDefinitions(kit), 'DEMO_EXECUTOR');
    const material = await kit.variables.readSecrets([{ name: 'DEMO_EXECUTOR', consumer: { definition: consumer.definition, item: consumer.item, sends_to: consumer.sends_to } }]);
    assert.ok(material[0].value === value);
    assert.ok(!lines.join('\n').includes(value));
});

test('definition parsing failures never expose native JSON snippets or raw filesystem causes', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
    const value = randomBytes(24).toString('base64url'), lines: string[] = [];
    const object = await kit.objects.put(Buffer.from('{"broken":"' + value), 'application/json');
    await kit.authorizations.configureResource(admin, newId('res'), object.sha256, '合成损坏定义');
    await assert.rejects(namedSecretCommand(session(kit, admin, lines), ['adopt', '--all', '--reason', '合成错误']), error => error instanceof Error && /当前部署定义或密钥库目录不可核对/.test(error.message) && !error.message.includes(value));
    assert.ok(!lines.join('\n').includes(value));
});

test('a batch reason containing another selected sealed value cannot leak through an earlier successful name', async t => {
    const kit = await openTestRecords({ postgres: pg });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user, lines: string[] = [];
    const first = randomBytes(24).toString('base64url'), last = randomBytes(24).toString('base64url');
    for (const [name, value] of [['DEMO_A', first], ['DEMO_Z', last]]) {
        await reference(kit, admin, name);
        await kit.vault.put(entry(name), value);
    }
    await assert.rejects(namedSecretCommand(session(kit, admin, lines), ['adopt', '--all', '--reason', '合成 ' + last]), error => error instanceof Error && !error.message.includes(last));
    assert.equal((await kit.variables.history(admin, 'secret', 'DEMO_A')).length, 0);
    assert.equal((await kit.variables.history(admin, 'secret', 'DEMO_Z')).length, 0);
    assert.ok(!lines.join('\n').includes(last));
});
