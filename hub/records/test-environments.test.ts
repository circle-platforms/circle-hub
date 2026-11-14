import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { Database, createPool } from './db.ts';
import { canonicalBytes } from './canonical.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { TEST_ENVIRONMENT_CONFIG_PREFIX, TEST_ENVIRONMENT_INHERITANCE_KEY } from '../../contracts/api.ts';
import { definition } from '../dispatch/testing/definition.ts';
import { newId } from './ids.ts';
import type { TestEnvironmentInheritanceSources, TestEnvironmentInput } from './api.ts';

async function fixture() {
  const kit = await openTestRecords({ initKey: false });
  const db = new Database(createPool(kit.database, 2));
  const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
  const member = await kit.principals.createUser(admin, 'synthetic-member');
  const other = await kit.principals.createUser(admin, 'synthetic-other');
  const at = new Date().toISOString();
  const evidence = await kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'declared', body: { action: 'validate', run: null, item: null, inputs: [], component: 'synthetic-inheritance@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail: {} } });
  const executors: ExecutorSource[] = [];
  async function executor(target = 'synthetic-bed', resources = ['synthetic/device/a']) {
    const source = ExecutorSource.parse({ ...definition('http://127.0.0.1:9/mcp'), id: newId('exe'), target, resources });
    const object = await kit.objects.put(canonicalBytes(source), 'application/json');
    await kit.authorizations.configureResource(admin, 'executor.' + source.id, object.sha256);
    executors.push(source); return source;
  }
  const sources: TestEnvironmentInheritanceSources = { collect: async ctx => {
    assert.equal((await ctx.store.get(evidence.digest, ctx.tx))?.digest, evidence.digest);
    const references = [evidence.digest, ...ctx.authorizations.map(row => row.digest)];
    return { workflows: [{ id: 'synthetic-workflow', prefix: 'synthetic/', installedMethod: false, sourceRecords: [evidence.digest] }], executors, sourceRecords: references };
  } };
  const input = (name = '合成测试环境', target = 'synthetic-bed'): TestEnvironmentInput => ({ name, target, prefixes: [{ prefix: 'synthetic/device/', owner: member.id, registered_at: at }], resources: [], executors: [], enabled: true, missing_facts: [] });
  return { kit, db, admin, member, other, at, executor, executors, sources, input, close: async () => { await db.end(); await kit.close(); } };
}

test('ordinary catalog enforces unique names and targets, preserves ownership and never reuses a deleted identity', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const catalog = f.kit.testEnvironments;
    const environment = await catalog.register(f.admin, f.input());
    await assert.rejects(catalog.register(f.admin, f.input('合成测试环境', 'other-target')), /名字或目标/);
    await assert.rejects(catalog.register(f.admin, f.input('另一名字', 'synthetic-bed')), /名字或目标/);
    await assert.rejects(catalog.register({ ...f.member, role: 'admin' }, f.input('伪造名字', 'other-target')), /真实管理员/);
    assert.deepEqual(await catalog.ownership(), { prefixes: [{ prefix: 'synthetic/device/', owner: f.admin.id }], resources: [] });
    await f.kit.authorizations.grant(f.admin, { permission: 'resource_assign', subject: f.member.id, object: environment.id });
    assert.equal(await catalog.canUse(f.member, environment.id), true);
    assert.equal(await catalog.canUse(f.admin, environment.id), false);
    await catalog.update(f.admin, environment.id, f.input('改名后的环境'));
    assert.equal((await catalog.get(f.admin, environment.id))?.id, environment.id);
    await assert.rejects(catalog.update(f.admin, environment.id, f.input('换目标', 'different-target')), /目标身份不能更换/);
    await catalog.remove(f.admin, environment.id);
    assert.equal(await catalog.canUse(f.member, environment.id), false);
    const replacement = await catalog.register(f.admin, f.input());
    assert.notEqual(replacement.id, environment.id);
    assert.equal(await catalog.canUse(f.member, replacement.id), false);
  } finally { await f.close(); }
});

test('catalog registration rejects foreign executor targets and current executor drift refuses only matching use', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const executor = await f.executor();
    await assert.rejects(f.kit.testEnvironments.register(f.admin, { ...f.input('错误目标', 'different-target'), executors: [executor.id!] }), /目标或资源/);
    const environment = await f.kit.testEnvironments.register(f.admin, { ...f.input(), executors: [executor.id!] });
    assert.equal((await f.kit.testEnvironments.resolve(['synthetic/device/a']))[0].id, environment.id);
    const changed = await f.kit.objects.put(canonicalBytes({ ...executor, target: 'different-target' }), 'application/json');
    await f.kit.authorizations.configureResource(f.admin, 'executor.' + executor.id, changed.sha256);
    await assert.rejects(f.kit.testEnvironments.resolve(['synthetic/device/a']), /目标或资源/);
    assert.deepEqual(await f.kit.testEnvironments.resolve(['unrelated/key']), []);
  } finally { await f.close(); }
});

