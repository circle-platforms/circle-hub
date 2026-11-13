// Actual current-schema PostgreSQL and opaque file invariants; no previous-release reader or conversion fixture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PackManifest } from '../../../contracts/src/pack.ts';
import { DEFAULT_LIMITS } from '../../config/index.ts';
import { migrateRecords, openRecords, canonicalBytes, digestOf } from '../../records/api.ts';
import { createContext, postgresFor } from '../../platform/api.ts';
import { layoutAt, ensureLayout } from '../../platform/api.ts';
import { newSettingsFile, writeSettingsFile } from '../../platform/api.ts';
import { ensureDatabaseRunning } from '../../platform/api.ts';
import { withSession } from '../../platform/api.ts';
import { exit, recordingRunner, freePort, socketPort, libpqAvailable, LIBPQ_MISSING } from '../../platform/test-support.ts';
import { createResetConfigurationPorts } from '../api.ts';
import { resetData, previewReset, resetRecordTally } from './host.ts';
import { protectedFiles } from './protected-files.ts';
import { ResetFailure, type ResetStage } from './operation.ts';
import type { ResetScope } from './types.ts';

const libpq = await libpqAvailable();
async function fixture(incompatible = false) {
  const parent = await mkdtemp(join(tmpdir(), 'chr-')), layout = layoutAt(join(parent, 'data'));
  await ensureLayout(layout);
  const port = await freePort(), dbPort = socketPort();
  await writeSettingsFile(layout, newSettingsFile({ environment: 'test', port, database: { port: dbPort } }));
  const runner = recordingRunner(call => call.command.endsWith('launchctl') ? exit(113, 'not loaded') : undefined).runner;
  const context = createContext({ CIRCLE_HUB_DATA_DIR: layout.root }, { platform: 'darwin', home: parent, launchAgentsDir: join(parent, 'agents'), layout, runner, libpqBin: libpq });
  const postgres = postgresFor(context);
  try {
    await postgres.initialise(); await ensureDatabaseRunning(postgres, { create: true });
    const database = { host: postgres.target.socketDir, port: dbPort, user: postgres.target.user, database: postgres.target.database };
    let records: Record<string, string> = {};
    if (incompatible) await withSession(postgres.connector, postgres.target.database, async session => {
      await session.query('CREATE TABLE schema_migrations(version int,name text,sha256 text)');
      await session.query('INSERT INTO schema_migrations VALUES(99,$1,$2)', ['synthetic_incompatible', 'a'.repeat(64)]);
      await session.query('CREATE TABLE synthetic_unclassified(content text)');
      await session.query('INSERT INTO synthetic_unclassified VALUES($1)', ['合成未分类记录']);
    });
    else {
      await migrateRecords({ database }, { runtimeRole: postgres.application.user });
      const kit = await openRecords({ dataDir: layout.root, logDir: layout.logs, database: { ...database, user: postgres.application.user }, limits: { ...DEFAULT_LIMITS } }, { migrate: false });
      try {
        const { user } = await kit.principals.bootstrapAdmin('合成重建管理员');
        const at = '2026-11-13T00:00:00.000Z';
        const history = await kit.store.put({ kind: 'call_log', schema: 'call_log@1', provenance: 'observed', body: { at, trace_id: '1'.repeat(32), span_id: '2'.repeat(16), user: null, session: null, tool: 'list_task_packs', run: null, args_digest: digestOf({}), args_size: 2, args_preview: null, call_result: 'ok', acceptance: null, error_code: null, duration_ms: 1 } });
        const node = { name: '', height: 0, level: 'leaf', children: [], entries: [] };
        const knowledge = await kit.store.put({ kind: 'tree_node', schema: 'tree_node@1', provenance: 'projected', body: node, index: [{ key: 'knowledge.node', value: digestOf({ name: '', children: [], entries: [] }) }] });
        const files = [];
        for (const [path, body] of [['SKILL.md', '# 合成技能'], ['skill.json', { schema: 'skill@1', parsers: [], modules: [] }]] as const) {
          const bytes = typeof body === 'string' ? Buffer.from(body) : canonicalBytes(body), object = await kit.objects.put(bytes, 'application/json');
          files.push({ path, sha256: object.sha256, size: bytes.byteLength });
        }
        const manifest = PackManifest.parse({ schema: 'pack@1', id: 'synthetic-reset-skill', version: '1.0.0', kind: 'skill', title: '合成技能', description: '当前模式范围验证', files });
        const object = await kit.objects.put(canonicalBytes(manifest), 'application/json');
        const pack = await kit.store.put({ kind: 'pack_version', schema: 'pack_version@1', provenance: 'declared', body: { pack: manifest.id, version: manifest.version, kind: manifest.kind, digest: object.sha256, title: manifest.title, description: manifest.description, manifest, publisher: user.id, report: {} } });
        records = { history: history.digest, knowledge: knowledge.digest, packs: pack.digest };
      } finally { await kit.close(); }
    }
    await mkdir(join(layout.root, 'keys'), { recursive: true });
    await mkdir(join(layout.vault, 'metadata'), { recursive: true });
    for (const [path, content] of [
      [join(layout.root, 'keys', 'synthetic-master'), Buffer.alloc(32, 17)],
      [join(layout.vault, 'secret.synthetic_key.' + 'a'.repeat(24) + '.sealed'), Buffer.from('synthetic opaque ciphertext')],
      [join(layout.vault, 'metadata', 'secret.synthetic_key.sealed'), Buffer.from('synthetic opaque metadata')],
      [join(layout.vault, 'connector.res_' + '1'.repeat(26) + '.session.sealed'), Buffer.from('synthetic opaque session')],
      [join(layout.vault, 'login-stop.trial.sealed'), Buffer.from('synthetic opaque stop')],
      [join(layout.vault, 'archive.existing.sealed'), Buffer.from('synthetic pre-existing archive')],
    ] as const) await writeFile(path, content, { mode: 0o600 });
    const originals = await protectedFiles(layout);
    return { parent, layout, context, postgres, records, originals,
      ownerConfig: { dataDir: layout.root, logDir: layout.logs, database, limits: { ...DEFAULT_LIMITS } },
      async close() { await postgres.stop(); await rm(parent, { recursive: true, force: true }); } };
  } catch (error) { await postgres.stop().catch(() => {}); await rm(parent, { recursive: true, force: true }); throw error; }
}

