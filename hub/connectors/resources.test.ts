// Resource administration and ResourceCatalogPort: admins decide and see addresses; users see rows without them through the
// admin API and nothing through the catalog port; definitions are content-addressed and bound by resource_config decisions;
// credentials go to the vault, passwords only as the digest their system requires; `describe` gives admins one resource's
// credential names, vault entries and digest rules, never a value.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { canonicalBytes, sha256Hex, type Vault } from '../records/api.ts';
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

test('several credentials in one call: every value is checked before any is stored, then the session is forgotten once', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  const set = (by: typeof k.admin, values: Record<string, string>) => k.connectors.admin.setCredentials(by, record.id, values);
  assert.equal(await code(set(k.user, { username: 'reader', password: 'Synthetic#Pass42' })), 'ACCESS_DENIED');
  assert.equal(await code(set(k.admin, {})), 'RESOURCE_INVALID');
  assert.equal(await code(set(k.admin, { username: 'reader', token: 'x1234567' })), 'RESOURCE_INVALID', 'an undeclared name');
  assert.equal(await code(set(k.admin, { username: 'reader', password: 'bad\nvalue' })), 'RESOURCE_INVALID', 'a value with a control character');
  assert.equal(await k.records.vault.getText(record.credentials.username), null, 'nothing stored when any value is refused');
  // A stop in the vault: one call ends it after both values are stored.
  await k.records.vault.put(`connector.${record.id}.session`, JSON.stringify({ v: 1, binding: 'x', token: null, stopped: true }));
  await set(k.admin, { username: 'reader', password: 'Synthetic#Pass42' });
  assert.equal(await k.records.vault.getText(record.credentials.username), 'reader');
  assert.equal(await k.records.vault.getText(record.credentials.password), createHash('sha512').update('Synthetic#Pass42').digest('base64'));
  assert.equal(await k.records.vault.has(`connector.${record.id}.session`), false);
  assert.deepEqual(
    k.log.filter((event) => event.event === 'credential_set').map((event) => [event.credential, event.digest]),
    [
      ['password', 'sha512_base64'],
      ['username', 'plain'],
    ],
    'in the order of the definition, whatever the order given',
  );
  // The removal fails: the message names every credential stored.
  const vault = k.records.vault;
  const refused = () => Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
  const cli = k.make({ records: { ...k.records, vault: { initKey: () => vault.initKey(), put: (n, v) => vault.put(n, v), get: (n) => vault.get(n), getText: (n) => vault.getText(n), has: (n) => vault.has(n), stat: (n) => vault.stat(n), list: () => vault.list(), remove: refused } } });
  await assert.rejects(cli.admin.setCredentials(k.admin, record.id, { username: 'reader', password: 'Synthetic#Pass43' }), (error: unknown) => error instanceof ConnectorError && error.code === 'STORE_FAILED' && /凭据 password、username 已存进密钥库.*（EACCES）/.test(error.message));
  // A value that cannot be stored after another was: the error names what was stored, and the session is kept.
  await vault.put(`connector.${record.id}.session`, JSON.stringify({ v: 1, binding: 'x', token: null, stopped: true }));
  const putRefused = (name: string) => Promise.reject(Object.assign(new Error(`ENOSPC: no space left, write ${name}`), { code: 'ENOSPC' }));
  const full = k.make({
    records: {
      ...k.records,
      vault: { initKey: () => vault.initKey(), put: (n, v) => (n === record.credentials.username ? putRefused(n) : vault.put(n, v)), get: (n) => vault.get(n), getText: (n) => vault.getText(n), has: (n) => vault.has(n), stat: (n) => vault.stat(n), list: () => vault.list(), remove: (n) => vault.remove(n) },
    },
  });
  await assert.rejects(
    full.admin.setCredentials(k.admin, record.id, { username: 'reader3', password: 'Synthetic#Pass44' }),
    (error: unknown) => error instanceof ConnectorError && error.code === 'STORE_FAILED' && /凭据 password 已存进密钥库，username 没能存进去（ENOSPC）/.test(error.message) && !error.message.includes('write'),
  );
  assert.equal(await vault.has(`connector.${record.id}.session`), true, 'no login with half of the new values: the session stays');
  assert.equal(await vault.getText(record.credentials.username), 'reader');
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
  assert.deepEqual((await k.connectors.admin.describe(k.admin, record.id))?.credentials, [{ name: 'password', entry: record.credentials.password, digest: 'sha512_base64', set: true }], 'described from the definition in force');
  assert.equal(await code(k.connectors.admin.resetLogin(k.user, record.id)), 'ACCESS_DENIED');
});

