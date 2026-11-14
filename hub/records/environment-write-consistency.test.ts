import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { openTestRecords } from '../testing/records.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { TestEnvironment, TEST_ENVIRONMENT_CONFIG_PREFIX, EXECUTOR_NAME_PREFIX, ExecutorNameBinding } from '../../contracts/api.ts';
import { definition } from '../dispatch/testing/definition.ts';
import { Database, createPool } from './db.ts';
import { canonicalBytes } from './canonical.ts';
import { newId } from './ids.ts';
import { environmentProgramWrite } from './environment-program-write.ts';
import { EnvironmentWriteError } from './environment-write-consistency.ts';
import { withEnvironmentPermissionLock, type TestEnvironmentInput, type Transaction, type AuthorizationRecord } from './api.ts';

async function fixture() {
  const kit = await openTestRecords(), db = new Database(createPool(kit.database, 2));
  const admin = (await kit.principals.bootstrapAdmin('synthetic-admin')).user;
  const member = await kit.principals.createUser(admin, 'synthetic-member');
  const at = new Date().toISOString();
  const input = (name: string, target: string, prefixes: string[] = [], resources: string[] = [], executors: string[] = []): TestEnvironmentInput => ({ name, target, prefixes: prefixes.map(prefix => ({ prefix, owner: member.id, registered_at: at })), resources: resources.map(key => ({ key, owner: member.id, registered_at: at })), executors, enabled: true, missing_facts: [] });
  async function executor(target: string, resources: string[], name: string) {
    const source = ExecutorSource.parse({ ...definition('http://127.0.0.1:9/mcp'), id: newId('exe'), target, resources });
    const object = await kit.objects.put(canonicalBytes(source), 'application/json');
    await kit.authorizations.configureResource(admin, 'executor.' + source.id, object.sha256);
    const binding = await kit.objects.put(canonicalBytes(ExecutorNameBinding.parse({ schema: 'executor-name@1', executor: source.id, name })), 'application/json');
    await kit.authorizations.configureResource(admin, EXECUTOR_NAME_PREFIX + source.id, binding.sha256);
    return source;
  }
  const state = async () => ({ records: (await db.query('SELECT digest FROM records ORDER BY seq')).rows, objects: (await db.query('SELECT sha256 FROM objects ORDER BY sha256')).rows });
  async function legacyEnvironment(value: TestEnvironment) {
    await kit.store.withTransaction(tx => environmentProgramWrite(tx, async () => {
      const object = await kit.objects.put(canonicalBytes(TestEnvironment.parse(value)), 'application/json', tx);
      await kit.authorizations.configureResourceInTransaction(admin, TEST_ENVIRONMENT_CONFIG_PREFIX + value.id, object.sha256, 'synthetic preexisting inconsistent declaration', tx);
    }));
  }
  async function legacyVariable(name: string, value: unknown) {
    const old = await kit.authorizations.latest('resource_config', '*', 'var:' + name);
    const object = await kit.objects.put(canonicalBytes({ schema: 'variable@1', name, value }), 'application/json');
    const body: AuthorizationRecord['body'] = { permission: 'resource_config', subject: '*', object: 'var:' + name, revoked: false, bound: object.sha256, decided_by: admin.id, decided_at: new Date().toISOString(), expires_at: null, note: 'synthetic preexisting value, not a new interactive write', supersedes: old?.digest ?? null };
    await kit.store.put({ kind: 'authorization', schema: 'authorization@1', provenance: 'declared', body, index: [{ key: 'authz.key', value: 'resource_config|*|var:' + name }, { key: 'authz.subject', value: 'resource_config|*' }, { key: 'authz.object', value: 'resource_config|var:' + name }, { key: 'authz.permission', value: 'resource_config' }, { key: 'authz.subject-any', value: '*' }, { key: 'authz.object-any', value: 'var:' + name }, { key: 'authz.decider', value: admin.id }] });
  }
  async function legacyExecutor(id: string, source: ExecutorSource) {
    const prior = await kit.authorizations.latest('resource_config', '*', 'executor.' + id);
    const object = await kit.objects.put(canonicalBytes(source), 'application/json');
    const body: AuthorizationRecord['body'] = { permission: 'resource_config', subject: '*', object: 'executor.' + id, revoked: false, bound: object.sha256, decided_by: admin.id, decided_at: new Date().toISOString(), expires_at: null, note: 'synthetic preexisting identity mismatch, not ordinary configure', supersedes: prior?.digest ?? null };
    await kit.store.put({ kind: 'authorization', schema: 'authorization@1', provenance: 'declared', body, index: [{ key: 'authz.key', value: 'resource_config|*|executor.' + id }, { key: 'authz.subject', value: 'resource_config|*' }, { key: 'authz.object', value: 'resource_config|executor.' + id }, { key: 'authz.permission', value: 'resource_config' }, { key: 'authz.subject-any', value: '*' }, { key: 'authz.object-any', value: 'executor.' + id }, { key: 'authz.decider', value: admin.id }] });
  }
  return { kit, db, admin, member, input, executor, state, legacyEnvironment, legacyVariable, legacyExecutor, close: async () => { await db.end(); await kit.close(); } };
}
const invalid = (error: unknown) => error instanceof EnvironmentWriteError && error.code === 'SUBMISSION_SCHEMA_VIOLATION';