test('one conversion keeps account, team and whole-Hub subjects, real owner facts and never regrants after revocation', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    await f.executor(); await f.executor('synthetic-bed', ['synthetic/device/b']);
    const team = await f.kit.teams.create(f.admin, 'synthetic-team');
    await f.kit.teams.add(f.admin, team.id, f.other.id);
    for (const subject of [f.member.id, team.id, '*']) await f.kit.authorizations.grant(f.admin, { permission: 'assign', subject, object: 'synthetic-workflow', expiresAt: subject === f.member.id ? '2099-01-01T00:00:00.000Z' : null });
    // Historical M1 registration state, constructed only in this synthetic scratch database.
    await f.db.query('INSERT INTO lease_registrations(prefix,owner,registered_at) VALUES($1,$2,$3),($4,$2,$3)', ['synthetic/device/', f.member.id, f.at, 'unbound/owner/']);
    const before = (await f.db.query('SELECT * FROM leases ORDER BY key')).rows;
    assert.equal((await f.kit.testEnvironments.inheritance()).completed, false);
    const receipt = await f.kit.testEnvironments.inherit(f.admin, f.sources);
    assert.equal(receipt.assignments, 3);
    assert.equal((await f.kit.testEnvironments.inheritance()).completed, true);
    const environments = await f.kit.testEnvironments.list(f.admin);
    const environment = environments.find(value => value.target === 'synthetic-bed')!;
    assert.equal(environment.executors.length, 2);
    assert.deepEqual(environment.prefixes, [{ prefix: 'synthetic/device/', owner: f.member.id, registered_at: f.at }]);
    const unbound = environments.find(value => value.target === null)!;
    assert.deepEqual(unbound.prefixes, [{ prefix: 'unbound/owner/', owner: f.member.id, registered_at: f.at }]);
    assert.deepEqual(unbound.executors, []);
    assert.equal((await f.kit.testEnvironments.ownership()).prefixes.length, 2);
    assert.equal((await f.kit.authorizations.latest('resource_assign', f.member.id, environment.id))?.body.expires_at, '2099-01-01T00:00:00.000Z');
    for (const subject of [f.member.id, team.id, '*']) await f.kit.authorizations.unassignResource(f.admin, environment.id, subject);
    assert.equal(await f.kit.testEnvironments.canUse(f.member, environment.id), false);
    assert.equal((await f.kit.testEnvironments.inherit(f.admin, f.sources)).assignments, 0);
    assert.equal(await f.kit.testEnvironments.canUse(f.member, environment.id), false);
    const later = await f.kit.testEnvironments.register(f.admin, f.input('切点后的环境', 'later-target'));
    assert.equal(await f.kit.testEnvironments.canUse(f.member, later.id), false);
    assert.deepEqual((await f.db.query('SELECT * FROM leases ORDER BY key')).rows, before);
  } finally { await f.close(); }
});

test('reserved completion cannot be forged or revoked through ordinary APIs and unreadable history never becomes first conversion', { timeout: 120000 }, async t => {
  const f = await fixture();
  try {
    const input = { permission: 'resource_config' as const, subject: '*', object: TEST_ENVIRONMENT_INHERITANCE_KEY, bound: 'a'.repeat(64) };
    await assert.rejects(f.kit.authorizations.grant(f.admin, input), /正式目录操作/);
    await assert.rejects(f.kit.authorizations.revoke(f.admin, input), /正式目录操作/);
    await assert.rejects(f.kit.authorizations.configureResource(f.admin, input.object, input.bound), /正式目录操作/);
    await assert.rejects(f.kit.store.put({ kind: 'authorization', schema: 'authorization@1', provenance: 'declared', body: { ...input, revoked: false } }), /正式目录操作/);
    const receipt = await f.kit.testEnvironments.inherit(f.admin, f.sources);
    assert.equal(receipt.assignments, 0, 'genuinely empty conversion still records completion');
    const marker = await f.kit.authorizations.latest('resource_config', '*', input.object);
    assert.ok(marker?.body.bound);
    const original = f.kit.objects.get.bind(f.kit.objects);
    t.mock.method(f.kit.objects, 'get', async (...args: Parameters<typeof original>) => args[0] === marker!.body.bound ? null : original(...args));
    assert.equal((await f.kit.testEnvironments.inheritance()).completed, null);
    await assert.rejects(f.kit.testEnvironments.inherit(f.admin, f.sources), /完成事实/);
  } finally { await f.close(); }
});

test('a failure after directory creation rolls back all environment, assignment and completion decisions', { timeout: 120000 }, async t => {
  const f = await fixture();
  try {
    await f.executor();
    await f.kit.authorizations.grant(f.admin, { permission: 'assign', subject: f.member.id, object: 'synthetic-workflow' });
    const before = (await f.db.query('SELECT digest FROM records ORDER BY seq')).rows;
    const original = f.kit.authorizations.grant.bind(f.kit.authorizations);
    t.mock.method(f.kit.authorizations, 'grant', async (...args: Parameters<typeof original>) => {
      if (args[1].permission === 'resource_assign') throw new Error('synthetic assignment failure');
      return original(...args);
    });
    await assert.rejects(f.kit.testEnvironments.inherit(f.admin, f.sources), /synthetic assignment failure/);
    assert.deepEqual((await f.db.query('SELECT digest FROM records ORDER BY seq')).rows, before);
    assert.deepEqual(await f.kit.testEnvironments.list(f.admin), []);
    assert.equal((await f.kit.testEnvironments.inheritance()).completed, false);
    assert.equal(await f.kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_INHERITANCE_KEY), null);
    assert.equal((await f.kit.authorizations.history({ permission: 'resource_config' })).items.some(row => row.body.object.startsWith(TEST_ENVIRONMENT_CONFIG_PREFIX)), false);
  } finally { await f.close(); }
});
