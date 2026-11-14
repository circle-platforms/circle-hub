import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openTestRecords } from '../testing/records.ts';
import { Database, createPool } from './db.ts';
import { canonicalBytes } from './canonical.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { TestEnvironment, TestEnvironmentInheritanceCompletion, TEST_ENVIRONMENT_CONFIG_PREFIX, TEST_ENVIRONMENT_INHERITANCE_KEY } from '../../contracts/api.ts';
import { LeaseService } from '../leases/api.ts';
import { definition } from '../dispatch/testing/definition.ts';
import { newId } from './ids.ts';
import { openRecords, withEnvironmentPermissionLock, EnvironmentWriteError, type RecordsKit, type AuthorizationRecord, type TestEnvironmentInheritanceSources, type TestEnvironmentInput } from './api.ts';
import { environmentProgramWrite } from './environment-program-write.ts';

async function fixture(initKey = false) {
  const kit = await openTestRecords({ initKey });
  const db = new Database(createPool(kit.database, 2));
  const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
  const member = await kit.principals.createUser(admin, 'synthetic-member');
  const other = await kit.principals.createUser(admin, 'synthetic-other');
  const at = new Date().toISOString();
  const evidence = await kit.store.put({ kind: 'action', schema: 'action@1', provenance: 'declared', body: { action: 'validate', run: null, item: null, inputs: [], component: 'synthetic-inheritance@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail: {} } });
  const executors: ExecutorSource[] = [];
  async function executor(target = 'synthetic-bed', resources = ['synthetic/device/a'], credential?: string) {
    const source = ExecutorSource.parse({ ...definition('http://127.0.0.1:9/mcp'), id: newId('exe'), target, resources, ...(credential === undefined ? {} : { credential }) });
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
  // Test-only historical state: canonical append, not an ordinary configuration API or a production exemption.
  async function historicalConfiguration(object: string, value: unknown) {
    await kit.store.withTransaction(tx => environmentProgramWrite(tx, async () => {
      const previous = (await kit.store.find<AuthorizationRecord['body']>({ kind: 'authorization', key: 'authz.key', value: `resource_config|*|${object}`, newestFirst: true, limit: 1 }, tx)).items[0];
      const stored = await kit.objects.put(canonicalBytes(value), 'application/json', tx);
      const body: AuthorizationRecord['body'] = { permission: 'resource_config', subject: '*', object, revoked: false, bound: stored.sha256, decided_by: admin.id, decided_at: new Date().toISOString(), expires_at: null, note: 'synthetic preexisting inconsistent state', supersedes: previous?.digest ?? null };
      await kit.store.put({ kind: 'authorization', schema: 'authorization@1', provenance: 'declared', body, index: [
        { key: 'authz.key', value: `resource_config|*|${object}` }, { key: 'authz.subject', value: 'resource_config|*' },
        { key: 'authz.object', value: 'resource_config|' + object }, { key: 'authz.permission', value: 'resource_config' },
        { key: 'authz.subject-any', value: '*' }, { key: 'authz.object-any', value: object }, { key: 'authz.decider', value: admin.id },
      ] }, tx);
    }));
  }
  return { kit, db, admin, member, other, at, executor, executors, sources, input, historicalConfiguration, close: async () => { await db.end(); await kit.close(); } };
}

test('ordinary catalog enforces unique names and targets, preserves ownership and never reuses a deleted identity', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const catalog = f.kit.testEnvironments;
    const environment = await catalog.register(f.admin, f.input());
    await assert.rejects(catalog.register(f.admin, f.input('合成测试环境', 'other-target')), /名字或目标/);
    await assert.rejects(catalog.register(f.admin, f.input('另一名字', 'synthetic-bed')), /名字或目标/);
    await assert.rejects(catalog.register({ ...f.member, role: 'admin' }, f.input('伪造名字', 'other-target')), /真实管理员/);
    assert.deepEqual(await catalog.ownership(), { prefixes: [{ prefix: 'synthetic/device/', owner: f.member.id }], resources: [] });
    await f.kit.authorizations.grant(f.admin, { permission: 'resource_assign', subject: f.member.id, object: environment.id });
    assert.equal(await catalog.canUse(f.member, environment.id), true);
    assert.equal(await catalog.canUse(f.admin, environment.id), false);
    await assert.rejects(catalog.update(f.admin, environment.id, { ...f.input(), prefixes: [{ ...f.input().prefixes[0], owner: f.other.id }] }), /责任人不能/);
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
    await assert.rejects(f.kit.testEnvironments.register(f.admin, { ...f.input('错误目标', 'different-target'), executors: [executor.id!] }), error => error instanceof EnvironmentWriteError && error.code === 'SUBMISSION_SCHEMA_VIOLATION' && error.detail.expected_target === 'different-target' && error.detail.proposed_target === 'synthetic-bed');
    const environment = await f.kit.testEnvironments.register(f.admin, { ...f.input(), executors: [executor.id!] });
    assert.equal((await f.kit.testEnvironments.resolve(['synthetic/device/a'])).environments[0].id, environment.id);
    const changed = await f.kit.objects.put(canonicalBytes({ ...executor, target: 'different-target' }), 'application/json');
    await assert.rejects(f.kit.authorizations.configureResource(f.admin, 'executor.' + executor.id, changed.sha256), EnvironmentWriteError);
    await f.historicalConfiguration('executor.' + executor.id, { ...executor, target: 'different-target' });
    await assert.rejects(f.kit.testEnvironments.resolve(['synthetic/device/a']), /目标或资源/);
    assert.deepEqual(await f.kit.testEnvironments.resolve(['unrelated/key']), { environments: [], unregistered: [] });
  } finally { await f.close(); }
});

test('one conversion keeps account, team and whole-Hub subjects, real owner facts and never regrants after revocation', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    await f.executor(); await f.executor('synthetic-bed', ['synthetic/device/b']);
    await f.executor('another-bed', ['another/device/a']);
    const team = await f.kit.teams.create(f.admin, 'synthetic-team');
    await f.kit.teams.add(f.admin, team.id, f.other.id);
    for (const subject of [f.member.id, team.id, '*']) await f.kit.authorizations.grant(f.admin, { permission: 'assign', subject, object: 'synthetic-workflow', expiresAt: subject === f.member.id ? '2099-01-01T00:00:00.000Z' : null });
    // Historical M1 registration state, constructed only in this synthetic scratch database.
    await f.db.query('INSERT INTO lease_registrations(prefix,owner,registered_at) VALUES($1,$2,$3),($4,$2,$3)', ['synthetic/device/', f.member.id, f.at, 'unbound/owner/']);
    const booked = await new LeaseService(f.db).acquire({ keys: ['synthetic/device/a'], prefix: 'synthetic/', ttlSeconds: 900, maxTtlSeconds: 3600, holder: { user: f.member.id, run: newId('run') } });
    assert.ok(booked.ok);
    const before = (await f.db.query('SELECT * FROM leases ORDER BY key')).rows;
    assert.equal(before.length, 1, 'preservation checks a real preexisting reservation, not an empty table');
    assert.equal((await f.kit.testEnvironments.inheritance()).completed, false);
    const receipt = await f.kit.testEnvironments.inherit(f.admin, f.sources);
    assert.equal(receipt.assignments, 6);
    assert.equal((await f.kit.testEnvironments.inheritance()).completed, true);
    const environments = await f.kit.testEnvironments.list(f.admin);
    const environment = environments.find(value => value.target === 'synthetic-bed')!;
    assert.equal(environment.executors.length, 2);
    assert.equal(environment.name, 'synthetic-bed');
    assert.equal(environments.filter(value => value.name === null).length, 1);
    assert.deepEqual(environment.prefixes, [{ prefix: 'synthetic/device/', owner: f.member.id, registered_at: f.at }]);
    const otherNamespace = environments.find(value => value.target === 'another-bed')!;
    assert.equal(otherNamespace.name, 'another-bed');
    assert.ok(await f.kit.authorizations.latest('resource_assign', f.member.id, otherNamespace.id), 'qualified workflow audience inherits the whole existing environment set, not only its matching prefix');
    const unbound = environments.find(value => value.target === null)!;
    assert.deepEqual(unbound.prefixes, [{ prefix: 'unbound/owner/', owner: f.member.id, registered_at: f.at }]);
    assert.deepEqual(unbound.executors, []);
    assert.equal(unbound.isTestEnvironment, false);
    assert.equal(await f.kit.authorizations.latest('resource_assign', f.member.id, unbound.id), null);
    assert.equal(await f.kit.testEnvironments.canUse(f.member, unbound.id), false);
    const resolution = await f.kit.testEnvironments.resolve(['unbound/owner/key']);
    assert.deepEqual(resolution.environments, []);
    assert.equal(resolution.unregistered[0].id, unbound.id);
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

test('formal booking-prefix registration is not an environment and adoption archives its old identity with zero automatic grants', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const prefix = await f.kit.testEnvironments.registerBookingPrefix(f.admin, { prefix: 'ordinary/', owner: f.member.id });
    assert.equal(prefix.isTestEnvironment, false);
    assert.equal(prefix.isBookingPrefix, true);
    assert.deepEqual(prefix.missing_facts, []);
    await assert.rejects(f.kit.authorizations.grant(f.admin, { permission: 'resource_assign', subject: f.member.id, object: prefix.id }), /有目标的测试环境/);
    const resolution = await f.kit.testEnvironments.resolve(['ordinary/key']);
    assert.deepEqual(resolution.environments, []);
    assert.equal(resolution.unregistered[0].id, prefix.id);
    const environment = await f.kit.testEnvironments.register(f.admin, { ...f.input('由前缀登记的新环境', 'new-target'), prefixes: prefix.prefixes });
    assert.notEqual(environment.id, prefix.id);
    assert.deepEqual(environment.prefixes, prefix.prefixes);
    assert.equal(await f.kit.testEnvironments.get(f.admin, prefix.id), null);
    assert.equal((await f.kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_CONFIG_PREFIX + prefix.id))?.body.revoked, true);
    assert.equal(await f.kit.authorizations.latest('resource_assign', f.member.id, environment.id), null);
    assert.equal(await f.kit.testEnvironments.canUse(f.member, environment.id), false);
    assert.equal((await f.kit.testEnvironments.ownership()).prefixes.filter(row => row.prefix === 'ordinary/').length, 1);
  } finally { await f.close(); }
});