test('register and definition restore reject all cross-environment claim forms before any formal write', { timeout: 120000 }, async () => {
  for (const [aPrefixes, aKeys, bPrefixes, bKeys] of [
    [[], ['pool/key'], [], ['pool/key']], [['pool/'], [], ['pool/sub/'], []],
    [['pool/'], [], [], ['pool/key']], [[], ['pool/key'], ['pool/'], []],
  ]) {
    const f = await fixture();
    try {
      await f.kit.testEnvironments.register(f.admin, f.input('已有环境', 'existing', aPrefixes, aKeys));
      const before = await f.state();
      const candidate = f.input('候选环境', 'candidate', bPrefixes, bKeys);
      await assert.rejects(f.kit.testEnvironments.register(f.admin, candidate), invalid);
      await assert.rejects(f.kit.testEnvironments.registerFromDefinition(f.admin, candidate), invalid);
      assert.deepEqual(await f.state(), before);
    } finally { await f.close(); }
  }
});

test('a local update can repair old overlap or retain it during unrelated repair without requiring global clean data', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.kit.testEnvironments.register(f.admin, f.input('当前环境', 'first', ['pool/']));
    const old = TestEnvironment.parse({ ...f.input('旧矛盾', 'legacy', [], ['pool/key']), schema: 'test-environment@1', id: newId('env') });
    await f.legacyEnvironment(old);
    const oldRecord = await f.kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_CONFIG_PREFIX + old.id);
    await f.kit.testEnvironments.update(f.admin, first.id, f.input('修正名字', 'first', ['pool/']));
    await f.kit.testEnvironments.update(f.admin, first.id, f.input('修正名字', 'first', ['narrow/']));
    assert.equal((await f.kit.authorizations.latest('resource_config', '*', TEST_ENVIRONMENT_CONFIG_PREFIX + old.id))?.digest, oldRecord?.digest);
    const before = await f.state();
    await assert.rejects(f.kit.testEnvironments.update(f.admin, first.id, f.input('修正名字', 'first', ['pool/'])), invalid);
    assert.deepEqual(await f.state(), before);
    await f.kit.testEnvironments.register(f.admin, f.input('无关新登记', 'unrelated', ['unrelated/']));
  } finally { await f.close(); }
});

test('two named executors at one target remain in one environment while new target and coverage contradictions reject', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.executor('same-target', ['pool/a'], 'first-executor');
    const second = await f.executor('same-target', ['pool/b'], 'second-executor');
    const environment = await f.kit.testEnvironments.register(f.admin, f.input('同目标环境', 'same-target', ['pool/'], [], [first.id!, second.id!]));
    const before = await f.state();
    for (const candidate of [{ ...first, target: 'different-target' }, { ...first, resources: ['outside/key'] }, { ...first, id: second.id }]) {
      await assert.rejects(withEnvironmentPermissionLock(f.kit.store, tx => f.kit.testEnvironments.assertExecutorWrite(f.admin, first.id!, candidate, tx)), invalid);
      assert.deepEqual(await f.state(), before);
    }
    await withEnvironmentPermissionLock(f.kit.store, tx => f.kit.testEnvironments.assertExecutorWrite(f.admin, first.id!, { ...first, max_run_ms: first.max_run_ms + 1 }, tx));
    assert.equal((await f.kit.testEnvironments.list(f.admin)).filter(row => row.target === 'same-target').length, 1);
    assert.deepEqual((await f.kit.testEnvironments.get(f.admin, environment.id))?.executors, [first.id, second.id]);
  } finally { await f.close(); }
});

