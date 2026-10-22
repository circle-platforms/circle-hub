import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_KEYCHAIN_ACCOUNT,
  DEFAULT_KEYCHAIN_SERVICE,
  DEFAULT_LIMITS,
  HUB_ENVIRONMENT,
  HubConfigError,
  HubEnvironmentError,
  PLATFORM_ONLY_ENVIRONMENT,
  assertNoRetiredEnvironment,
  isLoopbackAddress,
  loadConfig,
  retiredEnvironmentKeys,
} from './index.ts';

const BASE = { CIRCLE_HUB_DATA_DIR: '/srv/hub-data', CIRCLE_HUB_PORT: '7999', CIRCLE_HUB_DATABASE_SOCKET_DIR: '/srv/hub-data/pg' };

function problems(env: Record<string, string | undefined>, options?: Parameters<typeof loadConfig>[1]): readonly string[] {
  try {
    loadConfig(env, options);
  } catch (error) {
    assert.ok(error instanceof HubConfigError, String(error));
    return error.problems;
  }
  assert.fail('loadConfig accepted an invalid configuration');
}

test('defaults with the required variables only', () => {
  const config = loadConfig(BASE);
  assert.deepEqual(config, {
    dataDir: '/srv/hub-data',
    logDir: '/srv/hub-data/logs',
    host: '127.0.0.1',
    port: 7999,
    database: { host: '/srv/hub-data/pg', port: 5432, database: 'circle_hub', user: 'circle_hub' },
    keychain: { service: 'circle-hub', account: 'vault-master-key' },
    limits: { ...DEFAULT_LIMITS },
  });
  assert.equal('password' in config.database, false);
  assert.deepEqual(config.keychain, { service: DEFAULT_KEYCHAIN_SERVICE, account: DEFAULT_KEYCHAIN_ACCOUNT });
});

test('every variable is read and validated', () => {
  const config = loadConfig({
    CIRCLE_HUB_DATA_DIR: '/srv/a/../hub',
    CIRCLE_HUB_LOG_DIR: '/var/log/hub',
    CIRCLE_HUB_HOST: '::1',
    CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_HOST: '127.0.0.2',
    CIRCLE_HUB_DATABASE_PORT: '6543',
    CIRCLE_HUB_DATABASE_NAME: 'hub_main',
    CIRCLE_HUB_DATABASE_USER: 'hub_owner',
    CIRCLE_HUB_KEYCHAIN_SERVICE: 'org.example.hub',
    CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'vault-key',
    CIRCLE_HUB_MAX_UPLOAD_BYTES: '1048576',
    CIRCLE_HUB_MAX_RECORD_BYTES: '65536',
    CIRCLE_HUB_MAX_REQUEST_BYTES: '2000000',
    UNRELATED: 'ignored',
  });
  assert.equal(config.dataDir, '/srv/hub');
  assert.equal(config.logDir, '/var/log/hub');
  assert.equal(config.host, '::1');
  assert.equal(config.port, 0);
  assert.deepEqual(config.database, { host: '127.0.0.2', port: 6543, database: 'hub_main', user: 'hub_owner' });
  assert.deepEqual(config.keychain, { service: 'org.example.hub', account: 'vault-key' });
  assert.deepEqual(config.limits, { maxUploadBytes: 1048576, maxRecordBytes: 65536, maxRequestBytes: 2000000 });
  // The request limit follows a raised upload limit unless set explicitly.
  const raised = loadConfig({ ...BASE, CIRCLE_HUB_MAX_UPLOAD_BYTES: String(96 * 1024 * 1024) });
  assert.ok(raised.limits.maxRequestBytes >= Math.ceil((96 * 1024 * 1024) / 3) * 4);
});

test('uploads are capped at 256 MiB: the credential scan decodes an upload into one string', () => {
  const largest = loadConfig({ ...BASE, CIRCLE_HUB_MAX_UPLOAD_BYTES: String(256 * 1024 * 1024) });
  assert.equal(largest.limits.maxUploadBytes, 256 * 1024 * 1024);
  // The derived request limit of the largest upload fits under the request cap.
  assert.ok(largest.limits.maxRequestBytes <= 512 * 1024 * 1024);
  for (const value of [256 * 1024 * 1024 + 1, 1024 * 1024 * 1024]) {
    assert.ok(problems({ ...BASE, CIRCLE_HUB_MAX_UPLOAD_BYTES: String(value) }).some((problem) => /CIRCLE_HUB_MAX_UPLOAD_BYTES 必须是 1024 到 268435456/.test(problem)), String(value));
  }
  assert.ok(problems({ ...BASE, CIRCLE_HUB_MAX_REQUEST_BYTES: String(512 * 1024 * 1024 + 1) }).some((problem) => problem.includes('CIRCLE_HUB_MAX_REQUEST_BYTES')));
});

