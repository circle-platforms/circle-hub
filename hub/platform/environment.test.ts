import assert from 'node:assert/strict';
import { test } from 'node:test';
// Test-only read of hub/config's public entry: the platform keeps a copy of its list and must not drift from it.
import { HUB_ENVIRONMENT } from '../config/index.ts';
import { assertHubEnvironment, assertKnownHubVariables, HUB_CONFIG_VARIABLES, PLATFORM_VARIABLES, retiredEnvironmentKeys, unknownHubVariables, variable } from './environment.ts';
import { PlatformError } from './errors.ts';
import { OPERATOR_TOKEN_ITEM, VAULT_KEY_ITEM } from './keychain.ts';
import { DEFAULT_KEYCHAIN_ACCOUNT, DEFAULT_KEYCHAIN_SERVICE, OPERATOR_TOKEN_ACCOUNT } from './settings.ts';

test('retired CIRCLE_SERVER_* names refuse to start, even empty or beside the new name, naming keys only', () => {
  assert.deepEqual(retiredEnvironmentKeys({ CIRCLE_SERVER_PORT: '1', CIRCLE_HUB_PORT: '2', CIRCLE_SERVER_DATA_DIR: '' }), [
    'CIRCLE_SERVER_DATA_DIR',
    'CIRCLE_SERVER_PORT',
  ]);
  assert.throws(
    () => assertHubEnvironment({ CIRCLE_SERVER_DATABASE_CONFIG: 'secret-looking-value', CIRCLE_HUB_PORT: '7420' }),
    (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /不再读取 CIRCLE_SERVER_\*/);
      assert.match(error.hint ?? '', /CIRCLE_SERVER_DATABASE_CONFIG -> CIRCLE_HUB_DATABASE_CONFIG/);
      assert.doesNotMatch(`${error.message}${error.hint}`, /secret-looking-value/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertHubEnvironment({ CIRCLE_HUB_PORT: '7420', HOME: '/synthetic-homes/x' }));
});

test('variable treats empty as unset', () => {
  assert.equal(variable({ A: '' }, 'A'), undefined);
  assert.equal(variable({ A: 'x' }, 'A'), 'x');
  assert.equal(variable({}, 'A'), undefined);
});

test('the platform knows exactly the names hub/config reads, plus its own', () => {
  assert.deepEqual([...HUB_CONFIG_VARIABLES].sort(), Object.keys(HUB_ENVIRONMENT).sort());
  for (const name of Object.values(PLATFORM_VARIABLES)) assert.ok(HUB_CONFIG_VARIABLES.includes(name) || name === PLATFORM_VARIABLES.libpqBin, name);
});

test('hub/config describes the keychain names as the platform uses them: one service for both items, an account the vault master key may not use', () => {
  const service = HUB_ENVIRONMENT[PLATFORM_VARIABLES.keychainService];
  const account = HUB_ENVIRONMENT[PLATFORM_VARIABLES.keychainAccount];
  for (const text of [VAULT_KEY_ITEM.label, OPERATOR_TOKEN_ITEM.label, `账户 ${OPERATOR_TOKEN_ACCOUNT}`, `默认 ${DEFAULT_KEYCHAIN_SERVICE}`]) assert.ok(service.includes(text), `${text} in ${service}`);
  for (const text of [VAULT_KEY_ITEM.label, `默认 ${DEFAULT_KEYCHAIN_ACCOUNT}`, `${OPERATOR_TOKEN_ACCOUNT} 留给${OPERATOR_TOKEN_ITEM.label}`]) assert.ok(account.includes(text), `${text} in ${account}`);
});

test('a misspelled or unknown CIRCLE_HUB_* name is refused by name, with the list of real ones', () => {
  assert.deepEqual(unknownHubVariables({ CIRCLE_HUB_DATADIR: '/x', CIRCLE_HUB_HOME: '/y', CIRCLE_HUB_DATA_DIR: '/z', CIRCLE_HUB_LIBPQ_BIN: '/opt', PATH: '/bin' }), [
    'CIRCLE_HUB_DATADIR',
    'CIRCLE_HUB_HOME',
  ]);
  assert.throws(
    () => assertKnownHubVariables({ CIRCLE_HUB_DATADIR: '/scratch' }),
    (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /CIRCLE_HUB_DATADIR 不是 circle-hub 的配置项（可能拼错了），不执行/);
      assert.match(error.hint ?? '', /CIRCLE_HUB_DATA_DIR/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertKnownHubVariables({ CIRCLE_HUB_ADMIN_TOKEN_FILE: '/x' }, ['CIRCLE_HUB_ADMIN_TOKEN_FILE']), 'names the caller reads itself');
  assert.doesNotThrow(() => assertKnownHubVariables(Object.fromEntries(HUB_CONFIG_VARIABLES.map((name) => [name, 'x']))));
});
