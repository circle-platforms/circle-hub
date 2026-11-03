import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ensureLayout, layoutAt } from './layout.ts';
import { createPostgres } from './postgres.ts';
import { DEFAULT_KEY_ACCOUNT, DEFAULT_KEY_SERVICE, fileKeyStore, VAULT_KEY_ITEM } from './file-key.ts';
import { deploymentKeyNames, ensureHubDatabase, hubKeyProvider } from './service.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { withSession } from './sql.ts';
import { removeDir, socketPort, tempDir } from './test-support.ts';

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

test('hubKeyProvider reads the key file the deployment settings name; a data root without settings, the default names; no data root, none', async () => {
  const key = randomBytes(32);
  // A development data root without settings (as hub/testing makes them): the default names, on every platform.
  const plain = await tempDir();
  roots.push(plain);
  await fileKeyStore({ root: plain, service: DEFAULT_KEY_SERVICE, account: DEFAULT_KEY_ACCOUNT, item: VAULT_KEY_ITEM }).write(key);
  const provider = hubKeyProvider({ CIRCLE_HUB_DATA_DIR: plain });
  assert.deepEqual(Buffer.from(await provider.getKey()), key);
  // Without a data root nothing is guessed, as ensureHubDatabase refuses: the default root's settings may name other keys.
  for (const env of [{}, { CIRCLE_HUB_DATA_DIR: '' }]) {
    await assert.rejects(hubKeyProvider(env).getKey(), /^PlatformError: 没有设置 CIRCLE_HUB_DATA_DIR：密钥文件由部署的数据根里的部署设置决定，不猜默认数据根$/, JSON.stringify(env));
  }

  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  await writeSettingsFile(layout, newSettingsFile({ environment: 'test', keyService: 'hub-pinned', keyAccount: 'key-pinned' }));
  // The default names' file is not the deployment's key: the settings' names are.
  await fileKeyStore({ root, service: DEFAULT_KEY_SERVICE, account: DEFAULT_KEY_ACCOUNT, item: VAULT_KEY_ITEM }).write(randomBytes(32));
  await assert.rejects(hubKeyProvider({ CIRCLE_HUB_DATA_DIR: root }).getKey(), /没有密钥库主密钥/);
  await fileKeyStore({ root, service: 'hub-pinned', account: 'key-pinned', item: VAULT_KEY_ITEM }).write(key);
  assert.deepEqual(Buffer.from(await hubKeyProvider({ CIRCLE_HUB_DATA_DIR: root }).getKey()), key);
  assert.deepEqual(await deploymentKeyNames({ CIRCLE_HUB_DATA_DIR: root }).then(({ vaultKey, operatorToken }) => [vaultKey.service, vaultKey.account, operatorToken.service, operatorToken.account]), ['hub-pinned', 'key-pinned', 'hub-pinned', 'operator-token']);
});