test('a non-environment prefix preserves complete lease refusal and ownership results across conversion and still permits ordinary booking', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const prefix = 'ordinary/', keys = ['ordinary/key'], holder = { user: f.member.id, run: newId('run') };
    await f.kit.authorizations.grant(f.admin, { permission: 'assign', subject: f.member.id, object: 'ordinary-workflow' });
    await f.db.query('INSERT INTO lease_registrations(prefix,owner,registered_at) VALUES($1,$2,$3)', [prefix, f.member.id, f.at]);
    // Test-only historical input adapter, never a runtime fallback: before conversion the prefix table is the source.
    const beforeService = new LeaseService(f.db, { records: f.kit.store, now: async () => new Date(f.at), catalog: { ownership: async tx => ({ prefixes: (await f.db.query<{ prefix: string; owner: string }>('SELECT prefix,owner FROM lease_registrations ORDER BY prefix', [], tx)).rows, resources: [] }) } });
    const input = { keys, prefix, holder, ttlSeconds: 900, maxTtlSeconds: 3600 };
    assert.equal(await f.kit.authorizations.canUse(f.member.id, 'ordinary-workflow'), true);
    const first = await beforeService.acquire(input);
    assert.ok(first.ok);
    const busyBefore = await beforeService.acquire(input);
    assert.equal(busyBefore.ok, false);
    const deniedCleanupBefore = await beforeService.forceRelease({ keys, by: f.other.id, owner: f.other.id, reason: 'synthetic wrong owner' });
    const registrationsBefore = await beforeService.registrations('');
    const leaseBytes = (await f.db.query('SELECT * FROM leases ORDER BY key')).rows;
    const sources: TestEnvironmentInheritanceSources = { collect: async ctx => {
      const original = await f.sources.collect(ctx);
      return { ...original, workflows: [{ ...original.workflows[0], id: 'ordinary-workflow', prefix }] };
    } };
    assert.equal((await f.kit.testEnvironments.inherit(f.admin, sources)).assignments, 0);
    const resolution = await f.kit.testEnvironments.resolve(keys);
    assert.deepEqual(resolution.environments, []);
    assert.equal(resolution.unregistered.length, 1);
    assert.deepEqual(resolution.unregistered[0].prefixes, [{ prefix, owner: f.member.id, registered_at: f.at }]);
    const afterService = new LeaseService(f.db, { records: f.kit.store, now: async () => new Date(f.at), catalog: f.kit.testEnvironments });
    assert.deepEqual(await afterService.registrations(''), registrationsBefore);
    assert.deepEqual(await afterService.acquire(input), busyBefore, 'all actual refusal fields, including holder and earliest-free evidence, remain identical');
    assert.deepEqual(await afterService.forceRelease({ keys, by: f.other.id, owner: f.other.id, reason: 'synthetic wrong owner' }), deniedCleanupBefore);
    assert.deepEqual((await f.db.query('SELECT * FROM leases ORDER BY key')).rows, leaseBytes);
    assert.equal(await f.kit.authorizations.canUse(f.member.id, 'ordinary-workflow'), true);
    assert.equal((await afterService.release({ keys, holder })).ok, true);
    const next = await afterService.acquire(input);
    assert.ok(next.ok, 'ordinary booking after explicit release still succeeds without an environment assignment');
    assert.deepEqual(next.keys, first.keys);
    assert.equal(next.until, first.until);
    assert.notEqual(next.lease, first.lease, 'new real booking must have a new identity');
    assert.equal(next.token, first.token + 2, 'release and reacquire keep the actual fencing progression');
  } finally { await f.close(); }
});