test('missing and invalid values are all reported, in Chinese, before refusing to start', () => {
  assert.deepEqual(problems({}).length, 3);
  assert.match(problems({})[0], /必须设置 CIRCLE_HUB_DATA_DIR/);
  const found = problems({
    CIRCLE_HUB_DATA_DIR: 'relative/path',
    CIRCLE_HUB_PORT: '65536',
    CIRCLE_HUB_HOST: '0.0.0.0',
    CIRCLE_HUB_DATABASE_HOST: '192.0.2.10',
    CIRCLE_HUB_DATABASE_PORT: '05432',
    CIRCLE_HUB_DATABASE_NAME: 'bad name',
    CIRCLE_HUB_KEYCHAIN_SERVICE: 'has space',
    CIRCLE_HUB_MAX_UPLOAD_BYTES: '12abc',
  });
  for (const pattern of [
    /CIRCLE_HUB_DATA_DIR 必须是绝对路径/,
    /CIRCLE_HUB_PORT 必须是 0 到 65535/,
    /CIRCLE_HUB_HOST 只允许回环地址/,
    /CIRCLE_HUB_DATABASE_HOST 只允许回环地址/,
    /CIRCLE_HUB_DATABASE_PORT 必须是/,
    /CIRCLE_HUB_DATABASE_NAME 的写法不对/,
    /CIRCLE_HUB_KEYCHAIN_SERVICE 的写法不对/,
    /CIRCLE_HUB_MAX_UPLOAD_BYTES 必须是/,
  ]) {
    assert.ok(found.some((problem) => pattern.test(problem)), `${pattern} in ${found.join(' | ')}`);
  }
  assert.ok(problems({ ...BASE, CIRCLE_HUB_HOST: 'localhost' }).some((problem) => problem.includes('请写 127.0.0.1')));
  assert.ok(problems({ ...BASE, CIRCLE_HUB_DATABASE_HOST: '127.0.0.1' }).some((problem) => problem.includes('只能设置一个')));
  assert.ok(problems({ CIRCLE_HUB_DATA_DIR: '/d', CIRCLE_HUB_PORT: '1' }).some((problem) => problem.includes('不使用默认数据库')));
  assert.ok(
    problems({ ...BASE, CIRCLE_HUB_MAX_UPLOAD_BYTES: String(64 * 1024 * 1024), CIRCLE_HUB_MAX_REQUEST_BYTES: String(64 * 1024 * 1024) }).some((problem) =>
      problem.includes('base64'),
    ),
  );
  const longSocket = `/${'s'.repeat(95)}`;
  assert.ok(problems({ ...BASE, CIRCLE_HUB_DATABASE_SOCKET_DIR: longSocket }).some((problem) => problem.includes('太长')));
  assert.ok(problems({ ...BASE, CIRCLE_HUB_DATABASE_SOCKET_DIR: 'pg' }).some((problem) => problem.includes('绝对路径')));
});

test('loopback addresses only', () => {
  for (const host of ['127.0.0.1', '127.255.0.9', '::1']) assert.equal(isLoopbackAddress(host), true, host);
  for (const host of ['localhost', '0.0.0.0', '128.0.0.1', '127.0.0.256', '127.0.0.01', '::', '::ffff:127.0.0.1', '192.0.2.1', '']) {
    assert.equal(isLoopbackAddress(host), false, host);
  }
});

test('unknown CIRCLE_HUB_* names refuse to start; secret-looking names are pointed at the vault', () => {
  const typo = problems({ ...BASE, CIRCLE_HUB_DATADIR: '/x' });
  assert.equal(typo.length, 1);
  assert.match(typo[0], /CIRCLE_HUB_DATADIR 不是 Hub 的配置项（可能拼错了）/);
  for (const name of ['CIRCLE_HUB_DATABASE_PASSWORD', 'CIRCLE_HUB_TOKEN', 'CIRCLE_HUB_API_KEY', 'CIRCLE_HUB_SECRET']) {
    const found = problems({ ...BASE, [name]: 'value-that-must-not-echo' });
    assert.equal(found.length, 1, name);
    assert.match(found[0], /只经密钥库命令进入 Hub/);
    assert.doesNotMatch(found[0], /value-that-must-not-echo/);
  }
  // A program that reads a client-side name itself may say so; the Hub configuration still never reads it.
  const config = loadConfig({ ...BASE, CIRCLE_HUB_TOKEN: 'client-side' }, { allowUnknown: ['CIRCLE_HUB_TOKEN'] });
  assert.equal(JSON.stringify(config).includes('client-side'), false);
  assert.equal(Object.keys(HUB_ENVIRONMENT).every((name) => name.startsWith('CIRCLE_HUB_')), true);
});

