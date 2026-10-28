import { addSyntheticResource, setSyntheticCredential, setSyntheticCredentials, syntheticStoredCredential } from './testing/credentials.ts';
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
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
  assert.match(record.id, /^res_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.ok(Object.values(record.credentials).every(entry=>/^\$\{secret:DEMO_[A-F0-9]+\}$/.test(entry)));
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
  assert.equal(await code(addSyntheticResource(k.records, k.packs, k.connectors, k.user, agileInput())), 'ACCESS_DENIED');
  assert.equal(await code(addSyntheticResource(k.records, k.packs, k.connectors, { id: 'usr_01jacd5z8q3w7v9h2k4m6n8p0t', name: 'ghost', role: 'admin' }, agileInput())), 'ACCESS_DENIED');
  assert.equal(await code(addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput({ system_pack: 'no-such-pack' }))), 'PACK_UNAVAILABLE');
  const workflow = await writePack(k.packRoot, { id: 'not-a-system', kind: 'workflow', system: {} });
  k.packs.set(workflow);
  assert.equal(await code(addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput({ system_pack: 'not-a-system' }))), 'PACK_UNAVAILABLE');
  const cases: Record<string, unknown>[] = [
    { origins: { 'agile-api': 'http://192.0.2.10:8080' } },
    { origins: { 'agile-oauth': 'http://192.0.2.10:8080', 'agile-api': 'http://192.0.2.10:8080', other: 'http://192.0.2.10:8080' } },
    { origins: { 'agile-oauth': 'http://192.0.2.10:8080/', 'agile-api': 'http://192.0.2.10:8080' } },
    { origins: { 'agile-oauth': ["http:/","/user:","pw@192",".0.2.1","0:8080"].join(''), 'agile-api': 'http://192.0.2.10:8080' } },
    { allow_plaintext: ['http://192.0.2.99'] },
    { environment: 'staging' },
    { settings: { note: 'password=Synthetic#Pass42' } },
    { limits: { concurrency: 100 } },
  ];
  for (const overrides of cases) assert.equal(await code(addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput(overrides))), 'RESOURCE_INVALID', JSON.stringify(overrides));
  assert.deepEqual(await k.connectors.admin.listResources(k.admin), []);
});

test('addresses are for admins only; the catalog port gives users nothing', async (t) => {
  const k = await kit(t);
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
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
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
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
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
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
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
  assert.equal(await code(setSyntheticCredential(k.records, k.connectors, k.user, record.id, 'password', 'Synthetic#Pass42')), 'ACCESS_DENIED');
  assert.equal(await code(setSyntheticCredential(k.records, k.connectors, k.admin, record.id, 'token', 'x1234567')), 'RESOURCE_INVALID');
  assert.equal(await code(setSyntheticCredential(k.records, k.connectors, k.admin, record.id, 'password', 'bad\nvalue')), 'RESOURCE_INVALID');
  assert.equal(await code(setSyntheticCredential(k.records, k.connectors, k.admin, 'res_01jacd5z8q3w7v9h2k4m6n8p0t', 'password', 'x')), 'RESOURCE_INVALID');
  await setSyntheticCredential(k.records, k.connectors, k.admin, record.id, 'username', 'reader');
  await setSyntheticCredential(k.records, k.connectors, k.admin, record.id, 'password', 'Synthetic#Pass42');
  assert.equal(await syntheticStoredCredential(k.records,record,'username'), 'reader');
  assert.equal(await syntheticStoredCredential(k.records,record,'password'), createHash('sha512').update('Synthetic#Pass42').digest('base64'));
  const logged = JSON.stringify(k.log);
  assert.ok((await k.records.variables.list(k.admin)).length===2);
  assert.ok(!logged.includes('Synthetic#Pass42') && !logged.includes(createHash('sha512').update('Synthetic#Pass42').digest('base64')));
  assert.equal(await code(k.connectors.admin.loginStatus(k.user, record.id)), 'ACCESS_DENIED');
  assert.deepEqual(await k.connectors.admin.loginStatus(k.admin, record.id), { token: false, expiresAt: null, obtainedAt: null, cooldownUntil: null, failure: null, stopped: false });
});

test('several named credentials commit atomically and a failed validation leaves prior versions in force', async t=>{
  const k=await kit(t);const record=await addSyntheticResource(k.records,k.packs,k.connectors,k.admin,agileInput());
  const set=(by:typeof k.admin,values:Record<string,string>)=>setSyntheticCredentials(k.records,k.connectors,by,record.id,values);
  assert.equal(await code(set(k.user,{username:'reader',password:'Synthetic#Pass42'})),'ACCESS_DENIED');
  for(const values of ([{},{username:'reader',token:'x1234567'},{username:'reader',password:'bad\nvalue'}] as Record<string,string>[]))assert.equal(await code(set(k.admin,values)),'RESOURCE_INVALID');
  assert.deepEqual(await k.records.variables.list(k.admin),[]);
  await set(k.admin,{username:'reader',password:'Synthetic#Pass42'});
  const previous=(await k.records.variables.list(k.admin)).map(v=>v.decision.digest);
  assert.equal(await syntheticStoredCredential(k.records,record,'username'),'reader');
  assert.equal(await syntheticStoredCredential(k.records,record,'password'),createHash('sha512').update('Synthetic#Pass42').digest('base64'));
  await assert.rejects(set(k.admin,{username:'changed',password:'bad\nvalue'}));
  assert.deepEqual((await k.records.variables.list(k.admin)).map(v=>v.decision.digest),previous);
});

