import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createPackRegistry } from '../runs/api.ts';
import { workflowPack, writePack } from '../runs/packs/testing/builder.ts';
import { definition as executorDefinition } from '../dispatch/testing/definition.ts';
import { LeaseService } from '../leases/api.ts';
import { PgTeams } from './teams.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import { canonicalBytes } from './canonical.ts';
import { environmentAssignmentUpgradeSources } from '../server/environment-assignment-upgrade-sources.ts';
import { DEFAULT_LIMITS } from '../config/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { Database, createPool } from './db.ts';
import { MIGRATIONS, migrate, migrationChecksum, verifyMigrations, migrateEnvironmentAssignments } from './migrations.ts';
import { PgRecordStore } from './store.ts';
import { PgPrincipals } from './principals.ts';
import { RecordAuthorizations } from './authorizations.ts';
import { RecordArtifacts } from './artifacts.ts';
import { canUseEnvironment } from './environment-permissions.ts';
import { MemberEnvironments } from '../dispatch/api.ts';
import { FileObjectStore } from './objects.ts';
import { newId } from './ids.ts';
import { authenticateEnvironmentUpgradeActor, readEnvironmentAssignmentActivation, previewEnvironmentAssignmentUpgrade, applyEnvironmentAssignmentUpgrade, requireEnvironmentAssignmentActivation, verifyEnvironmentUpgradeOpenSchema, type EnvironmentUpgradeSources } from './environment-assignment-upgrade.ts';
import { planEnvironmentAssignmentUpgrade } from '../server/environment-assignment-upgrade.ts';

let postgres: TemporaryPostgres;
before(async () => { postgres = await startPostgres(); });
after(async () => { await postgres?.stop(); });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const database = await postgres.createDatabase(), dataDir = await mkdtemp(join(tmpdir(), 'environment-upgrade-'));
  const config = { database, dataDir, limits: { ...DEFAULT_LIMITS } }, db = new Database(createPool(database, 1));
  t.after(async () => { await db.end(); await postgres.dropDatabase(database.database); await rm(dataDir, { recursive: true, force: true }); });
  await migrate(db, [MIGRATIONS[0]]);
  await mkdir(join(dataDir, 'objects'));
  const store = new PgRecordStore(db, { maxRecordBytes: DEFAULT_LIMITS.maxRecordBytes, now: () => new Date() });
  const objects = new FileObjectStore(join(dataDir, 'objects'), db, { maxBytes: DEFAULT_LIMITS.maxUploadBytes, now: () => new Date() });
  const principals = new PgPrincipals(db, () => new Date(), store), auth = new RecordAuthorizations(db, store, () => new Date(), objects);
  const admin = (await principals.bootstrapAdmin('合成升级责任人')).user, user = await principals.createUser(admin, '合成旧成员');
  const executor = newId('exe'), workflow = 'synthetic-lease-workflow', now = new Date().toISOString();
  const evidence = await store.put({ kind: 'action', schema: 'action@1', provenance: 'declared', body: { action: 'validate', run: null, item: null, inputs: [], component: 'synthetic-upgrade@1', lease: null, started_at: now, ended_at: now, result: 'completed', error_code: null, acceptance: null, codes: [], detail: { fixture: true } } });
  let keys = ['synthetic/key'];
  const sources: EnvironmentUpgradeSources = {
    plan: planEnvironmentAssignmentUpgrade,
    collect: async ctx => {
      assert.ok(await ctx.store.get(evidence.digest, ctx.tx));
      return { snapshot: { boundary: ctx.boundary, at: ctx.at,
        members: ctx.members.map(member => ({ ...member, packs: member.id === user.id ? [workflow] : [] })),
        workflows: [{ id: workflow, digest: evidence.digest, kind: 'workflow', available: true, publishedAt: '2000-01-01T00:00:00.000Z', declaration: { context: ['leases'], leases: { prefix: 'synthetic/' } } }],
        executors: [{ id: executor, registeredAt: '2000-01-01T00:00:00.000Z', keys }], holdings: [], effectiveAssignments: [], revokedAssignments: [],
      }, sourceRecords: [evidence.digest] };
    },
  };
  const unchanged = async () => {
    assert.equal((await db.query<{ present: boolean }>("SELECT to_regclass('public.environment_assignment_cutover') IS NOT NULL AS present")).rows[0].present, false);
    assert.deepEqual((await db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version), [1]);
    assert.equal(await auth.latest('resource_assign', user.id, executor), null);
  };
  return { config, db, store, objects, principals, auth, admin, user, executor, sources, setKeys: (value: string[]) => { keys = value; }, unchanged };
}

