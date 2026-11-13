import assert from 'node:assert/strict';
import { copyFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { ReadManifest } from '../../contracts/src/resources.ts';
import { openConnectorKit } from './testing/kit.ts';
import { writePack } from './testing/packs.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

async function addSource(kit: Awaited<ReturnType<typeof openConnectorKit>>, name: string) {
  const pack = await writePack(kit.packRoot, { id: 'vault-source', system: {
    schema: 'system@1', title: '合成封存来源', roles: [{ name: 'source' }],
    auth: { kind: 'static_header', header: { name: 'X-Api-Key', scheme: 'bearer' }, roles: ['source'], credential: 'token' },
    routes: [{ id: 'one', role: 'source', method: 'GET', path: '/one', response: 'json', max_bytes: 4096, read: true }],
    reads: [{ name: 'one', external: 'fixture:vault', request: { route: 'one' } }],
  } });
  kit.packs.set(pack);
  return kit.connectors.admin.addResource(kit.admin, { system_pack: pack.id, name: '合成来源', environment: 'test',
    origins: { source: 'http://192.0.2.1' }, allow_plaintext: ['http://192.0.2.1'], credentials: { token: name } });
}

test('a fresh records database reads a newly configured resource using only copied vault files', async t => {
  const value = 'Synthetic-Copied-Vault-4242';
  const name = 'DEMO_IMPORTED';
  const old = await openConnectorKit(postgres);
  t.after(() => old.close());
  await old.records.variables.setSecrets(old.admin, [{ name, value }], '合成：在来源配置之前保存密钥');
  let calls = 0, sentExpected = false;
  const kit = await openConnectorKit(postgres, { fetch: async (_url, options) => {
    calls++;
    sentExpected = new Headers(options?.headers).get('X-Api-Key') === 'Bearer ' + value;
    return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
  } });
  t.after(() => kit.close());
  await copyFile(old.records.keyProvider.path, kit.records.keyProvider.path);
  await rm(join(kit.records.dataDir, 'vault'), { recursive: true, force: true });
  await cp(join(old.records.dataDir, 'vault'), join(kit.records.dataDir, 'vault'), { recursive: true });
  assert.equal(await kit.records.authorizations.resourceConfig('secret:' + name), null);
  const resource = await addSource(kit, name);
  const context = { principal: kit.user, purpose: 'synthetic copied vault read' };
  assert.equal((await kit.connectors.executeRead(resource.id, 'one', { id: 'sample' }, context)).ok, false);
  assert.equal(calls, 0, 'a copied vault does not grant resource usage');
  await kit.records.authorizations.grant(kit.admin, { permission: 'resource_assign', subject: '*', object: resource.id });
  const outcome = await kit.connectors.executeRead(resource.id, 'one', { id: 'sample' }, context);
  assert.ok(outcome.ok, 'the copied named material is usable without a secret database decision');
  assert.ok(sentExpected, 'the request uses the copied named value');
  assert.equal(calls, 1);
  if (!outcome.ok) return;
  const manifest = ReadManifest.parse((await kit.records.store.get(outcome.manifest))!.body);
  assert.deepEqual(manifest.variables, [{ kind: 'secret', at: resource.id + '#/credentials/token', name, version: 1 }]);
  const configuration = await kit.records.authorizations.resourceConfig(resource.id);
  assert.deepEqual(manifest.inputs, ['rec:' + configuration!.digest]);
  const metadataVault = new Proxy(kit.records.vault, { get(target, key) {
    if (key === 'readSecret' || key === 'getText') return async () => { throw new Error('metadata read attempted to fetch material'); };
    const member = Reflect.get(target, key, target);
    return typeof member === 'function' ? member.bind(target) : member;
  } });
  const metadataOnly = kit.make({ records: { ...kit.records, vault: metadataVault } });
  const description = await metadataOnly.admin.describe(kit.admin, resource.id);
  assert.deepEqual(description!.credentials.map(item => [item.set, item.version, item.stored_digest]), [[true, 1, 'plain']]);
  assert.equal(Object.hasOwn(description!.credentials[0], 'registered'), false);
  assert.ok(!JSON.stringify({ description, outcome, log: kit.log }).includes(value), 'public returns and logs contain no material');
  for (const object of await kit.allObjects()) assert.ok(!object.includes(Buffer.from(value)), 'stored objects contain no material');
});

test('a missing name is reported before a credential can reach the source', async t => {
  let calls = 0;
  const kit = await openConnectorKit(postgres, { fetch: async () => { calls++; return new Response('{}'); } });
  t.after(() => kit.close());
  const resource = await addSource(kit, 'DEMO_MISSING');
  await kit.records.authorizations.grant(kit.admin, { permission: 'resource_assign', subject: '*', object: resource.id });
  const outcome = await kit.connectors.executeRead(resource.id, 'one', { id: 'sample' }, { principal: kit.user, purpose: 'synthetic missing name' });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) { assert.equal(outcome.code, 'CREDENTIAL_MISSING'); assert.match(outcome.reason, /DEMO_MISSING/); }
  assert.equal(calls, 0);
  assert.equal((await kit.connectors.admin.describe(kit.admin, resource.id))!.credentials[0].set, false);
});
