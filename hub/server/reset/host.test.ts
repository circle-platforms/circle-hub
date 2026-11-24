import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PackManifest } from '../../../contracts/src/pack.ts';
import { DEFAULT_LIMITS } from '../../config/index.ts';
import { migrateRecords, openRecords, canonicalBytes, digestOf } from '../../records/api.ts';
import { createContext, postgresFor, nativeResetBackup, verifyBackup, restoreBackup, agentFor, settingsOf } from '../../platform/api.ts';
import { layoutAt, ensureLayout } from '../../platform/api.ts';
import { newSettingsFile, writeSettingsFile } from '../../platform/api.ts';
import { ensureDatabaseRunning } from '../../platform/api.ts';
import { withSession } from '../../platform/api.ts';
import { exit, recordingRunner, freePort, socketPort, libpqAvailable, LIBPQ_MISSING } from '../../platform/test-support.ts';
import { createResetConfigurationPorts } from '../api.ts';
import { resetCommand } from './cli.ts';
import { resetData, previewReset, resetRecordTally } from './host.ts';
import { RecoveryConflictError, recoverPendingReset } from './recovery.ts';
import { protectedFiles } from './protected-files.ts';
import { ResetFailure, type ResetStage } from './operation.ts';
import type { ResetDataScope } from './types.ts';

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