test('partial keys and changed read sets are refused before any M2 DDL, grant or receipt', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  f.setKeys(['synthetic/key', 'other/key']);
  const blocked = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources);
  assert.equal(blocked.canApply, false);
  await assert.rejects(applyEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources, blocked), /预检/);
  await f.unchanged();
  f.setKeys(['synthetic/key']);
  const ready = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources);
  f.setKeys(['synthetic/changed']);
  await assert.rejects(applyEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources, ready), /已改变/);
  await f.unchanged();
});

test('same-connection API grants, M2 and completion commit together, and restart never restores revocation', { timeout: 120000 }, async t => {
  const f = await fixture(t), baseline = migrationChecksum(MIGRATIONS[0]);
  const preview = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources);
  assert.equal(preview.canApply, true);
  assert.equal(preview.minimumReaderLevel, 2);
  assert.match(preview.downgradeNotice, /不能直接降回 4a/);
  const result = await applyEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources, preview);
  assert.equal(result.grants, 1);
  const grant = await f.auth.latest('resource_assign', f.user.id, f.executor);
  assert.equal(grant?.body.decided_by, f.admin.id);
  assert.match(grant?.body.note ?? '', /升级自动保权.*非管理员手工/);
  assert.equal((await f.db.query('SELECT minimum_reader_level FROM hub_migration_compatibility')).rows[0].minimum_reader_level, 2);
  assert.equal((await f.db.query('SELECT sha256 FROM schema_migrations WHERE version=1')).rows[0].sha256, baseline);
  await verifyMigrations(f.db);
  await assert.rejects(verifyMigrations(f.db, [MIGRATIONS[0]]), /不认识的迁移/);
  await requireEnvironmentAssignmentActivation(f.db, f.store);
  await f.auth.unassignResource(f.admin, f.executor, f.user.id);
  assert.equal((await applyEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources, preview)).alreadyCompleted, true);
  assert.equal((await f.auth.latest('resource_assign', f.user.id, f.executor))?.body.revoked, true);
  await requireEnvironmentAssignmentActivation(f.db, f.store);
});

test('authorization failure after M2 rolls back the migration, all prior grants and completion', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const unknownUser = newId('usr');
  const sources: EnvironmentUpgradeSources = { ...f.sources, plan: snapshot => {
    const plan = planEnvironmentAssignmentUpgrade(snapshot);
    plan.grants.push({ ...plan.grants[0], user: unknownUser });
    return plan;
  } };
  const preview = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, sources);
  await assert.rejects(applyEnvironmentAssignmentUpgrade(f.config, f.admin, sources, preview), /分配对象/);
  await f.unchanged();
});

test('preview is SQL read-only and never accepts a forged admin role or a missing source', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(previewEnvironmentAssignmentUpgrade(f.config, { ...f.user, role: 'admin' }, f.sources), /真实管理员/);
  const writable: EnvironmentUpgradeSources = { ...f.sources, collect: async ctx => {
    await f.auth.grant(f.admin, { permission: 'resource_assign', subject: f.user.id, object: f.executor }, ctx.tx);
    return f.sources.collect(ctx);
  } };
  await assert.rejects(previewEnvironmentAssignmentUpgrade(f.config, f.admin, writable), /read-only/);
  const readersOnly: EnvironmentUpgradeSources = { ...f.sources, collect: async ctx => {
    assert.equal('put' in ctx.objects, false, 'preview must not expose an object writer that can write files before a SQL refusal');
    assert.equal('put' in ctx.store, false);
    return f.sources.collect(ctx);
  } };
  assert.equal((await previewEnvironmentAssignmentUpgrade(f.config, f.admin, readersOnly)).canApply, true);
  const lost: EnvironmentUpgradeSources = { ...f.sources, collect: async ctx => ({ ...await f.sources.collect(ctx), sourceRecords: ['e'.repeat(64)] }) };
  await assert.rejects(previewEnvironmentAssignmentUpgrade(f.config, f.admin, lost), /来源原件缺失/);
  await f.unchanged();
});

