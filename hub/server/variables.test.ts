import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { openTestRecords } from '../testing/records.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { canonicalBytes, newId, type Principal } from '../records/api.ts';
import { variableCommand, namedSecretCommand, parseVariableJson, type VariableCommandSession } from './variables.ts';
import { readSecrets } from './assemble/secret-input.ts';
let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());
async function setup(t: any) {
    const kit = await openTestRecords({ postgres });
    t.after(() => kit.close());
    const admin = (await kit.principals.bootstrapAdmin('合成管理员')).user;
    const user = await kit.principals.createUser(admin, '合成用户');
    const lines: string[] = [];
    let reads = 0;
    const value = randomBytes(24).toString('base64url');
    let by: Principal = admin;
    let pack: any = null;
    const session: VariableCommandSession = { ctx: { io: { cwd: kit.dataDir } }, options: { readSecret: async () => { reads++; return value; } }, admin: async () => by, records: async () => kit, hub: async () => ({ packs: { pack: async () => pack } as any }), out: line => lines.push(line), err: line => lines.push(line) };
    const definition = async (name = 'DEMO_KEY', item = 'password', rule = 'plain') => { const id = newId('res'); const body = { schema: 'resource@1', id, system_pack: 'demo-system@1.0.0', system_pack_digest: 'b'.repeat(64), enabled: true, origins: { api: 'https://service.example.invalid' }, allow_plaintext: [], credentials: { [item]: '${secret:' + name + '}' }, credential_digests: { [item]: rule } }; const object = await kit.objects.put(canonicalBytes(body), 'application/json'); await kit.authorizations.configureResource(admin, id, object.sha256, '合成引用'); return { id, body }; };
    return { kit, admin, user, session, lines, value, definition, get reads() { return reads; }, act: (principal: Principal) => by = principal, pack: (v: any) => pack = v };
}
test('variable commands preserve explicit text and hide values until show --value', async (t) => {
    const f = await setup(t);
    await writeFile(join(f.kit.dataDir, 'value.txt'), '10.6\n');
    await variableCommand(f.session, ['set', 'DEMO_LINE', '--file', 'value.txt', '--text', '--reason', '合成设置']);
    await variableCommand(f.session, ['list']);
    await variableCommand(f.session, ['show', 'DEMO_LINE']);
    assert.ok(!f.lines.join('\n').includes('10.6'));
    f.lines.length = 0;
    await variableCommand(f.session, ['show', 'DEMO_LINE', '--value', '--history']);
    assert.match(f.lines[0], /会留在终端记录/);
    assert.ok(f.lines.join('\n').includes('"10.6"'));
    await variableCommand(f.session, ['unset', 'DEMO_LINE', '--reason', '合成撤回']);
    assert.equal((await f.kit.variables.snapshot()).has('DEMO_LINE'), false);
});
test('every named command is administrator only and never echoes invalid positional input', async (t) => {
    const f = await setup(t);
    const marker = randomBytes(24).toString('base64url');
    await assert.rejects(namedSecretCommand(f.session, ['set', '--name', 'DEMO_KEY', marker, '--reason', '合成']), e => e instanceof Error && !e.message.includes(marker));
    assert.equal(f.reads, 0);
    await assert.rejects(variableCommand(f.session, ['set', 'demo_key', '--reason', '合成']), e => e instanceof Error && !e.message.includes('DEMO_KEY') && !e.message.includes('demo_key'));
    await assert.rejects(variableCommand(f.session, ['set', 'DEMO_PASSWORD', '--reason', '合成']), /secret set --name/);
    f.act(f.user);
    for (const cmd of [() => variableCommand(f.session, ['list']), () => namedSecretCommand(f.session, ['list'])])
        await assert.rejects(cmd(), /只有管理员/);
    assert.equal((await f.kit.store.list({ kind: 'authorization' })).items.length, 0);
});
test('named secret writes require consumers before reading values and print metadata and revocation advice only', async (t) => {
    const f = await setup(t);
    await assert.rejects(namedSecretCommand(f.session, ['set', '--name', 'DEMO_KEY', '--reason', '合成设置']), /还没有部署定义/);
    assert.equal(f.reads, 0);
    const def = await f.definition();
    await namedSecretCommand(f.session, ['set', '--name', 'DEMO_KEY', '--reason', '合成设置']);
    assert.equal(f.reads, 1);
    assert.ok(f.lines.some(line => line.includes(def.id)));
    assert.ok(!f.lines.join('\n').includes(f.value));
    assert.match(f.lines.at(-1)!, /签发方吊销/);
    await namedSecretCommand(f.session, ['list']);
    await namedSecretCommand(f.session, ['show', '--name', 'DEMO_KEY', '--history']);
    assert.ok(!f.lines.join('\n').includes(f.value));
    await namedSecretCommand(f.session, ['unset', '--name', 'DEMO_KEY', '--reason', '合成撤回']);
    await assert.rejects(f.kit.variables.readSecrets([{ name: 'DEMO_KEY', consumer: { definition: def.id, item: 'password', sends_to: 'a'.repeat(64) } }]), /secret set/);
});
test('secret import dry run is read only, validates digest compatibility and never exposes file data', async (t) => {
    const f = await setup(t);
    await f.definition('DEMO_USER', 'username', 'plain');
    await f.definition('DEMO_PASSWORD', 'password', 'sha512_base64');
    await writeFile(join(f.kit.dataDir, 'synthetic.env'), `USER=reader\nPASSWORD=${f.value}\nIGNORED=SyntheticIgnored42\n`);
    const args = ['import', '--env-file', 'synthetic.env', '--key', 'USER=DEMO_USER', '--key', 'PASSWORD=DEMO_PASSWORD', '--digest', 'DEMO_PASSWORD=sha512_base64', '--short', 'DEMO_USER', '--reason', '合成导入'];
    await namedSecretCommand(f.session, [...args, '--dry-run']);
    assert.deepEqual(await f.kit.vault.list(), []);
    await namedSecretCommand(f.session, args);
    assert.equal((await f.kit.variables.list(f.admin)).length, 2);
    assert.ok(!f.lines.join('\n').includes(f.value));
    assert.ok(!f.lines.join('\n').includes('SyntheticIgnored42'));
    await assert.rejects(namedSecretCommand(f.session, ['set', '--name', 'DEMO_USER', '--digest', 'DEMO_USER=sha512_base64', '--reason', '合成不合']), /需要原值/);
});
test('a value already persisted as ordinary data cannot later become a secret without issuer rotation', async (t) => {
    const f = await setup(t);
    await f.kit.variables.setVariable(f.admin, 'DEMO_DATA', f.value, '合成确认', { notSecret: true });
    await f.definition();
    await assert.rejects(namedSecretCommand(f.session, ['set', '--name', 'DEMO_KEY', '--reason', '合成设置']), e => e instanceof Error && /明文存在变量 DEMO_DATA/.test(e.message) && !e.message.includes(f.value));
    assert.equal((await f.kit.variables.history(f.admin, 'secret', 'DEMO_KEY')).length, 0);
});
test('JSON diagnostics expose exact locations without quoting syntax or duplicate keys', () => {
    for (const input of ['{bad:1}', '{\n "a":1,\n }', '{"a":1,"a":2}', '[1,]'])
        assert.throws(() => parseVariableJson(input), e => e instanceof Error && /第 \d+ 行第 \d+ 列/.test(e.message) && !e.message.includes(input));
    assert.deepEqual(parseVariableJson('{"a":[true,null,1.2e3]}'), { a: [true, null, 1200] });
});
test('a pipe supplies one line per name and a terminal prompts independently without echo', async () => {
    const a = randomBytes(12).toString('hex'), b = randomBytes(12).toString('hex');
    assert.deepEqual(await readSecrets(['DEMO_A', 'DEMO_B'], { input: Readable.from([a + '\r\n' + b + '\n']) }), [a, b]);
    await assert.rejects(readSecrets(['DEMO_A'], { input: Readable.from([a + '\n' + b + '\n']) }), /行数/);
    const tty = new EventEmitter() as any;
    const queue = [a, b];
    const prompts: string[] = [];
    tty.isTTY = true;
    tty.setRawMode = () => { };
    tty.pause = () => tty;
    tty.resume = () => { queueMicrotask(() => tty.emit('data', Buffer.from(queue.shift() + '\r'))); return tty; };
    assert.deepEqual(await readSecrets(['DEMO_A', 'DEMO_B'], { input: tty, prompt: line => prompts.push(line) }), [a, b]);
    assert.equal(prompts.length, 2);
    assert.ok(prompts.every(line => !line.includes(a) && !line.includes(b)));
});
test('Basic import follows the bound profile header declaration rather than guessing a credential name', async (t) => {
    const f = await setup(t);
    const def = await f.definition('DEMO_AUTH', 'token', 'plain');
    const directory = join(f.kit.dataDir, 'profile');
    await mkdir(directory);
    const profile: any = { schema: 'system@1', title: '合成头值认证', roles: [{ name: 'api' }], auth: { kind: 'static_header', header: { name: 'Authorization', scheme: 'raw' }, roles: ['api'], credential: 'token' }, routes: [{ id: 'document', role: 'api', method: 'GET', path: '/document', response: 'text', max_bytes: 4096, read: true }], reads: [{ name: 'document', external: 'demo:document', request: { route: 'document' } }] };
    await writeFile(join(directory, 'system.json'), JSON.stringify(profile));
    f.pack({ id: 'demo-system', version: '1.0.0', kind: 'system', digest: 'b'.repeat(64), directory });
    await writeFile(join(f.kit.dataDir, 'basic.env'), `USER=reader\nPASS=${f.value}\n`);
    const args = ['import', '--env-file', 'basic.env', '--basic', 'USER:PASS=DEMO_AUTH', '--reason', '合成头值'];
    await namedSecretCommand(f.session, args);
    const versions = await f.kit.variables.history(f.admin, 'secret', 'DEMO_AUTH');
    assert.equal(versions[0].version, 1);
    assert.ok(!f.lines.join('\n').includes(f.value));
    profile.auth.header.scheme = 'bearer';
    await writeFile(join(directory, 'system.json'), JSON.stringify(profile));
    await assert.rejects(namedSecretCommand(f.session, [...args.slice(0, 2), 'must-not-read', ...args.slice(3)]), /Basic 只用于/);
    assert.ok(def.id);
});
test('batch pipe capacity respects each secret character limit instead of an accidental single value buffer', async () => {
    const value = '界'.repeat(4096), labels = Array.from({ length: 6 }, (_, i) => 'DEMO_' + i);
    const values = await readSecrets(labels, { input: Readable.from([labels.map(() => value).join('\n') + '\n']) });
    assert.equal(values.length, 6);
    assert.ok(values.every(v => v === value));
});
