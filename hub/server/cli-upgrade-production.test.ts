// Actual CLI registration, old-schema token identity and production startup on an isolated socket-only database.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { startPostgres } from '../testing/postgres.ts';
import { loadConfig } from '../config/index.ts';
import { Database, createPool, migrateRecords, openRecords, type Principal, type RecordsKit, sha256Hex } from '../records/api.ts';
import { main } from './cli.ts';
import { serve } from './main.ts';
import { assembleHub } from './assemble/hub.ts';
import { readProductionUpgradeStartup } from './upgrade-production.ts';
import { upgradeStartupDecision } from './upgrade-startup.ts';

async function fixture(t: TestContext) {
  const postgres = await startPostgres({ socket: true, passwordless: true });
  const root = await mkdtemp(join(tmpdir(), 'hub-production-upgrade-'));
  const database = await postgres.createDatabase();
  const owner = new Database(createPool(database, 1));
  let opened: RecordsKit | undefined;
  t.after(async () => { try { await opened?.close(); } finally { try { await owner.end(); } finally { try { await postgres.stop(); } finally { await rm(root, { recursive: true, force: true }); } } } });
  await owner.query('CREATE ROLE synthetic_upgrade_runtime LOGIN NOSUPERUSER');
  await owner.query(`REVOKE TEMPORARY ON DATABASE "${database.database}" FROM PUBLIC`);
  await migrateRecords({ database }, { runtimeRole: 'synthetic_upgrade_runtime' });
  const env = { CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_PORT: '0', CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir, CIRCLE_HUB_DATABASE_PORT: String(database.port), CIRCLE_HUB_DATABASE_NAME: database.database, CIRCLE_HUB_DATABASE_USER: 'synthetic_upgrade_runtime' };
  const config = loadConfig(env);
  const records = await openRecords(config, { migrate: false });
  opened = records;
  const bootstrap = await records.principals.bootstrapAdmin('合成升级责任人');
  const actor: Principal = { id: bootstrap.user.id, name: bootstrap.user.name, role: bootstrap.user.role };
  const second = await records.principals.createUser(actor, '另一个合成管理员', 'admin');
  const member = await records.principals.createUser(actor, '合成普通成员', 'user');
  const memberToken = await records.principals.issueToken(actor, member.id);
  await owner.transaction(async tx => {
    await owner.query('DROP TABLE public.environment_assignment_completion,public.environment_assignment_snapshot,public.environment_assignment_cutover,public.hub_migration_compatibility', [], tx);
    await owner.query('DELETE FROM public.schema_migrations WHERE version=2', [], tx);
  });
  const snapshot = async () => {
    const tables = (await owner.query<{ name: string }>("SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname")).rows;
    const counts = [];
    for (const row of tables) { assert.match(row.name, /^[a-z_]+$/); counts.push([row.name, (await owner.query(`SELECT count(*)::text AS count FROM public."${row.name}"`)).rows[0].count]); }
    return { counts, tokens: (await owner.query('SELECT id,last_used_at,revoked_at FROM public.tokens ORDER BY id')).rows, migrations: (await owner.query('SELECT version,name,sha256 FROM public.schema_migrations ORDER BY version')).rows };
  };
  const cli = async (args: string[], token: string = bootstrap.token.token) => {
    const out: string[] = [], err: string[] = [];
    const code = await main(['upgrade', ...args], { io: { env: { ...env, CIRCLE_HUB_TOKEN: token }, cwd: root, stdout: line => out.push(line), stderr: line => err.push(line) } });
    assert.ok(!out.join('\n').includes(token)); assert.ok(!err.join('\n').includes(token));
    return { code, out, err };
  };
  return { root, env, config, database, owner, records, actor, second, memberToken, cli, snapshot };
}