test('a real member state change after preview is rejected with no migration or authorization effects', { timeout: 120000 }, async t => {
  const f = await fixture(t), preview = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources);
  await f.principals.setDisabled(f.admin, f.user.id, true);
  await assert.rejects(applyEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources, preview), /已改变/);
  await f.unchanged();
});

test('known previous checksums stay strict and normal migration cannot bypass preservation', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(verifyEnvironmentUpgradeOpenSchema(f.db), /先只读预检/);
  await assert.rejects(migrate(f.db), /先只读预检/);
  await f.unchanged();
  await f.db.query("UPDATE schema_migrations SET sha256=repeat('a',64) WHERE version=1");
  await assert.rejects(previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources), /校验和/);
  assert.equal((await f.db.query("SELECT to_regclass('public.environment_assignment_cutover') AS name")).rows[0].name, null);
});

test('fresh database initialization has no fabricated administrator and no automatic grants', { timeout: 120000 }, async t => {
  const database = await postgres.createDatabase(), dataDir = await mkdtemp(join(tmpdir(), 'environment-upgrade-fresh-'));
  const config = { database, dataDir, limits: { ...DEFAULT_LIMITS } }, db = new Database(createPool(database, 1));
  t.after(async () => { await db.end(); await postgres.dropDatabase(database.database); await rm(dataDir, { recursive: true, force: true }); });
  await migrate(db);
  const store = new PgRecordStore(db, { maxRecordBytes: DEFAULT_LIMITS.maxRecordBytes, now: () => new Date() });
  await requireEnvironmentAssignmentActivation(db, store);
  assert.equal((await db.query('SELECT fresh_database FROM environment_assignment_cutover')).rows[0].fresh_database, true);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM environment_assignment_completion')).rows[0].n, 0);
});


test('an incomplete carrier never activates guards or silently resamples grants', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.db.transaction(tx => migrateEnvironmentAssignments(f.db, tx));
  await assert.rejects(requireEnvironmentAssignmentActivation(f.db, f.store), /先只读预检/);
  await assert.rejects(previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources), /未完成保权/);
  assert.equal(await f.auth.latest('resource_assign', f.user.id, f.executor), null);
});

test('a SELECT-only runtime can inspect a known previous schema but cannot become the migration owner', { timeout: 120000 }, async t => {
  const f = await fixture(t), role = 'synthetic_upgrade_reader', password = randomBytes(24).toString('hex');
  await f.db.query('CREATE ROLE ' + role + " LOGIN PASSWORD '" + password + "'");
  await f.db.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await f.db.query('REVOKE TEMPORARY ON DATABASE "' + f.config.database.database + '" FROM PUBLIC');
  await f.db.query('GRANT USAGE ON SCHEMA public TO ' + role);
  await f.db.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO ' + role);
  const config = { ...f.config, database: { ...f.config.database, user: role, password } };
  const preview = await previewEnvironmentAssignmentUpgrade(config, f.admin, f.sources);
  assert.equal(preview.canApply, false);
  assert.ok(preview.problems.some(problem => problem.includes('不是表拥有者')));
  await assert.rejects(applyEnvironmentAssignmentUpgrade(config, f.admin, f.sources, preview), /预检/);
  await f.unchanged();
});


