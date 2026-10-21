import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { ENVIRONMENT } from '../../contracts/generated/vocabulary.ts';
import { ensureLayout, layoutAt } from './layout.ts';
import {
  APPLICATION_ROLE,
  assertApplicationRoleName,
  DATABASE_NAME,
  DATABASE_PORT,
  DEFAULT_KEYCHAIN_ACCOUNT,
  DEFAULT_PORT,
  deploymentDatabase,
  environmentText,
  newSettingsFile,
  readSettings,
  readSettingsFile,
  resolveDatabaseNames,
  resolveSettings,
  SETTINGS_SCHEMA,
  settingsPath,
  writeSettingsFile,
} from './settings.ts';
import { removeDir, tempDir } from './test-support.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

async function freshLayout() {
  const root = await tempDir();
  roots.push(root);
  const layout = layoutAt(root);
  await ensureLayout(layout);
  return layout;
}

test('settings are written once, read back and never replaced', async () => {
  const layout = await freshLayout();
  assert.equal(await readSettingsFile(layout), undefined);
  await assert.rejects(readSettings(layout, {}), /还没初始化/);
  const file = newSettingsFile({ environment: 'shared' });
  await writeSettingsFile(layout, file);
  assert.deepEqual(await readSettingsFile(layout), file);
  await assert.rejects(writeSettingsFile(layout, newSettingsFile({ environment: 'test' })), /已存在，不覆盖/);
  const text = await readFile(settingsPath(layout), 'utf8');
  assert.match(text, /"environment": "shared"/);
  const settings = await readSettings(layout, {});
  assert.equal(settings.port, DEFAULT_PORT);
  assert.equal(settings.keychainAccount, DEFAULT_KEYCHAIN_ACCOUNT);
});

test('a settings file with unknown fields or a hand-written environment class is refused', async () => {
  const layout = await freshLayout();
  await writeFile(settingsPath(layout), JSON.stringify({ ...newSettingsFile({ environment: 'test' }), extra: 1 }));
  await assert.rejects(readSettingsFile(layout), /字段：\(根\)|extra|不符合/);
  await writeFile(settingsPath(layout), JSON.stringify({ ...newSettingsFile({ environment: 'test' }), environment: 'staging' }));
  await assert.rejects(readSettingsFile(layout), /environment/);
  await writeFile(settingsPath(layout), '{not json');
  await assert.rejects(readSettingsFile(layout), /不是合法的 JSON/);
});

test('the deployment settings pin the database names, the port and the keychain item', async () => {
  const file = newSettingsFile({ environment: 'production', port: 7500, keychainAccount: 'key-a', database: { name: 'hub_a', role: 'hub_app', port: 6543 } });
  assert.equal(file.schema, SETTINGS_SCHEMA);
  assert.deepEqual(file.database, { name: 'hub_a', role: 'hub_app', socket_port: 6543 });
  const settings = resolveSettings(file, {});
  assert.deepEqual(settings.database, { name: 'hub_a', role: 'hub_app', port: 6543 });
  assert.equal(settings.port, 7500);
  assert.equal(settings.keychainAccount, 'key-a');
  assert.deepEqual(newSettingsFile({ environment: 'test' }).database, { name: DATABASE_NAME, role: APPLICATION_ROLE, socket_port: DATABASE_PORT });
  assert.throws(() => newSettingsFile({ environment: 'test', keychainService: 'has space' }), /取值不对.*keychain_service/);
  assert.throws(() => newSettingsFile({ environment: 'test', database: { name: 'bad name;' } }), /database\.name/);
});

test('a CIRCLE_HUB_* variable may repeat a setting but never change it: a disagreeing one is refused by name', () => {
  const layout = layoutAt('/srv/hub');
  const file = newSettingsFile({ environment: 'production', port: 7500 });
  const same = {
    CIRCLE_HUB_PORT: '7500',
    CIRCLE_HUB_KEYCHAIN_SERVICE: 'circle-hub',
    CIRCLE_HUB_KEYCHAIN_ACCOUNT: DEFAULT_KEYCHAIN_ACCOUNT,
    CIRCLE_HUB_DATABASE_NAME: DATABASE_NAME,
    CIRCLE_HUB_DATABASE_USER: APPLICATION_ROLE,
    CIRCLE_HUB_DATABASE_PORT: String(DATABASE_PORT),
    CIRCLE_HUB_DATABASE_SOCKET_DIR: '/srv/hub/run',
  };
  assert.equal(resolveSettings(file, same, layout).port, 7500);
  assert.equal(resolveSettings(file, { CIRCLE_HUB_PORT: '' }, layout).port, 7500, 'an empty variable is unset');
  for (const [name, value] of [
    ['CIRCLE_HUB_PORT', '7999'],
    ['CIRCLE_HUB_KEYCHAIN_SERVICE', 'hub-b'],
    ['CIRCLE_HUB_KEYCHAIN_ACCOUNT', 'dev-key'],
    ['CIRCLE_HUB_DATABASE_NAME', 'circle_hub_dev'],
    ['CIRCLE_HUB_DATABASE_USER', 'someone_else'],
    ['CIRCLE_HUB_DATABASE_PORT', '6543'],
    ['CIRCLE_HUB_DATABASE_SOCKET_DIR', '/tmp/other'],
  ] as const) {
    assert.throws(
      () => resolveSettings(file, { ...same, [name]: value }, layout),
      (error: unknown) => {
        assert.match((error as Error).message, new RegExp(`环境变量与部署设置.*不一致，不执行：${name} 是 ${value.replaceAll('/', '\\/')}`));
        assert.match(String((error as { hint?: string }).hint), /部署设置是唯一的来源/);
        return true;
      },
      name,
    );
  }
  assert.throws(() => resolveSettings(file, { CIRCLE_HUB_DATABASE_HOST: '127.0.0.1' }, layout), /只有 unix 套接字/);
});