for (const scope of ['history','knowledge','packs','config'] as const satisfies readonly ResetScope[]) test(`current ${scope} reset clears only that selection and leaves every protected file byte unchanged`, { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const request = { scopes: [scope], keepConfig: false };
  const preview = await previewReset(f.context, request);
  if (preview.blocked.length) t.diagnostic(JSON.stringify(preview.blocked));
  assert.deepEqual(preview.blocked, []);
  const report = await resetData(f.context, request);
  assert.ok(report.archive); assert.ok(report.backup);
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
  await withSession(f.postgres.connector, f.postgres.target.database, async session => {
    for (const [kind, digest] of Object.entries(f.records)) {
      const [row] = await session.query('SELECT count(*)::int AS n FROM records WHERE digest=$1', [digest]);
      assert.equal(row!.n, kind === scope ? 0 : 1);
    }
    const [users] = await session.query('SELECT count(*)::int AS n FROM users');
    assert.equal(users!.n, scope === 'config' ? 0 : 1);
  });
});

test('confirmed incompatible all reset archives and initializes without reading unknown business shapes', { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(true); t.after(() => f.close());
  const preview = await previewReset(f.context, { scopes: 'all', keepConfig: false });
  assert.equal(preview.inspection.needsRebuild, true); assert.deepEqual(preview.blocked, []);
  const report = await resetData(f.context, { scopes: 'all', keepConfig: false });
  assert.ok(report.archivedTables?.some(table => table.table === 'synthetic_unclassified' && table.rows === 1));
  const [row] = await withSession(f.postgres.connector, f.postgres.target.database, session => session.query('SELECT version,name FROM schema_migrations'));
  assert.equal(row!.name, 'baseline');
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
});

test('missing protected configuration ports block before any backup, service stop or archive', { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const preview = await previewReset(f.context, { scopes: 'all', keepConfig: true });
  assert.ok(preview.blocked.some(problem => problem.scope === 'config'));
  await assert.rejects(resetData(f.context, { scopes: 'all', keepConfig: true }));
  const [row] = await withSession(f.postgres.connector, 'postgres', session => session.query("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE '%_archive_%'"));
  assert.equal(row!.n, 0); assert.deepEqual(await protectedFiles(f.layout), f.originals);
});

for (const stage of ['stop','exportConfiguration','archive','create','prepare','restoreConfiguration','preflight','restart'] as const satisfies readonly ResetStage[]) test(`a real failure after reset ${stage} restores the original database and every opaque/metadata file`, { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  await assert.rejects(resetData(f.context, { scopes: 'all', keepConfig: false }, { hostTransform(host) { return { ...host, [stage]: async () => { await host[stage](); throw new Error('SyntheticProtectedError938'); } }; } }), (error: unknown) => {
    assert.ok(error instanceof ResetFailure); assert.equal(error.stage, stage); assert.equal(error.rollback, 'succeeded'); assert.doesNotMatch(error.message, /SyntheticProtectedError938/); return true;
  });
  const [row] = await withSession(f.postgres.connector, f.postgres.target.database, session => session.query('SELECT count(*)::int AS n FROM users'));
  assert.equal(row!.n, 1); assert.deepEqual(await protectedFiles(f.layout), f.originals);
});