test('actual var set and unset inspect the proposed overlay before objects and generic configuration cannot bypass it', { timeout: 120000 }, async t => {
  const f = await fixture();
  try {
    await f.kit.variables.setVariable(f.admin, 'SYNTHETIC_TARGET', 'target-a', 'owner-approved target', { notSecret: true });
    const source = await f.executor('${var:SYNTHETIC_TARGET}', ['pool/key'], 'variable-executor');
    await f.kit.testEnvironments.register(f.admin, f.input('变量环境', 'target-a', ['pool/'], [], [source.id!]));
    const previous = await f.kit.authorizations.latest('resource_config', '*', 'var:SYNTHETIC_TARGET');
    const before = await f.state();
    let puts = 0;
    const originalPut = f.kit.objects.put.bind(f.kit.objects);
    const mock = t.mock.method(f.kit.objects, 'put', async (...args: Parameters<typeof originalPut>) => { puts++; return originalPut(...args); });
    await assert.rejects(f.kit.variables.setVariable(f.admin, 'SYNTHETIC_TARGET', 'target-b', 'owner-approved candidate', { notSecret: true }), invalid);
    await assert.rejects(f.kit.variables.unset(f.admin, 'var', 'SYNTHETIC_TARGET', 'owner-approved withdrawal'), invalid);
    assert.equal(puts, 0);
    mock.mock.restore();
    assert.deepEqual(await f.state(), before);
    const candidate = await f.kit.objects.put(canonicalBytes({ schema: 'variable@1', name: 'SYNTHETIC_TARGET', value: 'target-b' }), 'application/json');
    const afterPrepared = await f.state();
    await assert.rejects(f.kit.authorizations.configureResource(f.admin, 'var:SYNTHETIC_TARGET', candidate.sha256), invalid);
    await assert.rejects(f.kit.authorizations.revoke(f.admin, { permission: 'resource_config', subject: '*', object: 'var:SYNTHETIC_TARGET' }), invalid);
    assert.deepEqual(await f.state(), afterPrepared);
    assert.equal((await f.kit.authorizations.latest('resource_config', '*', 'var:SYNTHETIC_TARGET'))?.digest, previous?.digest);
  } finally { await f.close(); }
});

test('a bad historical variable can be corrected without repairing another unrelated bad variable or changing old declarations', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    for (const [name, target, prefix] of [['SYNTHETIC_TARGET', 'target-a', 'pool/'], ['OTHER_TARGET', 'target-c', 'other/']]) {
      await f.kit.variables.setVariable(f.admin, name, target, 'owner-approved target', { notSecret: true });
      const source = await f.executor('${var:' + name + '}', [prefix + 'key'], name + '-executor');
      await f.kit.testEnvironments.register(f.admin, f.input(target, target, [prefix], [], [source.id!]));
    }
    await f.legacyVariable('SYNTHETIC_TARGET', 'legacy-wrong-a');
    await f.legacyVariable('OTHER_TARGET', 'legacy-wrong-c');
    const other = await f.kit.authorizations.latest('resource_config', '*', 'var:OTHER_TARGET');
    await f.kit.variables.setVariable(f.admin, 'SYNTHETIC_TARGET', 'target-a', 'owner-approved local correction', { notSecret: true });
    assert.deepEqual((await f.kit.variables.resolveVariables({ target: '${var:SYNTHETIC_TARGET}' }, 'fixture')).value, { target: 'target-a' });
    assert.equal((await f.kit.authorizations.latest('resource_config', '*', 'var:OTHER_TARGET'))?.digest, other?.digest);
  } finally { await f.close(); }
});

