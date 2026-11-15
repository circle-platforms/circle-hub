// UNRUN until the Boss ends the full suite and the parent allocates a PostgreSQL slot.
// Real M1 runtime, published reservation workflows, executor sources and ordinary grants; no conversion-port injection.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { join } from 'node:path';
import { Database, createPool, openRecords, newId, type RecordsKit, type Principal } from '../records/api.ts';
import { LeaseService } from '../leases/api.ts';
import { ExecutorRegistry } from '../dispatch/api.ts';
import { addSyntheticExecutor } from '../dispatch/testing/credentials.ts';
import { definition } from '../dispatch/testing/definition.ts';
import { createPackRegistry } from '../runs/api.ts';
import { workflowPack, editJson, writePack } from '../runs/packs/testing/builder.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { openCliHarness, RUNTIME_ROLE, type CliHarness } from './assemble/test-cli.ts';
import { loadServerConfig } from './main.ts';

let harness: CliHarness;
before(async () => { harness = await openCliHarness(); });
after(async () => { await harness?.close(); });

async function fixture() {
  // This initializes the synthetic pre-existing M1 database, before the installation/restart path under test.
  const deployment = await harness.deployment();
  const config = loadServerConfig(deployment.env);
  const database = new Database(createPool(config.database, 1));
  const records = await openRecords(config, { migrate: false, keyProvider: deployment.key });
  try {
    const first = await records.principals.bootstrapAdmin('合成已有管理员');
    const admin: Principal = { id: first.user.id, name: first.user.name, role: first.user.role };
    const created = await records.principals.createUser(admin, '合成已有预订成员');
    const member: Principal = { id: created.id, name: created.name, role: created.role };
    const teammateUser = await records.principals.createUser(admin, '合成团队成员');
    const teammate: Principal = { id: teammateUser.id, name: teammateUser.name, role: teammateUser.role };
    const team = await records.teams.create(admin, '合成预订团队');
    await records.teams.add(admin, team.id, member.id);
    await records.teams.add(admin, team.id, teammate.id);
    await records.authorizations.grantPublishRight(admin, admin.id);
    const registry = createPackRegistry({ records, extractDir: join(deployment.dataDir, 'fixture-extracted'), sandbox: { requireOsIsolation: false } });
    const declarations = [
      { id: 'synthetic-account-booking', prefix: 'account/', target: 'synthetic-account-target', subject: member.id },
      { id: 'synthetic-team-booking', prefix: 'team/', target: 'synthetic-team-target', subject: team.id },
      { id: 'synthetic-whole-booking', prefix: 'whole/', target: 'synthetic-whole-target', subject: '*' },
    ];
    const executorIds: string[] = [];
    for (const declared of declarations) {
      let pack = workflowPack({ id: declared.id, product: { catalogs: [] } });
      pack = editJson(pack, 'workflow.json', workflow => { workflow.context = ['leases']; workflow.leases = { prefix: declared.prefix }; });
      pack = editJson(pack, 'knowledge.json', knowledge => { knowledge.requires = []; });
      const written = await writePack(join(deployment.dataDir, 'fixture-packs', declared.id), pack);
      const published = await registry.publish(admin, written.dir);
      if (!published.ok) throw new Error('synthetic reservation workflow publication refused: ' + JSON.stringify(published.problems));
      const stored = await records.store.find({ kind: 'pack_version', key: 'pack.digest', value: published.version.digest, limit: 2 });
      assert.equal(stored.items.length, 1, 'publication must persist the actual manifest and file references');
      if (declared.subject === member.id) await records.authorizations.assign(admin, member.id, declared.id);
      else if (declared.subject === team.id) await records.authorizations.assignTeam(admin, team.id, declared.id);
      else await records.authorizations.grant(admin, { permission: 'assign', subject: '*', object: declared.id });
      const raw = definition('http://127.0.0.1:1/mcp');
      const registered = await addSyntheticExecutor(records, new ExecutorRegistry(records), admin, {
        ...raw, target: declared.target, resources: [declared.prefix + 'device/a'],
        proof: { ...raw.proof, package: declared.id },
      }, 'synthetic-startup-credential');
      executorIds.push(registered.id);
    }
    // Multiple executors for one target must not become multiple environments.
    const raw = definition('http://127.0.0.1:1/mcp');
    const additional = await addSyntheticExecutor(records, new ExecutorRegistry(records), admin, {
      ...raw, target: declarations[0].target, resources: ['account/device/a'],
      proof: { ...raw.proof, package: declarations[0].id },
    }, 'synthetic-additional-startup-credential');
    executorIds.push(additional.id);
    const holder = { user: member.id, run: newId('run') };
    const acquired = await new LeaseService(database, { records: records.store, catalog: records.testEnvironments }).acquire({
      keys: ['account/device/a'], holder, prefix: 'account/', ttlSeconds: 3600, maxTtlSeconds: 7200,
    });
    assert.equal(acquired.ok, true, 'the original booking is made through the real lease service');
    assert.deepEqual(await records.testEnvironments.inheritance(), { completed: false, record: null, missingFacts: [] });
    assert.deepEqual(await records.testEnvironments.list(admin), [], 'no environment or completion is fabricated by the fixture');
    const originalRecords = (await database.query('SELECT * FROM records ORDER BY seq')).rows;
    const through = originalRecords.at(-1)!.seq;
    const snapshot = async () => ({
      migrations: (await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows,
      columns: (await database.query("SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position")).rows,
      records: (await database.query('SELECT * FROM records WHERE seq <= $1 ORDER BY seq', [through])).rows,
      leases: (await database.query('SELECT * FROM leases ORDER BY key')).rows,
      users: (await database.query('SELECT * FROM users ORDER BY id')).rows,
      role: (await database.query('SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolcanlogin FROM pg_roles WHERE rolname=current_user')).rows,
      rights: (await database.query("SELECT current_user AS role,has_schema_privilege(current_user,'public','CREATE') AS can_create,(SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owned_objects")).rows,
    });
    const original = await snapshot();
    assert.deepEqual(original.migrations.map(row => row.version), [1]);
    assert.equal(config.database.user, RUNTIME_ROLE);
    assert.notEqual(config.database.user, harness.postgres.config.user);
    assert.deepEqual(original.role, [{ rolname: RUNTIME_ROLE, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolcanlogin: true }]);
    assert.deepEqual(original.rights, [{ role: RUNTIME_ROLE, can_create: false, owned_objects: 0 }]);
    return { deployment, config, database, admin, member, teammate, team, token: first.token, declarations, executorIds, snapshot, original };
  } catch (error) { await database.end(); throw error; }
  finally { await records.close(); }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Only ordinary serve and the existing stored-token seam; default collector, kernel and assembly are untouched. */
async function serveAndInspect(w: Fixture, token: string | null, inspect: (records: RecordsKit) => Promise<void>) {
  const stopped = Promise.withResolvers<void>();
  let inspected = Promise.resolve(), error: unknown = null, listened = 0, tokenReads = 0;
  const store = memoryOperatorTokens(token);
  const result = await w.deployment.run(['serve'], {
    operatorTokens: () => ({ ...store, read: async () => { tokenReads++; return store.read(); } }),
    onListening: () => {
      listened++;
      inspected = (async () => {
        const records = await openRecords(w.config, { migrate: false, keyProvider: w.deployment.key });
        try { await inspect(records); } finally { await records.close(); }
      })().catch(failure => { error = failure; }).finally(() => stopped.resolve());
    },
    stopSignal: () => stopped.promise,
  });
  await inspected;
  if (error !== null) throw error;
  assert.equal(result.code, 0, result.text);
  assert.equal(listened, 1, 'inspection runs after the actual listener starts');
  if (token !== null) assert.equal(result.text.includes(token), false);
  assert.deepEqual(await w.snapshot(), w.original, 'schema, original records, users, lease bytes and runtime role remain unchanged');
  return { result, tokenReads };
}

async function inherited(records: RecordsKit, w: Fixture) {
  const completion = await records.testEnvironments.inheritance();
  assert.equal(completion.completed, true); assert.ok(completion.record);
  const environments = (await records.testEnvironments.list(w.admin)).filter(row => row.isTestEnvironment);
  assert.deepEqual(environments.map(row => row.target).sort(), w.declarations.map(row => row.target).sort());
  assert.equal(environments.length, 3);
  assert.deepEqual(environments.flatMap(row => row.executors).sort(), [...w.executorIds].sort());
  const decisions: string[] = [];
  for (const environment of environments) {
    for (const subject of [w.member.id, w.team.id, '*']) {
      const decision = await records.authorizations.latest('resource_assign', subject, environment.id);
      assert.ok(decision, 'account, team and whole-Hub origins remain ordinary distinct assignments');
      assert.equal(decision.body.revoked, false);
      assert.equal(decision.body.decided_by, w.admin.id, 'only the real stored-token administrator performed inheritance');
      assert.equal(decision.body.expires_at, null);
      decisions.push(decision.digest);
    }
    assert.equal(await records.testEnvironments.canUse(w.member, environment.id), true);
    assert.equal(await records.testEnvironments.canUse(w.teammate, environment.id), true);
  }
  assert.equal(new Set(decisions).size, 9, 'team and whole-Hub grants are not expanded into extra account grants');
  const marker = await records.store.get(completion.record);
  assert.ok(marker);
  assert.equal(marker.kind, 'authorization');
  return { completion, environments };
}

test('ordinary serve inherits real account, team and whole-Hub reservation grants using the actual collector', { timeout: 180_000 }, async () => {
  const w = await fixture();
  try {
    const result = await serveAndInspect(w, w.token.token, async records => { await inherited(records, w); });
    assert.equal(result.tokenReads, 1);
  } finally { await w.database.end(); }
});

test('the same existing database stays pending and listens with missing and then revoked stored delegation', { timeout: 180_000 }, async () => {
  const w = await fixture();
  const pending = async (records: RecordsKit) => {
    assert.deepEqual(await records.testEnvironments.inheritance(), { completed: false, record: null, missingFacts: [] });
    assert.deepEqual(await records.testEnvironments.list(w.admin), []);
    assert.deepEqual((await records.authorizations.history({ permission: 'resource_assign', limit: 500 })).items, []);
  };
  try {
    const missing = await serveAndInspect(w, null, pending);
    assert.equal(missing.tokenReads, 1);
    assert.match(missing.result.text, /仍按原工作流和预订规则/);
    const records = await openRecords(w.config, { migrate: false, keyProvider: w.deployment.key });
    try { await records.principals.revokeToken(w.admin, w.token.id); } finally { await records.close(); }
    const revoked = await serveAndInspect(w, w.token.token, pending);
    assert.equal(revoked.tokenReads, 1);
    assert.match(revoked.result.text, /仍按原工作流和预订规则/);
  } finally { await w.database.end(); }
});

test('a second ordinary startup keeps administrator withdrawals instead of inheriting the still-assigned workflows again', { timeout: 180_000 }, async () => {
  const w = await fixture();
  try {
    let completion: string | null = null, environment = '';
    await serveAndInspect(w, w.token.token, async records => {
      const result = await inherited(records, w);
      completion = result.completion.record;
      environment = result.environments.find(row => row.target === w.declarations[0].target)!.id;
    });
    const records = await openRecords(w.config, { migrate: false, keyProvider: w.deployment.key });
    const withdrawals: string[] = [];
    try {
      for (const subject of [w.member.id, w.team.id, '*']) withdrawals.push((await records.authorizations.unassignResource(w.admin, environment, subject)).digest);
      assert.equal(await records.testEnvironments.canUse(w.member, environment), false);
      // The legacy sources remain valid; a repeated conversion would incorrectly recreate the withdrawals.
      for (const declared of w.declarations) assert.equal((await records.authorizations.latest('assign', declared.subject, declared.id))?.body.revoked, false);
    } finally { await records.close(); }
    const total = (await w.database.query('SELECT count(*)::int AS count FROM records')).rows[0].count;
    const restarted = await serveAndInspect(w, w.token.token, async current => {
      assert.equal((await current.testEnvironments.inheritance()).record, completion);
      assert.equal(await current.testEnvironments.canUse(w.member, environment), false);
      const latest = await Promise.all([w.member.id, w.team.id, '*'].map(subject => current.authorizations.latest('resource_assign', subject, environment)));
      assert.deepEqual(latest.map(row => row?.digest), withdrawals);
      assert.ok(latest.every(row => row?.body.revoked === true));
    });
    assert.equal(restarted.tokenReads, 0, 'trusted completion never consults delegation or repeats inheritance');
    assert.equal((await w.database.query('SELECT count(*)::int AS count FROM records')).rows[0].count, total);
  } finally { await w.database.end(); }
});
