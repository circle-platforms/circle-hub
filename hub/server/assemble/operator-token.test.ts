// The operator token store and the secret input: the token in the deployment's private key file on every platform (the
// Hub no longer uses the macOS keychain, decision 137), its errors naming the operator token, its key service resolved as
// the vault master key's, the token form, CIRCLE_HUB_TOKEN taken out of the environment, and secrets read from a pipe or a
// terminal without echo (special keys, characters split across reads, a terminal that closes).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { OPERATOR_TOKEN_ITEM, SETTINGS_SCHEMA, VAULT_KEY_ITEM, fileKeyStore, keyDirectory, layoutAt } from '../../platform/api.ts';
import { removeTree } from './files.ts';
import {
  OPERATOR_TOKEN_ACCOUNT,
  OPERATOR_TOKEN_VARIABLE,
  OperatorTokenError,
  deploymentKeyService,
  fileOperatorTokens,
  memoryOperatorTokens,
  takeEnvironmentToken,
  tokenBytes,
} from './operator-token.ts';
import { MAX_SECRET_BYTES, readSecret } from './secret-input.ts';

const newToken = (): string => randomBytes(32).toString('base64url');

describe('the operator token in the private key file', () => {
  test('is private (0700 directory, 0600 file), beside but distinct from the vault master key, and never overwritten', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hub-operator-file-'));
    t.after(() => removeTree(root));
    const store = fileOperatorTokens(root, 'synthetic');
    assert.equal(store.where, `私有密钥文件（${keyDirectory(root)}，服务 synthetic，账户 ${OPERATOR_TOKEN_ACCOUNT}）`);
    const token = newToken();
    assert.equal(await store.present(), false);
    assert.equal(await store.read(), null);
    await store.write(token);
    assert.equal(await store.read(), token);
    assert.equal((await lstat(keyDirectory(root))).mode & 0o777, 0o700);
    const [file] = await readdir(keyDirectory(root));
    assert.equal((await lstat(join(keyDirectory(root), file!))).mode & 0o777, 0o600);
    assert.equal(file!.includes(token), false, 'the file name says nothing about the token');
    await assert.rejects(store.write(newToken()), /不覆盖/);
    await assert.rejects(store.write('invalid'), /不是 Hub 签发的格式/);
    // The vault master key of the same service is another file; removing the token leaves it.
    const vault = fileKeyStore({ root, service: 'synthetic', account: 'vault-master-key', item: VAULT_KEY_ITEM });
    await vault.init();
    assert.equal((await readdir(keyDirectory(root))).length, 2);
    assert.equal(await store.remove(), true);
    assert.equal(await store.remove(), false);
    assert.equal(await store.read(), null);
    assert.deepEqual(await vault.status(), { present: true });
  });

  test('errors of the file name the operator token, never the vault master key, and never advise key init', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'hub-operator-file-'));
    t.after(() => removeTree(root));
    const store = fileOperatorTokens(root, 'synthetic');
    await store.write(newToken());
    const [file] = await readdir(keyDirectory(root));
    await chmod(join(keyDirectory(root), file!), 0o644);
    for (const action of [() => store.read(), () => store.present()]) {
      await assert.rejects(action(), (error: unknown) => {
        assert.ok(error instanceof OperatorTokenError);
        assert.equal(error.message, `${OPERATOR_TOKEN_ITEM.label}文件的属主或权限不对`);
        assert.ok(!error.message.includes(VAULT_KEY_ITEM.label));
        assert.ok(!(error.hint ?? '').includes('key init'), 'the vault key\'s remedy (key init) is not offered for the token');
        return true;
      });
    }
    await chmod(keyDirectory(root), 0o755);
    await assert.rejects(store.read(), (error: unknown) => error instanceof OperatorTokenError && /0700/.test(error.message));
  });

  test('the memory store removes its token too', async () => {
    const memory = memoryOperatorTokens(newToken());
    assert.equal(await memory.remove(), true);
    assert.equal(await memory.remove(), false);
    assert.equal(await memory.read(), null);
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

describe('the key service of the operator token', () => {
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

  test('is the deployment settings\' of the data root, as for the vault master key; without settings the default', async () => {
    const data = join(root, 'b');
    await mkdir(layoutAt(data).config, { recursive: true });
    await writeFile(join(layoutAt(data).config, 'platform.json'), JSON.stringify(settings('circle-hub-b')));
    // A shell that sets only the data root: the settings decide, not the default.
    assert.equal(await deploymentKeyService({ CIRCLE_HUB_DATA_DIR: data }), 'circle-hub-b');
    // No settings file (a development data root) or no data root: the default service.
    assert.equal(await deploymentKeyService({ CIRCLE_HUB_DATA_DIR: join(root, 'plain') }), 'circle-hub');
    assert.equal(await deploymentKeyService({}), 'circle-hub');
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
