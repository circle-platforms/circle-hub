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
import { FileKeyProvider, migrateRecords, openRecords, MIGRATIONS } from './index.ts';

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
  await sql(postgres.config, 'REVOKE TEMPORARY ON DATABASE t_roles FROM PUBLIC');
  t.after(() => postgres.dropDatabase('t_roles'));
  const owner: DatabaseConfig = { ...postgres.config, database: 't_roles', user: 'hub_owner', password: ownerPassword };
  const runtime: DatabaseConfig = { ...postgres.config, database: 't_roles', user: 'hub_runtime', password: runtimePassword };
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-roles-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { dataDir, logDir: join(dataDir, 'logs'), database: runtime, limits: { ...DEFAULT_LIMITS } };
  // Before the owner migrated, the runtime role refuses to start instead of trying to create tables.
  await assert.rejects(openRecords(config, { migrate: false }), (error: unknown) => error instanceof MigrationError && /还没有应用/.test((error as Error).message));
  assert.deepEqual(await migrateRecords({ database: owner }, { runtimeRole: 'hub_runtime' }), MIGRATIONS.map(m=>m.version));
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
  const initial = await kit.principals.resetPassword(admin, member.id);
  const verified = await kit.principals.verifyPassword(member.name, initial);
  assert.ok(verified?.mustChange);
  const session = await kit.principals.openConsoleSession(member.id, verified.revision);
  assert.ok(session);
  assert.ok(await kit.principals.changePassword(member, initial, 'synthetic-runtime-password'));
  assert.equal(await kit.principals.authenticate('Bearer '+session.token), null);
  await kit.principals.setRole(admin, member.id, 'admin');
  await kit.principals.setDisabled(admin, member.id, true);
  assert.equal((await kit.principals.rename(admin, member.id, '成员改名')).name, '成员改名');
  const issued = await kit.principals.issueToken(admin, user.id, '第二枚');
  assert.equal(await kit.principals.revokeToken(admin, issued.id), true);
  // The standard authorization's stores (migration 7): a client, an invitation taken by it, a token for it, revocation by value.
  const client = await kit.principals.registerClient('Circle', ['http://127.0.0.1:43123/callback']);
  const invitation = await kit.principals.invite(admin, user.id);
  assert.equal((await kit.principals.takeInvitation(invitation.id, client.id))?.id, user.id);
  const bound = await kit.principals.issueToken(admin, user.id, client.name, client.id);
  assert.equal(await kit.principals.revokeTokenValue(bound.token), true);
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
  const spaceVersion = await kit.store.put({ kind: 'knowledge_space_version', schema: 'knowledge-space-version@1', provenance: 'projected', body: { synthetic: 'runtime-index' } });
  await kit.spaceIndex!.add(spaceVersion.digest, [{ space: member.id, path: '/', entry: artifact.digest, record: artifact.digest, text: '合成搜索' }]);
  await kit.spaceIndex!.add(spaceVersion.digest,[{space:member.id,path:'/second',entry:artifact.digest,record:artifact.digest}]);
  assert.equal((await sql(runtime,'SELECT count(*)::int AS n FROM knowledge_space_search_totals')).rows[0].n,1);
  await kit.spaceIndex!.complete(spaceVersion.digest, '/');
  assert.equal(await kit.spaceIndex!.ready(spaceVersion.digest, '/'), true);
  assert.equal((await kit.spaceIndex!.search('合成', [{ version: spaceVersion.digest, paths: ['/'] }], 0, 1)).length, 1);

  const document=await kit.store.put({kind:'memory_document',schema:'memory-document@1',provenance:'declared',body:{space:member.id,by:member.id,at:new Date().toISOString(),intent:'a'.repeat(64)}});
  const version=await kit.store.put({kind:'memory_version',schema:'memory-version@1',provenance:'declared',body:{document:document.digest,space:member.id,title:'合成记忆',path:'/',state:'enabled',bytes:6,markdown:'合成',content_version:null,parent:null,by:member.id,at:new Date().toISOString(),intent:'b'.repeat(64),payload:'c'.repeat(64)}});
  await kit.store.withTransaction(async tx=>{await kit.store.lock('knowledge-space:'+member.id,tx);await kit.memoryIndex!.apply({document:document.digest,space:member.id,version:version.digest,path:'/',state:'enabled',bytes:6,contextBytes:19},300,tx);});
  assert.deepEqual(await kit.memoryIndex!.usage(member.id),{active:19,history:300,activeDocuments:1});
  const refused = [
    'DELETE FROM memory_heads',
    'DELETE FROM memory_space_usage',
    'UPDATE memory_heads SET space=space',
    'UPDATE memory_heads SET document=document',
    'UPDATE memory_space_usage SET space=space',
    'DELETE FROM knowledge_space_search',
    'DELETE FROM knowledge_space_search_ready',
    'DELETE FROM knowledge_space_search_totals',
    'UPDATE knowledge_space_search_totals SET quota_space = quota_space',
    `UPDATE records SET body = '{}'`,
    'DELETE FROM records',
    'TRUNCATE records CASCADE',
    'ALTER TABLE records DISABLE TRIGGER USER',
    'ALTER TABLE call_logs DISABLE TRIGGER ALL',
    'DROP TABLE call_notes',
    "UPDATE record_index SET value = 'x'",
    'DELETE FROM call_notes',
    "UPDATE users SET created_at = now()", // name is updatable since migration 25 (rename)
    'DELETE FROM users',
    'DELETE FROM tokens',
    'DELETE FROM pointers',
    "UPDATE oauth_clients SET name = 'x'",
    "UPDATE invitations SET user_id = user_id",
    'DELETE FROM invitations',
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