test('only the bounded definition restore reproduces disabled nondeleted responsibility and environment grants without enabling the account', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    await f.kit.principals.setDisabled(f.admin, f.member.id, true);
    await assert.rejects(f.kit.testEnvironments.register(f.admin, f.input()), /责任账户/);
    await assert.rejects(f.kit.testEnvironments.registerBookingPrefix(f.admin, { prefix: 'ordinary/', owner: f.member.id }), /责任账户/);
    await assert.rejects(f.kit.testEnvironments.registerFromDefinition({ ...f.member, role: 'admin' }, f.input()), /真实管理员/);
    const environment = await f.kit.testEnvironments.registerFromDefinition(f.admin, f.input());
    assert.equal(environment.prefixes[0].owner, f.member.id);
    const prefix = await f.kit.testEnvironments.registerBookingPrefixFromDefinition(f.admin, { prefix: 'ordinary/', owner: f.member.id });
    assert.equal(prefix.prefixes[0].owner, f.member.id);
    assert.equal(prefix.isTestEnvironment, false);
    const restored = await f.kit.testEnvironments.assignFromDefinition(f.admin, { environment: environment.id, subject: f.member.id, expiresAt: '2099-01-01T00:00:00.000Z' });
    assert.equal(restored.body.decided_by, f.admin.id);
    assert.equal(restored.body.subject, f.member.id);
    assert.equal(restored.body.expires_at, '2099-01-01T00:00:00.000Z');
    assert.equal((await f.kit.principals.get(f.member.id))?.disabled, true);
    assert.equal(await f.kit.testEnvironments.canUse(f.member, environment.id), false);
    await assert.rejects(f.kit.authorizations.grant(f.admin, { permission: 'resource_assign', subject: f.member.id, object: environment.id }), /分配对象不存在或未启用/);
    // Existing deleted source state in a synthetic fixture is never admitted, even by the restore capability.
    await f.kit.principals.setDisabled(f.admin, f.other.id, true);
    await f.db.query('UPDATE users SET deleted_at=$1 WHERE id=$2', [new Date().toISOString(), f.other.id]);
    await assert.rejects(f.kit.testEnvironments.registerFromDefinition(f.admin, { ...f.input('删除账户不能恢复', 'other-target'), prefixes: [{ ...f.input().prefixes[0], owner: f.other.id }] }), /责任账户/);
    await assert.rejects(f.kit.testEnvironments.assignFromDefinition(f.admin, { environment: environment.id, subject: f.other.id }), /分配对象不存在或未启用/);
  } finally { await f.close(); }
});

