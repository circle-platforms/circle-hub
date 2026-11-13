// Actual temporary PostgreSQL only. The upgrader sees token hashes; this test alone owns the synthetic raw material.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../config/index.ts';
import { FileVault, openRecords, sha256Hex } from '../../records/api.ts';
import { assembleHub } from '../../server/assemble.ts';
import { listTools } from '../../server/tools.ts';
import { createContext, postgresFor } from '../context.ts';
import { ensureLayout, layoutAt } from '../layout.ts';
import { ensureDatabaseRunning } from '../postgres.ts';
import { newSettingsFile, writeSettingsFile } from '../settings.ts';
import { hubKeyProvider } from '../service.ts';
import { sha256File } from '../files.ts';
import { withSession } from '../sql.ts';
import { exit, recordingRunner, freePort, socketPort, libpqAvailable, LIBPQ_MISSING } from '../test-support.ts';
import { upgradeDatabase, type UpgradeOptions } from './host.ts';
import { UpgradeFailure, type UpgradeStage } from './operation.ts';
import { createOld33Schema } from './testing/old33.ts';
import { buildOld33Fixture, seedOld33Fixture, writeOld33Objects } from './testing/fixtures.ts';

const libpq = await libpqAvailable();
const rawToken = 'SyntheticUpgradeToken0123456789abcdefghijkl';
const rawSecret = 'SyntheticUpgradeKey!9384';

async function setup(origin?: string) {
  const parent = await mkdtemp(join(tmpdir(), 'circle-hub-upgrade-test-'));
  const layout = layoutAt(join(parent, 'data'));
  await ensureLayout(layout);
  const databasePort = socketPort(), port = await freePort();
  await writeSettingsFile(layout, newSettingsFile({ environment: 'test', port, database: { port: databasePort } }));
  const runner = recordingRunner(call => call.command.endsWith('launchctl') ? exit(113, 'not loaded') : undefined).runner;
  const env = { CIRCLE_HUB_PORT: String(port), CIRCLE_HUB_DATA_DIR: layout.root, CIRCLE_HUB_DATABASE_SOCKET_DIR: layout.run, CIRCLE_HUB_DATABASE_PORT: String(databasePort), CIRCLE_HUB_DATABASE_USER: 'circle_hub' };
  const context = createContext(env, { platform: 'darwin', home: parent, launchAgentsDir: join(parent, 'agents'), layout, runner, libpqBin: libpq });
  const postgres = postgresFor(context);
  try {
    await postgres.initialise(); await ensureDatabaseRunning(postgres, { create: true });
    const fixture = buildOld33Fixture({ tokenSha256: sha256Hex(rawToken), resourceOrigin: origin });
    await withSession(postgres.connector, postgres.target.database, async session => { await createOld33Schema(session); await seedOld33Fixture(session, fixture); });
    await writeOld33Objects(layout.objects, fixture);
    const vault = new FileVault(layout.vault, hubKeyProvider(env));
    await vault.initKey();
    for (const secret of fixture.handles.secrets) await vault.put(secret.entry, rawSecret);
    const fingerprints = await Promise.all(fixture.handles.secrets.map(async secret => ({ path: join(layout.vault, secret.entry + '.sealed'), digest: (await sha256File(join(layout.vault, secret.entry + '.sealed'))).sha256 })));
    const check = { path: join(layout.vault, 'key-check'), digest: (await sha256File(join(layout.vault, 'key-check'))).sha256 }; fingerprints.push(check);
    return { parent, layout, context, postgres, fixture, vault, fingerprints, env,
      async close() { await postgres.stop(); await rm(parent, { recursive: true, force: true }); } };
  } catch (error) { await postgres.stop().catch(() => {}); await rm(parent, { recursive: true, force: true }); throw error; }
}