for (const scope of ['history','knowledge','packs','config'] as const satisfies readonly ResetDataScope[]) test(`current ${scope} reset clears only that selection and leaves every protected file byte unchanged`, { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const request = { scopes: [scope], keepConfig: false };
  const preview = await previewReset(f.context, request);
  if (preview.blocked.length) t.diagnostic(JSON.stringify(preview.blocked));
  assert.deepEqual(preview.blocked, []);
  const report = await resetData(f.context, request);
  assert.ok(report.archive); assert.ok(report.backup);
  assert.equal((await verifyBackup(report.backup)).schema, 'circle-hub-backup@3');
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
    await source.principals.resetPassword(admin, admin.id);
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


test('native reset backup restores with the public backup reader into another empty cluster', { timeout: 180_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const opaque = Buffer.from('synthetic immutable configuration');
  await writeFile(join(f.layout.config, 'synthetic-reset.json'), opaque, { mode: 0o600 });
  const backup = await nativeResetBackup(f.context, f.postgres);
  const manifest = await verifyBackup(backup.directory);
  assert.equal(manifest.schema, 'circle-hub-backup@3');
  for (const area of ['objects', 'vault', 'config']) assert.ok(manifest.files.some(file => file.path.startsWith(area + '/')), area);
  assert.ok(!manifest.files.some(file => file.path.startsWith('keys/')));
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
  const parent = await mkdtemp(join(tmpdir(), 'chr-restore-')), layout = layoutAt(join(parent, 'data'));
  await ensureLayout(layout);
  const databasePort = socketPort();
  const context = createContext({ CIRCLE_HUB_DATA_DIR: layout.root }, { home: parent, layout, libpqBin: libpq, database: { ...f.context.database, port: databasePort } });
  const postgres = postgresFor(context);
  t.after(async () => { await postgres.stop(); await rm(parent, { recursive: true, force: true }); });
  const report = await restoreBackup({ layout, backupDir: backup.directory, postgres, libpqBin: libpq });
  assert.equal(report.tables, manifest.database.tables.length);
  assert.equal(report.privileges, manifest.database.application_role.privileges.length);
  assert.deepEqual(await readFile(join(layout.config, 'synthetic-reset.json')), opaque);
  for (const file of manifest.files.filter(file => file.path.startsWith('vault/') || file.path.startsWith('objects/'))) {
    assert.deepEqual(await readFile(join(layout.root, file.path)), await readFile(join(f.layout.root, file.path)));
  }
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
});


test('native reset refuses a role-owned table before accepting a standard backup or changing the source', { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  await withSession(f.postgres.connector, f.postgres.target.database, async session => {
    await session.query('CREATE TABLE synthetic_reset_owned (id integer)');
    await session.query('INSERT INTO synthetic_reset_owned VALUES (1)');
    await session.query('ALTER TABLE synthetic_reset_owned OWNER TO "' + f.postgres.application.user.replaceAll('"', '""') + '"');
  });
  await assert.rejects(nativeResetBackup(f.context, f.postgres), /应用角色.*应当只能连接并按授权读写/);
  assert.deepEqual(await readdir(f.layout.backups), []);
  const [row] = await withSession(f.postgres.connector, f.postgres.target.database, session => session.query('SELECT count(*)::int AS n FROM synthetic_reset_owned'));
  assert.equal(row!.n, 1);
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
});

test('H2: all/config reset without keepConfig cleans bot-runtime files and staging while history reset and failed rollback preserve them', { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const botFiles = join(f.layout.root, 'bot-runtime', 'files', '0'.repeat(64));
  const staging = join(f.layout.root, 'bot-runtime', 'channel-staging', 'sub1');
  await mkdir(botFiles, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(botFiles, 'a'.repeat(64)), 'synthetic-bot-attachment');
  await writeFile(join(staging, 'b'.repeat(64)), 'synthetic-bot-staging');

  // 1. history-only reset keeps bot-runtime files and staging.
  const historyReport = await resetData(f.context, { scopes: ['history'], keepConfig: false });
  assert.equal(historyReport.botRuntime, 'retained');
  assert.equal(await readFile(join(botFiles, 'a'.repeat(64)), 'utf8'), 'synthetic-bot-attachment');

  // 2. Rolled-back all reset restores bot-runtime files and staging.
  await assert.rejects(
    resetData(f.context, { scopes: 'all', keepConfig: false }, {
      hostTransform(host) {
        return {
          ...host,
          restart: async () => {
            throw new Error('SyntheticRestartFail');
          },
        };
      },
    }),
    ResetFailure,
  );
  assert.equal(await readFile(join(botFiles, 'a'.repeat(64)), 'utf8'), 'synthetic-bot-attachment');
  assert.equal(await readFile(join(staging, 'b'.repeat(64)), 'utf8'), 'synthetic-bot-staging');

  // 3. Successful all reset removes bot-runtime/files and bot-runtime/channel-staging while keeping keys/ and vault/.
  const { resetCommand } = await import('./cli.ts');
  const historyOut: string[] = [];
  const historyCode = await resetCommand(
    ['--scope', 'history'],
    f.context,
    { cwd: f.layout.root, env: {}, stdout: line => historyOut.push(line), stderr: () => {} },
  );
  assert.equal(historyCode, 0);
  assert.match(historyOut.join('\n'), /保留 <数据目录>\/bot-runtime 下的机器人私聊附件与通道暂存/);
  assert.ok(!historyOut.join('\n').includes('私聊成员附件'));

  const cliOut: string[] = [];
  const cliCode = await resetCommand(
    ['--scope', 'all'],
    f.context,
    { cwd: f.layout.root, env: {}, stdout: line => cliOut.push(line), stderr: () => {} },
  );
  assert.equal(cliCode, 0);
  assert.match(cliOut.join('\n'), /已清理 <数据目录>\/bot-runtime 下的机器人私聊附件与通道暂存/);
  assert.ok(!cliOut.join('\n').includes('私聊成员附件'));
  await assert.rejects(stat(join(f.layout.root, 'bot-runtime', 'files')));
  await assert.rejects(stat(join(f.layout.root, 'bot-runtime', 'channel-staging')));
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
});

test('S7: recoverPendingReset restores bot-runtime files and channel-staging from set-aside stage when journal carries botRuntimeStage', { timeout: 120_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const stageName = 'reset-bot-01234567-89ab-cdef-0123-456789abcdef';
  const stageDir = join(f.layout.setAside, stageName);
  const stagedFiles = join(stageDir, 'files', '0'.repeat(64));
  const stagedStaging = join(stageDir, 'channel-staging', '1'.repeat(64));
  await mkdir(stagedFiles, { recursive: true, mode: 0o700 });
  await mkdir(stagedStaging, { recursive: true, mode: 0o700 });
  await writeFile(join(stagedFiles, 'a'.repeat(64)), 'staged-bot-file');
  await writeFile(join(stagedStaging, 'b'.repeat(64)), 'staged-channel-file');

  const [identity] = await withSession(f.postgres.connector, 'postgres', session =>
    session.query('SELECT oid::text FROM pg_database WHERE datname=$1', [f.postgres.target.database]),
  );
  const dbPrefix = f.postgres.target.database.slice(0, 20);
  const journalPath = join(f.layout.run, 'reset-operation.json');
  await writeFile(journalPath, JSON.stringify({
    database: f.postgres.target.database,
    archive: `${dbPrefix}_archive_01234567`,
    failed: `${dbPrefix}_failed_01234567`,
    originalOid: String(identity!.oid),
    wasLoaded: false,
    wasRunning: false,
    botRuntimeStage: stageName,
    originals: f.originals,
  }), { mode: 0o600 });

  await recoverPendingReset(f.context);

  assert.equal((await stat(join(f.layout.root, 'bot-runtime'))).mode & 0o777, 0o700);
  assert.equal(await readFile(join(f.layout.root, 'bot-runtime', 'files', '0'.repeat(64), 'a'.repeat(64)), 'utf8'), 'staged-bot-file');
  assert.equal(await readFile(join(f.layout.root, 'bot-runtime', 'channel-staging', '1'.repeat(64), 'b'.repeat(64)), 'utf8'), 'staged-channel-file');
  await assert.rejects(stat(stageDir));
  await assert.rejects(stat(journalPath));
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
});

test('T5-S7: real resetData crash during restart persists botRuntimeStage via host.ts and recoverPendingReset returns bot-runtime attachments', { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const memberHash = '0'.repeat(64);
  const fileSha = 'a'.repeat(64);
  const stageSha = 'b'.repeat(64);
  const filesDir = join(f.layout.root, 'bot-runtime', 'files', memberHash);
  const stagingDir = join(f.layout.root, 'bot-runtime', 'channel-staging', memberHash);
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  await writeFile(join(filesDir, fileSha), 'real-reset-staged-bot-file');
  await writeFile(join(stagingDir, stageSha), 'real-reset-staged-channel-file');

  await assert.rejects(
    resetData(f.context, { scopes: 'all', keepConfig: false }, {
      hostTransform(host) {
        return {
          ...host,
          restart: async () => { throw new Error('SyntheticCrashAtRestart'); },
          rollback: async () => {},
        };
      },
    }),
    (error: unknown) => error instanceof ResetFailure && error.stage === 'restart',
  );

  const journalPath = join(f.layout.run, 'reset-operation.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { botRuntimeStage?: string };
  await assert.rejects(stat(join(filesDir, fileSha)), { code: 'ENOENT' });

  await recoverPendingReset(f.context);

  assert.equal(await readFile(join(filesDir, fileSha), 'utf8'), 'real-reset-staged-bot-file');
  assert.equal(await readFile(join(stagingDir, stageSha), 'utf8'), 'real-reset-staged-channel-file');
  assert.match(String(journal.botRuntimeStage), /^reset-bot-[0-9a-f-]+$/);
  await assert.rejects(stat(join(f.layout.setAside, journal.botRuntimeStage!)), { code: 'ENOENT' });
  await assert.rejects(stat(journalPath), { code: 'ENOENT' });
  const [users] = await withSession(f.postgres.connector, f.postgres.target.database, session => session.query('SELECT count(*)::int AS n FROM users'));
  assert.equal(users!.n, 1);
  assert.deepEqual(await protectedFiles(f.layout), f.originals);
});

test('F6: recoverPendingReset merges staged bot-runtime directories into recreated non-empty directories and deduplicates identical files', { timeout: 120_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const stageName = 'reset-bot-11111111-2222-4333-8444-555555555555';
  const stageDir = join(f.layout.setAside, stageName);
  const memberA = 'a'.repeat(64);
  const memberB = 'b'.repeat(64);
  const fileOnlyStaged = '1'.repeat(64);
  const fileShared = '2'.repeat(64);
  const fileOnlyRecreated = '3'.repeat(64);
  const fileOtherMember = '4'.repeat(64);
  const stageFileStaged = '5'.repeat(64);
  const stageFileRecreated = '6'.repeat(64);

  await mkdir(join(stageDir, 'files', memberA), { recursive: true, mode: 0o700 });
  await mkdir(join(stageDir, 'files', memberB), { recursive: true, mode: 0o700 });
  await mkdir(join(stageDir, 'channel-staging', memberA), { recursive: true, mode: 0o700 });
  await writeFile(join(stageDir, 'files', memberA, fileOnlyStaged), 'from-stage-only');
  await writeFile(join(stageDir, 'files', memberA, fileShared), 'identical-shared-bytes');
  await writeFile(join(stageDir, 'files', memberB, fileOtherMember), 'other-member-staged');
  await writeFile(join(stageDir, 'channel-staging', memberA, stageFileStaged), 'staged-channel-entry');

  // Simulate Hub restarted after crash and recreated non-empty bot-runtime/files & channel-staging.
  await mkdir(join(f.layout.root, 'bot-runtime', 'files', memberA), { recursive: true, mode: 0o700 });
  await mkdir(join(f.layout.root, 'bot-runtime', 'channel-staging', memberA), { recursive: true, mode: 0o700 });
  await writeFile(join(f.layout.root, 'bot-runtime', 'files', memberA, fileShared), 'identical-shared-bytes');
  await writeFile(join(f.layout.root, 'bot-runtime', 'files', memberA, fileOnlyRecreated), 'from-recreated-only');
  await writeFile(join(f.layout.root, 'bot-runtime', 'channel-staging', memberA, stageFileRecreated), 'recreated-channel-entry');

  const [identity] = await withSession(f.postgres.connector, 'postgres', session =>
    session.query('SELECT oid::text FROM pg_database WHERE datname=$1', [f.postgres.target.database]),
  );
  const dbPrefix = f.postgres.target.database.slice(0, 20);
  const journalPath = join(f.layout.run, 'reset-operation.json');
  await writeFile(journalPath, JSON.stringify({
    database: f.postgres.target.database,
    archive: `${dbPrefix}_archive_11111111`,
    failed: `${dbPrefix}_failed_11111111`,
    originalOid: String(identity!.oid),
    wasLoaded: false,
    wasRunning: false,
    botRuntimeStage: stageName,
    originals: f.originals,
  }), { mode: 0o600 });

  await recoverPendingReset(f.context);

  assert.equal(await readFile(join(f.layout.root, 'bot-runtime', 'files', memberA, fileOnlyStaged), 'utf8'), 'from-stage-only');
  assert.equal(await readFile(join(f.layout.root, 'bot-runtime', 'files', memberA, fileShared), 'utf8'), 'identical-shared-bytes');
  assert.equal(await readFile(join(f.layout.root, 'bot-runtime', 'files', memberA, fileOnlyRecreated), 'utf8'), 'from-recreated-only');
  assert.equal(await readFile(join(f.layout.root, 'bot-runtime', 'files', memberB, fileOtherMember), 'utf8'), 'other-member-staged');
  assert.equal(await readFile(join(f.layout.root, 'bot-runtime', 'channel-staging', memberA, stageFileStaged), 'utf8'), 'staged-channel-entry');
  assert.equal(await readFile(join(f.layout.root, 'bot-runtime', 'channel-staging', memberA, stageFileRecreated), 'utf8'), 'recreated-channel-entry');
  await assert.rejects(stat(stageDir), { code: 'ENOENT' });
  await assert.rejects(stat(journalPath), { code: 'ENOENT' });
});

test('F6: recoverPendingReset throws explicit conflict error naming path when bot-runtime cannot be merged safely', { timeout: 120_000 }, async t => {
  const f = await fixture(); t.after(() => f.close());
  const stageName = 'reset-bot-22222222-3333-4444-8555-666666666666';
  const stageDir = join(f.layout.setAside, stageName);
  const memberA = 'c'.repeat(64);
  const collidingFile = 'd'.repeat(64);
  await mkdir(join(stageDir, 'files', memberA), { recursive: true, mode: 0o700 });
  await writeFile(join(stageDir, 'files', memberA, collidingFile), 'staged-bytes-alpha');

  const [identity] = await withSession(f.postgres.connector, 'postgres', session =>
    session.query('SELECT oid::text FROM pg_database WHERE datname=$1', [f.postgres.target.database]),
  );
  const dbPrefix = f.postgres.target.database.slice(0, 20);
  const journalPath = join(f.layout.run, 'reset-operation.json');
  await writeFile(journalPath, JSON.stringify({
    database: f.postgres.target.database,
    archive: `${dbPrefix}_archive_22222222`,
    failed: `${dbPrefix}_failed_22222222`,
    originalOid: String(identity!.oid),
    wasLoaded: false,
    wasRunning: false,
    botRuntimeStage: stageName,
    originals: f.originals,
  }), { mode: 0o600 });

  // 1. Non-directory file at bot-runtime/files.
  const botRuntimeFilesPath = join(f.layout.root, 'bot-runtime', 'files');
  await mkdir(join(f.layout.root, 'bot-runtime'), { recursive: true, mode: 0o700 });
  await writeFile(botRuntimeFilesPath, 'blocking-non-directory-file');
  await assert.rejects(
    recoverPendingReset(f.context),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^上次重建的原库或原文件恢复冲突（/);
      assert.ok(error.message.includes(botRuntimeFilesPath), error.message);
      assert.match(error.message, /请核对后清理或移走冲突目录再重试，全部归档和恢复记录已保留$/);
      return true;
    },
  );
  await stat(stageDir);
  await stat(journalPath);

  // 2. Replace with directory containing a colliding file whose bytes differ.
  await rm(botRuntimeFilesPath, { force: true });
  const conflictingFilePath = join(botRuntimeFilesPath, memberA, collidingFile);
  await mkdir(join(botRuntimeFilesPath, memberA), { recursive: true, mode: 0o700 });
  await writeFile(conflictingFilePath, 'different-recreated-bytes');
  await assert.rejects(
    recoverPendingReset(f.context),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^上次重建的原库或原文件恢复冲突（/);
      assert.ok(error.message.includes(conflictingFilePath), error.message);
      assert.match(error.message, /同名文件内容不一致/);
      assert.match(error.message, /请核对后清理或移走冲突目录再重试，全部归档和恢复记录已保留$/);
      return true;
    },
  );
  await stat(stageDir);
  await stat(journalPath);

  // 3. Once the conflicting file is removed, retrying recoverPendingReset completes cleanly.
  await rm(conflictingFilePath, { force: true });
  await recoverPendingReset(f.context);
  assert.equal(await readFile(conflictingFilePath, 'utf8'), 'staged-bytes-alpha');
  await assert.rejects(stat(stageDir), { code: 'ENOENT' });
  await assert.rejects(stat(journalPath), { code: 'ENOENT' });
});

