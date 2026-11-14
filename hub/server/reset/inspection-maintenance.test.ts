import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres } from '../../testing/postgres.ts';
import { Database, createPool, migrateRecords, diagnoseRecordsSchema, diagnoseRecordsSchemaForMaintenance } from '../../records/api.ts';
import { createContext, layoutAt, ensureLayout, newSettingsFile, writeSettingsFile, postgresFor } from '../../platform/api.ts';
import { inspectReset } from './inspection.ts';

const runtime = 'synthetic_reset_runtime';

test('reset maintenance observes the actual runtime role while CONNECT remains revoked', { timeout: 180_000 }, async t => {
  const postgres = await startPostgres({ socket: true, passwordless: true, private: true });
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-maintenance-inspection-'));
  let owner: Database | undefined;
  t.after(async () => { try { await owner?.end(); } finally { try { await postgres.stop(); } finally { await rm(root, { recursive: true, force: true }); } } });
  const database = await postgres.createDatabase();
  owner = new Database(createPool(database, 1));
  await owner.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER`);
  await owner.query(`REVOKE TEMPORARY ON DATABASE "${database.database}" FROM PUBLIC`);
  await migrateRecords({ database }, { runtimeRole: runtime });
  // Use only the synthetic cluster's private socket; no platform service command is run.
  const layout = { ...layoutAt(join(root, 'data')), run: postgres.socketDir };
  await ensureLayout(layout);
  const settings = newSettingsFile({ environment: 'test', port: 7999, database: { name: database.database, role: runtime, port: database.port } });
  await writeSettingsFile(layout, settings);
  const context = createContext({}, { layout, home: root, user: database.user, database: { name: database.database, role: runtime, port: database.port },
    runner: async () => { throw new Error('maintenance inspection must not invoke a service command'); } });
  assert.equal(postgresFor(context).application.user, runtime);
  await mkdir(join(layout.root, 'keys'), { recursive: true });
  const protectedFile = join(layout.root, 'keys', 'synthetic-retained-key');
  await writeFile(protectedFile, 'synthetic-private-bytes', { mode: 0o600 });
  await owner.query(`REVOKE CONNECT ON DATABASE "${database.database}" FROM PUBLIC,${runtime}`);
  const connectStillRevoked = async () => {
    const row = (await owner!.query<{ allowed: boolean }>('SELECT pg_catalog.has_database_privilege($1,$2,$3) AS allowed', [runtime, database.database, 'CONNECT'])).rows[0];
    assert.equal(row.allowed, false);
    const direct = new Database(createPool({ ...database, user: runtime }, 1));
    try { await assert.rejects(direct.query('SELECT current_user'), error => error !== null && typeof error === 'object' && 'code' in error && error.code === '42501'); }
    finally { await direct.end(); }
    assert.equal(await readFile(protectedFile, 'utf8'), 'synthetic-private-bytes');
  };

  await t.test('owner maintenance can inspect under runtime ACL without restoring CONNECT', async () => {
    await connectStillRevoked();
    const directOwner = await diagnoseRecordsSchema({ database });
    assert.equal(directOwner.status, 'incompatible', 'owner must never be mislabeled as a read-only runtime');
    const result = await inspectReset(context);
    assert.equal(result.compatible, true); assert.equal(result.available, true); assert.equal(result.needsRebuild, false);
    await connectStillRevoked();
  });
  await t.test('SELECT revoked from the actual role is unavailable despite owner access', async () => {
    await owner!.query(`REVOKE SELECT ON public.hub_migration_compatibility FROM ${runtime}`);
    try {
      const result = await inspectReset(context);
      assert.equal(result.available, false); assert.equal(result.compatible, false); assert.equal(result.needsRebuild, false);
    } finally { await owner!.query(`GRANT SELECT ON public.hub_migration_compatibility TO ${runtime}`); }
    await connectStillRevoked();
  });
  await t.test('actual runtime declaration write privilege is still rejected', async () => {
    await owner!.query(`GRANT INSERT ON public.hub_migration_compatibility TO ${runtime}`);
    try {
      const result = await inspectReset(context);
      assert.equal(result.available, true); assert.equal(result.compatible, false); assert.equal(result.needsRebuild, true);
    } finally { await owner!.query(`REVOKE INSERT ON public.hub_migration_compatibility FROM ${runtime}`); }
    await connectStillRevoked();
  });
  await t.test('unauthorized SET ROLE and a quoted nonexistent role never fall back to owner', async () => {
    const observer = 'synthetic_reset_observer';
    await owner!.query(`CREATE ROLE ${observer} LOGIN NOSUPERUSER`);
    await owner!.query(`GRANT CONNECT ON DATABASE "${database.database}" TO ${observer}`);
    const denied = await diagnoseRecordsSchemaForMaintenance({ database: { ...database, user: observer } }, runtime);
    assert.equal(denied.status, 'unavailable'); assert.equal(denied.compatible, null);
    const malformed = await diagnoseRecordsSchemaForMaintenance({ database }, runtime + '\"; RESET ROLE; --');
    assert.equal(malformed.status, 'unavailable'); assert.equal(malformed.compatible, null);
    await connectStillRevoked();
  });
  await t.test('known checksum corruption stays incompatible under the switched role', async () => {
    const original = (await owner!.query<{ sha256: string }>('SELECT sha256 FROM public.schema_migrations WHERE version=1')).rows[0].sha256;
    await owner!.query('UPDATE public.schema_migrations SET sha256=$1 WHERE version=1', ['c'.repeat(64)]);
    try { assert.equal((await inspectReset(context)).needsRebuild, true); }
    finally { await owner!.query('UPDATE public.schema_migrations SET sha256=$1 WHERE version=1', [original]); }
    await connectStillRevoked();
  });
});