test('all keep-config uses the actual U1 factory and current records restore once into a fresh baseline', { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const application = { ...f.ownerConfig, database: { ...f.ownerConfig.database, user: f.postgres.application.user } };
  const source = await openRecords(application, { migrate: false });
  let token: string, userId: string, tokenId: string;
  try {
    const admin = await source.principals.findByName('合成重建管理员'); assert.ok(admin);
    await source.principals.resetPassword(admin, admin.id); // The returned synthetic password is deliberately not retained or printed.
    const issued = await source.principals.issueToken(admin, admin.id, '合成重建保留验证');
    token = issued.token; tokenId = issued.id; userId = admin.id;
    const pack = await source.store.get<Record<string, unknown>>(f.records.packs!); assert.ok(pack);
    await source.authorizations.grantPublishRight(admin, admin.id, '合成发布授权');
    await source.authorizations.grant(admin, { permission: 'publish', subject: admin.id, object: 'synthetic-reset-skill@1.0.0', bound: String(pack.body.digest), note: '合成发布' });
    await source.authorizations.grant(admin, { permission: 'assign', subject: '*', object: 'synthetic-reset-skill', note: '合成整库启用' });
  } finally { await source.close(); }
  const before = await withSession(f.postgres.connector, f.postgres.target.database, session => session.query('SELECT u.id,u.password_hash,t.sha256 FROM users u JOIN tokens t ON t.user_id=u.id WHERE t.id=$1', [tokenId!]));
  let definitionCalled = false;
  const actualPorts = await createResetConfigurationPorts({ config: f.ownerConfig, applyDefinition: async () => { definitionCalled = true; throw new Error('定义文件未在此请求中选择'); } });
  const report = await resetData(f.context, { scopes: 'all', keepConfig: true }, actualPorts);
  assert.ok(report.configurationSnapshot); assert.equal(definitionCalled, false);
  assert.equal(report.countsUnit, 'records');
  assert.ok((report.counts.find(count => count.scope === 'config')?.retained ?? 0) > 0, 'restored configuration records must be counted from the actual destination');
  assert.equal(report.unclassifiedRetainedRecords, 0);
  assert.equal((await stat(report.configurationSnapshot)).mode & 0o777, 0o600);
  assert.equal((await readFile(report.configurationSnapshot, 'utf8')).includes(token!), false, 'the protected snapshot must contain a hash, never the raw client token');
  const after = await withSession(f.postgres.connector, f.postgres.target.database, session => session.query('SELECT u.id,u.password_hash,t.sha256 FROM users u JOIN tokens t ON t.user_id=u.id WHERE t.id=$1', [tokenId!]));
  assert.ok(JSON.stringify(before) === JSON.stringify(after), 'original identities and authentication hashes must be unchanged');
  const restored = await openRecords(application, { migrate: false });
  try {
    const principal = await restored.principals.authenticate('Bearer ' + token!); assert.ok(principal?.id === userId!);
    assert.equal((await restored.store.list({ kind: 'call_log', limit: 10 })).items.length, 0);
    assert.equal((await restored.store.list({ kind: 'tree_node', limit: 10 })).items.length, 0);
    assert.ok(await restored.store.get(f.records.packs!));
    assert.deepEqual(await restored.authorizations.packsFor('*'), ['synthetic-reset-skill']);
  } finally { await restored.close(); }
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
});


test('reset counts distinguish logical records from table rows and expose unclassified records', () => {
  const user = 'usr_' + '0'.repeat(26), at = '2026-11-13T00:00:00.000Z';
  const config = { digest: '1'.repeat(64), kind: 'authorization', schema: 'authorization@1', body: { permission: 'resource_config', subject: '*', object: 'var:SYNTHETIC_LABEL', revoked: true, bound: null, decided_by: user, decided_at: at, expires_at: null, note: null, supersedes: null } };
  const knowledge = { digest: '2'.repeat(64), kind: 'tree_node', schema: 'tree_node@1', body: { name: '', height: 0, level: 'leaf', children: [], entries: [] } };
  const unknown = { digest: '3'.repeat(64), kind: 'claim', schema: 'synthetic-unclassified@1', body: {} };
  const result = resetRecordTally([config, knowledge, unknown], new Set([knowledge.digest]));
  assert.equal(result.countsUnit, 'records');
  assert.deepEqual(result.counts.find(count => count.scope === 'config'), { scope: 'config', retained: 1, cleared: 0 });
  assert.deepEqual(result.counts.find(count => count.scope === 'knowledge'), { scope: 'knowledge', retained: 0, cleared: 1 });
  assert.equal(result.unclassifiedRetainedRecords, 1);
});
