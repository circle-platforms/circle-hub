// Resource administration and ResourceCatalogPort: admins decide and see addresses; users see rows without them through the
// admin API and nothing through the catalog port; definitions are content-addressed and bound by resource_config decisions;
// credentials go to the vault, passwords only as the digest their system requires.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { ConnectorError } from './errors.ts';
import { openConnectorKit, type ConnectorKit } from './testing/kit.ts';
import { AGILE_FUNCTIONS, agileSystem, writePack } from './testing/packs.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(() => postgres?.stop());

async function kit(t: { after: (fn: () => Promise<void>) => void }): Promise<ConnectorKit> {
  const k = await openConnectorKit(postgres);
  t.after(() => k.close());
  return k;
}

const agileInput = (overrides: Record<string, unknown> = {}) => ({
  system_pack: 'agile-test',
  name: '合成敏捷平台（测试）',
  environment: 'test' as const,
  origins: { 'agile-oauth': 'http://192.0.2.10:8080', 'agile-api': 'http://192.0.2.10:8080' },
  allow_plaintext: ['http://192.0.2.10:8080'],
  settings: { roots: ['7714'] },
  ...overrides,
});

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof ConnectorError ? error.code : `other: ${String(error)}`;
  }
}

test('an admin adds a resource; its definition is bound by a resource_config decision', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  assert.match(record.id, /^res_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.deepEqual(record.credentials, { username: `connector.${record.id}.username`, password: `connector.${record.id}.password` });
  assert.deepEqual(record.credential_digests, { username: 'plain', password: 'sha512_base64' });
  assert.equal(record.system_pack, 'agile-test@1.0.0', 'the version current at configuration time, exactly');
  assert.equal(record.system_pack_digest, k.handles.agile.digest);
  assert.equal(record.created_by, k.admin.id);
  const decision = await k.records.authorizations.resourceConfig(record.id);
  assert.ok(decision !== null);
  assert.equal(decision.body.permission, 'resource_config');
  assert.equal(decision.body.bound, sha256Hex(canonicalBytes(record)));
  assert.equal(decision.body.decided_by, k.admin.id);
  assert.deepEqual(JSON.parse(Buffer.from((await k.records.objects.get(decision.body.bound!))!).toString()), record);
});