test('an actual administrator revocation after preview is never replaced by an automatic upgrade grant', { timeout: 120000 }, async t => {
  const f = await fixture(t), preview = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources);
  await f.auth.unassignResource(f.admin, f.executor, f.user.id);
  await assert.rejects(applyEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources, preview), /已有明确决定/);
  assert.deepEqual((await f.db.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version), [1]);
  assert.equal((await f.auth.latest('resource_assign', f.user.id, f.executor))?.body.revoked, true);
  assert.equal((await f.db.query("SELECT to_regclass('public.environment_assignment_cutover') AS name")).rows[0].name, null);
});


test('unknown migration receipts never enter the known-previous preview path', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.db.query('INSERT INTO schema_migrations(version,name,sha256) VALUES(3,$1,$2)', ['synthetic_unknown', 'f'.repeat(64)]);
  await assert.rejects(previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources), /不认识的迁移/);
  assert.equal((await f.db.query("SELECT to_regclass('public.environment_assignment_cutover') AS name")).rows[0].name, null);
});


async function publishActualWorkflow(f: Awaited<ReturnType<typeof fixture>>) {
  const db = new Database(createPool(f.config.database, 4));
  try {
    const store = new PgRecordStore(db, { maxRecordBytes: DEFAULT_LIMITS.maxRecordBytes, now: () => new Date() });
    const objects = new FileObjectStore(join(f.config.dataDir, 'objects'), db, { maxBytes: DEFAULT_LIMITS.maxUploadBytes, now: () => new Date() });
    const principals = new PgPrincipals(db, () => new Date(), store), auth = new RecordAuthorizations(db, store, () => new Date(), objects);
    await auth.grantPublishRight(f.admin, f.admin.id);
    const registry = createPackRegistry({ records: { store, objects, principals, authorizations: auth }, extractDir: join(f.config.dataDir, 'pack-extract'), sandbox: { requireOsIsolation: false } });
    const description = workflowPack({ id: 'synthetic-upgrade-workflow', product: { catalogs: [] } });
    description.files['workflow.json'] = { ...description.files['workflow.json'] as Record<string, unknown>, context: ['leases'], leases: { prefix: 'synthetic/', max_ttl_seconds: 3600 } };
    const written = await writePack(join(f.config.dataDir, 'source-pack'), description);
    const published = await registry.publish(f.admin, written.dir);
    assert.ok(published.ok, JSON.stringify(published));
    return { id: description.id, info: published.version };
  } finally { await db.end(); }
}
async function registerActualExecutor(f: Awaited<ReturnType<typeof fixture>>, id: string, keys: string[]) {
  const source = ExecutorSource.parse({ ...executorDefinition('http://127.0.0.1:9/mcp'), id, credential: '${secret:SYNTHETIC_UPGRADE_KEY}', resources: keys });
  const stored = await f.objects.put(canonicalBytes(source), 'application/json');
  await f.auth.configureResource(f.admin, 'executor.' + id, stored.sha256, '合成执行器登记');
  return stored;
}

test('actual public catalog, team grants and executor source ports produce a real cutover and atomic writer result', { timeout: 180000 }, async t => {
  const f = await fixture(t), workflow = await publishActualWorkflow(f);
  await registerActualExecutor(f, f.executor, ['synthetic/device/a', 'synthetic/device/b']);
  const teamDb = new Database(createPool(f.config.database, 4));
  try {
    const store = new PgRecordStore(teamDb, { maxRecordBytes: DEFAULT_LIMITS.maxRecordBytes, now: () => new Date() });
    const objects = new FileObjectStore(join(f.config.dataDir, 'objects'), teamDb, { maxBytes: DEFAULT_LIMITS.maxUploadBytes, now: () => new Date() });
    const auth = new RecordAuthorizations(teamDb, store, () => new Date(), objects), principals = new PgPrincipals(teamDb, () => new Date(), store);
    const teams = new PgTeams(teamDb, store, objects, principals, auth, () => new Date());
    const team = await teams.create(f.admin, '合成升级团队');
    await teams.add(f.admin, team.id, f.user.id);
    await auth.assignTeam(f.admin, team.id, workflow.id);
  } finally { await teamDb.end(); }
  const sources = environmentAssignmentUpgradeSources(), preview = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, sources);
  assert.equal(preview.canApply, true, preview.problems.join(';'));
  assert.deepEqual(preview.payload?.plan.grants.map(row => [row.user, row.executor]), [[f.user.id, f.executor]]);
  assert.ok(preview.payload?.plan.grants[0].workflows.includes(workflow.info.digest));
  const result = await applyEnvironmentAssignmentUpgrade(f.config, f.admin, sources, preview);
  assert.equal(result.grants, 1);
  assert.equal((await f.auth.latest('resource_assign', f.user.id, f.executor))?.body.decided_by, f.admin.id);
});

