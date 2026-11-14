// Real catalog inheritance through ordinary serve; no scripted completion port, SQL marker or owner impersonation.
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { Database, createPool, openRecords, type RecordsKit, type Principal } from '../records/api.ts';
import { LeaseService } from '../leases/api.ts';
import { assembleHub, type AssembledHub } from './assemble/hub.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { openCliHarness, type CliHarness, type Deployment } from './assemble/test-cli.ts';
import { environmentPermissionSources } from './env-permission-sources.ts';
import type { EnvironmentPermissionStartup } from './env-startup.ts';
import { loadServerConfig } from './main.ts';

let harness: CliHarness;
before(async () => { harness = await openCliHarness(); });
after(async () => { await harness?.close(); });

async function existing() {
  const deployment = await harness.deployment();
  const config = loadServerConfig(deployment.env);
  const database = new Database(createPool(config.database, 1));
  const kit = await openRecords(config, { migrate: false, keyProvider: deployment.key });
  try {
    const created = (await kit.principals.bootstrapAdmin('合成已有管理员')).user;
    const admin: Principal = { id: created.id, name: created.name, role: created.role };
    const user = await kit.principals.createUser(admin, '合成已有预订成员');
    const member: Principal = { id: user.id, name: user.name, role: user.role };
    const delegation = await kit.principals.issueToken(admin, admin.id, '合成安装委托');
    const leases = new LeaseService(database, { records: kit.store, catalog: kit.testEnvironments });
    const holder = { user: member.id, run: 'run_0123456789abcdefghjkmnpqrs' };
    assert.equal((await leases.acquire({ keys: ['synthetic/existing'], holder, prefix: 'synthetic/', ttlSeconds: 600, maxTtlSeconds: 900 })).ok, true);
    assert.equal((await kit.testEnvironments.inheritance()).completed, false, 'absence must come from the real catalog');
    const oldRecords = (await database.query('SELECT * FROM records ORDER BY seq')).rows;
    const through = oldRecords.at(-1)!.seq;
    const snapshot = async () => ({
      migrations: (await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows,
      columns: (await database.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
      records: (await database.query('SELECT * FROM records WHERE seq <= $1 ORDER BY seq', [through])).rows,
      leases: (await database.query('SELECT * FROM leases ORDER BY key')).rows,
      member: (await database.query('SELECT * FROM users WHERE id=$1', [member.id])).rows,
    });
    const original = await snapshot();
    assert.deepEqual(original.migrations.map(row => row.version), [1]);
    assert.deepEqual(original.records, oldRecords);
    return { deployment, config, database, admin, member, delegation, snapshot, original };
  } catch (error) { await database.end(); throw error; }
  finally { await kit.close(); }
}

async function ordinaryServe(deployment: Deployment, token: string | null, inspect: (hub: AssembledHub, records: RecordsKit, startup: EnvironmentPermissionStartup) => Promise<void>) {
  const stopped = Promise.withResolvers<void>();
  let listened = 0, reads = 0;
  const store = memoryOperatorTokens(token);
  const result = await deployment.run(['serve'], {
    operatorTokens: () => ({ ...store, read: async () => { reads++; return store.read(); } }),
    assembly: async () => ({ assemble: async (config, records, startup?: EnvironmentPermissionStartup) => {
      assert.ok(startup);
      const hub = await assembleHub(config, records, { requireVaultKey: true, requireOsIsolation: false, log: () => {}, environmentPermissionStartup: startup });
      try { await inspect(hub, records, startup); return hub.deps; }
      catch (error) { await hub.deps.close?.(); throw error; }
    } }),
    onListening: () => { listened++; stopped.resolve(); }, stopSignal: () => stopped.promise,
  });
  assert.equal(result.code, 0, result.text); assert.equal(listened, 1);
  if (token !== null) assert.equal(result.text.includes(token), false);
  return reads;
}

test('ordinary M1 serve writes genuine empty-catalog completion before business without changing existing records or booking', { timeout: 60_000 }, async () => {
  const w = await existing();
  try {
    assert.equal(await ordinaryServe(w.deployment, w.delegation.token, async (hub, records, startup) => {
      const completion = await records.testEnvironments.inheritance();
      assert.equal(completion.completed, true); assert.ok(completion.record);
      assert.equal(startup.completed, true);
      assert.equal((await hub.deps.environmentPermissionStartup!()).completed, true);
      assert.equal((await hub.deps.memberCapabilities(w.member)).environmentAccess.enforced, true);
      assert.equal(hub.dispatch!.options.enforceEnvironmentAssignments, true);
      assert.deepEqual(await w.snapshot(), w.original);
    }), 1);
    assert.deepEqual(await w.snapshot(), w.original);
  } finally { await w.database.end(); }
});

test('missing operator delegation starts legacy management, and a real ordinary admin action becomes visible without restart', { timeout: 60_000 }, async () => {
  const w = await existing();
  try {
    await ordinaryServe(w.deployment, null, async (hub, records, startup) => {
      assert.equal(startup.completed, false);
      assert.equal((await records.testEnvironments.inheritance()).completed, false);
      assert.equal((await hub.deps.memberCapabilities(w.member)).environmentAccess.enforced, false);
      const result = await records.testEnvironments.inherit(w.admin, environmentPermissionSources());
      assert.equal(result.completed, true);
      assert.equal((await hub.deps.environmentPermissionStartup!()).completed, true);
      assert.equal((await hub.deps.memberCapabilities(w.member)).environmentAccess.enforced, true);
      assert.deepEqual(await w.snapshot(), w.original);
    });
    assert.deepEqual(await w.snapshot(), w.original);
  } finally { await w.database.end(); }
});

test('a genuine completion survives a restart with a revoked delegate and is not written again', { timeout: 60_000 }, async () => {
  const w = await existing();
  try {
    const kit = await openRecords(w.config, { migrate: false, keyProvider: w.deployment.key });
    let record: string | null;
    try {
      await kit.testEnvironments.inherit(w.admin, environmentPermissionSources());
      record = (await kit.testEnvironments.inheritance()).record;
      assert.ok(record);
      await kit.principals.revokeToken(w.admin, w.delegation.id);
    } finally { await kit.close(); }
    const total = (await w.database.query('SELECT count(*)::int AS count FROM records')).rows[0].count;
    assert.equal(await ordinaryServe(w.deployment, w.delegation.token, async (hub, records, startup) => {
      assert.equal(startup.completed, true);
      assert.equal((await records.testEnvironments.inheritance()).record, record);
      assert.equal((await hub.deps.environmentPermissionStartup!()).completed, true);
      assert.equal((await hub.deps.memberCapabilities(w.member)).environmentAccess.enforced, true);
    }), 0, 'durable completion bypasses token access, never the permission checks');
    assert.equal((await w.database.query('SELECT count(*)::int AS count FROM records')).rows[0].count, total);
    assert.deepEqual(await w.snapshot(), w.original);
  } finally { await w.database.end(); }
});

test('a post-conversion ordinary grant withdrawn by an administrator is not replenished on restart', { timeout: 60_000 }, async () => {
  const w = await existing();
  try {
    const kit = await openRecords(w.config, { migrate: false, keyProvider: w.deployment.key });
    let environment: string;
    try {
      await kit.testEnvironments.inherit(w.admin, environmentPermissionSources());
      const registered = await kit.testEnvironments.register(w.admin, {
        name: '合成后来登记的测试环境', target: 'synthetic-later-target',
        prefixes: [{ prefix: 'synthetic/later/', owner: w.admin.id, registered_at: new Date().toISOString() }],
        resources: [], executors: [], enabled: true, missing_facts: [],
      });
      environment = registered.id;
      await kit.authorizations.assignResource(w.admin, environment, w.member.id);
      assert.equal(await kit.testEnvironments.canUse(w.member, environment), true);
      await kit.authorizations.unassignResource(w.admin, environment, w.member.id);
      assert.equal(await kit.testEnvironments.canUse(w.member, environment), false);
    } finally { await kit.close(); }
    const total = (await w.database.query('SELECT count(*)::int AS count FROM records')).rows[0].count;
    assert.equal(await ordinaryServe(w.deployment, w.delegation.token, async (_hub, records, startup) => {
      assert.equal(startup.completed, true);
      assert.equal(await records.testEnvironments.canUse(w.member, environment), false);
    }), 0);
    assert.equal((await w.database.query('SELECT count(*)::int AS count FROM records')).rows[0].count, total);
    assert.deepEqual(await w.snapshot(), w.original);
  } finally { await w.database.end(); }
});
