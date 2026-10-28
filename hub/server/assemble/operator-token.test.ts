// The operator token store and the secret input: the keychain item written only through stdin of `security -i` and read
// back through hub/platform keychainStore (a fake security tool records every call; the real keychain is never touched),
// its errors naming the operator token, its keychain service resolved as the vault master key's, the token form,
// CIRCLE_HUB_TOKEN taken out of the environment, and secrets read from a pipe or a terminal without echo (special keys,
// characters split across reads, a terminal that closes).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { OPERATOR_TOKEN_ITEM, SETTINGS_SCHEMA, VAULT_KEY_ITEM, layoutAt, type CommandRunner } from '../../platform/api.ts';
import { removeTree } from './files.ts';
import {
  OPERATOR_TOKEN_ACCOUNT,
  OPERATOR_TOKEN_VARIABLE,
  OperatorTokenError,
  deploymentKeychainService,
  fileOperatorTokens,
  keychainOperatorTokens,
  memoryOperatorTokens,
  runTool,
  takeEnvironmentToken,
  tokenBytes,
} from './operator-token.ts';
import { MAX_SECRET_BYTES, readSecret } from './secret-input.ts';

const newToken = (): string => randomBytes(32).toString('base64url');

test('Linux operator token is private, distinct from the vault key, and never overwritten', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hub-operator-file-'));
  t.after(() => removeTree(root));
  const store = fileOperatorTokens(root, 'synthetic');
  const token = newToken();
  assert.equal(await store.present(), false);
  assert.equal(await store.read(), null);
  await store.write(token);
  assert.equal(await store.read(), token);
  await assert.rejects(store.write(newToken()), /不覆盖/);
  await assert.rejects(store.write('invalid'), /不是 Hub 签发的格式/);
});

