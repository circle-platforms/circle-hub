import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../config/index.ts';
import { startPostgres } from '../testing/postgres.ts';
import { FileKeyProvider, VaultError, openRecords } from './index.ts';

test('openRecords from a loaded configuration over a Unix socket: directories, migrations, every store wired', async (t) => {
  const postgres = await startPostgres({ socket: true });
  t.after(() => postgres.stop());
  const database = await postgres.createDatabase('t_open');
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-open-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    CIRCLE_HUB_DATA_DIR: join(dataDir, 'hub'),
    CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_SOCKET_DIR: database.host,
    CIRCLE_HUB_DATABASE_PORT: String(database.port),
    CIRCLE_HUB_DATABASE_NAME: database.database,
    CIRCLE_HUB_DATABASE_USER: database.user,
  });
  assert.equal(config.database.password, undefined);
  // The environment never carries the password; the platform supplies it (from the vault) when the server asks for one.
  const kit = await openRecords({ ...config, database: { ...config.database, password: database.password } });
  t.after(() => kit.close());
  for (const directory of [config.dataDir, join(config.dataDir, 'objects'), config.logDir]) {
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  }
  const record = await kit.store.put({ kind: 'run', schema: 'run@1', provenance: 'observed', body: { synthetic: true } });
  assert.deepEqual((await kit.store.get(record.digest))?.body, { synthetic: true });
  // No key provider was given: the vault refuses instead of inventing a key.
  await assert.rejects(kit.vault.put('x', 'y'), VaultError);
  // Opening a second kit against the same database applies no migration and works side by side.
  const keyProvider = new FileKeyProvider(join(dataDir, 'key'));
  await keyProvider.initKey();
  const second = await openRecords({ ...config, database: { ...config.database, password: database.password } }, { keyProvider });
  t.after(() => second.close());
  assert.equal((await second.store.getById(record.id))?.digest, record.digest);
  await second.vault.put('db.password', 'synthetic');
  assert.equal(await second.vault.getText('db.password'), 'synthetic');
  await second.close();
  await second.close();
});

test('a passwordless socket cluster is reachable from CIRCLE_HUB_* variables alone, as a Hub child process would be', async (t) => {
  await assert.rejects(startPostgres({ passwordless: true }), TypeError);
  const postgres = await startPostgres({ socket: true, passwordless: true });
  t.after(() => postgres.stop());
  assert.equal(postgres.config.password, undefined);
  const database = await postgres.createDatabase('t_env_only');
  const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-open-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const environment = {
    CIRCLE_HUB_DATA_DIR: join(dataDir, 'hub'),
    CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
    CIRCLE_HUB_DATABASE_PORT: String(database.port),
    CIRCLE_HUB_DATABASE_NAME: database.database,
    CIRCLE_HUB_DATABASE_USER: database.user,
  };
  const kit = await openRecords(loadConfig(environment));
  t.after(() => kit.close());
  const record = await kit.store.put({ kind: 'claim', schema: 'claim@1', provenance: 'observed', body: { ok: true } });
  assert.equal((await kit.store.get(record.digest))?.digest, record.digest);
});