test('a new deployment refuses an application role name the records package would not grant; one pinned earlier is read but not deployed', async () => {
  const layout = layoutAt('/srv/hub');
  for (const name of ['hub-app', 'Hub_App', 'hub$app', '9hub', 'a'.repeat(64)]) {
    assert.throws(() => newSettingsFile({ environment: 'test', database: { role: name } }), (error: unknown) => {
      assert.match((error as Error).message, /字段：database\.role/);
      assert.match(String((error as { hint?: string }).hint), /应用角色名只能用小写字母、数字和下划线，以小写字母或下划线开头，最长 63 个字符/);
      return true;
    }, name);
    assert.throws(() => resolveDatabaseNames(layout, { CIRCLE_HUB_DATABASE_USER: name }), (error: unknown) => {
      assert.equal((error as Error).message, `CIRCLE_HUB_DATABASE_USER 的写法不对：${name}`);
      assert.match(String((error as { hint?: string }).hint), /记录包只给这样的角色授权/);
      return true;
    }, name);
  }
  for (const name of ['hub_app', '_hub', 'a'.repeat(63)]) {
    assert.equal(newSettingsFile({ environment: 'test', database: { role: name } }).database.role, name);
    assert.equal(resolveDatabaseNames(layout, { CIRCLE_HUB_DATABASE_USER: name }).role, name);
    assert.doesNotThrow(() => assertApplicationRoleName(name));
  }
  // Settings written before the rule: still read (status, backup and db keep working), but deploy refuses them.
  const root = await freshLayout();
  const old = newSettingsFile({ environment: 'test' });
  await writeFile(settingsPath(root), JSON.stringify({ ...old, database: { ...old.database, role: 'Hub-App' } }));
  assert.equal((await readSettings(root, {})).database.role, 'Hub-App');
  assert.throws(() => assertApplicationRoleName('Hub-App'), (error: unknown) => {
    assert.match((error as Error).message, /^部署设置里的应用角色名 Hub-App 不符合要求，不部署：/);
    assert.match(String((error as { hint?: string }).hint), /ALTER ROLE "Hub-App" RENAME TO hub_app，把部署设置里的 database\.role 改成 hub_app/);
    return true;
  });
});

test('an @1 settings file is read with the database names it implied', async () => {
  const layout = await freshLayout();
  const { database: _database, ...rest } = newSettingsFile({ environment: 'test', port: 7600 });
  await writeFile(settingsPath(layout), JSON.stringify({ ...rest, schema: 'circle-hub-platform@1' }));
  const file = await readSettingsFile(layout);
  assert.equal(file?.schema, SETTINGS_SCHEMA);
  assert.deepEqual(file?.database, { name: DATABASE_NAME, role: APPLICATION_ROLE, socket_port: DATABASE_PORT });
  assert.equal(file?.port, 7600);
});

test('every environment class comes from the generated vocabulary and has a Chinese label', () => {
  for (const code of ENVIRONMENT) {
    assert.doesNotThrow(() => newSettingsFile({ environment: code }));
    assert.match(environmentText(code), new RegExp(`（${code}）$`));
  }
});

test('a new data root takes the database names from the variables; a root with settings takes them from the file', async () => {
  const layout = layoutAt('/srv/hub');
  assert.deepEqual(resolveDatabaseNames(layout, {}), { port: 5432, name: DATABASE_NAME, role: APPLICATION_ROLE });
  assert.deepEqual(resolveDatabaseNames(layout, { CIRCLE_HUB_DATABASE_PORT: '6543', CIRCLE_HUB_DATABASE_NAME: 'hub_b', CIRCLE_HUB_DATABASE_USER: 'hub_app' }), {
    port: 6543,
    name: 'hub_b',
    role: 'hub_app',
  });
  assert.doesNotThrow(() => resolveDatabaseNames(layout, { CIRCLE_HUB_DATABASE_SOCKET_DIR: '/srv/hub/run' }));
  assert.throws(() => resolveDatabaseNames(layout, { CIRCLE_HUB_DATABASE_SOCKET_DIR: '/tmp/other' }), /套接字目录/);
  assert.throws(() => resolveDatabaseNames(layout, { CIRCLE_HUB_DATABASE_HOST: '127.0.0.1' }), /只有 unix 套接字/);
  assert.throws(() => resolveDatabaseNames(layout, { CIRCLE_HUB_DATABASE_PORT: '0' }), /1 到 65535/);
  assert.throws(() => resolveDatabaseNames(layout, { CIRCLE_HUB_DATABASE_USER: 'bad name;' }), /写法不对/);

  const root = await freshLayout();
  assert.deepEqual(deploymentDatabase(root, { CIRCLE_HUB_DATABASE_PORT: '6000' }), { port: 6000, name: DATABASE_NAME, role: APPLICATION_ROLE });
  await writeSettingsFile(root, newSettingsFile({ environment: 'test', database: { port: 6100 } }));
  assert.deepEqual(deploymentDatabase(root, {}), { port: 6100, name: DATABASE_NAME, role: APPLICATION_ROLE });
  assert.throws(() => deploymentDatabase(root, { CIRCLE_HUB_DATABASE_NAME: 'circle_hub_dev' }), /CIRCLE_HUB_DATABASE_NAME 是 circle_hub_dev/);
});
