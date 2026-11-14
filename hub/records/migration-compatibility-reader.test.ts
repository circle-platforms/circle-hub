import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres } from '../testing/postgres.ts';
import { DEFAULT_LIMITS } from '../config/index.ts';
import { Database, createPool } from './db.ts';
import { MIGRATIONS, migrate, grantRuntime, migrateEnvironmentAssignments } from './migrations.ts';
import { openRecords, diagnoseRecordsSchema, EnvironmentUpgradeRequiredError, type RecordsConfig } from './api.ts';
import { rebuildRequiredState } from '../server/rebuild-state.ts';
import { appendMigrationCompatibility } from './migration-compatibility-store.ts';

const runtimeRole = 'synthetic_c2_runtime';

test('real PostgreSQL openRecords and diagnostics share strict compatibility independently of preservation', { timeout: 180_000 }, async t => {
  const postgres = await startPostgres({ socket: true, passwordless: true, private: true });
  t.after(() => postgres.stop());
  const maintenance = new Database(createPool(postgres.config, 1));
  try { await maintenance.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER`); }
  finally { await maintenance.end(); }

  async function fixture(sub: { after(fn: () => Promise<void>): void }, mode: 'fresh' | 'pending' | 'previous' = 'fresh') {
    const database = await postgres.createDatabase();
    const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-c2-reader-'));
    const owner = new Database(createPool(database, 1));
    sub.after(async () => { await owner.end(); await postgres.dropDatabase(database.database); await rm(dataDir, { recursive: true, force: true }); });
    await owner.query(`REVOKE TEMPORARY ON DATABASE "${database.database}" FROM PUBLIC`);
    if (mode === 'fresh') await migrate(owner);
    else {
      await migrate(owner, [MIGRATIONS[0]]);
      if (mode === 'pending') await owner.transaction(tx => migrateEnvironmentAssignments(owner, tx));
    }
    if (mode === 'previous') await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${runtimeRole}`);
    else await grantRuntime(owner, runtimeRole);
    await mkdir(join(dataDir, 'keys')); await mkdir(join(dataDir, 'vault'));
    const files = [join(dataDir, 'keys', 'synthetic.key'), join(dataDir, 'vault', 'synthetic.sealed')];
    for (const file of files) await writeFile(file, 'synthetic-preserved-bytes', { mode: 0o600 });
    let keyReads = 0;
    const config: RecordsConfig = { database: { ...database, user: runtimeRole }, dataDir, logDir: join(dataDir, 'logs'), limits: { ...DEFAULT_LIMITS } };
    const options = { migrate: false, keyProvider: { getKey: async (): Promise<Uint8Array> => { keyReads++; throw new Error('compatibility must not read key bytes'); } } };
    const unchanged = async () => {
      assert.equal(keyReads, 0);
      for (const file of files) assert.equal(await readFile(file, 'utf8'), 'synthetic-preserved-bytes');
    };
    const future = async (declaration: 'matching' | 'missing' | 'wrong' | 'higher' = 'matching') => {
      const version = MIGRATIONS.at(-1)!.version + 1, name = 'synthetic_future_addition', sha256 = 'e'.repeat(64);
      await owner.transaction(async tx => {
        await owner.query('CREATE TABLE public.synthetic_future_addition (value integer)', [], tx);
        await owner.query('INSERT INTO public.schema_migrations(version,name,sha256) VALUES($1,$2,$3)', [version, name, sha256], tx);
        if (declaration === 'wrong') {
          await owner.query('INSERT INTO public.hub_migration_compatibility(migration_version,format_version,migration_name,migration_sha256,minimum_reader_level) VALUES($1,1,$2,$3,2)', [version, name, 'f'.repeat(64)], tx);
        } else if (declaration !== 'missing') {
          await appendMigrationCompatibility(owner, tx, { migration_version: version, format_version: 1, migration_name: name, migration_sha256: sha256, minimum_reader_level: declaration === 'higher' ? 3 : 2 });
        }
      });
      return version;
    };
    return { owner, config, options, future, unchanged };
  }

  await t.test('unknown additive migration with exact declaration opens through the actual API', async sub => {
    const f = await fixture(sub); const version = await f.future();
    const diagnosis = await diagnoseRecordsSchema(f.config);
    assert.equal(diagnosis.status, 'compatible');
    assert.equal('environmentAssignmentCompleted' in diagnosis, false);
    assert.equal(rebuildRequiredState(diagnosis), null);
    const records = await openRecords(f.config, f.options);
    try { assert.ok(records.authorizations); }
    finally { await records.close(); }
    assert.ok(diagnosis.applied?.some(row => row.version === version));
    await f.unchanged();
  });
  await t.test('known checksum remains strict even when future metadata is valid', async sub => {
    const f = await fixture(sub); await f.future();
    await f.owner.query('UPDATE public.schema_migrations SET sha256=$1 WHERE version=$2', ['d'.repeat(64), MIGRATIONS[0].version]);
    const diagnosis = await diagnoseRecordsSchema(f.config);
    assert.equal(diagnosis.status, 'incompatible');
    await assert.rejects(openRecords(f.config, f.options));
    await f.unchanged();
  });
  for (const declaration of ['missing', 'wrong', 'higher'] as const) {
    await t.test(`unknown declaration ${declaration} rejects both API entry points`, async sub => {
      const f = await fixture(sub); await f.future(declaration);
      assert.equal((await diagnoseRecordsSchema(f.config)).status, 'incompatible');
      await assert.rejects(openRecords(f.config, f.options)); await f.unchanged();
    });
  }
  await t.test('unreadable metadata and a missing database are unavailable, never rebuild', async sub => {
    const f = await fixture(sub);
    await f.owner.query(`REVOKE SELECT ON public.hub_migration_compatibility FROM ${runtimeRole}`);
    for (const config of [f.config, { ...f.config, database: { ...f.config.database, database: 'synthetic_missing_database' } }]) {
      const diagnosis = await diagnoseRecordsSchema(config);
      assert.equal(diagnosis.status, 'unavailable'); assert.equal(diagnosis.compatible, null);
      assert.equal(rebuildRequiredState(diagnosis), null);
      await assert.rejects(openRecords(config, f.options));
    }
    await f.unchanged();
  });
  await t.test('readable current schema does not bypass missing preservation completion', async sub => {
    const f = await fixture(sub, 'pending');
    assert.equal((await diagnoseRecordsSchema(f.config)).status, 'compatible');
    await assert.rejects(openRecords(f.config, f.options), error => error instanceof EnvironmentUpgradeRequiredError);
    await f.unchanged();
  });
  await t.test('exact previous baseline keeps the explicit upgrade path rather than implicit activation', async sub => {
    const f = await fixture(sub, 'previous');
    await assert.rejects(openRecords(f.config, f.options), error => error instanceof EnvironmentUpgradeRequiredError);
    await f.unchanged();
  });
  await t.test('runtime temporary-object privilege remains forbidden', async sub => {
    const f = await fixture(sub);
    await f.owner.query(`GRANT TEMPORARY ON DATABASE "${f.config.database.database}" TO ${runtimeRole}`);
    await assert.rejects(openRecords(f.config, f.options), /临时对象/);
    await f.unchanged();
  });
});