test('explicit reassignment from a disabled owner appends responsibility without changing grants or releasing the old reservation', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const environment = await f.kit.testEnvironments.register(f.admin, f.input());
    const config = await f.kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_CONFIG_PREFIX + environment.id);
    assert.ok(config?.body.bound);
    const grant = await f.kit.authorizations.grant(f.admin, { permission: 'resource_assign', subject: f.member.id, object: environment.id });
    const booked = await new LeaseService(f.db, { records: f.kit.store, catalog: f.kit.testEnvironments }).acquire({ keys: ['synthetic/device/a'], prefix: 'synthetic/', ttlSeconds: 900, maxTtlSeconds: 3600, holder: { user: f.member.id, run: newId('run') } });
    assert.ok(booked.ok);
    const leaseBytes = (await f.db.query('SELECT * FROM leases ORDER BY key')).rows;
    await f.kit.principals.setDisabled(f.admin, f.member.id, true);
    const changed = await f.kit.testEnvironments.reassignOwner(f.admin, environment.id, { prefix: 'synthetic/device/', owner: f.other.id });
    assert.equal(changed.id, environment.id);
    assert.equal(changed.target, environment.target);
    assert.equal(changed.prefixes[0].owner, f.other.id);
    const original = TestEnvironment.parse(JSON.parse(Buffer.from((await f.kit.objects.get(config.body.bound))!).toString()));
    assert.equal(original.prefixes[0].owner, f.member.id);
    assert.equal((await f.kit.authorizations.latest('resource_assign', f.member.id, environment.id))?.digest, grant.digest);
    assert.equal(await f.kit.authorizations.latest('resource_assign', f.other.id, environment.id), null);
    assert.equal(await f.kit.testEnvironments.canUse(f.member, environment.id), false);
    assert.equal(await f.kit.testEnvironments.canUse(f.other, environment.id), false);
    assert.deepEqual((await f.db.query('SELECT * FROM leases ORDER BY key')).rows, leaseBytes);
    await assert.rejects(f.kit.testEnvironments.reassignOwner(f.admin, environment.id, { prefix: 'synthetic/device/', owner: f.member.id }), /当前启用/);
  } finally { await f.close(); }
});

