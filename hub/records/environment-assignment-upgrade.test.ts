import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_LIMITS } from '../config/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { Database, createPool } from './db.ts';
import { MIGRATIONS, migrate, migrationChecksum, verifyMigrations, migrateEnvironmentAssignments } from './migrations.ts';
import { PgRecordStore } from './store.ts';
import { PgPrincipals } from './principals.ts';
import { RecordAuthorizations } from './authorizations.ts';
import { FileObjectStore } from './objects.ts';
import { newId } from './ids.ts';
import { previewEnvironmentAssignmentUpgrade, applyEnvironmentAssignmentUpgrade, requireEnvironmentAssignmentActivation, verifyEnvironmentUpgradeOpenSchema, type EnvironmentUpgradeSources } from './environment-assignment-upgrade.ts';
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
  return { config, db, store, principals, auth, admin, user, executor, sources, setKeys: (value: string[]) => { keys = value; }, unchanged };
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