test('only admins configure; bad definitions are refused with the reason', async (t) => {
  const k = await kit(t);
  assert.equal(await code(k.connectors.admin.addResource(k.user, agileInput())), 'ACCESS_DENIED');
  assert.equal(await code(k.connectors.admin.addResource({ id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0t', name: 'ghost', role: 'admin' }, agileInput())), 'ACCESS_DENIED');
  assert.equal(await code(k.connectors.admin.addResource(k.admin, agileInput({ system_pack: 'no-such-pack' }))), 'PACK_UNAVAILABLE');
  const workflow = await writePack(k.packRoot, { id: 'not-a-system', kind: 'workflow', system: {} });
  k.packs.set(workflow);
  assert.equal(await code(k.connectors.admin.addResource(k.admin, agileInput({ system_pack: 'not-a-system' }))), 'PACK_UNAVAILABLE');
  const cases: Record<string, unknown>[] = [
    { origins: { 'agile-api': 'http://192.0.2.10:8080' } },
    { origins: { 'agile-oauth': 'http://192.0.2.10:8080', 'agile-api': 'http://192.0.2.10:8080', other: 'http://192.0.2.10:8080' } },
    { origins: { 'agile-oauth': 'http://192.0.2.10:8080/', 'agile-api': 'http://192.0.2.10:8080' } },
    { origins: { 'agile-oauth': 'http://user:pw@192.0.2.10:8080', 'agile-api': 'http://192.0.2.10:8080' } },
    { allow_plaintext: ['http://192.0.2.99'] },
    { environment: 'staging' },
    { settings: { note: 'password=Synthetic#Pass42' } },
    { limits: { concurrency: 100 } },
  ];
  for (const overrides of cases) assert.equal(await code(k.connectors.admin.addResource(k.admin, agileInput(overrides))), 'RESOURCE_INVALID', JSON.stringify(overrides));
  assert.deepEqual(await k.connectors.admin.listResources(k.admin), []);
});

test('addresses are for admins only; the catalog port gives users nothing', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  const forAdmin = await k.connectors.admin.listResources(k.admin);
  assert.deepEqual(forAdmin, [
    { id: record.id, system_pack: 'agile-test@1.0.0', name: record.name, environment: 'test', enabled: true, origins: record.origins, allow_plaintext: record.allow_plaintext },
  ]);
  const forUser = await k.connectors.admin.listResources(k.user);
  assert.deepEqual(forUser, [{ id: record.id, system_pack: 'agile-test@1.0.0', name: record.name, environment: 'test', enabled: true }]);
  assert.deepEqual(await k.connectors.catalog.list(k.admin), forAdmin);
  assert.deepEqual(await k.connectors.catalog.list(k.user), []);
  assert.deepEqual(await k.connectors.catalog.list({ id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0t', name: 'ghost', role: 'admin' }), [], 'a principal that is not an account');
  // A demoted admin loses the view at once (the account is re-read).
  const second = await k.records.principals.createUser(k.admin, 'bob', 'admin');
  assert.equal((await k.connectors.catalog.list(second)).length, 1);
  await k.records.principals.setRole(k.admin, second.id, 'user');
  assert.deepEqual(await k.connectors.catalog.list(second), []);
});

test('disable and enable are decisions; a disabled resource reads nothing', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  assert.equal(await k.connectors.reader.accepts('agile:mindmap:abc'), true);
  assert.equal(await code(k.connectors.admin.disable(k.user, record.id)), 'ACCESS_DENIED');
  await k.connectors.admin.disable(k.admin, record.id, '维护');
  assert.equal((await k.connectors.admin.listResources(k.admin))[0].enabled, false);
  assert.equal(await k.connectors.reader.accepts('agile:mindmap:abc'), false);
  const read = await k.connectors.reader.read('agile:mindmap:abc', { principal: k.user, purpose: 'test' });
  assert.equal(read.ok, false);
  assert.equal(await code(k.connectors.admin.updateResource(k.admin, record.id, { name: 'x' })), 'RESOURCE_INVALID');
  await k.connectors.admin.enable(k.admin, record.id);
  assert.equal(await k.connectors.reader.accepts('agile:mindmap:abc'), true);
  const history = await k.records.authorizations.history({ permission: 'resource_config', object: record.id });
  assert.deepEqual(history.items.map((r) => r.body.revoked), [false, true, false], 'grant, revoke, grant (newest first)');
});

test('an update is a new definition under the same id with the same vault entries', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  const updated = await k.connectors.admin.updateResource(k.admin, record.id, { name: '改名后', settings: { roots: ['7714', '7001'] } });
  assert.equal(updated.id, record.id);
  assert.equal(updated.name, '改名后');
  assert.deepEqual(updated.credentials, record.credentials);
  assert.equal(updated.created_at, record.created_at);
  const decision = await k.records.authorizations.resourceConfig(record.id);
  assert.equal(decision?.body.bound, sha256Hex(canonicalBytes(updated)));
  assert.equal(decision?.body.supersedes !== null, true);
  assert.equal((await k.connectors.admin.listResources(k.admin))[0].name, '改名后');
});

test('credentials: admins only, declared names only, passwords kept as Base64(SHA-512)', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  assert.equal(await code(k.connectors.admin.setCredential(k.user, record.id, 'password', 'Synthetic#Pass42')), 'ACCESS_DENIED');
  assert.equal(await code(k.connectors.admin.setCredential(k.admin, record.id, 'token', 'x1234567')), 'RESOURCE_INVALID');
  assert.equal(await code(k.connectors.admin.setCredential(k.admin, record.id, 'password', 'bad\nvalue')), 'RESOURCE_INVALID');
  assert.equal(await code(k.connectors.admin.setCredential(k.admin, 'res_01jacd5z8q3w7v9h2k4m6n8p0t', 'password', 'x')), 'RESOURCE_INVALID');
  await k.connectors.admin.setCredential(k.admin, record.id, 'username', 'reader');
  await k.connectors.admin.setCredential(k.admin, record.id, 'password', 'Synthetic#Pass42');
  assert.equal(await k.records.vault.getText(record.credentials.username), 'reader');
  assert.equal(await k.records.vault.getText(record.credentials.password), createHash('sha512').update('Synthetic#Pass42').digest('base64'));
  const logged = JSON.stringify(k.log);
  assert.ok(logged.includes('credential_set'));
  assert.ok(!logged.includes('Synthetic#Pass42') && !logged.includes(createHash('sha512').update('Synthetic#Pass42').digest('base64')));
  assert.equal(await code(k.connectors.admin.loginStatus(k.user, record.id)), 'ACCESS_DENIED');
  assert.deepEqual(await k.connectors.admin.loginStatus(k.admin, record.id), { token: false, expiresAt: null, obtainedAt: null, cooldownUntil: null, failure: null, stopped: false });
});

test('an update that changes the credential set drops the vault entries it no longer declares', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  await k.connectors.admin.setCredential(k.admin, record.id, 'username', 'reader');
  await k.connectors.admin.setCredential(k.admin, record.id, 'password', 'Synthetic#Pass42');
  const system = agileSystem() as { auth: Record<string, unknown> };
  system.auth = { ...system.auth, credentials: [{ name: 'password', digest: 'sha512_base64' }], login: { ...(system.auth.login as object), body: { password: '{password}' } } };
  k.packs.set(await writePack(k.packRoot, { id: 'agile-test', version: '1.1.0', system, functions: AGILE_FUNCTIONS }));
  const updated = await k.connectors.admin.updateResource(k.admin, record.id, { system_pack: 'agile-test@1.1.0' });
  assert.deepEqual(Object.keys(updated.credentials), ['password']);
  assert.equal(await k.records.vault.getText(record.credentials.username), null, 'a credential no longer declared leaves the vault');
  assert.ok(await k.records.vault.getText(record.credentials.password), 'an unchanged one stays');
  assert.equal(await code(k.connectors.admin.resetLogin(k.user, record.id)), 'ACCESS_DENIED');
});

test('other resource configurations of the Hub (not resource ids) are not resources', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  // A configuration decision about something else, as the records package makes for an accepted credential scan.
  await k.records.authorizations.configureResource(k.admin, `scan:${'a'.repeat(64)}`, 'b'.repeat(64), 'not a resource');
  const listed = await k.connectors.admin.listResources(k.admin);
  assert.deepEqual(listed.map((row) => row.id), [record.id]);
  assert.ok(!k.log.some((event) => event.event === 'resource_unreadable'));
});