test('assigned disabled environments remain visible with unchanged holdings while use and unassigned target disclosure stay denied', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const environment = await f.kit.testEnvironments.register(f.admin, f.input());
    const other = await f.kit.testEnvironments.register(f.admin, { ...f.input('未分配的另一环境', 'unassigned-target'), prefixes: [{ ...f.input().prefixes[0], prefix: 'unassigned/' }] });
    const grant = await f.kit.authorizations.grant(f.admin, { permission: 'resource_assign', subject: f.member.id, object: environment.id });
    const booked = await new LeaseService(f.db, { records: f.kit.store, catalog: f.kit.testEnvironments }).acquire({ keys: ['synthetic/device/a'], prefix: 'synthetic/', ttlSeconds: 900, maxTtlSeconds: 3600, holder: { user: f.member.id, run: newId('run') } });
    assert.ok(booked.ok);
    const held = (await f.db.query('SELECT * FROM leases ORDER BY key')).rows;
    await f.kit.testEnvironments.update(f.admin, environment.id, { ...f.input(), enabled: false });
    const visible = await f.kit.testEnvironments.list(f.member);
    assert.deepEqual(visible.map(value => value.id), [environment.id]);
    assert.equal(visible[0].enabled, false);
    assert.equal((await f.kit.authorizations.latest('resource_assign', f.member.id, environment.id))?.digest, grant.digest);
    assert.equal(await f.kit.testEnvironments.canUse(f.member, environment.id), false);
    assert.equal(await f.kit.testEnvironments.get(f.member, other.id), null);
    assert.deepEqual((await f.db.query('SELECT * FROM leases ORDER BY key')).rows, held);
    await f.kit.principals.setDisabled(f.admin, f.member.id, true);
    assert.deepEqual(await f.kit.testEnvironments.list(f.member), []);
  } finally { await f.close(); }
});