test('production CLI previews without writes then applies the exact snapshot as the real token owner and starts with enforced policy', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const before = await f.snapshot();
  const preview = await f.cli(['preview', '--json', '--owner-role=' + f.database.user]);
  assert.equal(preview.code, 0, preview.err.join('\n'));
  assert.deepEqual(await f.snapshot(), before, 'preview includes authentication and telemetry: no public table or last-used write');
  const document = JSON.parse(preview.out.join('\n'));
  assert.equal(document.canApply, true); assert.equal(document.payload.responsibleUser, f.actor.id);
  let pendingAssembly = false;
  const pendingErrors: string[] = [];
  assert.equal(await serve([], { io: { env: { ...f.env }, cwd: f.root, stdout: () => {}, stderr: line => pendingErrors.push(line) }, ensureDatabase: async () => {}, stopSignal: () => Promise.resolve(), assembly: async () => ({ assemble: () => { pendingAssembly = true; throw new Error('must not assemble pending upgrade'); } }) }), 1);
  assert.equal(pendingAssembly, false); assert.match(pendingErrors.join('\n'), /upgrade preview/); assert.match(pendingErrors.join('\n'), /--expected-snapshot/); assert.doesNotMatch(pendingErrors.join('\n'), /记录库需要重建/);
  const file = join(f.root, 'preview.json'); await writeFile(file, JSON.stringify(document), { mode: 0o600 });
  const applied = await f.cli(['apply', '--preview=' + file, '--expected-snapshot=' + document.sha256, '--owner-role=' + f.database.user]);
  assert.equal(applied.code, 0, applied.err.join('\n'));
  let listening = false, enforced = false;
  const errors: string[] = [];
  const code = await serve([], { io: { env: { ...f.env }, cwd: f.root, stdout: () => {}, stderr: line => errors.push(line) }, ensureDatabase: async () => {}, stopSignal: () => Promise.resolve(), onListening: () => { listening = true; }, assembly: async () => ({ assemble: async (config, records) => {
    const hub = await assembleHub(config, records, { requireVaultKey: false, command: true, requireOsIsolation: false });
    enforced = hub.dispatch?.options.enforceEnvironmentAssignments === true;
    assert.equal((await hub.deps.memberCapabilities(f.actor)).environmentAccess.enforced, true);
    return hub.deps;
  } }) });
  assert.equal(code, 0, errors.join('\n')); assert.equal(listening, true); assert.equal(enforced, true);
});

test('production upgrade never chooses another administrator for a member, invalid token or disabled token owner', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  for (const token of [f.memberToken.token, 'A'.repeat(43)]) {
    const before = await f.snapshot();
    const result = await f.cli(['preview', '--json', '--owner-role=' + f.database.user], token);
    assert.equal(result.code, 1); assert.deepEqual(await f.snapshot(), before);
  }
  await f.records.principals.setDisabled(f.actor, f.actor.id, true);
  assert.equal((await f.records.principals.get(f.second.id))?.disabled, false, 'a different live administrator exists but is never a fallback');
  const before = await f.snapshot();
  assert.equal((await f.cli(['preview', '--json', '--owner-role=' + f.database.user])).code, 1);
  assert.deepEqual(await f.snapshot(), before);
});

async function applyCurrentPreview(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.cli(['preview', '--json', '--owner-role=' + f.database.user]);
  assert.equal(result.code, 0, result.err.join('\n'));
  const document = JSON.parse(result.out.join('\n'));
  const file = join(f.root, 'preview.json'); await writeFile(file, JSON.stringify(document), { mode: 0o600 });
  const applied = await f.cli(['apply', '--preview=' + file, '--expected-snapshot=' + document.sha256, '--owner-role=' + f.database.user]);
  assert.equal(applied.code, 0, applied.err.join('\n'));
}

test('a compatible declared future migration does not invalidate the independently verified completed cutover', { timeout: 180000 }, async t => {
  const f = await fixture(t); await applyCurrentPreview(f);
  const sha = sha256Hex('synthetic future append-only fixture');
  await f.owner.transaction(async tx => {
    await f.owner.query('INSERT INTO public.schema_migrations(version,name,sha256) VALUES(3,$1,$2)', ['synthetic_future', sha], tx);
    await f.owner.query('INSERT INTO public.hub_migration_compatibility(migration_version,format_version,migration_name,migration_sha256,minimum_reader_level) VALUES(3,1,$1,$2,2)', ['synthetic_future', sha], tx);
  });
  const observed = await readProductionUpgradeStartup(f.config);
  assert.equal(observed.compatibility.compatible, true);
  assert.equal(observed.environmentAssignmentCompleted, true, 'activation must verify N2 receipts without replacing C2 declaration admission with an exact migration-count check');
  assert.equal(upgradeStartupDecision(observed).enforceEnvironmentAssignments, true);
});