test('old33 all-class state upgrades in place and the old client and secret-backed read still work', { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
  let received = false;
  const endpoint = createServer((request, response) => {
    received = request.headers.authorization === 'Bearer ' + rawSecret;
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ title: '合成升级后的原件' }));
  });
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => endpoint.close(() => resolve())));
  const address = endpoint.address(); assert.ok(address && typeof address !== 'string');
  const f = await setup('http://127.0.0.1:' + address.port); t.after(() => f.close());
  let report;
  try { report = await upgradeDatabase(f.context); }
  catch (error) {
    // Non-value migration reasons only, to make the red test useful without disclosing stored rows.
    const files = await import('node:fs/promises').then(fs => fs.readdir(f.layout.logs));
    for (const name of files.filter(name => name.startsWith('upgrade-'))) {
      const diagnostic = JSON.parse(await readFile(join(f.layout.logs, name), 'utf8')) as { issues: unknown };
      t.diagnostic(JSON.stringify(diagnostic.issues));
    }
    throw error;
  }
  assert.equal(report.status, 'upgraded'); assert.ok(report.archive); assert.ok(report.backup);
  assert.equal(report.tables.length, 60);
  for (const table of report.tables) assert.equal(table.migrated + table.archived, table.original);
  for (const fingerprint of f.fingerprints) assert.ok((await sha256File(fingerprint.path)).sha256 === fingerprint.digest, 'original ciphertext and key-check bytes must not change');
  const config = loadConfig(f.env);
  const kit = await openRecords(config, { migrate: false, keyProvider: hubKeyProvider(f.env) }); t.after(() => kit.close());
  const principal = await kit.principals.authenticate('Bearer ' + rawToken); assert.ok(principal);
  const hub = await assembleHub(config, kit, { requireOsIsolation: false, checkSandbox: false, leases: null, log: () => {} });
  const tools = await listTools(hub.deps, principal); assert.equal(tools.length, 6);
  const result = await hub.connectors.executeRead(f.fixture.handles.resource.id, 'document', {}, { principal, purpose: '合成升级验收' });
  assert.equal(result.ok, true, 'the configured resource read must succeed'); assert.equal(received, true, 'the resource receives the retained synthetic credential');
  const histories = await kit.store.list({ kind: 'run', limit: 100 }); assert.equal(histories.items.length, 0);
  const quota = await withSession(f.postgres.connector, f.postgres.target.database, session => session.query('SELECT key,run_id,user_id,token::text,acquired_at::text,expires_at::text,released_at::text FROM leases ORDER BY key'));
  assert.equal(quota.length, 4); assert.equal(quota.some(row => row.run_id === f.fixture.handles.reservation.run), true);
  const noop = await upgradeDatabase(f.context); assert.equal(noop.status, 'noop'); assert.equal(noop.backup, null);
});

for (const stage of ['stop','archive','create','migrate','transfer','preflight','restart'] as const satisfies readonly UpgradeStage[]) {
  test(`a real database failure after ${stage} restores the old33 database and preserves original vault files`, { timeout: 120_000, skip: libpq ? false : LIBPQ_MISSING }, async t => {
    const f = await setup(); t.after(() => f.close());
    const options: UpgradeOptions = { hostTransform(host) { return { ...host, [stage]: async () => { await host[stage](); throw new Error('SyntheticOpaquePrivate938'); } }; } };
    await assert.rejects(upgradeDatabase(f.context, options), (error: unknown) => {
      assert.ok(error instanceof UpgradeFailure); assert.equal(error.stage, stage); assert.equal(error.rollback, 'succeeded');
      assert.doesNotMatch(error.message, /SyntheticOpaquePrivate938/); return true;
    });
    const [row] = await withSession(f.postgres.connector, f.postgres.target.database, session => session.query('SELECT count(*)::int AS n FROM schema_migrations'));
    assert.equal(row!.n, 33);
    for (const fingerprint of f.fingerprints) assert.ok((await sha256File(fingerprint.path)).sha256 === fingerprint.digest);
  });
}
