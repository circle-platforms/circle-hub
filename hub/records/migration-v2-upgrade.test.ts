import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { DEFAULT_LIMITS, type DatabaseConfig } from '../config/index.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { Database, createPool } from './db.ts';
import { FileKeyProvider, MIGRATIONS, openRecords } from './index.ts';
import { grantRuntime, migrate } from './migrations.ts';
import { PgPrincipals } from './principals.ts';
import { createRecordStore } from './store.ts';
import { sha256Hex } from './digest.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres();
});
after(async () => {
  await postgres?.stop();
});

async function sql(config: DatabaseConfig, text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ ...config, ssl: false });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

async function sqlState(db: Database, query: string, values: unknown[] = []): Promise<string | null> {
  try {
    await db.query(query, values);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}

test('H10a: upgrading from Migration 1 preserves users, tokens and records and grants SELECT/INSERT/DELETE only on external_member_identities', async (t) => {
  const dbName = 't_mig_v1_v2_' + randomBytes(4).toString('hex');
  const ownerRole = 'mig_owner_' + randomBytes(4).toString('hex');
  const runtimeRole = 'mig_runtime_' + randomBytes(4).toString('hex');
  const ownerPassword = randomBytes(18).toString('base64url');
  const runtimePassword = randomBytes(18).toString('base64url');
  await sql(postgres.config, `CREATE ROLE "${ownerRole}" LOGIN PASSWORD '${ownerPassword}'`);
  await sql(postgres.config, `CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${runtimePassword}'`);
  await sql(postgres.config, `CREATE DATABASE "${dbName}" OWNER "${ownerRole}"`);
  await sql(postgres.config, `REVOKE TEMPORARY ON DATABASE "${dbName}" FROM PUBLIC`);
  t.after(async () => {
    await postgres.dropDatabase(dbName);
    await sql(postgres.config, `DROP ROLE IF EXISTS "${runtimeRole}", "${ownerRole}"`).catch(() => {});
  });

  const ownerConfig: DatabaseConfig = { ...postgres.config, database: dbName, user: ownerRole, password: ownerPassword };
  const runtimeConfig: DatabaseConfig = { ...postgres.config, database: dbName, user: runtimeRole, password: runtimePassword };
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-mig-v2-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const ownerDb = new Database(createPool(ownerConfig));
  t.after(() => ownerDb.end());

  // Apply ONLY Migration 1 (baseline schema present on v1 / release/2026-11-23).
  assert.deepEqual(await migrate(ownerDb, MIGRATIONS.slice(0, 1)), [1]);
  assert.equal((await ownerDb.query("SELECT to_regclass('public.external_member_identities') AS reg")).rows[0].reg, null);

  const keyProvider = new FileKeyProvider(join(dataDir, 'vault.key'));
  await keyProvider.initKey();
  const v1Now = () => new Date();
  const v1Store = createRecordStore(ownerDb, { maxRecordBytes: DEFAULT_LIMITS.maxRecordBytes, now: v1Now });
  const v1Principals = new PgPrincipals(ownerDb, v1Now, v1Store);
  const { user: adminUser, token: adminToken } = await v1Principals.bootstrapAdmin('迁移管理员');
  const adminPrincipal = { id: adminUser.id, name: adminUser.name, role: adminUser.role };
  const member = await v1Principals.createUser(adminPrincipal, '迁移测试成员', 'user', {
    password: 'Synthetic-v1-password-1!',
    mustChange: false,
  });
  const memberToken = await v1Principals.issueToken(adminPrincipal, member.id, 'v1-token');
  const rec = await v1Store.put({
    kind: 'memory_version',
    schema: 'memory-version@1',
    provenance: 'declared',
    body: { space: member.id, markdown: 'synthetic-v1-preserved-content' },
  });

  // Upgrade from Migration 1 to latest (Migration 2+) and apply runtime role grants.
  assert.deepEqual(await migrate(ownerDb, MIGRATIONS), [2]);
  await grantRuntime(ownerDb, runtimeRole);

  // Open RecordsKit as the least-privilege runtime role against the upgraded database.
  const rtKit = await openRecords(
    { dataDir, logDir: join(dataDir, 'logs'), database: runtimeConfig, limits: { ...DEFAULT_LIMITS } },
    { migrate: false, keyProvider },
  );
  t.after(() => rtKit.close());

  // 1. All v1 users, tokens and records are preserved unchanged.
  assert.equal((await rtKit.principals.get(adminUser.id))?.name, '迁移管理员');
  assert.equal((await rtKit.principals.get(member.id))?.name, '迁移测试成员');
  assert.equal((await rtKit.principals.authenticate('Bearer ' + adminToken.token))?.id, adminUser.id);
  assert.equal((await rtKit.principals.authenticate('Bearer ' + memberToken.token))?.id, member.id);
  const loadedRec = await rtKit.store.get(rec.digest);
  assert.ok(loadedRec);
  assert.equal(loadedRec.digest, rec.digest);
  assert.deepEqual(loadedRec.body, rec.body);

  // 2. Runtime role has SELECT, INSERT, DELETE on external_member_identities, and NEVER UPDATE or TRUNCATE.
  const rtDb = new Database(createPool(runtimeConfig));
  t.after(() => rtDb.end());
  const issuer = sha256Hex('migration-v2-issuer');
  assert.equal(
    await sqlState(rtDb, 'INSERT INTO external_member_identities(issuer, subject, owner) VALUES($1, $2, $3)', [issuer, 'sub-1', member.id]),
    null,
  );
  assert.equal(
    (await rtDb.query('SELECT owner FROM external_member_identities WHERE issuer=$1 AND subject=$2', [issuer, 'sub-1'])).rows[0]?.owner,
    member.id,
  );
  assert.equal(
    await sqlState(rtDb, 'UPDATE external_member_identities SET subject=$1 WHERE issuer=$2', ['sub-2', issuer]),
    '42501',
    'runtime role must not UPDATE external_member_identities',
  );
  assert.equal(
    await sqlState(rtDb, 'TRUNCATE external_member_identities'),
    '42501',
    'runtime role must not TRUNCATE external_member_identities',
  );
  assert.equal(
    await sqlState(rtDb, 'DELETE FROM external_member_identities WHERE owner=$1', [member.id]),
    null,
    'runtime role must be able to DELETE external_member_identities for unbind/disable/delete',
  );
  assert.equal(
    (await rtDb.query('SELECT count(*)::int AS n FROM external_member_identities WHERE owner=$1', [member.id])).rows[0].n,
    0,
  );
});