test('describe: one resource for admins, enabled or not, with its credential names, vault entries, digest rules and whether each is set; never a value', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  assert.deepEqual(await k.connectors.admin.describe(k.admin, record.id), {
    id: record.id,
    system_pack: 'agile-test@1.0.0',
    name: record.name,
    environment: 'test',
    enabled: true,
    origins: record.origins,
    allow_plaintext: record.allow_plaintext,
    credentials: [
      { name: 'password', entry: `connector.${record.id}.password`, digest: 'sha512_base64', set: false },
      { name: 'username', entry: `connector.${record.id}.username`, digest: 'plain', set: false },
    ],
  });
  await k.connectors.admin.setCredential(k.admin, record.id, 'password', 'Synthetic#Pass42');
  const described = await k.connectors.admin.describe(k.admin, record.id);
  assert.deepEqual(described?.credentials.map((c) => [c.name, c.set]), [['password', true], ['username', false]]);
  const shown = JSON.stringify(described);
  assert.ok(!shown.includes('Synthetic#Pass42') && !shown.includes(createHash('sha512').update('Synthetic#Pass42').digest('base64')), 'never a value or its digest');
  // Admins only; absent and not a resource id are null.
  assert.equal(await code(k.connectors.admin.describe(k.user, record.id)), 'ACCESS_DENIED');
  assert.equal(await code(k.connectors.admin.describe({ id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0t', name: 'ghost', role: 'admin' }, record.id)), 'ACCESS_DENIED');
  assert.equal(await k.connectors.admin.describe(k.admin, 'res_01jacd5z8q3w7v9h2k4m6n8p0t'), null);
  assert.equal(await k.connectors.admin.describe(k.admin, 'jev'), null);
  // A disabled resource is described too: its credential can be set before it is enabled again.
  await k.connectors.admin.disable(k.admin, record.id);
  assert.equal((await k.connectors.admin.describe(k.admin, record.id))?.enabled, false);
  // An anonymous system declares none; describing needs neither the system pack nor the vault key.
  const site = await k.connectors.admin.addResource(k.admin, { system_pack: 'buildsite-test', name: '合成构建站', environment: 'test', origins: { 'build-site': 'http://192.0.2.20' } });
  k.packs.remove('buildsite-test');
  k.connectors.refresh();
  assert.deepEqual((await k.connectors.admin.describe(k.admin, site.id))?.credentials, []);
  const vault = k.records.vault;
  const noKey = () => Promise.reject(new Error('密钥库主密钥不存在'));
  const keyless: Vault = { initKey: noKey, put: noKey, get: noKey, getText: noKey, has: (name) => vault.has(name), stat: (n) => vault.stat(n), list: () => vault.list(), remove: (name) => vault.remove(name) };
  const cli = k.make({ records: { ...k.records, vault: keyless } });
  assert.equal((await cli.admin.describe(k.admin, record.id))?.credentials[0].set, true, 'presence only, without the key');
});

test('a reset or a new credential whose session entry cannot be removed is an error for the admin, naming the system code and no path', async (t) => {
  const k = await kit(t);
  const record = await k.connectors.admin.addResource(k.admin, agileInput());
  await k.connectors.admin.setCredential(k.admin, record.id, 'username', 'reader');
  const vault = k.records.vault;
  const refused = () => Promise.reject(Object.assign(new Error('EACCES: permission denied, unlink synthetic-vault/connector.x.session.sealed'), { code: 'EACCES' }));
  const stuck: Vault = { initKey: () => vault.initKey(), put: (name, value) => vault.put(name, value), get: (name) => vault.get(name), getText: (name) => vault.getText(name), has: (name) => vault.has(name), stat: (n) => vault.stat(n), list: () => vault.list(), remove: refused };
  const failed = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
      return 'resolved';
    } catch (error) {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, 'STORE_FAILED');
      assert.ok(!error.message.includes('synthetic-vault'), 'no path in the message');
      return error.message;
    }
  };
  // A process without the resource's runtime (the CLI), and one whose runtime holds the session (it showed the status).
  const cli = k.make({ records: { ...k.records, vault: stuck } });
  assert.match(await failed(cli.admin.resetLogin(k.admin, record.id)), /登录状态没能从密钥库清除（EACCES）/);
  const viewer = k.make({ records: { ...k.records, vault: stuck } });
  await viewer.admin.loginStatus(k.admin, record.id);
  assert.match(await failed(viewer.admin.resetLogin(k.admin, record.id)), /EACCES/);
  assert.ok(!k.log.some((event) => event.event === 'login_reset'), 'no reset is reported that did not happen');
  assert.ok(k.log.some((event) => event.event === 'session_reset_failed'));
  assert.match(await failed(cli.admin.setCredential(k.admin, record.id, 'password', 'Synthetic#Pass42')), /凭据 password 已存进密钥库，但资源 .* 的登录状态没能清除（EACCES）/);
  assert.equal(await vault.getText(record.credentials.password), createHash('sha512').update('Synthetic#Pass42').digest('base64'), 'the value itself was stored');
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