test('an update that changes credential declarations preserves named material shared by other consumers', async (t) => {
  const k = await kit(t);
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
  await setSyntheticCredential(k.records, k.connectors, k.admin, record.id, 'username', 'reader');
  await setSyntheticCredential(k.records, k.connectors, k.admin, record.id, 'password', 'Synthetic#Pass42');
  const system = agileSystem() as { auth: Record<string, unknown> };
  system.auth = { ...system.auth, credentials: [{ name: 'password', digest: 'sha512_base64' }], login: { ...(system.auth.login as object), body: { password: '{password}' } } };
  k.packs.set(await writePack(k.packRoot, { id: 'agile-test', version: '1.1.0', system, functions: AGILE_FUNCTIONS }));
  const updated = await k.connectors.admin.updateResource(k.admin, record.id, { system_pack: 'agile-test@1.1.0' });
  assert.deepEqual(Object.keys(updated.credentials), ['password']);
  assert.equal(await syntheticStoredCredential(k.records,record,'username'),'reader','removing a consumer does not delete named material');
  assert.ok(await syntheticStoredCredential(k.records,record,'password'), 'an unchanged one stays');
  assert.deepEqual((await k.connectors.admin.describe(k.admin,record.id))?.credentials.map(c=>[c.name,c.set,c.version,c.registered]),[['password',true,1,true]]);
  assert.equal(await code(k.connectors.admin.resetLogin(k.user, record.id)), 'ACCESS_DENIED');
});

test('describe: one resource for admins, enabled or not, with its credential names, vault entries, digest rules and whether each is set; never a value', async (t) => {
  const k = await kit(t);
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
  assert.deepEqual(await k.connectors.admin.describe(k.admin, record.id), {
    id: record.id,
    system_pack: 'agile-test@1.0.0',
    name: record.name,
    environment: 'test',
    enabled: true,
    origins: record.origins,
    allow_plaintext: record.allow_plaintext,
    credentials: [
      { name: 'password', entry: record.credentials.password, digest: 'sha512_base64', set: false },
      { name: 'username', entry: record.credentials.username, digest: 'plain', set: false },
    ],
  });
  await setSyntheticCredential(k.records, k.connectors, k.admin, record.id, 'password', 'Synthetic#Pass42');
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
  const site = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, { system_pack: 'buildsite-test', name: '合成构建站', environment: 'test', origins: { 'build-site': 'http://192.0.2.20' } });
  k.packs.remove('buildsite-test');
  k.connectors.refresh();
  assert.deepEqual((await k.connectors.admin.describe(k.admin, site.id))?.credentials, []);
  const vault = k.records.vault;
  const noKey = () => Promise.reject(new Error('密钥库主密钥不存在'));
  const keyless: Vault = { initKey: noKey, put: noKey, get: noKey, getText: noKey, has: (name) => vault.has(name), stat: (n) => vault.stat(n), list: () => vault.list(), remove: (name) => vault.remove(name) };
  const cli = k.make({ records: { ...k.records, vault: keyless } });
  assert.equal((await cli.admin.describe(k.admin, record.id))?.credentials[0].set, true, 'presence only, without the key');
});

test('a reset whose session entry cannot be removed is an error for the admin, naming the system code and no path', async (t) => {
  const k = await kit(t);
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
  await setSyntheticCredential(k.records, k.connectors, k.admin, record.id, 'username', 'reader');
  await setSyntheticCredential(k.records,k.connectors,k.admin,record.id,'password','Synthetic#Pass42');
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

});

test('other resource configurations of the Hub (not resource ids) are not resources', async (t) => {
  const k = await kit(t);
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());
  // A configuration decision about something else, as the records package makes for an accepted credential scan.
  await k.records.authorizations.configureResource(k.admin, `scan:${'a'.repeat(64)}`, 'b'.repeat(64), 'not a resource');
  const listed = await k.connectors.admin.listResources(k.admin);
  assert.deepEqual(listed.map((row) => row.id), [record.id]);
  assert.ok(!k.log.some((event) => event.event === 'resource_unreadable'));
});

test('updateResource prunes stale allow_plaintext when origins change without explicit allow_plaintext, keeps it when origins unchanged or roles kept', async (t) => {
  const k = await kit(t);
  const record = await addSyntheticResource(k.records, k.packs, k.connectors, k.admin, agileInput());

  const renamed = await k.connectors.admin.updateResource(k.admin, record.id, { name: '新名字', settings: { roots: ['7714', '7001'] } });
  assert.deepEqual(renamed.allow_plaintext, ['http://192.0.2.10:8080']);

  const moved = await k.connectors.admin.updateResource(k.admin, record.id, {
    origins: { 'agile-oauth': 'https://oauth.example.invalid', 'agile-api': 'https://api.example.invalid' },
  });
  assert.deepEqual(moved.allow_plaintext, []);

  const withPlain = await k.connectors.admin.updateResource(k.admin, record.id, {
    origins: { 'agile-oauth': 'http://192.0.2.30:8080', 'agile-api': 'http://192.0.2.30:8080' },
    allow_plaintext: ['http://192.0.2.30:8080'],
  });
  assert.deepEqual(withPlain.allow_plaintext, ['http://192.0.2.30:8080']);

  const partial = await k.connectors.admin.updateResource(k.admin, record.id, {
    origins: { 'agile-oauth': 'https://oauth.example.invalid', 'agile-api': 'http://192.0.2.30:8080' },
  });
  assert.deepEqual(partial.allow_plaintext, ['http://192.0.2.30:8080']);
});