test('CIRCLE_HUB_JEV_MODEL, the removed judgment-service model variable, is an unknown name now and refuses to start', () => {
  for (const value of ['jev-1.13.0', 'jev-latest', '']) {
    const found = problems({ ...BASE, CIRCLE_HUB_JEV_MODEL: value });
    assert.equal(found.length, 1, JSON.stringify(value));
    assert.match(found[0], /CIRCLE_HUB_JEV_MODEL 不是 Hub 的配置项（可能拼错了）/);
    assert.match(found[0], /CIRCLE_HUB_DATA_DIR/, 'the problem lists the names that do exist');
  }
});

test('the names only platform commands read are tolerated and never read; other unknown names still refuse to start', () => {
  assert.deepEqual(Object.keys(PLATFORM_ONLY_ENVIRONMENT), ['CIRCLE_HUB_LIBPQ_BIN']);
  const config = loadConfig({ ...BASE, CIRCLE_HUB_LIBPQ_BIN: '/opt/synthetic/libpq/bin' });
  assert.deepEqual(config, loadConfig(BASE));
  assert.equal(JSON.stringify(config).includes('/opt/synthetic/libpq/bin'), false);
  assert.equal(Object.keys(HUB_ENVIRONMENT).some((name) => name in PLATFORM_ONLY_ENVIRONMENT), false);
  // CIRCLE_HUB_HOME is not a platform name (hub/platform reads the data root from CIRCLE_HUB_DATA_DIR and refuses it too).
  const home = problems({ ...BASE, CIRCLE_HUB_HOME: '/srv/elsewhere' });
  assert.equal(home.length, 1);
  assert.match(home[0], /CIRCLE_HUB_HOME 不是 Hub 的配置项/);
});

test('retired CIRCLE_SERVER_* names refuse to start, even empty or beside the new name, and values never appear', () => {
  assert.deepEqual(retiredEnvironmentKeys({ CIRCLE_SERVER_B: 'x', OTHER: 'y', CIRCLE_SERVER_A: '' }), ['CIRCLE_SERVER_A', 'CIRCLE_SERVER_B']);
  assert.doesNotThrow(() => assertNoRetiredEnvironment({ CIRCLE_HUB_PORT: '1', CIRCLE_SERVERLESS: 'unrelated' }));
  for (const env of [
    { CIRCLE_SERVER_DATA_DIR: '/old/secret-path' },
    { CIRCLE_SERVER_PORT: '' },
    { ...BASE, CIRCLE_SERVER_DATA_DIR: '/old/secret-path' },
  ]) {
    assert.throws(
      () => loadConfig(env),
      (error: unknown) => error instanceof HubEnvironmentError && !error.message.includes('/old/secret-path') && error.keys.length === 1,
    );
  }
  assert.throws(
    () => assertNoRetiredEnvironment({ CIRCLE_SERVER_DATA_DIR: 'x', CIRCLE_SERVER_DATABASE_CONFIG: 'y' }),
    (error: unknown) =>
      error instanceof HubEnvironmentError &&
      error.message.includes('CIRCLE_SERVER_DATA_DIR -> CIRCLE_HUB_DATA_DIR') &&
      error.message.includes('CIRCLE_SERVER_DATABASE_CONFIG（没有同名的新变量'),
  );
});

test('the guard module stops a process that carries a retired name', () => {
  const guard = join(fileURLToPath(new URL('.', import.meta.url)), 'guard.ts');
  const environment = { PATH: process.env.PATH ?? '' };
  const clean = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(guard)}); console.log('started')`], {
    env: environment,
    encoding: 'utf8',
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /started/);
  const retired = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(guard)}); console.log('started')`], {
    env: { ...environment, CIRCLE_SERVER_PORT: '1' },
    encoding: 'utf8',
  });
  assert.notEqual(retired.status, 0);
  assert.doesNotMatch(retired.stdout, /started/);
  assert.match(retired.stderr, /HubEnvironmentError/);
});
