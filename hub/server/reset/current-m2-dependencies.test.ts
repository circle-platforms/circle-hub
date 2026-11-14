import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres } from '../../testing/postgres.ts';
import { DEFAULT_LIMITS } from '../../config/index.ts';
import { Database, createPool, canonicalBytes } from '../../records/api.ts';
import { migrate, MIGRATIONS, grantRuntime } from '../../records/migrations.ts';
import { PgRecordStore } from '../../records/store.ts';
import { PgPrincipals } from '../../records/principals.ts';
import { FileObjectStore } from '../../records/objects.ts';
import { newId } from '../../records/ids.ts';
import { previewEnvironmentAssignmentUpgrade, applyEnvironmentAssignmentUpgrade, type EnvironmentUpgradeSources } from '../../records/environment-assignment-upgrade.ts';
import { planEnvironmentAssignmentUpgrade } from '../environment-assignment-upgrade.ts';
import { createContext, ensureLayout, layoutAt, newSettingsFile, writeSettingsFile, type SqlSession } from '../../platform/api.ts';
import { inspectCurrentState, clearOfflineSelection, assertCurrentForeignKeys } from './current.ts';
import { previewReset } from './host.ts';
import type { ResetRequest } from './types.ts';

const runtime = 'synthetic_m2_reset_runtime';
const request = (scope: 'history' | 'config'): ResetRequest => ({ scopes: [scope], keepConfig: false });
const foundations = ['hub_migration_compatibility', 'environment_assignment_cutover', 'environment_assignment_snapshot', 'environment_assignment_completion'];

