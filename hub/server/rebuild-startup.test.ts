import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { startPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import { createPool } from '../records/api.ts';
import { diagnoseRecordsSchema } from '../records/api.ts';
import { loadServerConfig, serve, type ServeOptions } from './main.ts';
import type { CliIo, ListenInfo } from './api.ts';
import type { RebuildResetBridge } from './rebuild-http.ts';

function scratchIo(kit: TestRecordsKit): CliIo & { errors: string[] } {
  const errors: string[] = [];
  return {
    env: {
      CIRCLE_HUB_DATA_DIR: kit.dataDir,
      CIRCLE_HUB_PORT: '0',
      CIRCLE_HUB_DATABASE_SOCKET_DIR: kit.database.host,
      CIRCLE_HUB_DATABASE_PORT: String(kit.database.port),
      CIRCLE_HUB_DATABASE_NAME: kit.database.database,
      CIRCLE_HUB_DATABASE_USER: kit.database.user,
    },
    cwd: kit.dataDir, stdout: () => {}, stderr: line => errors.push(line), errors,
  };
}

function startupSpies(kit: TestRecordsKit) {
  let keys = 0, assemblies = 0, bridgeCalls = 0;
  const forbidden = async (): Promise<never> => {
    bridgeCalls++;
    throw new Error('startup must not execute reset bridge operations');
  };
  const bridge: RebuildResetBridge = {
    validate: () => { bridgeCalls++; throw new Error('startup must not validate reset requests'); },
    inspect: forbidden, preview: forbidden,
    launch: forbidden, acknowledge: forbidden, status: forbidden,
  };
  const options: Pick<ServeOptions, 'keyProvider' | 'assembly' | 'rebuild'> = {
    keyProvider: () => ({ getKey: async () => { keys++; return kit.keyProvider.getKey(); } }),
    assembly: async () => { assemblies++; throw new Error('normal assembly must not load'); },
    rebuild: { bridge, render: context => {
      assert.equal(context.authorized, false);
      assert.equal(context.rebuildNeeded, undefined);
      assert.equal(context.inspection, undefined);
      return '维护授权';
    } },
  };
  return { options, counts: () => ({ keys, assemblies, bridgeCalls }) };
}

test('incompatible PG migration fingerprint starts only the restricted real HTTP listener', { timeout: 180_000 }, async t => {
  const postgres = await startPostgres({ socket: true, passwordless: true, private: true });
  let kit: TestRecordsKit;
  try { kit = await openTestRecords({ postgres }); }
  catch (error) { await postgres.stop(); throw error; }
  t.after(async () => { try { await kit.close(); } finally { await postgres.stop(); } });
  const pool = createPool(kit.database, 1);
  try {
    const changed = await pool.query('UPDATE public.schema_migrations SET sha256 = $1', ['0'.repeat(64)]);
    assert.ok(changed.rowCount !== null && changed.rowCount > 0);
  } finally { await pool.end(); }
  const io = scratchIo(kit), spies = startupSpies(kit);
  const diagnosis = await diagnoseRecordsSchema(loadServerConfig(io.env));
  assert.equal(diagnosis.status, 'incompatible');
  assert.equal(diagnosis.compatible, false);
  const listening = Promise.withResolvers<ListenInfo>();
  const stop = Promise.withResolvers<void>();
  const serving = serve([], {
    io, ...spies.options, stopSignal: () => stop.promise,
    onListening: listening.resolve,
  });
  t.after(async () => { stop.resolve(); await serving; });
  const info = await Promise.race([
    listening.promise,
    serving.then(code => { throw new Error(`serve exited before listening (${code}): ${io.errors.join('\n')}`); }),
  ]);
  assert.equal(info.host, '127.0.0.1');
  assert.ok(info.port > 0);
  try {
    const health = await fetch(`${info.url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { needsRebuild: true });
    const page = await fetch(`${info.url}/console/rebuild`);
    assert.equal(page.status, 401);
    assert.equal(await page.text(), '维护授权');
    for (const [path, method] of [
      ['/mcp', 'POST'], ['/oauth/authorize', 'GET'], ['/oauth/token', 'POST'],
      ['/.well-known/oauth-authorization-server', 'GET'], ['/sync', 'POST'],
      ['/local-tools', 'POST'], ['/console/api/knowledge', 'GET'],
    ]) {
      const response = await fetch(info.url + path, { method });
      assert.equal(response.status, 503, `${method} ${path}`);
      assert.match(await response.text(), /reset|重建/);
    }
    assert.deepEqual(spies.counts(), { keys: 0, assemblies: 0, bridgeCalls: 0 });
  } finally { stop.resolve(); }
  assert.equal(await serving, 0);
});

test('unobservable PG connection or migration permissions never starts a rebuild listener', { timeout: 180_000 }, async t => {
  const postgres = await startPostgres({ socket: true, passwordless: true, private: true });
  let kit: TestRecordsKit;
  try { kit = await openTestRecords({ postgres }); }
  catch (error) { await postgres.stop(); throw error; }
  t.after(async () => { try { await kit.close(); } finally { await postgres.stop(); } });
  const role = `probe_${randomUUID().replaceAll('-', '')}`;
  const pool = createPool(kit.database, 1);
  try {
    await pool.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER`);
    await pool.query(`REVOKE ALL ON public.schema_migrations FROM "${role}"`);
  } finally { await pool.end(); }
  for (const failure of ['connection', 'permissions']) {
    await t.test(failure, { timeout: 60_000 }, async () => {
      const io = scratchIo(kit), spies = startupSpies(kit);
      if (failure === 'connection') io.env.CIRCLE_HUB_DATABASE_NAME = 'synthetic_missing_database';
      else io.env.CIRCLE_HUB_DATABASE_USER = role;
      const diagnosis = await diagnoseRecordsSchema(loadServerConfig(io.env));
      assert.equal(diagnosis.status, 'unavailable');
      assert.equal(diagnosis.compatible, null);
      let listening = 0;
      const code = await serve([], {
        io, ...spies.options, onListening: () => { listening++; },
        stopSignal: async () => {},
      });
      assert.equal(code, 1);
      assert.equal(listening, 0);
      assert.ok(io.errors.length > 0);
      const counts = spies.counts();
      assert.equal(counts.assemblies, 0);
      assert.equal(counts.bridgeCalls, 0);
    });
  }
});