test('readable floor two with no preservation completion refuses startup and gives upgrade instructions instead of reset', { timeout: 180000 }, async t => {
  const f = await fixture(t); await applyCurrentPreview(f);
  // Corrupt only this isolated fixture after a committed cutover; no production repair or migration rewrite is introduced.
  await f.owner.transaction(async tx => {
    await f.owner.query('ALTER TABLE public.environment_assignment_completion DISABLE TRIGGER USER', [], tx);
    await f.owner.query('DELETE FROM public.environment_assignment_completion', [], tx);
    await f.owner.query('ALTER TABLE public.environment_assignment_completion ENABLE TRIGGER USER', [], tx);
  });
  const observed = await readProductionUpgradeStartup(f.config);
  assert.equal(observed.compatibility.compatible, true); assert.equal(observed.environmentAssignmentCompleted, false);
  assert.equal(upgradeStartupDecision(observed).enforceEnvironmentAssignments, false);
  const errors: string[] = []; let assembled = false;
  const code = await serve([], { io: { env: { ...f.env }, cwd: f.root, stdout: () => {}, stderr: line => errors.push(line) }, ensureDatabase: async () => {}, stopSignal: () => Promise.resolve(), assembly: async () => ({ assemble: () => { assembled = true; throw new Error('must not start business'); } }) });
  assert.equal(code, 1); assert.equal(assembled, false);
  assert.match(errors.join('\n'), /upgrade preview/); assert.match(errors.join('\n'), /--expected-snapshot/);
  assert.doesNotMatch(errors.join('\n'), /记录库需要重建/);
});

test('a real actor or source change after preview rejects the old snapshot before any migration or assignment write', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const result = await f.cli(['preview', '--json', '--owner-role=' + f.database.user]);
  assert.equal(result.code, 0, result.err.join('\n'));
  const document = JSON.parse(result.out.join('\n'));
  const file = join(f.root, 'stale-preview.json'); await writeFile(file, JSON.stringify(document), { mode: 0o600 });
  await f.records.principals.setDisabled(f.actor, f.memberToken.user, true);
  const before = await f.snapshot();
  const applied = await f.cli(['apply', '--preview=' + file, '--expected-snapshot=' + document.sha256, '--owner-role=' + f.database.user]);
  assert.equal(applied.code, 1); assert.match(applied.err.join('\n'), /切点来源或权限已改变/);
  assert.deepEqual(await f.snapshot(), before, 'owner transaction rejects before M2, grants, completion or token telemetry writes');
});

test('repository CLI script carries the actual token to zero-write preview and exact owner apply in separate processes', { timeout: 180000 }, async t => {
  const f = await fixture(t);
  // Keep HOME, settings lookup, data root and every CIRCLE_HUB value inside this synthetic deployment.
  const run = async (args: string[]) => {
    const { token } = await f.records.principals.issueToken(f.actor, f.actor.id, '合成子进程操作令牌');
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/circle-hub', import.meta.url)), 'upgrade', ...args], { cwd: f.root, env: { ...f.env, HOME: f.root, PATH: '/usr/bin:/bin', CIRCLE_HUB_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.ok(!out.includes(token)); assert.ok(!err.includes(token));
    return { code, out, err };
  };
  // Token issuance is an intentional setup write, before measuring the child preview.
  const operator = await f.records.principals.issueToken(f.actor, f.actor.id, '合成子进程固定令牌');
  const before = await f.snapshot();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/circle-hub', import.meta.url)), 'upgrade', 'preview', '--json', '--owner-role=' + f.database.user], { cwd: f.root, env: { ...f.env, HOME: f.root, PATH: '/usr/bin:/bin', CIRCLE_HUB_TOKEN: operator.token }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let json = '', stderr = ''; child.stdout.on('data', chunk => { json += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.ok(!json.includes(operator.token)); assert.ok(!stderr.includes(operator.token));
  assert.equal(code, 0, stderr); assert.deepEqual(await f.snapshot(), before);
  const preview = JSON.parse(json);
  const file = join(f.root, 'child-preview.json'); await writeFile(file, JSON.stringify(preview), { mode: 0o600 });
  const applied = await run(['apply', '--preview=' + file, '--expected-snapshot=' + preview.sha256, '--owner-role=' + f.database.user]);
  assert.equal(applied.code, 0, applied.err);
  assert.equal(upgradeStartupDecision(await readProductionUpgradeStartup(f.config)).enforceEnvironmentAssignments, true);
});
