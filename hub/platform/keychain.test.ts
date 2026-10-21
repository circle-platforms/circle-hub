import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PlatformError } from './errors.ts';
import { KEY_BYTES, keychainKeyProvider, keychainStore, SECURITY_TIMEOUT_MS } from './keychain.ts';
import { runCommand } from './process.ts';
import { exit, ok, recordingRunner, removeDir, tempDir, type Call } from './test-support.ts';

const HEX64 = /[0-9a-f]{64}/;

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
    await assert.rejects(keychainStore({ runner }).init(), /已有保险库主密钥.*不覆盖/);
    assert.ok(!calls.some((call) => call.args[0] === '-i'));
  });

  test('read never creates a key: a missing item is fatal, and so is any other error', async () => {
    const missing = recordingRunner(() => exit(44, 'The specified item could not be found in the keychain.'), { real: false });
    await assert.rejects(keychainStore({ runner: missing.runner }).read(), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /没有保险库主密钥/);
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
    const store = keychainStore({ runner, keychain, service: 'circle-hub-test', account: 'vault-master-key' });
    assert.deepEqual(await store.status(), { present: false });
    await assert.rejects(store.read(), /没有保险库主密钥/);
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
});
