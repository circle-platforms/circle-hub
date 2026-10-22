// Drift checks against copies other packages keep of hub/config rules (test-only reads of their exports; production code
// of hub/config imports neither package). Each test fails when the two sides stop agreeing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as platform from '../platform/environment.ts';
import { DEFAULT_KEYCHAIN_ACCOUNT as PLATFORM_KEYCHAIN_ACCOUNT, DEFAULT_KEYCHAIN_SERVICE as PLATFORM_KEYCHAIN_SERVICE } from '../platform/settings.ts';
import {
  HUB_ENVIRONMENT,
  HubConfigError,
  HubEnvironmentError,
  PLATFORM_ONLY_ENVIRONMENT,
  assertNoRetiredEnvironment,
  isHubEnvironmentName,
  loadConfig,
  retiredEnvironmentKeys,
} from './index.ts';

const BASE = { CIRCLE_HUB_DATA_DIR: '/srv/hub-data', CIRCLE_HUB_PORT: '7999', CIRCLE_HUB_DATABASE_SOCKET_DIR: '/srv/hub-data/pg' };

function refuses(check: () => void): boolean {
  try {
    check();
    return false;
  } catch {
    return true;
  }
}

test('hub/config refuses exactly the retired names hub/platform refuses', () => {
  const names = [
    ...Object.keys(HUB_ENVIRONMENT).map((name) => name.replace(/^CIRCLE_HUB_/, 'CIRCLE_SERVER_')),
    'CIRCLE_SERVER_DATABASE_CONFIG',
    'CIRCLE_SERVER_',
    'CIRCLE_SERVER',
    'CIRCLE_SERVERLESS',
    'CIRCLE_SERVER_X_',
    'circle_server_port',
    'Circle_Server_PORT',
    ' CIRCLE_SERVER_PORT',
    'XCIRCLE_SERVER_PORT',
    'CIRCLE_HUB_PORT',
    'CIRCLE_HUB_SERVER_PORT',
    'PATH',
  ];
  const environments: Array<Record<string, string | undefined>> = [{}];
  for (const name of names) {
    for (const value of ['1', '', undefined]) environments.push({ [name]: value }, { ...BASE, [name]: value });
  }
  environments.push(Object.fromEntries(names.map((name) => [name, 'x'])));
  for (const environment of environments) {
    const label = JSON.stringify(environment);
    assert.deepEqual(retiredEnvironmentKeys(environment), platform.retiredEnvironmentKeys(environment), label);
    const configRefuses = refuses(() => assertNoRetiredEnvironment(environment));
    assert.equal(configRefuses, refuses(() => platform.assertHubEnvironment(environment)), label);
    assert.equal(configRefuses, retiredEnvironmentKeys(environment).length > 0, label);
    // loadConfig applies the same guard before anything else.
    if (configRefuses) assert.throws(() => loadConfig(environment), HubEnvironmentError, label);
  }
});

test('hub/config tolerates exactly the platform-only names of PLATFORM_VARIABLES, and reads every other platform name', () => {
  const names = Object.values(platform.PLATFORM_VARIABLES);
  const platformOnly = names.filter((name) => !isHubEnvironmentName(name)).sort();
  assert.deepEqual(Object.keys(PLATFORM_ONLY_ENVIRONMENT).sort(), platformOnly);
  // An operator shell that sets the platform-only names can still load the server configuration.
  const shell = { ...BASE, ...Object.fromEntries(platformOnly.map((name) => [name, '/opt/synthetic/bin'])) };
  assert.deepEqual(loadConfig(shell), loadConfig(BASE));
  // Every name the platform passes on to the service is one hub/config reads.
  for (const name of names) assert.ok(isHubEnvironmentName(name) || name in PLATFORM_ONLY_ENVIRONMENT, name);
  assert.throws(() => loadConfig({ ...BASE, CIRCLE_HUB_NOT_A_PLATFORM_NAME: 'x' }), HubConfigError);
});

test('the keychain defaults are the platform defaults', () => {
  assert.deepEqual(loadConfig(BASE).keychain, { service: PLATFORM_KEYCHAIN_SERVICE, account: PLATFORM_KEYCHAIN_ACCOUNT });
});