test('actual legacy workflow entitlement preserves a preexisting unbound lease without changing its bytes or expiry', { timeout: 180000 }, async t => {
  const f = await fixture(t), workflow = await publishActualWorkflow(f);
  await f.auth.grant(f.admin, { permission: 'assign', subject: f.user.id, object: workflow.id });
  await registerActualExecutor(f, f.executor, ['synthetic/device/a', 'synthetic/device/b']);
  const leases = new LeaseService(f.db, { records: f.store });
  const holder = { user: f.user.id, run: newId('run') }, keys = ['synthetic/device/a', 'synthetic/device/b'];
  assert.ok((await leases.acquire({ keys, holder, prefix: 'synthetic/', ttlSeconds: 600, maxTtlSeconds: 3600 })).ok);
  const before = (await f.db.query('SELECT * FROM leases ORDER BY key')).rows;
  const sources = environmentAssignmentUpgradeSources(), preview = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, sources);
  assert.equal(preview.canApply, true, preview.problems.join(';'));
  assert.deepEqual(preview.payload?.plan.grants[0].holdingRuns, []);
  assert.ok(preview.payload?.plan.grants[0].workflows.includes(workflow.info.digest));
  assert.equal((await applyEnvironmentAssignmentUpgrade(f.config, f.admin, sources, preview)).grants, 1);
  assert.deepEqual((await f.db.query('SELECT * FROM leases ORDER BY key')).rows, before);
  const artifacts = new RecordArtifacts(f.db, f.store, f.objects, f.auth, { maxBytes: DEFAULT_LIMITS.maxUploadBytes, now: () => new Date() });
  const records = { artifacts, authorizations: f.auth, principals: f.principals };
  const environments = new MemberEnvironments(records, { readSource: async id => {
    const config = await f.auth.resourceConfig('executor.' + id);
    if (!config?.body.bound) return null;
    const bytes = await f.objects.get(config.body.bound);
    if (!bytes) throw new Error('合成执行器源缺失');
    return { id, digest: config.body.bound, source: ExecutorSource.parse(JSON.parse(Buffer.from(bytes).toString())) };
  } }, leases, (by, id) => canUseEnvironment(records, by, id));
  assert.equal(await environments.authorizeKeys(f.user, keys), null, 'the actual booking/renewal guard admits preserved rights');
  assert.equal(await environments.canUse(f.user, f.executor), true, 'the actual dispatch access port admits the runner');
  assert.equal(await environments.canUse(f.admin, f.executor), false, 'the scheduler administrator cannot lend use rights');
  assert.ok((await leases.extend({ keys, holder, ttlSeconds: 1200, maxTtlSeconds: 3600 })).ok);
  const renewed = (await f.db.query('SELECT * FROM leases ORDER BY key')).rows;
  await f.auth.unassignResource(f.admin, f.executor, f.user.id);
  assert.equal((await environments.authorizeKeys(f.user, keys))?.code, 'SOURCE_NOT_PERMITTED');
  assert.equal(await environments.canUse(f.user, f.executor), false);
  assert.equal((await applyEnvironmentAssignmentUpgrade(f.config, f.admin, sources, preview)).alreadyCompleted, true);
  assert.equal(await environments.canUse(f.user, f.executor), false, 'startup cannot restore an administrator revocation');
  assert.deepEqual((await f.db.query('SELECT * FROM leases ORDER BY key')).rows, renewed, 'revocation does not release or rewrite the old holding');
});

