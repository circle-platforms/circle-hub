import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { DEFAULT_LIMITS } from '../config/index.ts';
import { Database, createPool } from './db.ts';
import { MIGRATIONS, migrate, migrateEnvironmentAssignments, grantRuntime } from './migrations.ts';
import { readEnvironmentAssignmentActivation, authenticateEnvironmentUpgradeActor, previewEnvironmentAssignmentUpgrade, applyEnvironmentAssignmentUpgrade } from './api.ts';
import { appendMigrationCompatibility } from './migration-compatibility-store.ts';
import { PgRecordStore } from './store.ts';
import { PgPrincipals } from './principals.ts';
import { planEnvironmentAssignmentUpgrade } from '../server/environment-assignment-upgrade.ts';
import type { EnvironmentUpgradeSources } from './api.ts';
import { newId } from './ids.ts';

let postgres: TemporaryPostgres;
const role = 'synthetic_activation_reader';
before(async () => {
  postgres = await startPostgres({ socket: true, passwordless: true, private: true });
  const db = new Database(createPool(postgres.config, 1));
  try { await db.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER`); } finally { await db.end(); }
});
after(async () => { await postgres?.stop(); });

async function fixture(t: { after(fn: () => Promise<void>): void }, pending = false) {
  const database = await postgres.createDatabase(), dataDir = await mkdtemp(join(tmpdir(), 'activation-admission-'));
  const owner = new Database(createPool(database, 1));
  t.after(async () => { await owner.end(); await postgres.dropDatabase(database.database); await rm(dataDir, { recursive: true, force: true }); });
  await owner.query(`REVOKE TEMPORARY ON DATABASE "${database.database}" FROM PUBLIC`);
  if (pending) {
    await migrate(owner, [MIGRATIONS[0]]);
    await owner.transaction(tx => migrateEnvironmentAssignments(owner, tx));
  } else await migrate(owner);
  await grantRuntime(owner, role);
  const config = { database: { ...database, user: role }, dataDir, limits: { ...DEFAULT_LIMITS } };
  async function future(mode: 'matching' | 'missing' | 'wrong' | 'higher' = 'matching') {
    await owner.transaction(async tx => {
      await owner.query("INSERT INTO public.schema_migrations(version,name,sha256) VALUES(3,'synthetic_future_addition',$1)", ['e'.repeat(64)], tx);
      if (mode === 'wrong') await owner.query("INSERT INTO public.hub_migration_compatibility VALUES(3,1,'synthetic_future_addition',$1,2)", ['f'.repeat(64)], tx);
      else if (mode !== 'missing') await appendMigrationCompatibility(owner, tx, { migration_version: 3, format_version: 1, migration_name: 'synthetic_future_addition', migration_sha256: 'e'.repeat(64), minimum_reader_level: mode === 'higher' ? 3 : 2 });
    });
  }
  return { owner, config, future };
}

test('E admits declared floor2 M3 on a single readonly runtime connection and leaves A strict', { timeout: 120000 }, async t => {
  const f = await fixture(t); await f.future();
  assert.deepEqual(await readEnvironmentAssignmentActivation(f.config), { freshDatabase: true, alreadyCompleted: true, grants: 0, authorizationRecords: [] });
  await assert.rejects(authenticateEnvironmentUpgradeActor(f.config, 'Bearer invalid'), /未知|迁移/);
});
for (const mode of ['missing', 'wrong', 'higher'] as const) {
  test(`E refuses M3 declaration ${mode}`, { timeout: 120000 }, async t => {
    const f = await fixture(t); await f.future(mode);
    await assert.rejects(readEnvironmentAssignmentActivation(f.config));
  });
}
test('C2 compatible M3 never substitutes for missing preservation completion', { timeout: 120000 }, async t => {
  const f = await fixture(t, true); await f.future();
  await assert.rejects(readEnvironmentAssignmentActivation(f.config), /先只读预检/);
});
test('E still refuses a changed known M2 checksum despite declared M3', { timeout: 120000 }, async t => {
  const f = await fixture(t); await f.future();
  await f.owner.query("UPDATE public.schema_migrations SET sha256=$1 WHERE version=2", ['d'.repeat(64)]);
  await assert.rejects(readEnvironmentAssignmentActivation(f.config));
});
test('unobservable C2 metadata remains unknown rather than a completion verdict', { timeout: 120000 }, async t => {
  const f = await fixture(t); await f.future();
  await f.owner.query(`REVOKE SELECT ON public.hub_migration_compatibility FROM ${role}`);
  await assert.rejects(readEnvironmentAssignmentActivation(f.config), /无法观察/);
});


async function preserved(t: { after(fn: () => Promise<void>): void }) {
  const f = await fixture(t, true);
  // Recreate the known previous receipt set only in this isolated synthetic database.
  await f.owner.query('DROP TABLE public.environment_assignment_completion,public.environment_assignment_snapshot,public.environment_assignment_cutover,public.hub_migration_compatibility');
  await f.owner.query('DELETE FROM public.schema_migrations WHERE version=2');
  const store = new PgRecordStore(f.owner, { maxRecordBytes: DEFAULT_LIMITS.maxRecordBytes, now: () => new Date() });
  const principals = new PgPrincipals(f.owner, () => new Date(), store);
  const admin = (await principals.bootstrapAdmin('合成升级管理员')).user;
  const member = await principals.createUser(admin, '合成原工作流成员');
  const executor = newId('exe'), at = new Date().toISOString();
  const evidence = await store.put({ kind: 'action', schema: 'action@1', provenance: 'declared', body: { action: 'validate', run: null, item: null, inputs: [], component: 'synthetic-activation@1', lease: null, started_at: at, ended_at: at, result: 'completed', error_code: null, acceptance: null, codes: [], detail: {} } });
  const sources: EnvironmentUpgradeSources = {
    plan: planEnvironmentAssignmentUpgrade,
    collect: async ctx => ({ snapshot: { boundary: ctx.boundary, at: ctx.at,
      members: ctx.members.map(row => ({ ...row, packs: row.id === member.id ? ['synthetic-workflow'] : [] })),
      workflows: [{ id: 'synthetic-workflow', digest: evidence.digest, kind: 'workflow', available: true, publishedAt: '2000-01-01T00:00:00.000Z', declaration: { context: ['leases'], leases: { prefix: 'synthetic/' } } }],
      executors: [{ id: executor, registeredAt: '2000-01-01T00:00:00.000Z', keys: ['synthetic/key'] }],
      holdings: [], effectiveAssignments: [], revokedAssignments: [],
    }, sourceRecords: [evidence.digest] }),
  };
  const ownerConfig = { ...f.config, database: { ...f.config.database, user: postgres.config.user } };
  const preview = await previewEnvironmentAssignmentUpgrade(ownerConfig, admin, sources);
  assert.equal(preview.canApply, true, preview.problems.join(';'));
  const receipt = await applyEnvironmentAssignmentUpgrade(ownerConfig, admin, sources, preview, { runtimeRole: role });
  assert.equal(receipt.grants, 1);
  await f.future();
  assert.deepEqual(await readEnvironmentAssignmentActivation(f.config), { ...receipt, alreadyCompleted: true });
  return { ...f, ownerConfig, admin, sources };
}

test('admitted M3 still requires the exact preserved snapshot and keeps owner preview strict', { timeout: 120000 }, async t => {
  const f = await preserved(t);
  await assert.rejects(previewEnvironmentAssignmentUpgrade(f.ownerConfig, f.admin, f.sources), /未知|迁移/);
  await f.owner.query('ALTER TABLE public.environment_assignment_snapshot DISABLE TRIGGER USER');
  await f.owner.query("UPDATE public.environment_assignment_snapshot SET snapshot=jsonb_set(snapshot,'{responsibleUser}',to_jsonb('synthetic-wrong'::text))");
  await assert.rejects(readEnvironmentAssignmentActivation(f.config), /快照|完成事实/);
});
test('admitted M3 never bypasses actual preservation authorization references', { timeout: 120000 }, async t => {
  const f = await preserved(t);
  await f.owner.query('ALTER TABLE public.environment_assignment_completion DISABLE TRIGGER USER');
  await f.owner.query("UPDATE public.environment_assignment_completion SET authorization_records='[]'::jsonb");
  await assert.rejects(readEnvironmentAssignmentActivation(f.config), /授权回执/);
});
