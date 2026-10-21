import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ensureLayout, layoutAt } from './layout.ts';
import { createPostgres } from './postgres.ts';
import { ensureHubDatabase, hubKeyProvider } from './service.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { ok, recordingRunner, removeDir, socketPort, tempDir } from './test-support.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

test('ensureHubDatabase starts the cluster named by the service environment, never initialises one and never creates the database', async () => {
  const parent = await tempDir();
  roots.push(parent);
  const root = join(parent, 'root');
  const port = String(socketPort());
  const env = { CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_DATABASE_SOCKET_DIR: join(root, 'run'), CIRCLE_HUB_DATABASE_PORT: port };
  await assert.rejects(ensureHubDatabase(env), /还没初始化/);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  const control = createPostgres({ layout, port: Number(port) });
  await control.initialise();
  try {
    await assert.rejects(ensureHubDatabase(env), (error: unknown) => {
      assert.match((error as Error).message, /数据库 circle_hub（或它的角色 circle_hub）不存在，不新建/);
      assert.match(String((error as { hint?: string }).hint), /circle-hub init/);
      return true;
    });
    assert.equal(await control.databaseExists(), false, 'the refusal created nothing');
    assert.equal(await control.ensureDatabase(), true);
    assert.equal(await control.stop(), true);
    assert.deepEqual(await ensureHubDatabase(env), { started: true, created: false });
    assert.deepEqual(await ensureHubDatabase(env), { started: false, created: false });
    await writeSettingsFile(layout, newSettingsFile({ environment: 'test', database: { port: Number(port) } }));
    assert.deepEqual(await ensureHubDatabase(env), { started: false, created: false }, 'agrees with the settings');
    await assert.rejects(ensureHubDatabase({ ...env, CIRCLE_HUB_DATABASE_NAME: 'circle_hub_dev' }), /CIRCLE_HUB_DATABASE_NAME 是 circle_hub_dev，部署设置里是 circle_hub/);
  } finally {
    await control.stop();
  }
  await assert.rejects(ensureHubDatabase({ ...env, CIRCLE_HUB_DATABASE_SOCKET_DIR: '/tmp/elsewhere' }), /套接字目录/);
  await assert.rejects(ensureHubDatabase({ CIRCLE_HUB_DATABASE_PORT: port }), /没有设置 CIRCLE_HUB_DATA_DIR/, 'never the default data root');
});

test('hubKeyProvider reads the keychain item of the deployment settings; without settings, the one the environment names', async () => {
  const key = randomBytes(32).toString('hex');
  const { runner, calls } = recordingRunner(() => ok(`${key}\n`), { real: false });
  const provider = hubKeyProvider({ CIRCLE_HUB_KEYCHAIN_SERVICE: 'hub-x', CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'key-x' }, { runner });
  assert.equal(Buffer.from(await provider.getKey()).toString('hex'), key);
  assert.deepEqual(calls[0]?.args, ['find-generic-password', '-s', 'hub-x', '-a', 'key-x', '-w']);
  const defaults = recordingRunner(() => ok(`${key}\n`), { real: false });
  await hubKeyProvider({}, { runner: defaults.runner }).getKey();
  assert.deepEqual(defaults.calls[0]?.args, ['find-generic-password', '-s', 'circle-hub', '-a', 'vault-master-key', '-w']);

  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  await writeSettingsFile(layout, newSettingsFile({ environment: 'test', keychainService: 'hub-pinned', keychainAccount: 'key-pinned' }));
  const pinned = recordingRunner(() => ok(`${key}\n`), { real: false });
  await hubKeyProvider({ CIRCLE_HUB_DATA_DIR: root }, { runner: pinned.runner }).getKey();
  assert.deepEqual(pinned.calls[0]?.args, ['find-generic-password', '-s', 'hub-pinned', '-a', 'key-pinned', '-w']);
  const stray = recordingRunner(() => ok(`${key}\n`), { real: false });
  await assert.rejects(hubKeyProvider({ CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'dev-key' }, { runner: stray.runner }).getKey(), /CIRCLE_HUB_KEYCHAIN_ACCOUNT 是 dev-key/);
  assert.deepEqual(stray.calls, [], 'the keychain was not asked for another item');
});