test('concurrent variable change waits for a new environment link and rechecks the candidate after that link commits', { timeout: 120000 }, async () => {
  const f = await fixture();
  let release!: () => void;
  let first: Promise<unknown> | undefined, variable: Promise<unknown> | undefined;
  try {
    await f.kit.variables.setVariable(f.admin, 'SYNTHETIC_TARGET', 'target-a', 'owner-approved target', { notSecret: true });
    const source = await f.executor('${var:SYNTHETIC_TARGET}', ['pool/key'], 'concurrent-executor');
    const environment = await f.kit.testEnvironments.register(f.admin, f.input('并发环境', 'target-a', ['pool/']));
    const oldVariable = await f.kit.authorizations.latest('resource_config', '*', 'var:SYNTHETIC_TARGET');
    let ready!: (pid: number) => void;
    const entered = new Promise<number>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    first = withEnvironmentPermissionLock(f.kit.store, async tx => {
      await f.kit.testEnvironments.update(f.admin, environment.id, f.input('并发环境', 'target-a', ['pool/'], [], [source.id!]), tx);
      ready(Number((await f.db.query('SELECT pg_backend_pid() AS pid', [], tx)).rows[0].pid));
      await gate;
    });
    const pid = await Promise.race([entered, first.then(() => { throw new Error('link transaction completed without entering the synchronization point'); })]);
    variable = f.kit.variables.setVariable(f.admin, 'SYNTHETIC_TARGET', 'target-b', 'owner-approved concurrent candidate', { notSecret: true });
    const deadline = Date.now() + 30000;
    while (!(await f.db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE $1=ANY(pg_blocking_pids(a.pid))) AS blocked', [pid])).rows[0].blocked) {
      if (Date.now() > deadline) throw new Error('variable writer did not reach the shared environment boundary');
      await pause(5);
    }
    release(); await first;
    await assert.rejects(variable, invalid);
    assert.equal((await f.kit.authorizations.latest('resource_config', '*', 'var:SYNTHETIC_TARGET'))?.digest, oldVariable?.digest);
    assert.deepEqual((await f.kit.testEnvironments.get(f.admin, environment.id))?.executors, [source.id]);
  } finally { release?.(); await Promise.allSettled([first, variable].filter((v): v is Promise<unknown> => v !== undefined)); await f.close(); }
});

test('a retained bad source identity cannot bypass a newly uncovered resource or expanded namespace', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const source = await f.executor('legacy-target', ['p/x'], 'legacy-executor');
    const environment = await f.kit.testEnvironments.register(f.admin, f.input('旧身份矛盾环境', 'legacy-target', ['p/'], [], [source.id!]));
    // A structurally valid historical body is bound under the wrong identity, without changing old records.
    const bad = ExecutorSource.parse({ ...source, id: newId('exe') });
    await f.legacyExecutor(source.id!, bad);
    await assert.rejects(f.kit.testEnvironments.resolve(['p/x']), /登记身份不一致/);
    const before = await f.state();
    await assert.rejects(f.kit.testEnvironments.update(f.admin, environment.id, f.input('旧身份矛盾环境', 'legacy-target', ['q/'], [], [source.id!])), invalid);
    assert.deepEqual(await f.state(), before, 'a bad historical identity does not authorize a new namespace or orphan a covered resource');
    await assert.rejects(f.kit.testEnvironments.update(f.admin, environment.id, f.input('旧身份矛盾环境', 'legacy-target', ['p/', 'q/'], [], [source.id!])), invalid);
    assert.deepEqual(await f.state(), before);
    await f.kit.testEnvironments.update(f.admin, environment.id, f.input('只修正名字', 'legacy-target', ['p/'], [], [source.id!]));
    await f.kit.testEnvironments.update(f.admin, environment.id, f.input('只修正名字', 'legacy-target', [], ['p/x'], [source.id!]));
    assert.equal((await f.kit.testEnvironments.get(f.admin, environment.id))?.resources[0].key, 'p/x');
    await assert.rejects(f.kit.testEnvironments.resolve(['p/x']), /登记身份不一致/, 'runtime was already rejecting the bad identity and remains unchanged');
  } finally { await f.close(); }
});

test('ordinary raw executor configuration and revocation cannot bypass the domain reverse validator', { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    const source = await f.executor('bound-target', ['p/x'], 'raw-api-executor');
    await f.kit.testEnvironments.register(f.admin, f.input('直接API环境', 'bound-target', ['p/'], [], [source.id!]));
    const bad = await f.kit.objects.put(canonicalBytes({ ...source, id: newId('exe') }), 'application/json');
    const before = await f.state();
    await assert.rejects(f.kit.authorizations.configureResource(f.admin, 'executor.' + source.id, bad.sha256), invalid);
    await assert.rejects(f.kit.authorizations.revoke(f.admin, { permission: 'resource_config', subject: '*', object: 'executor.' + source.id }), invalid);
    assert.deepEqual(await f.state(), before);
  } finally { await f.close(); }
});
