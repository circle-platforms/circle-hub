import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPostgres } from '../testing/postgres.ts';
import { serve } from './main.ts';
import type { ListenInfo } from './api.ts';
import type { RebuildResetBridge } from './rebuild-http.ts';

const unusedBridge: RebuildResetBridge = {
  validate: () => null,
  inspect: async () => { throw new Error('anonymous page must not inspect'); },
  preview: async () => { throw new Error('not authorized'); },
  launch: async () => { throw new Error('not authorized'); },
  acknowledge: async () => { throw new Error('not authorized'); },
  status: async () => { throw new Error('not authorized'); },
};

test('serve with a confirmed incompatible scratch database opens only the real maintenance page and health', { timeout: 120_000 }, async t => {
  const postgres = await startPostgres({ socket: true, passwordless: true });
  t.after(() => postgres.stop());
  const database = await postgres.createDatabase(undefined, { empty: true });
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-rebuild-serve-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const stopped = Promise.withResolvers<void>(), listening = Promise.withResolvers<ListenInfo>();
  let assembled = false;
  const errors: string[] = [];
  const running = serve([], {
    io: { env: { CIRCLE_HUB_DATA_DIR: dataDir, CIRCLE_HUB_PORT: '0', CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
      CIRCLE_HUB_DATABASE_PORT: String(database.port), CIRCLE_HUB_DATABASE_NAME: database.database, CIRCLE_HUB_DATABASE_USER: database.user },
      cwd: dataDir, stdout: () => {}, stderr: line => errors.push(line) },
    assembly: async () => { assembled = true; throw new Error('must not assemble an incompatible database'); },
    stopSignal: () => stopped.promise,
    onListening: info => listening.resolve(info), rebuild: { bridge: unusedBridge },
  });
  t.after(async () => { stopped.resolve(); await running; });
  const ready = await Promise.race([listening.promise, running.then(code => { throw new Error(`serve exited before listening: ${code}; ${errors.join('；')}`); })]);
  const health = await fetch(ready.url + '/healthz');
  assert.deepEqual(await health.json(), { needsRebuild: true });
  const page = await fetch(ready.url + '/console/rebuild');
  assert.equal(page.status, 401);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const body = await page.text();
  assert.match(body, /setup_code/);
  assert.ok(!body.includes('schema_migrations'));
  for (const path of ['/mcp', '/oauth/token', '/console/settings']) assert.equal((await fetch(ready.url + path)).status, 503);
  assert.equal(assembled, false);
  stopped.resolve(); assert.equal(await running, 0);
});

test('serve connection failure never opens a needs-rebuild listener', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-rebuild-unavailable-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let listened = false, assembled = false;
  const code = await serve([], {
    io: { env: { CIRCLE_HUB_DATA_DIR: dataDir, CIRCLE_HUB_PORT: '0', CIRCLE_HUB_DATABASE_SOCKET_DIR: join(dataDir, 'absent-socket') },
      cwd: dataDir, stdout: () => {}, stderr: () => {} },
    onListening: () => { listened = true; },
    assembly: async () => { assembled = true; throw new Error('unavailable'); },
    rebuild: { bridge: unusedBridge },
  });
  assert.equal(code, 1); assert.equal(listened, false); assert.equal(assembled, false);
});