test('actual held keys alone do not grant an overlapping executor and preflight failure leaves baseline intact', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await registerActualExecutor(f, f.executor, ['synthetic/device/a']);
  await registerActualExecutor(f, newId('exe'), ['synthetic/device/a', 'synthetic/device/b']);
  const leases = new LeaseService(f.db, { records: f.store });
  assert.ok((await leases.acquire({ keys: ['synthetic/device/a'], holder: { user: f.user.id, run: newId('run') }, prefix: 'synthetic/' })).ok);
  const sources = environmentAssignmentUpgradeSources(), preview = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, sources);
  assert.equal(preview.canApply, false);
  assert.deepEqual(preview.payload?.plan.grants, []);
  assert.ok(preview.problems.some(problem => problem.includes('执行器归属')));
  await assert.rejects(applyEnvironmentAssignmentUpgrade(f.config, f.admin, sources, preview), /预检/);
  await f.unchanged();
});

test('actual collector refuses a missing source object instead of returning an empty executor catalog', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.auth.configureResource(f.admin, 'executor.' + f.executor, 'c'.repeat(64), '合成缺失源反例');
  await assert.rejects(previewEnvironmentAssignmentUpgrade(f.config, f.admin, environmentAssignmentUpgradeSources()), /原件缺失/);
  await f.unchanged();
});


test('upgrade authentication uses the actual Bearer owner without last-used writes and refuses invalid roles or receipts', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  const token = await f.principals.issueToken(f.admin, f.admin.id);
  const memberToken = await f.principals.issueToken(f.admin, f.user.id);
  const before = (await f.db.query('SELECT * FROM tokens ORDER BY id')).rows;
  assert.deepEqual(await authenticateEnvironmentUpgradeActor(f.config, `Bearer ${token.token}`), { id: f.admin.id, name: f.admin.name, role: f.admin.role });
  for (const value of [undefined, null, 'Bearer invalid', `Bearer ${memberToken.token}`]) await assert.rejects(authenticateEnvironmentUpgradeActor(f.config, value));
  assert.deepEqual((await f.db.query('SELECT * FROM tokens ORDER BY id')).rows, before);
  assert.equal((await f.principals.authenticate(`Bearer ${token.token}`))?.id, f.admin.id);
  assert.ok((await f.db.query('SELECT last_used_at FROM tokens WHERE id=$1', [token.id])).rows[0].last_used_at, 'normal authentication retains usage telemetry');
  await f.principals.revokeToken(f.admin, token.id);
  await assert.rejects(authenticateEnvironmentUpgradeActor(f.config, `Bearer ${token.token}`));
  const other = await f.principals.issueToken(f.admin, f.admin.id);
  await f.db.query("UPDATE schema_migrations SET sha256=repeat('0',64) WHERE version=1");
  await assert.rejects(authenticateEnvironmentUpgradeActor(f.config, `Bearer ${other.token}`));
});

test('activation is publicly readable only after completion and runtime grants share the cutover transaction', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(readEnvironmentAssignmentActivation(f.config));
  const preview = await previewEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources);
  await assert.rejects(applyEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources, preview, { runtimeRole: 'missing_synthetic_runtime' }));
  await f.unchanged();
  const role = 'synthetic_atomic_runtime';
  await f.db.query('CREATE ROLE ' + role);
  await f.db.query('REVOKE TEMPORARY ON DATABASE "' + f.config.database.database + '" FROM PUBLIC');
  await f.db.query('GRANT USAGE ON SCHEMA public TO ' + role);
  const receipt = await applyEnvironmentAssignmentUpgrade(f.config, f.admin, f.sources, preview, { runtimeRole: role });
  assert.deepEqual(await readEnvironmentAssignmentActivation(f.config), { ...receipt, alreadyCompleted: true });
  const rights = (await f.db.query("SELECT has_table_privilege($1,'public.environment_assignment_completion','SELECT') AS read, has_table_privilege($1,'public.environment_assignment_completion','INSERT') AS write", [role])).rows[0];
  assert.equal(rights.read, true);
  assert.equal(rights.write, false);
});
