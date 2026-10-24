// Owner and runtime roles (README decision 16): the owner migrates; the runtime role reads and appends, and cannot alter,
// delete, truncate or disable the triggers of the history tables.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { DEFAULT_LIMITS } from '../config/index.ts';
import type { DatabaseConfig } from '../config/index.ts';
import { startPostgres } from '../testing/postgres.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { sha256Hex } from './digest.ts';
import { MigrationError } from './errors.ts';
import { FileKeyProvider, migrateRecords, openRecords } from './index.ts';

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

test('the runtime role does what the Hub needs, and nothing that could rewrite or remove history', async (t) => {
  const ownerPassword = randomBytes(18).toString('base64url');
  const runtimePassword = randomBytes(18).toString('base64url');
  await sql(postgres.config, `CREATE ROLE hub_owner LOGIN PASSWORD '${ownerPassword}'`);
  await sql(postgres.config, `CREATE ROLE hub_runtime LOGIN PASSWORD '${runtimePassword}'`);
  await sql(postgres.config, 'CREATE DATABASE t_roles OWNER hub_owner');
  t.after(() => postgres.dropDatabase('t_roles'));
  const owner: DatabaseConfig = { ...postgres.config, database: 't_roles', user: 'hub_owner', password: ownerPassword };
  const runtime: DatabaseConfig = { ...postgres.config, database: 't_roles', user: 'hub_runtime', password: runtimePassword };
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-roles-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, logDir: join(dataDir, 'logs'), database: runtime, limits: { ...DEFAULT_LIMITS } };
  // Before the owner migrated, the runtime role refuses to start instead of trying to create tables.
  await assert.rejects(openRecords(config, { migrate: false }), (error: unknown) => error instanceof MigrationError && /还没有应用/.test((error as Error).message));
  assert.deepEqual(await migrateRecords({ database: owner }, { runtimeRole: 'hub_runtime' }), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(await migrateRecords({ database: owner }, { runtimeRole: 'hub_runtime' }), []);
  // The role that owns the tables could disable the triggers, so it is refused as the runtime role.
  await assert.rejects(migrateRecords({ database: owner }, { runtimeRole: 'hub_owner' }), MigrationError);
  await assert.rejects(migrateRecords({ database: owner }, { runtimeRole: 'Bad Role' }), TypeError);

  const keyProvider = new FileKeyProvider(join(dataDir, 'vault.key'));
  await keyProvider.initKey();
  const kit = await openRecords(config, { migrate: false, keyProvider });
  t.after(() => kit.close());
  // Every operation of the kit works as the runtime role.
  const { user, token } = await kit.principals.bootstrapAdmin('管理员');
  const admin = { id: user.id, name: user.name, role: user.role };
  assert.equal((await kit.principals.authenticate(`Bearer ${token.token}`))?.id, user.id);
  const member = await kit.principals.createUser(admin, '成员');
  await kit.principals.setRole(admin, member.id, 'admin');
  await kit.principals.setDisabled(admin, member.id, true);
  const issued = await kit.principals.issueToken(admin, user.id, '第二枚');
  assert.equal(await kit.principals.revokeToken(admin, issued.id), true);
  await kit.authorizations.assign(admin, user.id, 'case-review');
  const artifact = await kit.artifacts.ingest({
    bytes: Buffer.from('合成的上传'),
    mediaType: 'text/plain',
    origin: { upload: { session: 'sess-roles' } },
    author: { user: user.id },
    provenanceType: 'declared',
    visibility: { readers: [user.id], admins: true, packs: [], shareable: true },
  });
  assert.equal((await kit.artifacts.text(admin, artifact.body.sha256))?.text, '合成的上传');
  await kit.pointers.move({ name: 'knowledge/a', expected: null, next: sha256Hex('a') });
  await kit.pointers.move({ name: 'knowledge/a', expected: sha256Hex('a'), next: sha256Hex('b') });
  await kit.callLog.append({ traceId: 'c'.repeat(32), userId: user.id, sessionId: null, tool: 'get_nodes', runId: null, arguments: {}, callResult: 'error', errorCode: 'SOURCE_UNAVAILABLE', durationMs: 1, adminNote: '原因' });
  assert.equal((await kit.callLog.query(admin)).items[0].admin_note, '原因');
  await kit.vault.put('db.password', 'synthetic');

  const refused = [
    `UPDATE records SET body = '{}'`,
    'DELETE FROM records',
    'TRUNCATE records CASCADE',
    'ALTER TABLE records DISABLE TRIGGER USER',
    'ALTER TABLE call_logs DISABLE TRIGGER ALL',
    'DROP TABLE call_notes',
    "UPDATE record_index SET value = 'x'",
    'DELETE FROM call_notes',
    "UPDATE users SET name = 'x'",
    'DELETE FROM users',
    'DELETE FROM tokens',
    'DELETE FROM pointers',
    "UPDATE record_keys SET key='changed'",
    'DELETE FROM record_keys',
    'TRUNCATE record_keys',
    'ALTER TABLE record_keys DISABLE TRIGGER ALL',
    'DROP TABLE record_keys',
    "UPDATE schema_migrations SET sha256 = repeat('0', 64)",
    'CREATE TABLE intruder (x int)',
    'CREATE OR REPLACE FUNCTION hub_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$',
  ];
  // 42501 insufficient_privilege: "permission denied", "must be owner"; refused by privileges, before any trigger runs.
  for (const statement of refused) {
    await assert.rejects(sql(runtime, statement), (error: unknown) => (error as { code?: string }).code === '42501', statement);
  }
  assert.equal(Number((await sql(runtime, 'SELECT count(*) AS n FROM records')).rows[0].n) > 0, true);
});
