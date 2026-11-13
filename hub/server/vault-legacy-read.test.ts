import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { cp, copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openConnectorKit } from '../connectors/testing/kit.ts';
import { writePack } from '../connectors/testing/packs.ts';
import { FileVault } from '../records/api.ts';
import { canonicalBytes } from '../records/api.ts';

let pg: TemporaryPostgres;
before(async () => { pg = await startPostgres(); });
after(() => pg?.stop());
async function add(kit: Awaited<ReturnType<typeof openConnectorKit>>, name: string) {
    const pack = await writePack(kit.packRoot, { id: 'legacy-vault-source', system: {
        schema: 'system@1', title: '合成旧封存来源', roles: [{ name: 'source' }],
        auth: { kind: 'static_header', header: { name: 'X-Api-Key', scheme: 'bearer' }, roles: ['source'], credential: 'token' },
        routes: [{ id: 'one', role: 'source', method: 'GET', path: '/one', response: 'json', max_bytes: 4096, read: true }],
        reads: [{ name: 'one', external: 'fixture:legacy-vault', request: { route: 'one' } }],
    } });
    kit.packs.set(pack);
    return kit.connectors.admin.addResource(kit.admin, { system_pack: pack.id, name: '合成旧封存资源', environment: 'test', origins: { source: 'http://192.0.2.1' }, allow_plaintext: ['http://192.0.2.1'], credentials: { token: name } });
}

test('copied legacy v1 opaque bytes and the sole metadata format enable an actual new-resource read in a fresh database', async t => {
    const source = await openConnectorKit(pg); t.after(() => source.close());
    const name = 'DEMO_OLD_RESOURCE', value = randomBytes(24).toString('base64url');
    const originalResource = await add(source, name);
    const entry = 'secret.demo_old_resource.' + randomBytes(12).toString('hex');
    await source.records.vault.put(entry, value);
    const legacy = { schema: 'secret@1', name, entry, digest_rule: 'plain', length: [...value].length, consumers: [{ definition: originalResource.id, item: 'token', sends_to: 'a'.repeat(64) }] };
    const object = await source.records.objects.put(canonicalBytes(legacy), 'application/json');
    const decision = await source.records.authorizations.configureResource(source.admin, 'secret:' + name, object.sha256, '合成旧版设置事实');
    const original = await readFile(join(source.records.dataDir, 'vault', entry + '.sealed'));
    await (source.records.vault as FileVault).writeSecretMetadata({ name, versions: [{ metadata: { schema: 'secret@1', name, entry: 'secret.demo_old_resource', version: 1,
        digest_rule: 'plain', length: legacy.length, set_by: decision.body.decided_by, set_at: decision.body.decided_at, revoked: false }, sealed_entry: entry,
        sealed_sha256: createHash('sha256').update(original).digest('hex'), current: true }] });
    let calls = 0, correct = false;
    const target = await openConnectorKit(pg, { fetch: async (_url, options) => { calls++; correct = new Headers(options?.headers).get('X-Api-Key') === 'Bearer ' + value; return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); } });
    t.after(() => target.close());
    await copyFile(source.records.keyProvider.path, target.records.keyProvider.path);
    await rm(join(target.records.dataDir, 'vault'), { recursive: true, force: true });
    await cp(join(source.records.dataDir, 'vault'), join(target.records.dataDir, 'vault'), { recursive: true });
    assert.equal(await target.records.authorizations.resourceConfig('secret:' + name), null);
    const resource = await add(target, name);
    assert.ok(resource.id !== originalResource.id);
    const context = { principal: target.user, purpose: 'synthetic legacy copied source' };
    assert.ok(!(await target.connectors.executeRead(resource.id, 'one', { id: 'sample' }, context)).ok);
    assert.equal(calls, 0);
    await target.records.authorizations.assignResource(target.admin, resource.id, '*');
    const outcome = await target.connectors.executeRead(resource.id, 'one', { id: 'sample' }, context);
    assert.ok(outcome.ok);
    assert.ok(correct);
    assert.equal(calls, 1);
    assert.equal(await target.records.authorizations.resourceConfig('secret:' + name), null);
    assert.equal((await target.records.vault.secretMetadata(name))?.set_by, source.admin.id);
    assert.ok((await readFile(join(target.records.dataDir, 'vault', entry + '.sealed'))).equals(original));
    assert.ok(!JSON.stringify({ outcome, logs: target.log }).includes(value));
    for (const bytes of await target.allObjects()) assert.ok(!bytes.includes(Buffer.from(value)));
});