test('a configured ordinary target variable inherits and validates on a pool of one without secrets, and later changes never move rights or old state', { timeout: 120000 }, async t => {
  const f = await fixture(true);
  let single: RecordsKit | undefined;
  try {
    const variable = await f.kit.variables.setVariable(f.admin, 'SYNTHETIC_TARGET', 'synthetic-bed', 'owner-approved target', { notSecret: true });
    const executor = await f.executor('${var:SYNTHETIC_TARGET}', ['synthetic/device/a'], '${secret:SYNTHETIC_KEY}');
    await f.kit.authorizations.grant(f.admin, { permission: 'assign', subject: f.member.id, object: 'synthetic-workflow' });
    await f.db.query('INSERT INTO lease_registrations(prefix,owner,registered_at) VALUES($1,$2,$3)', ['synthetic/device/', f.member.id, f.at]);
    const booked = await new LeaseService(f.db, { records: f.kit.store }).acquire({ keys: ['synthetic/device/a'], prefix: 'synthetic/', ttlSeconds: 900, maxTtlSeconds: 3600, holder: { user: f.member.id, run: newId('run') } });
    assert.ok(booked.ok);
    const leaseBytes = (await f.db.query('SELECT * FROM leases ORDER BY key')).rows;
    let secretReads = 0;
    single = await openRecords({ database: f.kit.database, dataDir: f.kit.dataDir, logDir: f.kit.config.logDir, limits: f.kit.config.limits }, { migrate: false, maxConnections: 1, keyProvider: { getKey: async () => { secretReads++; throw new Error('target resolution must not read keys'); } } });
    const kit = single;
    const forbidden = async () => { secretReads++; throw new Error('target resolution must not read secrets or vault metadata'); };
    t.mock.method(kit.vault, 'readSecret', forbidden);
    t.mock.method(kit.vault, 'secretHistory', forbidden);
    t.mock.method(kit.vault, 'recentSecrets', forbidden);
    t.mock.method(kit.variables, 'readSecrets', forbidden);
    t.mock.method(kit.variables, 'recentSecrets', forbidden);
    assert.equal((await kit.testEnvironments.inherit(f.admin, f.sources)).assignments, 1);
    const environment = (await kit.testEnvironments.list(f.admin))[0];
    assert.equal(environment.target, 'synthetic-bed');
    assert.equal(environment.name, 'synthetic-bed');
    const marker = await kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_INHERITANCE_KEY);
    assert.ok(marker?.body.bound);
    const completion = TestEnvironmentInheritanceCompletion.parse(JSON.parse(Buffer.from((await kit.objects.get(marker.body.bound))!).toString()));
    assert.ok(completion.source_records.includes(variable.value.decision.digest));
    await withEnvironmentPermissionLock(kit.store, async tx => {
      const snapshot = await kit.variables.snapshot(tx);
      assert.equal(await kit.variables.valueAt('SYNTHETIC_TARGET', snapshot.get('SYNTHETIC_TARGET')!, tx), 'synthetic-bed');
      assert.deepEqual((await kit.variables.resolveVariables({ target: executor.target }, executor.id!, snapshot, tx)).value, { target: 'synthetic-bed' });
      assert.equal(await kit.testEnvironments.canUseExecutor(f.member, environment.id, executor.id!, tx), true);
      assert.equal(await kit.testEnvironments.canUseExecutor(f.admin, environment.id, executor.id!, tx), false, 'management role is not a use grant');
    });
    const originalEnvironment = await kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_CONFIG_PREFIX + environment.id);
    const grant = await kit.authorizations.latest('resource_assign', f.member.id, environment.id);
    const originalExecutor = await kit.authorizations.latest('resource_config', '*', 'executor.' + executor.id);
    assert.ok(grant && originalEnvironment && originalExecutor?.body.bound);
    assert.equal(ExecutorSource.parse(JSON.parse(Buffer.from((await kit.objects.get(originalExecutor.body.bound))!).toString())).target, '${var:SYNTHETIC_TARGET}');
    await assert.rejects(f.kit.variables.setVariable(f.admin, 'SYNTHETIC_TARGET', 'different-target', 'owner-approved target change', { notSecret: true }), EnvironmentWriteError);
    await f.historicalConfiguration('var:SYNTHETIC_TARGET', { schema: 'variable@1', name: 'SYNTHETIC_TARGET', value: 'different-target' });
    await assert.rejects(withEnvironmentPermissionLock(kit.store, tx => kit.testEnvironments.canUseExecutor(f.member, environment.id, executor.id!, tx)), /目标或资源声明不一致/);
    await assert.rejects(f.kit.variables.setVariable(f.admin, 'SYNTHETIC_TARGET', 42, 'owner-approved invalid-value fixture', { notSecret: true }), EnvironmentWriteError);
    await f.historicalConfiguration('var:SYNTHETIC_TARGET', { schema: 'variable@1', name: 'SYNTHETIC_TARGET', value: 42 });
    await assert.rejects(withEnvironmentPermissionLock(kit.store, tx => kit.testEnvironments.canUseExecutor(f.member, environment.id, executor.id!, tx)), /当前值不是字符串/);
    assert.equal((await kit.testEnvironments.inheritance()).completed, true);
    assert.equal((await kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_INHERITANCE_KEY))?.digest, marker.digest);
    assert.equal((await kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_CONFIG_PREFIX + environment.id))?.digest, originalEnvironment.digest);
    assert.equal((await kit.authorizations.latest('resource_assign', f.member.id, environment.id))?.digest, grant.digest);
    assert.equal((await kit.authorizations.latest('resource_config', '*', 'executor.' + executor.id))?.digest, originalExecutor.digest);
    assert.deepEqual((await f.db.query('SELECT * FROM leases ORDER BY key')).rows, leaseBytes);
    assert.equal(secretReads, 0);
    assert.ok(kit.poolStats);
    assert.equal(kit.poolStats().limit, 1);
    assert.equal(kit.poolStats().waiting, 0);
  } finally { await single?.close(); await f.close(); }
});

