import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, mock, test } from 'node:test';
import { createContext, keychainFor } from './context.ts';
import { PlatformError } from './errors.ts';
import {
  deploymentKeychainNames,
  KEY_BYTES,
  keychainKeyProvider,
  keychainStore,
  OPERATOR_TOKEN_ITEM,
  SECURITY_TIMEOUT_MS,
  VAULT_KEY_ITEM,
} from './keychain.ts';
import { ensureLayout, layoutAt } from './layout.ts';
import { runCommand, type CommandRunner } from './process.ts';
import { hubKeyProvider } from './service.ts';
import { newSettingsFile, OPERATOR_TOKEN_ACCOUNT, resolveSettings, settingsPath, writeSettingsFile } from './settings.ts';
import { exit, ok, recordingRunner, removeDir, tempDir, type Call } from './test-support.ts';

const HEX64 = /[0-9a-f]{64}/;

/** What each security call did: status (attributes only), read (-w), or the first argument (-i adds, delete-...). */
const kinds = (calls: readonly Call[]) =>
  calls.map((call) => (call.args[0] === 'find-generic-password' ? (call.args.includes('-w') ? 'read' : 'status') : call.args[0]));

/** A fake security tool holding generic-password items in memory, keyed by service and account, recording every call. */
function fakeSecurity(options: { onAdd?: (input: string) => { code: number; stderr: string } | undefined; tamper?: (hex: string) => string } = {}) {
  const items = new Map<string, string>();
  const keyOf = (args: readonly string[]) => `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
  return {
    items,
    ...recordingRunner(
      (call: Call) => {
        if (call.args[0] === '-i') {
          const input = call.options.input ?? '';
          const refused = options.onAdd?.(input);
          if (refused) return exit(refused.code, refused.stderr);
          const m = /^add-generic-password -s (\S+) -a (\S+) -w ([0-9a-f]{64})(?: "[^"]*")?\n$/.exec(input);
          if (m === null) return exit(1, 'bad command');
          if (items.has(`${m[1]}/${m[2]}`)) return exit(45, 'The specified item already exists in the keychain.');
          items.set(`${m[1]}/${m[2]}`, options.tamper ? options.tamper(m[3]!) : m[3]!);
          return ok();
        }
        if (call.args[0] === 'find-generic-password') {
          const value = items.get(keyOf(call.args));
          if (value === undefined) return exit(44, 'The specified item could not be found in the keychain.');
          return ok(call.args.includes('-w') ? `${value}\n` : 'keychain: "synthetic"\n');
        }
        return exit(1, 'unexpected');
      },
      { real: false },
    ),
  };
}

describe('keychain with a fake security tool', () => {
  test('init sends the key only through stdin of security -i and verifies it by reading back', async () => {
    let stored: string | undefined;
    const { runner, calls } = recordingRunner(
      (call: Call) => {
        if (call.args[0] === 'find-generic-password' && !call.args.includes('-w')) return stored ? ok() : exit(44, 'could not be found');
        if (call.args[0] === '-i') {
          stored = /-w ([0-9a-f]{64})/.exec(call.options.input ?? '')?.[1];
          return ok();
        }
        if (call.args[0] === 'find-generic-password') return stored ? ok(`${stored}\n`) : exit(44);
        return undefined;
      },
      { real: false },
    );
    const store = keychainStore({ runner, keychain: '/tmp/synthetic.keychain-db' });
    await store.init();
    assert.ok(stored && HEX64.test(stored));
    for (const call of calls) {
      assert.equal(call.command, '/usr/bin/security');
      assert.ok(!call.args.some((arg) => arg.includes(stored!)), 'the key never appears on a command line');
    }
    const add = calls.find((call) => call.args[0] === '-i');
    assert.match(add?.options.input ?? '', /^add-generic-password -s circle-hub -a vault-master-key -w [0-9a-f]{64} "\/tmp\/synthetic\.keychain-db"\n$/);
    const key = await store.read();
    assert.equal(key.length, KEY_BYTES);
    assert.equal(Buffer.from(key).toString('hex'), stored);
  });

  test('init refuses when a key exists and never writes', async () => {
    const { runner, calls } = recordingRunner((call) => (call.args[0] === 'find-generic-password' ? ok() : undefined), { real: false });
    await assert.rejects(keychainStore({ runner, item: VAULT_KEY_ITEM }).init(), /已有密钥库主密钥.*不覆盖/);
    assert.ok(!calls.some((call) => call.args[0] === '-i'));
  });

  test('read never creates a key: a missing item is fatal, and so is any other error', async () => {
    const missing = recordingRunner(() => exit(44, 'The specified item could not be found in the keychain.'), { real: false });
    await assert.rejects(keychainStore({ runner: missing.runner, item: VAULT_KEY_ITEM }).read(), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /没有密钥库主密钥/);
      assert.match(error.hint ?? '', /key init/);
      return true;
    });
    assert.ok(missing.calls.every((call) => call.args[0] === 'find-generic-password'));
    const locked = recordingRunner(() => exit(51, 'User interaction is not allowed.'), { real: false });
    await assert.rejects(keychainStore({ runner: locked.runner }).read(), /security 退出码 51/);
    const malformed = recordingRunner(() => ok('not-a-key\n'), { real: false });
    await assert.rejects(keychainStore({ runner: malformed.runner }).read(), /格式不对/);
  });

  test('every security call has a time limit, and a timeout (a locked keychain waiting for its dialog) says to unlock', async () => {
    let stored: string | undefined;
    const { runner, calls } = recordingRunner(
      (call: Call) => {
        if (call.args[0] === '-i') {
          stored = /-w ([0-9a-f]{64})/.exec(call.options.input ?? '')?.[1];
          return ok();
        }
        if (call.args[0] === 'find-generic-password') return stored ? ok(call.args.includes('-w') ? `${stored}\n` : '') : exit(44);
        if (call.args[0] === 'delete-generic-password') return ok();
        return undefined;
      },
      { real: false },
    );
    const store = keychainStore({ runner });
    await store.init();
    await store.status();
    await store.read();
    await store.delete();
    assert.ok(calls.length >= 5);
    for (const call of calls) assert.equal(call.options.timeoutMs, SECURITY_TIMEOUT_MS, call.args[0]);

    const locked = recordingRunner(() => exit(124, '\n超时（60000 毫秒）'), { real: false });
    for (const action of [() => keychainStore({ runner: locked.runner }).read(), () => keychainStore({ runner: locked.runner }).status()]) {
      await assert.rejects(action(), (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.match(error.message, /超时（60 秒没有结果）：默认钥匙串可能已锁定，正在等解锁/);
        assert.match(error.hint ?? '', /解锁钥匙串/);
        return true;
      });
    }
  });

  test('error text from security is scrubbed of anything shaped like a key', async () => {
    const leaked = randomBytes(32).toString('hex');
    const { runner } = recordingRunner(() => exit(1, `security: failed with ${leaked}`), { real: false });
    await assert.rejects(keychainStore({ runner }).status(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(leaked));
      assert.match(error.message, /已隐去/);
      return true;
    });
  });

  test('names with spaces or quotes are refused before any command runs', () => {
    assert.throws(() => keychainStore({ service: 'has space' }), /服务名/);
    assert.throws(() => keychainStore({ account: 'a"b' }), /账户名/);
    assert.throws(() => keychainStore({ keychain: 'relative.keychain' }), /绝对路径/);
    assert.throws(() => keychainStore({ keychain: '/tmp/a"b.keychain' }), /双引号/);
  });

  test('the key provider caches a successful read and retries after a failure', async () => {
    let reads = 0;
    let fail = true;
    const key = randomBytes(32).toString('hex');
    const { runner } = recordingRunner(
      () => {
        reads++;
        if (fail) return exit(51, 'locked');
        return ok(`${key}\n`);
      },
      { real: false },
    );
    const provider = keychainKeyProvider({ runner });
    await assert.rejects(provider.getKey(), /退出码 51/);
    fail = false;
    const first = await provider.getKey();
    const second = await provider.getKey();
    assert.equal(Buffer.from(first).toString('hex'), key);
    assert.deepEqual(first, second);
    first.fill(0);
    assert.equal(Buffer.from(await provider.getKey()).toString('hex'), key, 'callers get copies');
    assert.equal(reads, 2);
  });

  test('write stores the given 32 bytes through stdin of security -i only, in the form read returns, and leaves the value as it was', async () => {
    const security = fakeSecurity();
    const store = keychainStore({ runner: security.runner, service: 'circle-hub-test', account: OPERATOR_TOKEN_ACCOUNT, keychain: '/tmp/synthetic.keychain-db' });
    const value = randomBytes(KEY_BYTES);
    const copy = Buffer.from(value);
    await store.write(value);
    assert.deepEqual(Buffer.from(value), copy, 'the caller\'s bytes are not wiped');
    const hex = copy.toString('hex');
    assert.equal(security.items.get(`circle-hub-test/${OPERATOR_TOKEN_ACCOUNT}`), hex, 'stored as 64 hexadecimal characters');
    const adds = security.calls.filter((call) => call.args[0] === '-i');
    assert.equal(adds.length, 1);
    assert.equal(adds[0]?.options.input, `add-generic-password -s circle-hub-test -a ${OPERATOR_TOKEN_ACCOUNT} -w ${hex} "/tmp/synthetic.keychain-db"\n`);
    for (const call of security.calls) {
      assert.equal(call.command, '/usr/bin/security');
      assert.equal(call.options.timeoutMs, SECURITY_TIMEOUT_MS);
      assert.ok(!call.args.some((arg) => arg.includes(hex)), 'the value never appears on a command line');
    }
    // Order: does an item exist, add it, read it back.
    assert.deepEqual(kinds(security.calls), ['status', '-i', 'read']);
    assert.deepEqual(Buffer.from(await store.read()), copy);
  });

  test('write zeroes every copy of the value it made, the read-back included; the caller\'s bytes stay as they are', async () => {
    const security = fakeSecurity();
    const store = keychainStore({ runner: security.runner, account: OPERATOR_TOKEN_ACCOUNT });
    const value = randomBytes(KEY_BYTES);
    const kept = Buffer.from(value);
    // Every array the store makes passes through Buffer.from or Uint8Array.from, or shares memory with one that did; after
    // write none of them may still hold the value. The array the read-back returns is one of them.
    const buffers = mock.method(Buffer, 'from');
    const arrays = mock.method(Uint8Array, 'from');
    try {
      await store.write(value);
    } finally {
      buffers.mock.restore();
      arrays.mock.restore();
    }
    const made = (calls: readonly { result?: unknown }[]) =>
      calls.map((call) => call.result).filter((result): result is Uint8Array => result instanceof Uint8Array && result.length === KEY_BYTES);
    assert.ok(made(arrays.mock.calls).length >= 1, 'the array the read-back returned was seen');
    const copies = [...made(buffers.mock.calls), ...made(arrays.mock.calls)];
    assert.ok(copies.length >= 3, `the copy that was written, the decoded read-back and the array it returned (${copies.length})`);
    for (const copy of copies) assert.ok(copy.every((byte) => byte === 0), 'zeroed after use');
    assert.ok(Buffer.from(value).equals(kept), 'the caller\'s bytes are not wiped');
    assert.equal(security.items.get(`circle-hub/${OPERATOR_TOKEN_ACCOUNT}`), kept.toString('hex'), 'what was stored is the value');
  });

  test('write checks the bytes it writes, not what the value says about itself: a view that misreports its size is refused before any call', async () => {
    class Shorter extends Uint8Array {
      override get byteLength(): number {
        return KEY_BYTES;
      }
    }
    class Shortest extends Shorter {
      override get length(): number {
        return KEY_BYTES;
      }
    }
    const security = fakeSecurity();
    const store = keychainStore({ runner: security.runner, account: OPERATOR_TOKEN_ACCOUNT });
    for (const value of [new Shorter(2 * KEY_BYTES), new Shortest(2 * KEY_BYTES)]) {
      assert.equal(value.byteLength, KEY_BYTES, 'the view claims 32 bytes');
      await assert.rejects(store.write(value), /^PlatformError: 操作令牌必须正好是 32 字节（钥匙串项里存成 64 个十六进制字符），没有写入$/);
    }
    assert.deepEqual(security.calls, [], 'nothing reached security');
    assert.equal(security.items.size, 0);
  });

  test('write refuses an existing item without writing, and a value of any other size before any call', async () => {
    const security = fakeSecurity();
    const store = keychainStore({ runner: security.runner, account: OPERATOR_TOKEN_ACCOUNT });
    await store.write(randomBytes(KEY_BYTES));
    const before = security.items.get(`circle-hub/${OPERATOR_TOKEN_ACCOUNT}`);
    const calls = security.calls.length;
    await assert.rejects(store.write(randomBytes(KEY_BYTES)), /^PlatformError: 默认钥匙串里已有操作令牌（服务 circle-hub，账户 operator-token），不覆盖$/);
    assert.ok(!security.calls.slice(calls).some((call) => call.args[0] === '-i'), 'an existing item is never written over');
    assert.equal(security.items.get(`circle-hub/${OPERATOR_TOKEN_ACCOUNT}`), before);
    const fresh = fakeSecurity();
    for (const size of [0, 16, 31, 33, 64]) {
      await assert.rejects(keychainStore({ runner: fresh.runner, item: VAULT_KEY_ITEM }).write(new Uint8Array(size)), /^PlatformError: 密钥库主密钥必须正好是 32 字节（钥匙串项里存成 64 个十六进制字符），没有写入$/, String(size));
    }
    await assert.rejects(keychainStore({ runner: fresh.runner }).write('a'.repeat(32) as unknown as Uint8Array), /^PlatformError: 钥匙串项必须正好是 32 字节/);
    assert.deepEqual(fresh.calls, [], 'nothing reached security');
  });

  test('write reports a refused add (an item that appeared meanwhile) without the value, and checks the read-back', async () => {
    const value = randomBytes(KEY_BYTES);
    const hex = value.toString('hex');
    // Another process added the item between the check and the add: security refuses the duplicate (no -U).
    const raced = fakeSecurity({ onAdd: (input) => ({ code: 45, stderr: `security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain. ${input}` }) });
    await assert.rejects(keychainStore({ runner: raced.runner, account: OPERATOR_TOKEN_ACCOUNT }).write(value), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /^写入操作令牌失败（security 退出码 45）：.*already exists/);
      assert.ok(!error.message.includes(hex), error.message);
      return true;
    });
    assert.deepEqual(kinds(raced.calls), ['status', '-i'], 'the check, then the refused add; nothing is read back or retried');
    assert.equal(raced.items.size, 0);
    const tampered = fakeSecurity({ tamper: (stored) => `${stored.slice(0, 63)}${stored.endsWith('0') ? '1' : '0'}` });
    await assert.rejects(keychainStore({ runner: tampered.runner }).write(value), /^PlatformError: 写入钥匙串后读回的钥匙串项与写入的不一致$/);
    // security said yes but the item is not there.
    const lost = recordingRunner((call) => (call.args[0] === '-i' ? ok() : exit(44, 'The specified item could not be found in the keychain.')), { real: false });
    await assert.rejects(keychainStore({ runner: lost.runner, account: OPERATOR_TOKEN_ACCOUNT }).write(value), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.message, '写入操作令牌后读不回来：默认钥匙串里没有操作令牌（服务 circle-hub，账户 operator-token）');
      assert.equal(error.hint, '检查钥匙串里这个项');
      return true;
    });
  });

  test('messages name the item: the one given, the operator token for its account, otherwise nothing in particular and no advice', async () => {
    const missing = recordingRunner(() => exit(44, 'The specified item could not be found in the keychain.'), { real: false });
    await assert.rejects(keychainStore({ runner: missing.runner, service: 'circle-hub-test', account: OPERATOR_TOKEN_ACCOUNT }).read(), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.message, '默认钥匙串里没有操作令牌（服务 circle-hub-test，账户 operator-token）');
      assert.equal(error.hint, undefined, 'the vault key\'s remedy (key init) is not the token\'s');
      return true;
    });
    // Any other account without an item: neither the vault master key's name nor its advice.
    for (const account of ['some-other-item', 'vault-master-key']) {
      await assert.rejects(keychainStore({ runner: missing.runner, account }).read(), (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.message, `默认钥匙串里没有钥匙串项（服务 circle-hub，账户 ${account}）`);
        assert.equal(error.hint, undefined, 'no key init advice for an item that may not be the vault key');
        return true;
      });
    }
    await assert.rejects(keychainStore({ runner: missing.runner, account: 'vault-key-b', item: VAULT_KEY_ITEM }).read(), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.message, '默认钥匙串里没有密钥库主密钥（服务 circle-hub，账户 vault-key-b）');
      assert.equal(error.hint, VAULT_KEY_ITEM.missingHint);
      return true;
    });
    const named = { label: '合成项', missingHint: '合成的下一步' };
    await assert.rejects(keychainStore({ runner: missing.runner, account: OPERATOR_TOKEN_ACCOUNT, item: named }).read(), (error: unknown) => {
      assert.match((error as Error).message, /里没有合成项/);
      assert.equal((error as PlatformError).hint, '合成的下一步');
      return true;
    });
    const locked = recordingRunner(() => exit(51, 'User interaction is not allowed.'), { real: false });
    const token = keychainStore({ runner: locked.runner, account: OPERATOR_TOKEN_ACCOUNT });
    await assert.rejects(token.read(), /^PlatformError: 读取操作令牌失败（security 退出码 51）：User interaction is not allowed\.$/);
    await assert.rejects(token.delete(), /^PlatformError: 删除操作令牌失败（security 退出码 51）/);
    await assert.rejects(token.status(), /^PlatformError: 查询钥匙串失败（security 退出码 51）/);
    const slow = recordingRunner(() => exit(124, '\n超时（60000 毫秒）'), { real: false });
    await assert.rejects(keychainStore({ runner: slow.runner, account: OPERATOR_TOKEN_ACCOUNT }).read(), /^PlatformError: 读取操作令牌超时（60 秒没有结果）：默认钥匙串可能已锁定，正在等解锁$/);
    const malformed = recordingRunner(() => ok('not-a-token\n'), { real: false });
    await assert.rejects(keychainStore({ runner: malformed.runner, account: OPERATOR_TOKEN_ACCOUNT }).read(), /^PlatformError: 默认钥匙串里的操作令牌格式不对/);
    // The vault master key keeps its wording and its hints where it is meant: VAULT_KEY_ITEM, and the key provider.
    const present = recordingRunner(() => ok(), { real: false });
    await assert.rejects(keychainStore({ runner: present.runner, item: VAULT_KEY_ITEM }).init(), (error: unknown) => {
      assert.equal((error as Error).message, '默认钥匙串里已有密钥库主密钥（服务 circle-hub，账户 vault-master-key），不覆盖');
      assert.equal((error as PlatformError).hint, VAULT_KEY_ITEM.keepHint);
      return true;
    });
    await assert.rejects(keychainStore({ runner: present.runner }).init(), (error: unknown) => {
      assert.equal((error as Error).message, '默认钥匙串里已有钥匙串项（服务 circle-hub，账户 vault-master-key），不覆盖');
      assert.equal((error as PlatformError).hint, undefined);
      return true;
    });
    await assert.rejects(keychainKeyProvider({ runner: missing.runner, account: 'vault-key-b' }).getKey(), /^PlatformError: 默认钥匙串里没有密钥库主密钥（服务 circle-hub，账户 vault-key-b）$/);
    // The design standard's term for the vault (docs/design/object-standard.md: 密钥库条目).
    assert.equal(VAULT_KEY_ITEM.label, '密钥库主密钥');
    assert.match(VAULT_KEY_ITEM.keepHint ?? '', /密钥库条目/);
    assert.equal(OPERATOR_TOKEN_ITEM.label, '操作令牌');
    assert.equal(OPERATOR_TOKEN_ITEM.missingHint, undefined);
  });

  test('the vault master key is never the operator token\'s item: a key provider or a vault key store on its account is refused before any call', async () => {
    const { runner, calls } = recordingRunner(() => ok(`${randomBytes(KEY_BYTES).toString('hex')}\n`), { real: false });
    const refused = (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /^钥匙串账户 operator-token 留给操作令牌，密钥库主密钥不能用它（服务 circle-hub(-test)?）：两者会成为同一个钥匙串项，不执行$/);
      assert.match(error.hint ?? '', /给密钥库主密钥另选一个账户（默认 vault-master-key）/);
      return true;
    };
    assert.throws(() => keychainKeyProvider({ runner, account: OPERATOR_TOKEN_ACCOUNT }), refused);
    assert.throws(() => keychainKeyProvider({ runner, service: 'circle-hub-test', account: OPERATOR_TOKEN_ACCOUNT, item: { label: '合成项' } }), refused, 'whatever it is called, the provider reads the vault key');
    assert.throws(() => keychainStore({ runner, account: OPERATOR_TOKEN_ACCOUNT, item: VAULT_KEY_ITEM }), refused);
    assert.deepEqual(calls, [], 'the keychain was not asked');
    // The operator token's own store on its account is unchanged.
    assert.deepEqual(await keychainStore({ runner, account: OPERATOR_TOKEN_ACCOUNT }).status(), { present: true });
    assert.deepEqual(await keychainStore({ runner, account: OPERATOR_TOKEN_ACCOUNT, item: OPERATOR_TOKEN_ITEM }).status(), { present: true });
  });
});

describe('the keychain names of a deployment', () => {
  const roots: string[] = [];
  after(async () => {
    for (const root of roots) await removeDir(root);
  });

  async function deployment(input: Parameters<typeof newSettingsFile>[0]): Promise<string> {
    const root = await tempDir();
    roots.push(root);
    const layout = layoutAt(root);
    await ensureLayout(layout);
    await writeSettingsFile(layout, newSettingsFile(input));
    return root;
  }

  test('come from the deployment settings of the data root, the operator token beside the vault master key', async () => {
    const root = await deployment({ environment: 'test', keychainService: 'circle-hub-b', keychainAccount: 'key-b' });
    const names = await deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_KEYCHAIN_SERVICE: 'circle-hub-b' });
    assert.deepEqual(names, {
      vaultKey: { service: 'circle-hub-b', account: 'key-b', item: VAULT_KEY_ITEM },
      operatorToken: { service: 'circle-hub-b', account: OPERATOR_TOKEN_ACCOUNT, item: OPERATOR_TOKEN_ITEM },
    });
    // A shell variable that disagrees is refused, as every platform command refuses it.
    await assert.rejects(deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_KEYCHAIN_SERVICE: 'circle-hub' }), /CIRCLE_HUB_KEYCHAIN_SERVICE 是 circle-hub，部署设置里是 circle-hub-b/);
    await assert.rejects(deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: root, CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'dev-key' }), /CIRCLE_HUB_KEYCHAIN_ACCOUNT 是 dev-key，部署设置里是 key-b/);
    // hubKeyProvider asks for exactly the vault key item the resolver names.
    const key = randomBytes(32).toString('hex');
    const { runner, calls } = recordingRunner(() => ok(`${key}\n`), { real: false });
    await hubKeyProvider({ CIRCLE_HUB_DATA_DIR: root }, { runner }).getKey();
    assert.deepEqual(calls[0]?.args, ['find-generic-password', '-s', names.vaultKey.service, '-a', names.vaultKey.account, '-w']);
  });

  test('a data root without settings: the variables, else the defaults; without a data root nothing is guessed', async () => {
    const operatorToken = (service: string) => ({ service, account: OPERATOR_TOKEN_ACCOUNT, item: OPERATOR_TOKEN_ITEM });
    // A development data root without settings (as hub/testing makes them).
    const plain = await tempDir();
    roots.push(plain);
    assert.deepEqual(await deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: plain }), {
      vaultKey: { service: 'circle-hub', account: 'vault-master-key', item: VAULT_KEY_ITEM },
      operatorToken: operatorToken('circle-hub'),
    });
    assert.deepEqual(await deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: plain, CIRCLE_HUB_KEYCHAIN_SERVICE: 'hub-x', CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'key-x' }), {
      vaultKey: { service: 'hub-x', account: 'key-x', item: VAULT_KEY_ITEM },
      operatorToken: operatorToken('hub-x'),
    });
    assert.deepEqual((await deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: plain, CIRCLE_HUB_KEYCHAIN_SERVICE: 'circle-hub-rehearsal' })).operatorToken, operatorToken('circle-hub-rehearsal'));
    for (const [name, value] of [
      ['CIRCLE_HUB_KEYCHAIN_SERVICE', 'has space'],
      ['CIRCLE_HUB_KEYCHAIN_ACCOUNT', 'a"b'],
      ['CIRCLE_HUB_KEYCHAIN_SERVICE', 'x'.repeat(65)],
    ] as const) {
      await assert.rejects(deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: plain, [name]: value }), (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.message, `${name} 的写法不对：钥匙串名只能含字母、数字、点、下划线和连字符，最长 64 个字符`);
        return true;
      });
    }
    await assert.rejects(deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: 'relative/root' }), /绝对路径/);
    // Unset or empty: platform commands would act on the default data root, whose settings may name other items; the
    // server's configuration requires the variable. Neither the default root nor the variables are taken.
    for (const env of [{}, { CIRCLE_HUB_DATA_DIR: '' }, { CIRCLE_HUB_KEYCHAIN_SERVICE: 'hub-x', CIRCLE_HUB_KEYCHAIN_ACCOUNT: 'key-x' }]) {
      await assert.rejects(deploymentKeychainNames(env), (error: unknown) => {
        assert.ok(error instanceof PlatformError);
        assert.equal(error.message, '没有设置 CIRCLE_HUB_DATA_DIR：钥匙串项由部署的数据根里的部署设置决定，不猜默认数据根', JSON.stringify(env));
        assert.match(error.hint ?? '', /circle-hub service install/);
        return true;
      });
    }
  });

  test('the vault master key may not use the operator token\'s account: not in a variable, not in a settings file, not at init', async () => {
    const plain = await tempDir();
    roots.push(plain);
    await assert.rejects(deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: plain, CIRCLE_HUB_KEYCHAIN_ACCOUNT: OPERATOR_TOKEN_ACCOUNT }), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /^CIRCLE_HUB_KEYCHAIN_ACCOUNT 是 operator-token：这个账户留给操作令牌，密钥库主密钥用它就和操作令牌成了同一个钥匙串项，不执行$/);
      assert.match(error.hint ?? '', /另选一个名字，或删掉它（默认 vault-master-key）/);
      return true;
    });
    assert.throws(() => newSettingsFile({ environment: 'test', keychainAccount: OPERATOR_TOKEN_ACCOUNT }), /字段：keychain_account）：账户 operator-token 留给操作令牌，密钥库主密钥不能用它/);
    // A file edited by hand (or written by an earlier platform version) is refused where the keychain is used.
    const root = await deployment({ environment: 'test' });
    const layout = layoutAt(root);
    const file = { ...newSettingsFile({ environment: 'test' }), keychain_account: OPERATOR_TOKEN_ACCOUNT };
    await writeFile(settingsPath(layout), JSON.stringify(file));
    await assert.rejects(deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: root }), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.equal(error.message, `部署设置（${settingsPath(layout)}）里密钥库主密钥的钥匙串账户是 operator-token：这个账户留给操作令牌，两者会成为同一个钥匙串项，不执行`);
      assert.match(error.hint ?? '', /把部署设置里的 keychain_account 改成另一个名字（例如 vault-master-key）；钥匙串里已有这个账户的密钥库主密钥时/);
      return true;
    });
    const { runner, calls } = recordingRunner(() => ok(), { real: false });
    await assert.rejects(hubKeyProvider({ CIRCLE_HUB_DATA_DIR: root }, { runner }).getKey(), /留给操作令牌/);
    // The platform's own key init, key status and status use the same rule.
    const context = createContext({ CIRCLE_HUB_DATA_DIR: root }, { runner });
    assert.throws(() => keychainFor(context, resolveSettings(file, {}, layout)), /密钥库主密钥的钥匙串账户是 operator-token/);
    assert.deepEqual(calls, [], 'the keychain was not asked');
  });
});

async function securityAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await access('/usr/bin/security');
    return true;
  } catch {
    return false;
  }
}

describe('keychain against a temporary keychain file', { skip: (await securityAvailable()) ? false : 'skipped: /usr/bin/security is only on macOS' }, () => {
  let dir: string;
  let keychain: string;
  const password = randomBytes(16).toString('hex');

  before(async () => {
    dir = await tempDir('chk-');
    keychain = join(dir, 'synthetic.keychain-db');
    // Throwaway keychain with a throwaway password; it is not on the user's search list and is deleted afterwards.
    for (const args of [
      ['create-keychain', '-p', password, keychain],
      ['unlock-keychain', '-p', password, keychain],
      ['set-keychain-settings', keychain],
    ]) {
      const result = await runCommand('/usr/bin/security', args);
      assert.equal(result.code, 0, result.stderr);
    }
  });

  after(async () => {
    if (keychain) await runCommand('/usr/bin/security', ['delete-keychain', keychain]);
    if (dir) await removeDir(dir);
  });

  test('init, status, read, refuse a second init, delete', async () => {
    const { runner, calls } = recordingRunner(undefined, { keychain });
    const store = keychainStore({ runner, keychain, service: 'circle-hub-test', account: 'vault-master-key', item: VAULT_KEY_ITEM });
    assert.deepEqual(await store.status(), { present: false });
    await assert.rejects(store.read(), /没有密钥库主密钥/);
    assert.deepEqual(await store.status(), { present: false }, 'a failed read does not create a key');
    await store.init();
    assert.deepEqual(await store.status(), { present: true });
    const key = await store.read();
    assert.equal(key.length, KEY_BYTES);
    const hex = Buffer.from(key).toString('hex');
    await assert.rejects(store.init(), /不覆盖/);
    assert.equal(Buffer.from(await store.read()).toString('hex'), hex, 'the refused init left the key unchanged');
    for (const call of calls) assert.ok(!call.args.some((arg) => arg.includes(hex)), 'the key is never on a command line');
    const provider = keychainKeyProvider({ runner, keychain, service: 'circle-hub-test' });
    assert.equal(Buffer.from(await provider.getKey()).toString('hex'), hex);
    await assert.rejects(provider.initKey(), /不覆盖/, 'the provider never replaces a key either');
    assert.equal(await store.delete(), true);
    await provider.initKey();
    assert.deepEqual(await store.status(), { present: true }, 'initKey creates one explicitly');
    assert.equal(await store.delete(), true);
    assert.equal(await store.delete(), false);
    assert.deepEqual(await store.status(), { present: false });
  });

  test('write stores a given value beside the vault master key, refuses a second write, and read returns it', async () => {
    const { runner, calls } = recordingRunner(undefined, { keychain });
    // dir has no deployment settings: the names come from the variable.
    const names = await deploymentKeychainNames({ CIRCLE_HUB_DATA_DIR: dir, CIRCLE_HUB_KEYCHAIN_SERVICE: 'circle-hub-test-w' });
    const vault = keychainStore({ ...names.vaultKey, runner, keychain });
    const token = keychainStore({ ...names.operatorToken, runner, keychain });
    await vault.init();
    assert.deepEqual(await token.status(), { present: false }, 'two items under one service');
    const value = randomBytes(KEY_BYTES);
    const hex = value.toString('hex');
    await token.write(value);
    assert.equal(Buffer.from(await token.read()).toString('hex'), hex);
    await assert.rejects(token.write(randomBytes(KEY_BYTES)), /已有操作令牌（服务 circle-hub-test-w，账户 operator-token），不覆盖/);
    assert.equal(Buffer.from(await token.read()).toString('hex'), hex, 'the refused write left the item unchanged');
    assert.notEqual(Buffer.from(await vault.read()).toString('hex'), hex, 'the vault master key is its own item');
    for (const call of calls) assert.ok(!call.args.some((arg) => arg.includes(hex)), 'the value is never on a command line');
    assert.equal(await token.delete(), true);
    assert.equal(await vault.delete(), true);
  });

  test('the real security tool refuses an add over an existing item: a write that lost a race fails with 45 and the first value stays', async () => {
    const service = 'circle-hub-test-race';
    const plain = recordingRunner(undefined, { keychain });
    const token = keychainStore({ runner: plain.runner, keychain, service, account: OPERATOR_TOKEN_ACCOUNT });
    const first = randomBytes(KEY_BYTES);
    const hex = first.toString('hex');
    await token.write(first);
    // Another writer's item appears right after the check: the check answers "not found" once, then security runs for real.
    let checked = false;
    const raced = recordingRunner(
      (call: Call) => {
        if (checked || call.args[0] !== 'find-generic-password' || call.args.includes('-w')) return undefined;
        checked = true;
        return exit(44, 'The specified item could not be found in the keychain.');
      },
      { keychain },
    );
    const second = randomBytes(KEY_BYTES);
    await assert.rejects(keychainStore({ runner: raced.runner, keychain, service, account: OPERATOR_TOKEN_ACCOUNT }).write(second), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /^写入操作令牌失败（security 退出码 45）：.*already exists/);
      assert.ok(!error.message.includes(second.toString('hex')) && !error.message.includes(hex), error.message);
      return true;
    });
    assert.deepEqual(kinds(raced.calls), ['status', '-i'], 'the real add ran once, without -U; nothing was read back or retried');
    assert.equal(Buffer.from(await token.read()).toString('hex'), hex, 'the item still holds the first value');
    assert.equal(await token.delete(), true);
  });
});
