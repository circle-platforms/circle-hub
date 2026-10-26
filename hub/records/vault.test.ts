import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { VaultError } from './errors.ts';
import { FileKeyProvider, FileVault, maskedForDisplay } from './vault.ts';

async function scratch(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'circle-hub-vault-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function ready(t: TestContext): Promise<{ vault: FileVault; directory: string; keyPath: string }> {
  const directory = await scratch(t);
  const keyPath = join(directory, 'keys', 'vault.key');
  const provider = new FileKeyProvider(keyPath);
  const vault = new FileVault(join(directory, 'vault'), provider);
  await vault.initKey();
  return { vault, directory, keyPath };
}

test('a missing key is an error and the vault never creates one on its own', async (t) => {
  const directory = await scratch(t);
  const keyPath = join(directory, 'vault.key');
  const vault = new FileVault(join(directory, 'vault'), new FileKeyProvider(keyPath));
  await assert.rejects(vault.put('db.password', 'synthetic'), VaultError);
  await assert.rejects(vault.get('db.password'), VaultError);
  assert.equal(existsSync(keyPath), false);
  assert.equal(existsSync(join(directory, 'vault', 'db.password.sealed')), false);
  const unkeyed = new FileVault(join(directory, 'other'));
  await assert.rejects(unkeyed.put('x', 'y'), (error: unknown) => error instanceof VaultError && /没有配置密钥来源/.test((error as Error).message));
  await assert.rejects(unkeyed.initKey(), VaultError);
  // Explicit initialization creates a 32-byte 0600 key once and refuses to replace it.
  await vault.initKey();
  assert.equal((await readFile(keyPath)).byteLength, 32);
  assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
  await assert.rejects(vault.initKey(), (error: unknown) => error instanceof VaultError && /已经存在/.test((error as Error).message));
  await vault.put('db.password', 'synthetic');
  assert.equal(await vault.getText('db.password'), 'synthetic');
});

test('entries round-trip; list returns names only; files hold no plaintext and are private', async (t) => {
  const { vault, directory } = await ready(t);
  const secret = `synthetic-${randomBytes(12).toString('hex')}`;
  await vault.put('agile.token', secret);
  await vault.put('plm.cert', Buffer.from([0, 1, 2, 255]));
  await vault.put('a-first', '口令（合成）');
  assert.deepEqual(await vault.list(), ['a-first', 'agile.token', 'plm.cert']);
  assert.equal(await vault.getText('agile.token'), secret);
  assert.deepEqual([...((await vault.get('plm.cert')) ?? [])], [0, 1, 2, 255]);
  assert.equal(await vault.getText('a-first'), '口令（合成）');
  assert.equal(await vault.get('absent'), null);
  assert.equal(await vault.has('agile.token'), true);
  assert.equal(await vault.has('absent'), false);
  const file = await readFile(join(directory, 'vault', 'agile.token.sealed'), 'utf8');
  assert.equal(file.includes(secret), false);
  assert.equal(file.includes(Buffer.from(secret).toString('base64')), false);
  assert.equal((await stat(join(directory, 'vault', 'agile.token.sealed'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'vault'))).mode & 0o777, 0o700);
  // Replacing is atomic and leaves no temporary files.
  await vault.put('agile.token', 'synthetic-rotated');
  assert.equal(await vault.getText('agile.token'), 'synthetic-rotated');
  assert.equal((await readdir(join(directory, 'vault'))).some((name) => name.endsWith('.tmp')), false);
  assert.equal(await vault.remove('agile.token'), true);
  assert.equal(await vault.remove('agile.token'), false);
  assert.deepEqual(await vault.list(), ['a-first', 'plm.cert']);
  for (const name of ['', 'UPPER', '../escape', 'a/b', '.hidden', 'x'.repeat(101)]) await assert.rejects(vault.put(name, 'v'), TypeError, name);
  await assert.rejects(vault.put('big', Buffer.alloc(64 * 1024 + 1)), TypeError);
  await assert.rejects(vault.put('lone', `x${String.fromCharCode(0xd800)}`), TypeError);
});