test('executor admission never resolves shared keys by choosing only the environment assigned to the caller', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const firstExecutor = await f.executor('first-target');
    const secondExecutor = await f.executor('second-target');
    const first = await f.kit.testEnvironments.register(f.admin, { ...f.input('第一环境', 'first-target'), executors: [firstExecutor.id!] });
    const secondInput = { ...f.input('第二环境', 'second-target'), executors: [secondExecutor.id!] };
    await assert.rejects(f.kit.testEnvironments.register(f.admin, secondInput), EnvironmentWriteError);
    const historicalSecond = TestEnvironment.parse({ ...secondInput, schema: 'test-environment@1', id: newId('env') });
    await f.historicalConfiguration(TEST_ENVIRONMENT_CONFIG_PREFIX + historicalSecond.id, historicalSecond);
    await f.kit.authorizations.grant(f.admin, { permission: 'resource_assign', subject: f.member.id, object: first.id });
    await f.kit.testEnvironments.inherit(f.admin, f.sources);
    await withEnvironmentPermissionLock(f.kit.store, async tx => {
      assert.equal(await f.kit.testEnvironments.canUse(f.member, first.id, tx), true);
      assert.equal(await f.kit.testEnvironments.canUseExecutor(f.member, first.id, firstExecutor.id!, tx), false);
    });
  } finally { await f.close(); }
});
