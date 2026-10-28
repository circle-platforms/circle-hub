import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ensureLayout, layoutAt } from './layout.ts';
import { createPostgres } from './postgres.ts';
import { ensureHubDatabase, hubKeyProvider } from './service.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { withSession } from './sql.ts';
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
    // A database in which the application role owns something (an earlier platform version) is not served.
    await withSession(control.connector, control.target.database, async (s) => {
      await s.query('CREATE TABLE handed_over (n int)');
      await s.query('ALTER TABLE handed_over OWNER TO circle_hub');
    });
    const warnings: string[] = [];
    const warn = (line: string) => warnings.push(line);
    await assert.rejects(ensureHubDatabase(env, { warn }), (error: unknown) => {
      assert.match((error as Error).message, /^启动之前，应用角色 circle_hub 应当只能连接并按授权读写，现在却拥有 1 个对象（table handed_over）/);
      assert.match(String((error as { hint?: string }).hint), /REASSIGN OWNED BY "circle_hub"/);
      return true;
    });
    // A large object the application role made itself (any role may) gives it no power over history: serve warns only.
    const [lo] = await withSession(control.applicationConnector, control.target.database, (s) => s.query('SELECT lo_create(0)::text AS oid'));
    await assert.rejects(ensureHubDatabase(env, { warn }), /现在却拥有 2 个对象（large object \d+、table handed_over）：Hub 以它运行/, 'not together with a table');
    await withSession(control.connector, control.target.database, (s) => s.query('DROP TABLE handed_over'));
    assert.deepEqual(warnings, []);
    assert.deepEqual(await ensureHubDatabase(env, { warn }), { started: false, created: false });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, new RegExp(`^注意：应用角色 circle_hub 拥有 1 个对象（large object ${lo?.oid}），都是不需授权就能建的对象，Hub 照常启动，但备份和部署会拒绝；处理：`));
    assert.match(warnings[0]!, /执行「REASSIGN OWNED BY "circle_hub" TO "[^"]+";」$/);
    assert.doesNotMatch(warnings[0]!, /先停掉服务/);
    await withSession(control.connector, control.target.database, (s) => s.query(`SELECT lo_unlink(${lo?.oid})`));
    assert.deepEqual(await ensureHubDatabase(env, { warn }), { started: false, created: false });
    assert.equal(warnings.length, 1, 'nothing to warn about any more');
  } finally {
    await control.stop();
  }
  await assert.rejects(ensureHubDatabase({ ...env, CIRCLE_HUB_DATABASE_SOCKET_DIR: '/tmp/elsewhere' }), /套接字目录/);
  await assert.rejects(ensureHubDatabase({ CIRCLE_HUB_DATABASE_PORT: port }), /没有设置 CIRCLE_HUB_DATA_DIR/, 'never the default data root');
});

test('hubKeyProvider reads the keychain item of the deployment settings; a data root without settings, the one the environment names; no data root, none', async () => {
  const key = randomBytes(32).toString('hex');
  // A development data root without settings (as hub/testing makes them).
  const plain = await tempDir();
  roots.push(plain);
  const { runner, calls } = recordingRunner(() => ok(`${key}\n`), { real: false });
  const provider = hubKeyProvider({ CIRCLE_HUB_DATA_DIR: plain, CIRCLE_HUB_KEYCHAIN_SERVICE: 'hub-x', CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'key-x' }, { runner, platform: 'darwin' });
  assert.equal(Buffer.from(await provider.getKey()).toString('hex'), key);
  assert.deepEqual(calls[0]?.args, ['find-generic-password', '-s', 'hub-x', '-a', 'key-x', '-w']);
  const defaults = recordingRunner(() => ok(`${key}\n`), { real: false });
  await hubKeyProvider({ CIRCLE_HUB_DATA_DIR: plain }, { runner: defaults.runner, platform: 'darwin' }).getKey();
  assert.deepEqual(defaults.calls[0]?.args, ['find-generic-password', '-s', 'circle-hub', '-a', 'vault-master-key', '-w']);
  // Without a data root nothing is guessed, as ensureHubDatabase refuses: the default root's settings may name other items.
  const unset = recordingRunner(() => ok(`${key}\n`), { real: false });
  for (const env of [{}, { CIRCLE_HUB_DATA_DIR: '' }, { CIRCLE_HUB_KEYCHAIN_SERVICE: 'hub-x', CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'key-x' }]) {
    await assert.rejects(hubKeyProvider(env, { runner: unset.runner, platform: 'darwin' }).getKey(), /^PlatformError: 没有设置 CIRCLE_HUB_DATA_DIR：钥匙串项由部署的数据根里的部署设置决定，不猜默认数据根$/, JSON.stringify(env));
  }
  assert.deepEqual(unset.calls, [], 'the keychain was not asked');

  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  await writeSettingsFile(layout, newSettingsFile({ environment: 'test', keychainService: 'hub-pinned', keychainAccount: 'key-pinned' }));
  const pinned = recordingRunner(() => ok(`${key}\n`), { real: false });
  await hubKeyProvider({ CIRCLE_HUB_DATA_DIR: root }, { runner: pinned.runner, platform: 'darwin' }).getKey();
  assert.deepEqual(pinned.calls[0]?.args, ['find-generic-password', '-s', 'hub-pinned', '-a', 'key-pinned', '-w']);
  const stray = recordingRunner(() => ok(`${key}\n`), { real: false });
  await assert.rejects(hubKeyProvider({ CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'dev-key' }, { runner: stray.runner, platform: 'darwin' }).getKey(), /CIRCLE_HUB_KEYCHAIN_ACCOUNT 是 dev-key/);
  assert.deepEqual(stray.calls, [], 'the keychain was not asked for another item');
});