/** A fake security tool holding generic-password items in memory, recording every call (arguments and stdin). */
function fakeKeychain(options: { failAdd?: { code: number; stderr: string }; lockedRead?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: { args: string[]; input: string }[] = [];
  const keyOf = (args: readonly string[]) => `${args[args.indexOf('-s') + 1]}/${args[args.indexOf('-a') + 1]}`;
  const runner: CommandRunner = async (_command, args, opts = {}) => {
    calls.push({ args: [...args], input: opts.input ?? '' });
    if (args[0] === '-i') {
      if (options.failAdd) return { code: options.failAdd.code, stdout: '', stderr: options.failAdd.stderr };
      const m = /^add-generic-password -s (\S+) -a (\S+) -w ([0-9a-f]{64})(?: "[^"]*")?\n$/.exec(opts.input ?? '');
      if (m === null) return { code: 1, stdout: '', stderr: 'bad command' };
      items.set(`${m[1]}/${m[2]}`, m[3]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'find-generic-password') {
      if (options.lockedRead && args.includes('-w')) return { code: 51, stdout: '', stderr: 'User interaction is not allowed.' };
      const value = items.get(keyOf(args));
      if (value === undefined) return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
      return { code: 0, stdout: args.includes('-w') ? `${value}\n` : 'keychain: "synthetic"\n', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { runner, calls, items };
}

describe('the operator token in the keychain', () => {
  test('init writes the token only through stdin of security -i, never on a command line, and reads it back', async () => {
    const keychain = fakeKeychain();
    const store = keychainOperatorTokens({ service: 'circle-hub-test', keychain: '/tmp/synthetic-test.keychain-db', runner: keychain.runner });
    assert.match(store.where, /服务 circle-hub-test，账户 operator-token/);
    assert.equal(await store.present(), false);
    assert.equal(await store.read(), null);
    const token = newToken();
    await store.write(token);
    const hex = Buffer.from(token, 'base64url').toString('hex');
    for (const call of keychain.calls) {
      assert.ok(!call.args.some((arg) => arg.includes(token) || arg.includes(hex)), 'neither the token nor its bytes appear in arguments');
    }
    const add = keychain.calls.filter((call) => call.args[0] === '-i');
    assert.equal(add.length, 1);
    assert.equal(add[0].input, `add-generic-password -s circle-hub-test -a ${OPERATOR_TOKEN_ACCOUNT} -w ${hex} "/tmp/synthetic-test.keychain-db"\n`);
    assert.equal(await store.present(), true);
    assert.equal(await store.read(), token, 'read through hub/platform keychainStore');
    const before = keychain.calls.length;
    await assert.rejects(store.write(newToken()), /已经有操作令牌，不覆盖/);
    assert.ok(!keychain.calls.slice(before).some((call) => call.args[0] === '-i'), 'an existing item is never overwritten');
  });

  test('a failing write says why without the token or its bytes; a locked keychain is reported on read', async () => {
    const token = newToken();
    const hex = Buffer.from(token, 'base64url').toString('hex');
    const failing = fakeKeychain({ failAdd: { code: 45, stderr: `add-generic-password -w ${hex}: The user name or passphrase you entered is not correct. ${token}` } });
    const store = keychainOperatorTokens({ service: 'circle-hub-test', runner: failing.runner });
    await assert.rejects(store.write(token), (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /security 退出码 45/);
      assert.ok(!message.includes(hex) && !message.includes(token), message);
      return true;
    });
    const locked = fakeKeychain({ lockedRead: true });
    locked.items.set(`circle-hub-test/${OPERATOR_TOKEN_ACCOUNT}`, hex);
    await assert.rejects(keychainOperatorTokens({ service: 'circle-hub-test', runner: locked.runner }).read(), /退出码 51/);
    await assert.rejects(keychainOperatorTokens({ service: 'circle-hub-test', runner: failing.runner }).write('not-a-hub-token'), /不是 Hub 签发的格式/);
  });

  test('errors of the item name the operator token, never the vault master key, and never advise key init', async () => {
    const hex = Buffer.from(newToken(), 'base64url').toString('hex');
    const locked = fakeKeychain({ lockedRead: true });
    locked.items.set(`circle-hub-test/${OPERATOR_TOKEN_ACCOUNT}`, hex);
    await assert.rejects(keychainOperatorTokens({ service: 'circle-hub-test', runner: locked.runner }).read(), (error: unknown) => {
      assert.ok(error instanceof OperatorTokenError);
      assert.equal(error.message, '读取操作令牌失败（security 退出码 51）：User interaction is not allowed.');
      return true;
    });
    // An item that went away between the two calls: the platform names the item it was given (OPERATOR_TOKEN_ITEM) and
    // gives none of the vault master key's advice.
    let calls = 0;
    const vanishing: CommandRunner = async (_command, args) => {
      calls += 1;
      if (args[0] === 'find-generic-password' && !args.includes('-w')) return { code: 0, stdout: 'keychain: "synthetic"\n', stderr: '' };
      return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
    };
    await assert.rejects(keychainOperatorTokens({ service: 'circle-hub-test', runner: vanishing }).read(), (error: unknown) => {
      assert.ok(error instanceof OperatorTokenError);
      assert.equal(error.message, `默认钥匙串里没有${OPERATOR_TOKEN_ITEM.label}（服务 circle-hub-test，账户 operator-token）`);
      assert.equal(error.hint, null, 'the vault key\'s remedy (key init) is not offered for the token');
      assert.ok(!error.message.includes(VAULT_KEY_ITEM.label));
      return true;
    });
    assert.equal(calls, 2);
    // Another account (a test or a second item) is still named as the operator token, never as a nameless item.
    await assert.rejects(keychainOperatorTokens({ service: 'circle-hub-test', account: 'operator-token-2', runner: vanishing }).read(), (error: unknown) => {
      assert.equal((error as Error).message, `默认钥匙串里没有${OPERATOR_TOKEN_ITEM.label}（服务 circle-hub-test，账户 operator-token-2）`);
      return true;
    });
    const unreadable: CommandRunner = async () => ({ code: 25, stdout: '', stderr: 'synthetic failure' });
    await assert.rejects(keychainOperatorTokens({ service: 'circle-hub-test', runner: unreadable }).present(), /^OperatorTokenError: 查询钥匙串失败（security 退出码 25）：synthetic failure$/);
  });

  test('the token form, the memory store, and CIRCLE_HUB_TOKEN taken out of the environment', async () => {
    const token = newToken();
    assert.equal(tokenBytes(token)?.length, 32);
    for (const bad of ['', 'short', `${token}=`, `${token.slice(0, 42)}+`, token.slice(1)]) assert.equal(tokenBytes(bad), null, bad);
    const memory = memoryOperatorTokens();
    await memory.write(token);
    assert.equal(await memory.read(), token);
    await assert.rejects(memory.write(newToken()), /不覆盖/);
    const env: NodeJS.ProcessEnv = { [OPERATOR_TOKEN_VARIABLE]: token, OTHER: 'x' };
    assert.equal(takeEnvironmentToken(env), token);
    assert.equal(Object.hasOwn(env, OPERATOR_TOKEN_VARIABLE), false, 'removed, so the configuration check never sees it');
    assert.equal(env.OTHER, 'x');
    const empty: NodeJS.ProcessEnv = { [OPERATOR_TOKEN_VARIABLE]: '' };
    assert.equal(takeEnvironmentToken(empty), null);
    assert.equal(Object.hasOwn(empty, OPERATOR_TOKEN_VARIABLE), false);
    assert.equal(takeEnvironmentToken({}), null);
  });
});

describe('the keychain service of the operator token', () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'circle-hub-settings-'));
  });
  after(async () => {
    if (root) await removeTree(root);
  });

  const settings = (service: string) => ({
    schema: SETTINGS_SCHEMA,
    environment: 'shared',
    port: 7431,
    keychain_service: service,
    keychain_account: 'vault',
    database: { name: 'circle_hub', role: 'circle_hub', socket_port: 5432 },
    backups_keep: 7,
  });

  test('is the deployment settings\' of the data root, as for the vault master key; without settings the configuration\'s', async () => {
    const data = join(root, 'b');
    await mkdir(layoutAt(data).config, { recursive: true });
    await writeFile(join(layoutAt(data).config, 'platform.json'), JSON.stringify(settings('circle-hub-b')));
    // A shell that sets only the data root: the settings decide, not hub/config's default.
    assert.equal(await deploymentKeychainService({ CIRCLE_HUB_DATA_DIR: data }, 'circle-hub'), 'circle-hub-b');
    assert.equal(await deploymentKeychainService({ CIRCLE_HUB_DATA_DIR: data, CIRCLE_HUB_KEYCHAIN_SERVICE: 'circle-hub-b' }, 'circle-hub-b'), 'circle-hub-b');
    // A variable that disagrees is refused there, as every platform command refuses it.
    await assert.rejects(deploymentKeychainService({ CIRCLE_HUB_DATA_DIR: data, CIRCLE_HUB_KEYCHAIN_SERVICE: 'circle-hub' }, 'circle-hub'), /CIRCLE_HUB_KEYCHAIN_SERVICE 是 circle-hub，部署设置里是 circle-hub-b/);
    // No settings file (a development data root) or no data root: the configuration's service.
    assert.equal(await deploymentKeychainService({ CIRCLE_HUB_DATA_DIR: join(root, 'plain') }, 'circle-hub-rehearsal'), 'circle-hub-rehearsal');
    assert.equal(await deploymentKeychainService({}, 'circle-hub'), 'circle-hub');
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

describe('the operator token in a temporary keychain file', { skip: (await securityAvailable()) ? false : 'skipped: /usr/bin/security is only on macOS' }, () => {
  let dir: string;
  let keychain: string;
  const password = randomBytes(16).toString('hex');
  const calls: { args: string[]; input: string }[] = [];
  /** Runs the real security tool, but only for calls that name the temporary keychain (never the user's default one). */
  const guarded: CommandRunner = async (command, args, options = {}) => {
    const input = options.input ?? '';
    const targeted = basename(command) === 'security' && (args.at(-1) === keychain || (args[0] === '-i' && input.trimEnd().endsWith(`"${keychain}"`)));
    if (!targeted) throw new Error(`test tried to use another keychain: ${command} ${args[0]}`);
    calls.push({ args: [...args], input });
    return runTool(command, args, options);
  };

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chk-'));
    keychain = join(dir, 'synthetic.keychain-db');
    // A throwaway keychain with a throwaway password; not on the user's search list, deleted afterwards.
    for (const args of [
      ['create-keychain', '-p', password, keychain],
      ['unlock-keychain', '-p', password, keychain],
      ['set-keychain-settings', keychain],
    ]) {
      const result = await runTool('/usr/bin/security', args);
      assert.equal(result.code, 0, result.stderr);
    }
  });

  after(async () => {
    if (keychain) await runTool('/usr/bin/security', ['delete-keychain', keychain]).catch(() => {});
    if (dir) await removeTree(dir);
  });

  test('the real security tool stores the token through stdin and keychainStore reads it back', async () => {
    const store = keychainOperatorTokens({ service: 'circle-hub-test', keychain, runner: guarded });
    assert.equal(await store.present(), false);
    assert.equal(await store.read(), null);
    const token = randomBytes(32).toString('base64url');
    await store.write(token);
    assert.equal(await store.present(), true);
    assert.equal(await store.read(), token);
    await assert.rejects(store.write(randomBytes(32).toString('base64url')), /不覆盖/);
    assert.equal(await store.read(), token, 'the refused write left the item unchanged');
    const hex = Buffer.from(token, 'base64url').toString('hex');
    for (const call of calls) assert.ok(!call.args.some((arg) => arg.includes(hex) || arg.includes(token)), 'the token is never on a command line');
    assert.equal(calls.filter((call) => call.args[0] === '-i').length, 1);
  });
});

/** A fake terminal: a readable stream with isTTY and setRawMode, typed by the test. */
function fakeTerminal() {
  const emitter = new EventEmitter() as EventEmitter & { isTTY: boolean; setRawMode: (mode: boolean) => void; resume: () => void; pause: () => void; raw: boolean[] };
  emitter.isTTY = true;
  emitter.raw = [];
  emitter.setRawMode = (mode) => void emitter.raw.push(mode);
  emitter.resume = () => {};
  emitter.pause = () => {};
  return emitter;
}

describe('secret input', () => {
  test('from a pipe the whole input is the value, without one trailing line break', async () => {
    assert.equal(await readSecret('x', { input: Readable.from([Buffer.from('s3cret-Value\n')]) }), 's3cret-Value');
    assert.equal(await readSecret('x', { input: Readable.from([Buffer.from('a b\r\n')]) }), 'a b');
    assert.equal(await readSecret('x', { input: Readable.from([Buffer.from('two\n\n')]) }), 'two\n', 'only one line break is removed');
    assert.equal(await readSecret('x', { input: Readable.from([Buffer.from('密码'), Buffer.from('值')]) }), '密码值');
    await assert.rejects(readSecret('x', { input: Readable.from([Buffer.from([0xff, 0xfe])]) }), /不是 UTF-8/);
    await assert.rejects(readSecret('x', { input: Readable.from([Buffer.alloc(MAX_SECRET_BYTES + 1, 0x61)]) }), /超过/);
  });

  test('on a terminal the value is typed without echo; backspace edits; Ctrl-C cancels', async () => {
    const terminal = fakeTerminal();
    const prompts: string[] = [];
    const reading = readSecret('res_x password', { input: terminal as never, prompt: (text) => prompts.push(text) });
    terminal.emit('data', Buffer.from('pass'));
    terminal.emit('data', Buffer.from('x\u007fword'));
    terminal.emit('data', Buffer.from('\r'));
    assert.equal(await reading, 'password');
    assert.deepEqual(terminal.raw, [true, false], 'raw mode (no echo) on, then off');
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /res_x password 的值（不回显）/);
    assert.ok(!prompts[0].includes('password\u0000'));
    const cancelled = fakeTerminal();
    const pending = readSecret('x', { input: cancelled as never, prompt: () => {} });
    cancelled.emit('data', Buffer.from('ab\u0003'));
    await assert.rejects(pending, /已取消/);
    assert.deepEqual(cancelled.raw, [true, false]);
  });

  test('on a terminal special keys are not text, a character split across reads stays whole, Ctrl-U clears, and a closed terminal refuses', async () => {
    const typed = async (...chunks: (Buffer | string)[]): Promise<string> => {
      const terminal = fakeTerminal();
      const reading = readSecret('x', { input: terminal as never, prompt: () => {} });
      for (const chunk of chunks) terminal.emit('data', typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      return reading;
    };
    // The left arrow (CSI D) to fix a typo, an F5 key (CSI 15~), an application-mode arrow (SS3 A): none of it is the value.
    assert.equal(await typed('pass', '\u001b[D', 'word\u001b[15~\u001bOA', '\r'), 'password');
    // A sequence split across reads, and a lone ESC, which leaves the next key as typed.
    assert.equal(await typed('ab\u001b', '[C', 'c\u001b', 'd\r'), 'abcd');
    // A pasted value between the bracketed-paste markers.
    assert.equal(await typed('\u001b[200~粘贴的值\u001b[201~\r'), '粘贴的值');
    const bytes = Buffer.from('密码é', 'utf8');
    assert.equal(await typed(bytes.subarray(0, 2), bytes.subarray(2, 5), bytes.subarray(5), Buffer.from('\r')), '密码é', 'one decoder for the whole input');
    assert.equal(await typed('wrong', '\u0015', 'right\r'), 'right', 'Ctrl-U clears what was typed');
    assert.equal(await typed('a\u0085b\r'), 'ab', 'C1 control characters are not text');
    await assert.rejects(typed(Buffer.from([0x61, 0xff, 0x0d])), /输入不是 UTF-8 文本/);
    for (const event of ['end', 'close']) {
      const terminal = fakeTerminal();
      const reading = readSecret('x', { input: terminal as never, prompt: () => {} });
      terminal.emit('data', Buffer.from('half'));
      terminal.emit(event);
      await assert.rejects(reading, /标准输入在回车之前关闭了，没有设置/, event);
      assert.deepEqual(terminal.raw, [true, false], `raw mode is turned off after ${event}`);
      assert.equal(terminal.listenerCount('data'), 0);
    }
  });
});
