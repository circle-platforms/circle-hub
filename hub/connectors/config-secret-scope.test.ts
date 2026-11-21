import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { VaultReadinessError } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openConnectorKit } from './testing/kit.ts';
import { writePack } from './testing/packs.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

test('resource configuration checks its referenced name while actual reads retain the global redaction gate', async t => {
  let fetches = 0;
  const kit = await openConnectorKit(postgres, { fetch: async () => { fetches++; return new Response('{}'); } });
  t.after(() => kit.close());
  const nameA = 'DEMO_KEY_A', nameB = 'DEMO_KEY_B';
  await kit.records.variables.setSecrets(kit.admin, [{ name: nameA, value: 'Synthetic-Configuration-A-4242' }], '合成：配置引用材料');
  kit.packs.set(await writePack(kit.packRoot, { id: 'configuration-scope', system: {
    schema: 'system@1', title: '合成配置范围', roles: [{ name: 'source' }],
    auth: { kind: 'static_header', header: { name: 'X-Api-Key', scheme: 'bearer' }, roles: ['source'], credential: 'token' },
    routes: [{ id: 'one', role: 'source', method: 'GET', path: '/one', response: 'json', max_bytes: 1024, read: true }],
    reads: [{ name: 'one', external: 'fixture:scope', request: { route: 'one' } }],
  } }));
  const resource = await kit.connectors.admin.addResource(kit.admin, { system_pack: 'configuration-scope', name: '合成配置A', environment: 'test',
    origins: { source: 'http://192.0.2.1' }, allow_plaintext: ['http://192.0.2.1'], credentials: { token: nameA } });
  const failure = (name: string) => new VaultReadinessError([{ name, entry: 'secret.' + name.toLowerCase() + '.' + 'b'.repeat(24) + '.sealed',
    missing: ['metadata'], reason: '合成未认证材料', next_action: '管理员恢复认证元数据' }]);
  const badA = failure(nameA), badB = failure(nameB);
  const recent = kit.records.variables.recentSecrets.bind(kit.records.variables);
  const scopes: Array<readonly string[] | undefined> = [];
  let ownBroken = false;
  kit.records.variables.recentSecrets = async names => {
    scopes.push(names);
    if (names === undefined || names.includes(nameB)) throw badB;
    if (ownBroken && names.includes(nameA)) throw badA;
    return recent(names);
  };
  const changed = await kit.connectors.admin.updateResource(kit.admin, resource.id, { name: '合成配置A已修改' });
  assert.equal(changed.name, '合成配置A已修改');
  assert.deepEqual(scopes, [[nameA]]);
  const before = await kit.records.authorizations.resourceConfig(resource.id);
  ownBroken = true;
  await assert.rejects(kit.connectors.admin.updateResource(kit.admin, resource.id, { name: '不应写入' }), error => error === badA);
  assert.equal((await kit.records.authorizations.resourceConfig(resource.id))!.digest, before!.digest);
  ownBroken = false;
  await kit.records.authorizations.grant(kit.admin, { permission: 'resource_assign', subject: '*', object: resource.id });
  const privateNotes: string[] = [];
  const outcome = await kit.connectors.executeRead(resource.id, 'one', { id: 'sample' }, {
    principal: kit.user, purpose: 'synthetic runtime gate', adminNote: note => privateNotes.push(note),
  });
  assert.equal(outcome.ok, false);
  assert.equal(scopes.at(-1), undefined);
  assert.equal(fetches, 0);
  assert.ok(privateNotes.some(note => note.includes(nameB)));
  assert.ok(!JSON.stringify(outcome).includes(nameB));
});