test('an altered entry, a renamed or copied entry, and a wrong key are each refused', async (t) => {
  const { vault, directory, keyPath } = await ready(t);
  await vault.put('alpha', 'synthetic-alpha');
  await vault.put('beta', 'synthetic-beta');
  const alpha = join(directory, 'vault', 'alpha.sealed');
  const sealed = JSON.parse(await readFile(alpha, 'utf8')) as { data: string };
  const flipped = Buffer.from(sealed.data, 'base64');
  flipped[0] ^= 0x01;
  await writeFile(alpha, JSON.stringify({ ...sealed, data: flipped.toString('base64') }));
  await assert.rejects(vault.get('alpha'), (error: unknown) => error instanceof VaultError && /被改动/.test((error as Error).message));
  await writeFile(alpha, 'not json');
  await assert.rejects(vault.get('alpha'), VaultError);
  // The name is bound as associated data: beta's sealed bytes do not open as gamma.
  await copyFile(join(directory, 'vault', 'beta.sealed'), join(directory, 'vault', 'gamma.sealed'));
  await assert.rejects(vault.get('gamma'), (error: unknown) => error instanceof VaultError && /文件名与封存时不同/.test((error as Error).message));
  assert.equal(await vault.getText('beta'), 'synthetic-beta');
  // Another key: the key check names the real cause instead of blaming the entries.
  await writeFile(keyPath, randomBytes(32));
  await assert.rejects(vault.get('beta'), (error: unknown) => error instanceof VaultError && /密钥与密钥库不符/.test((error as Error).message));
  await assert.rejects(vault.put('delta', 'x'), VaultError);
  await writeFile(keyPath, randomBytes(31));
  await assert.rejects(vault.get('beta'), (error: unknown) => error instanceof VaultError && /长度不对/.test((error as Error).message));
});

test('a truncated authentication tag or a wrong IV length is refused, never accepted as a weaker tag', async (t) => {
  const { vault, directory } = await ready(t);
  await vault.put('plm.password', 'synthetic-value-1');
  const file = join(directory, 'vault', 'plm.password.sealed');
  const sealed = JSON.parse(await readFile(file, 'utf8')) as { iv: string; tag: string; data: string };
  const tag = Buffer.from(sealed.tag, 'base64');
  const warnings: string[] = [];
  const onWarning = (warning: Error) => warnings.push(warning.name);
  process.on('warning', onWarning);
  t.after(() => process.off('warning', onWarning));
  for (const length of [12, 8, 4]) {
    await writeFile(file, JSON.stringify({ ...sealed, tag: tag.subarray(0, length).toString('base64') }));
    await assert.rejects(vault.get('plm.password'), (error: unknown) => error instanceof VaultError && /长度不对/.test((error as Error).message), String(length));
  }
  await writeFile(file, JSON.stringify({ ...sealed, iv: Buffer.from(sealed.iv, 'base64').subarray(0, 8).toString('base64') }));
  await assert.rejects(vault.get('plm.password'), VaultError);
  await writeFile(file, JSON.stringify(sealed));
  assert.equal(await vault.getText('plm.password'), 'synthetic-value-1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings.filter((name) => name === 'DeprecationWarning'), []);
});

test('entries without a key-check file: the key must open an entry before a check is written', async (t) => {
  const { vault, directory } = await ready(t);
  await vault.put('agile.password', 'synthetic-first');
  await rm(join(directory, 'vault', 'key-check'));
  // Another key refuses to seal next to entries it cannot open, and writes no check file.
  const otherKey = new FileKeyProvider(join(directory, 'keys', 'other.key'));
  await otherKey.initKey();
  const intruder = new FileVault(join(directory, 'vault'), otherKey);
  await assert.rejects(intruder.put('plm.password', 'synthetic-second'), (error: unknown) => error instanceof VaultError && /没有一条能用这把主密钥解开/.test((error as Error).message));
  assert.equal(existsSync(join(directory, 'vault', 'plm.password.sealed')), false);
  assert.equal(existsSync(join(directory, 'vault', 'key-check')), false);
  // The original key opens an entry, so the check is written again and the vault works.
  await vault.put('plm.password', 'synthetic-second');
  assert.equal(existsSync(join(directory, 'vault', 'key-check')), true);
  assert.equal(await vault.getText('agile.password'), 'synthetic-first');
  await assert.rejects(intruder.get('agile.password'), (error: unknown) => error instanceof VaultError && /密钥与密钥库不符/.test((error as Error).message));
});

test('masked display shows only that a value is set and its length', () => {
  assert.equal(maskedForDisplay('synthetic-secret'), '已设置（长度 16）');
  assert.equal(maskedForDisplay('口令'), '已设置（长度 2）');
  assert.equal(maskedForDisplay(new Uint8Array(32)), '已设置（长度 32）');
  assert.equal(maskedForDisplay(''), '已设置（空值）');
  assert.equal(maskedForDisplay(null), '未设置');
  assert.equal(maskedForDisplay(undefined), '未设置');
  assert.equal(maskedForDisplay('abc123').includes('abc'), false);
});
