import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openConnectorKit } from './testing/kit.ts';
import { writePack } from './testing/packs.ts';
import { json, startStub } from './testing/stub.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(() => postgres?.stop());

async function world(t: TestContext) {
  const kit = await openConnectorKit(postgres);
  const source = await startStub(() => json({ item: 'synthetic' }));
  t.after(async () => { await source.close(); await kit.close(); });
  kit.packs.set(await writePack(kit.packRoot, {
    id: 'resource-access',
    system: {
      schema: 'system@1', title: '合成授权来源', roles: [{ name: 'source' }], auth: { kind: 'none' },
      routes: [{ id: 'one', role: 'source', method: 'GET', path: '/one', response: 'json', read: true, max_bytes: 1024 }],
      reads: [{ name: 'one', external: 'fixture:item', request: { route: 'one' } }],
    },
  }));
  const resource = await kit.connectors.admin.addResource(kit.admin, {
    system_pack: 'resource-access', name: '合成资源', environment: 'test', origins: { source: source.origin },
  });
  const context = { principal: kit.user, purpose: 'synthetic resource authorization' };
  const assignment = { permission: 'resource_assign' as const, subject: '*', object: resource.id };
  return { kit, source, resource, context, assignment };
}

test('resource configuration grants no business read while administrators retain the management directory', async t => {
  const w = await world(t);
  assert.deepEqual(await w.kit.connectors.admin.listResources(w.kit.user), []);
  assert.equal(await w.kit.connectors.reader.accepts('fixture:item:one', w.context), false);
  assert.equal((await w.kit.connectors.reader.read('fixture:item:one', w.context)).ok, false);
  const direct = await w.kit.connectors.executeRead(w.resource.id, 'one', { id: 'one' }, w.context);
  assert.equal(direct.ok, false);
  if (!direct.ok) assert.equal(direct.code, 'ACCESS_DENIED');
  assert.equal(w.source.requests.length, 0);
  assert.equal(await w.kit.connectors.reader.accepts('fixture:item:one'), true);
  assert.equal(w.source.requests.length, 0, 'routing without a principal does not make a source request');
  assert.equal((await w.kit.connectors.catalog.list(w.kit.admin)).length, 1);
  assert.equal((await w.kit.connectors.admin.listResources(w.kit.admin)).length, 1);
  assert.equal((await w.kit.connectors.reader.read('fixture:item:one', { ...w.context, principal: w.kit.admin })).ok, false);
  assert.equal((await w.kit.connectors.executeRead(w.resource.id, 'one', { id: 'one' }, { ...w.context, principal: w.kit.admin })).ok, false);
  assert.equal(w.source.requests.length, 0);
  await w.kit.records.authorizations.grant(w.kit.admin, w.assignment);
  assert.equal((await w.kit.connectors.reader.read('fixture:item:one', { ...w.context, principal: w.kit.admin })).ok, true);
  assert.equal(w.source.requests.length, 1);
});

test('revoking an all-member resource assignment closes the next read and listing without a connector refresh', async t => {
  const w = await world(t);
  await w.kit.records.authorizations.grant(w.kit.admin, w.assignment);
  assert.deepEqual((await w.kit.connectors.admin.listResources(w.kit.user)).map(row => row.id), [w.resource.id]);
  assert.equal((await w.kit.connectors.admin.listResources(w.kit.user))[0]?.origins, undefined);
  assert.deepEqual(await w.kit.connectors.catalog.list(w.kit.user), []);
  assert.equal((await w.kit.connectors.executeRead(w.resource.id, 'one', { id: 'one' }, w.context)).ok, true);
  await w.kit.records.authorizations.revoke(w.kit.admin, w.assignment);
  assert.equal(await w.kit.connectors.reader.accepts('fixture:item:one', w.context), false);
  assert.equal((await w.kit.connectors.reader.read('fixture:item:one', w.context)).ok, false);
  assert.equal((await w.kit.connectors.executeRead(w.resource.id, 'one', { id: 'one' }, w.context)).ok, false);
  assert.deepEqual(await w.kit.connectors.admin.listResources(w.kit.user), []);
  assert.equal((await w.kit.connectors.catalog.list(w.kit.admin)).length, 1);
  assert.equal(w.source.requests.length, 1, 'revocation prevents both public read entry points from reaching the source');
});

test('removing a team member withdraws the resource from the next external read and resource listing', async t => {
  const w = await world(t);
  const team = await w.kit.records.teams.create(w.kit.admin, '合成读取组');
  await w.kit.records.teams.add(w.kit.admin, team.id, w.kit.user.id);
  await w.kit.records.authorizations.grant(w.kit.admin, { ...w.assignment, subject: team.id });
  assert.equal((await w.kit.connectors.reader.read('fixture:item:one', w.context)).ok, true);
  await w.kit.records.teams.remove(w.kit.admin, team.id, w.kit.user.id);
  assert.equal((await w.kit.connectors.reader.read('fixture:item:one', w.context)).ok, false);
  assert.equal((await w.kit.connectors.executeRead(w.resource.id, 'one', { id: 'one' }, w.context)).ok, false);
  assert.deepEqual(await w.kit.connectors.admin.listResources(w.kit.user), []);
  assert.equal(w.source.requests.length, 1);
});

test('a disabled account cannot use an all-member assignment through a previously captured principal', async t => {
  const w = await world(t);
  await w.kit.records.authorizations.grant(w.kit.admin, w.assignment);
  assert.equal((await w.kit.connectors.executeRead(w.resource.id, 'one', { id: 'one' }, w.context)).ok, true);
  await w.kit.records.principals.setDisabled(w.kit.admin, w.kit.user.id, true);
  assert.equal(await w.kit.connectors.reader.accepts('fixture:item:one', w.context), false);
  assert.equal((await w.kit.connectors.executeRead(w.resource.id, 'one', { id: 'one' }, w.context)).ok, false);
  assert.deepEqual(await w.kit.connectors.admin.listResources(w.kit.user), []);
  assert.equal(w.source.requests.length, 1);
});