test('M2 selective reset keeps migration evidence and rejects its real dependencies before deletion', { timeout: 180_000 }, async t => {
  const postgres = await startPostgres({ socket: true, passwordless: true, private: true });
  t.after(() => postgres.stop());
  const adminDb = new Database(createPool(postgres.config, 1));
  try { await adminDb.query(`CREATE ROLE ${runtime} LOGIN NOSUPERUSER`); }
  finally { await adminDb.end(); }
  async function fixture(sub: { after(fn: () => Promise<void>): void }, nonfresh = false) {
    const database = await postgres.createDatabase(), root = await mkdtemp(join(tmpdir(), 'circle-hub-reset-m2-'));
    const layout = { ...layoutAt(join(root, 'data')), run: postgres.socketDir };
    await ensureLayout(layout);
    const db = new Database(createPool(database, 1));
    sub.after(async () => { await db.end(); await postgres.dropDatabase(database.database); await rm(root, { recursive: true, force: true }); });
    await db.query(`REVOKE TEMPORARY ON DATABASE "${database.database}" FROM PUBLIC`);
    await migrate(db, nonfresh ? [MIGRATIONS[0]] : MIGRATIONS);
    const store = new PgRecordStore(db, { maxRecordBytes: DEFAULT_LIMITS.maxRecordBytes, now: () => new Date() });
    const objects = new FileObjectStore(layout.objects, db, { maxBytes: DEFAULT_LIMITS.maxUploadBytes, now: () => new Date() });
    const at = new Date().toISOString();
    const source = await store.put({ kind: 'call_log', schema: 'call_log@1', provenance: 'observed', body: {
      at, trace_id: '1'.repeat(32), span_id: '2'.repeat(16), user: null, session: null, tool: 'list_task_packs', run: null,
      args_digest: 'a'.repeat(64), args_size: 2, args_preview: null, call_result: 'ok', acceptance: null, error_code: null, duration_ms: 1,
    } });
    if (nonfresh) {
      const principals = new PgPrincipals(db, () => new Date(), store);
      const admin = (await principals.bootstrapAdmin('合成保权责任人')).user;
      const member = await principals.createUser(admin, '合成原工作流使用者');
      const executor = newId('exe'), workflow = 'synthetic-retained-lease-workflow';
      const sources: EnvironmentUpgradeSources = {
        plan: planEnvironmentAssignmentUpgrade,
        collect: async ctx => ({ snapshot: { boundary: ctx.boundary, at: ctx.at,
          members: ctx.members.map(user => ({ ...user, packs: user.id === member.id ? [workflow] : [] })),
          workflows: [{ id: workflow, digest: source.digest, kind: 'workflow', available: true, publishedAt: '2000-01-01T00:00:00.000Z', declaration: { context: ['leases'], leases: { prefix: 'synthetic/' } } }],
          executors: [{ id: executor, registeredAt: '2000-01-01T00:00:00.000Z', keys: ['synthetic/key'] }], holdings: [], effectiveAssignments: [], revokedAssignments: [],
        }, sourceRecords: [source.digest] }),
      };
      const config = { database, dataDir: layout.root, limits: { ...DEFAULT_LIMITS } };
      const planned = await previewEnvironmentAssignmentUpgrade(config, admin, sources);
      assert.equal(planned.canApply, true); assert.equal(planned.payload?.plan.grants.length, 1);
      const receipt = await applyEnvironmentAssignmentUpgrade(config, admin, sources, planned, { runtimeRole: runtime });
      assert.equal(receipt.grants, 1);
    } else await grantRuntime(db, runtime);
    const settings = newSettingsFile({ environment: 'test', port: 7999, database: { name: database.database, role: runtime, port: database.port } });
    await writeSettingsFile(layout, settings);
    const context = createContext({}, { layout, home: root, user: database.user,
      database: { name: database.database, role: runtime, port: database.port }, runner: async () => { throw new Error('no service command is authorized in this fixture'); } });
    const session: SqlSession = { query: async (sql, args) => (await db.query(sql, args)).rows, close: async () => {} };
    const inspect = async (input: ResetRequest) => {
      await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try { return await inspectCurrentState(session, input, hash => objects.get(hash)); }
      finally { await session.query('ROLLBACK'); }
    };
    const contents = async () => {
      const tables: Record<string, unknown> = {};
      // PostgreSQL supplies JSON timestamp values; raw pg Date instances are not canonical JSON.
      for (const table of foundations) tables[table] = (await db.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY ${table === 'hub_migration_compatibility' ? 'migration_version' : 'singleton'}`)).rows.map(row => row.value);
      return canonicalBytes(tables);
    };
    const records = async () => (await db.query('SELECT digest FROM records ORDER BY seq')).rows;
    return { db, store, source, session, inspect, contents, records, context };
  }

  await t.test('fresh M2 clears unrelated history and preserves all four foundation tables byte for byte', async sub => {
    const f = await fixture(sub); const before = await f.contents();
    const state = await f.inspect(request('history'));
    assert.deepEqual(state.blocked, []); assert.deepEqual(state.selection.cleared, [f.source.digest]);
    assert.ok(foundations.every(table => state.tables.includes(table) && !state.clearTables.includes(table)));
    await clearOfflineSelection(f.session, state); await assertCurrentForeignKeys(f.session);
    assert.deepEqual(await f.records(), []); assert.deepEqual(await f.contents(), before);
  });
  await t.test('nonfresh snapshot sourceRecords blocks history removal with zero deletion', async sub => {
    const f = await fixture(sub, true), before = await f.records(), evidence = await f.contents();
    const state = await f.inspect(request('history'));
    assert.ok(state.blocked.some(problem => problem.table === 'environment_assignment_snapshot' && problem.reason.includes('/snapshot/sourceRecords/0')));
    assert.ok(state.selection.cleared.includes(f.source.digest), 'the source is not silently moved into retention');
    await assert.rejects(clearOfflineSelection(f.session, state), /不执行清除/);
    assert.deepEqual(await f.records(), before); assert.deepEqual(await f.contents(), evidence);
  });
  await t.test('nonfresh completion authorization records and responsible_user FK block config removal before mutation', async sub => {
    const f = await fixture(sub, true), before = await f.records(), evidence = await f.contents();
    const state = await f.inspect(request('config'));
    assert.ok(state.blocked.some(problem => problem.table === 'environment_assignment_completion' && problem.reason.includes('/authorization_records/0')));
    assert.ok(state.blocked.some(problem => foundations.includes(problem.table ?? '') && problem.reason.includes('responsible_user') && problem.reason.includes('users.id')));
    await assert.rejects(clearOfflineSelection(f.session, state), /不执行清除/);
    assert.deepEqual(await f.records(), before); assert.deepEqual(await f.contents(), evidence);
  });
  await t.test('unknown future tables still refuse selective reset, while all preview uses its unchanged path', async sub => {
    const f = await fixture(sub); await f.db.query('CREATE TABLE public.synthetic_future_unclassified (value text)');
    const state = await f.inspect(request('history'));
    assert.ok(state.blocked.some(problem => problem.table === 'synthetic_future_unclassified' && problem.reason.includes('范围责任')));
    await assert.rejects(clearOfflineSelection(f.session, state));
    const all = await previewReset(f.context, { scopes: 'all', keepConfig: false });
    assert.deepEqual(all.blocked, []); assert.equal(all.unclassifiedRetainedRecords, null);
    assert.deepEqual((await f.records()).map(row => row.digest), [f.source.digest]);
  });
});