test('M1: resetCommand surfaces RecoveryConflictError with path, reason, remediation, and stopped service state', { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  const f = await fixture(); t.after(() => f.close());
  let serviceLoaded = true;
  let serviceRunning = true;
  const launchctlCalls: string[][] = [];
  const { runner } = recordingRunner(call => {
    if (!call.command.endsWith('launchctl')) return undefined;
    launchctlCalls.push([...call.args]);
    const sub = call.args[0];
    if (sub === 'print') {
      return serviceLoaded
        ? exit(0, serviceRunning ? 'state = running\npid = 42424\n' : 'state = waiting\n')
        : exit(113, 'not loaded');
    }
    if (sub === 'bootout') {
      serviceLoaded = false;
      serviceRunning = false;
      return exit(0);
    }
    if (sub === 'bootstrap') {
      serviceLoaded = true;
      serviceRunning = true;
      return exit(0);
    }
    if (sub === 'kickstart') {
      serviceRunning = true;
      return exit(0);
    }
    return exit(0);
  });
  const settings = await settingsOf(f.context);
  await mkdir(join(f.parent, 'agents'), { recursive: true });
  await writeFile(join(f.parent, 'agents', `${settings.label}.plist`), '<plist/>');
  const context = createContext(
    { CIRCLE_HUB_DATA_DIR: f.layout.root },
    { platform: 'darwin', home: f.parent, launchAgentsDir: join(f.parent, 'agents'), layout: f.layout, runner, libpqBin: libpq },
  );

  const memberHash = '0'.repeat(64);
  const fileSha = 'e'.repeat(64);
  const filesDir = join(f.layout.root, 'bot-runtime', 'files', memberHash);
  const conflictingFilePath = join(filesDir, fileSha);
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  await writeFile(conflictingFilePath, 'staged-original-bytes');

  await assert.rejects(
    resetData(context, { scopes: 'all', keepConfig: false }, {
      hostTransform(host) {
        return {
          ...host,
          restart: async () => { throw new Error('SyntheticCrashAtRestart'); },
          rollback: async () => {},
        };
      },
    }),
    (error: unknown) => error instanceof ResetFailure && error.stage === 'restart',
  );

  // Simulate service running again and recreating a conflicting file under bot-runtime/files/...
  serviceLoaded = true;
  serviceRunning = true;
  launchctlCalls.length = 0;
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  await writeFile(conflictingFilePath, 'conflicting-recreated-bytes');

  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await resetCommand(
    ['--scope', 'history'],
    context,
    { cwd: f.layout.root, env: {}, stdout: line => stdout.push(line), stderr: line => stderr.push(line) },
    {},
  );
  assert.equal(code, 1);
  const errText = stderr.join('\n');
  assert.match(errText, /^上次重建的原库或原文件恢复冲突（/);
  assert.ok(errText.includes(conflictingFilePath), errText);
  assert.ok(errText.includes('同名文件内容不一致'), errText);
  assert.ok(errText.includes('服务当前已停止且没有重新启动'), errText);
  assert.ok(errText.includes('请核对后清理或移走冲突目录再重试，全部归档和恢复记录已保留'), errText);
  assert.ok(!errText.includes('尚未尝试停止服务'), errText);
  assert.equal(RecoveryConflictError.name, 'RecoveryConflictError');

  const statusAfter = await agentFor(context, settings).status();
  assert.equal(statusAfter.running, false);
  assert.equal(statusAfter.loaded, false);
  assert.ok(launchctlCalls.some(args => args[0] === 'bootout'));
  assert.ok(!launchctlCalls.some(args => args[0] === 'bootstrap' || args[0] === 'kickstart'));
});
