import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readdir, link, unlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { windowsKeychainStore, windowsKeychainStoreWithBoundary } from './windows-keychain.ts';
import { finishWindowsPrivateCreate, type WindowsPrivateFiles } from './windows-files.ts';
import type { WindowsDataProtection } from './windows-dpapi.ts';

function fixture() {
  const entries = new Map<string, Uint8Array>();
  const files: WindowsPrivateFiles = {
    sid: 'synthetic-user',
    read(name) { const value = entries.get(name); return value === undefined ? undefined : Uint8Array.from(value); },
    create(name, value) { if (entries.has(name)) throw Error('create-only'); entries.set(name, Uint8Array.from(value)); },
    remove(name) { return entries.delete(name); },
  };
  // Scripted cipher, deliberately not an OS encryption claim.
  const cipher: WindowsDataProtection = { protect: (value) => Uint8Array.from(value), unprotect: (value) => Uint8Array.from(value) };
  const options = { directory: 'synthetic', service: 'fixture', account: 'key' };
  return { entries, files, cipher, options, store: windowsKeychainStoreWithBoundary(options, files, cipher) };
}

test('synthetic encrypted store reads without implicit creation and refuses replacement', async () => {
  const { store, entries } = fixture();
  assert.deepEqual(await store.status(), { present: false });
  await assert.rejects(store.read());
  assert.equal(entries.size, 0);
  const key = randomBytes(32), before = Buffer.from(key);
  await store.write(key);
  assert.deepEqual(key, before);
  assert.deepEqual(await store.read(), Uint8Array.from(key));
  await assert.rejects(store.write(randomBytes(32)), /create-only/);
  assert.deepEqual(await store.read(), Uint8Array.from(key));
  assert.equal(await store.delete(), true);
  assert.equal(await store.delete(), false);
});

test('synthetic binding refuses identity migration, renamed entries, malformed envelope and plaintext', async () => {
  const { store, files, options, cipher, entries } = fixture();
  await store.init();
  const [name, bytes] = [...entries.entries()][0]!;
  const original = Buffer.from(bytes);
  const otherIdentity = windowsKeychainStoreWithBoundary(options, { ...files, sid: 'different-user' }, cipher);
  await assert.rejects(otherIdentity.read());
  for (const replacement of [Buffer.from('plaintext'), Buffer.from('{}'), Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), data: '!!!' })), Buffer.from(JSON.stringify({ ...JSON.parse(original.toString()), service: 'other' }))]) {
    entries.set(name, replacement);
    await assert.rejects(store.read());
    await assert.rejects(store.status());
  }
  entries.set(name, original);
  assert.equal((await store.read()).length, 32);
  const otherAccount = windowsKeychainStoreWithBoundary({ ...options, account: 'another' }, files, cipher);
  const otherName = (await import('node:crypto')).createHash('sha256').update(JSON.stringify([options.service, 'another'])).digest('hex') + '.bin';
  entries.set(otherName, original);
  await assert.rejects(otherAccount.read());
});

test('synthetic native-boundary failures and unavailable cipher never write a fallback', async () => {
  const { options, files, cipher, entries } = fixture();
  for (const reason of ['profile unavailable', 'owner differs', 'DACL inherited', 'DACL grants another user', 'reparse point', 'hard link']) {
    const denied: WindowsPrivateFiles = { ...files, read() { throw Error(reason); }, create() { throw Error(reason); } };
    const store = windowsKeychainStoreWithBoundary(options, denied, cipher);
    await assert.rejects(store.status(), new RegExp(reason));
    await assert.rejects(store.write(randomBytes(32)), new RegExp(reason));
  }
  const noCipher = windowsKeychainStoreWithBoundary(options, files, { ...cipher, protect() { throw Error('OS denied'); } });
  await assert.rejects(noCipher.write(randomBytes(32)), /OS denied/);
  assert.equal(entries.size, 0);
});

const runnerOnly = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true';
test('Windows runner native fixture: persistence, duplicate create, DACL rejection, no plaintext migration', { skip: !runnerOnly }, async () => {
  // Only a new synthetic directory in the ephemeral runner profile is used. No owner credential store is opened.
  const parent = await mkdtemp(join(homedir(), 'circle-hub-synthetic-'));
  const directory = join(parent, 'keys');
  try {
    const options = { directory, service: 'synthetic-runner', account: 'synthetic-key' };
    const store = windowsKeychainStore(options);
    const key = randomBytes(32);
    await store.write(key);
    assert.deepEqual(await windowsKeychainStore(options).read(), Uint8Array.from(key));
    await assert.rejects(store.write(randomBytes(32)));
    assert.deepEqual(await store.read(), Uint8Array.from(key));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { windowsKeychainStore } from ${JSON.stringify(new URL('./windows-keychain.ts', import.meta.url).href)}; const key = await windowsKeychainStore(${JSON.stringify(options)}).read(); if (key.length !== 32) process.exit(2); key.fill(0);`], { encoding: 'utf8' });
    assert.equal(child.status, 0, 'fresh process read failed');
    const file = join(directory, (await readdir(directory))[0]!);
    const linkedFile = join(parent, 'hardlink.bin');
    await link(file, linkedFile);
    await assert.rejects(store.read());
    await unlink(linkedFile);
    assert.equal((await store.read()).length, 32);
    const junction = join(parent, 'junction');
    await symlink(directory, junction, 'junction');
    await assert.rejects(windowsKeychainStore({ ...options, directory: junction }).read());
    const disposable = windowsKeychainStore({ ...options, account: 'disposable' });
    await disposable.init();
    assert.equal(await disposable.delete(), true);
    assert.equal(await disposable.delete(), false);
    // Granting Everyone read must be rejected by the native exact DACL check, even though OS reads would succeed.
    const widened = spawnSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(R)'], { encoding: 'utf8' });
    assert.equal(widened.status, 0, 'fixture ACL mutation failed');
    await assert.rejects(store.read());
    await assert.rejects(store.write(randomBytes(32)));
  } finally { await rm(parent, { recursive: true, force: true }); }
});


test('owned master-key copy has one shared backing allocation and is cleared after success or failure', async (t) => {
  const { store, files, options, cipher } = fixture();
  const key = randomBytes(32), original = Buffer.from(key);
  const owned: Buffer[] = [];
  const from = Buffer.from;
  t.mock.method(Buffer, 'from', ((...args: unknown[]) => {
    if (args[0] instanceof Uint8Array && args[0].byteLength === 32) throw Error('untracked extra plaintext copy');
    const result = Reflect.apply(from, Buffer, args) as Buffer;
    if (args[0] instanceof ArrayBuffer && args[0].byteLength === 32) owned.push(result);
    return result;
  }) as typeof Buffer.from);
  await store.write(key);
  const denied = windowsKeychainStoreWithBoundary(options, files, { ...cipher, protect() { throw Error('injected encryption failure'); } });
  await assert.rejects(denied.write(key), /injected encryption failure/);
  assert.equal(owned.length, 2);
  for (const copy of owned) assert.ok(copy.every((byte) => byte === 0));
  assert.deepEqual(key, original);
});

test('short write and flush failure discard only the newly created handle; failed discard reports unresolved state', () => {
  for (const fault of ['short write', 'flush failure', 'write throws', 'flush throws']) {
    let discarded = 0, flushed = 0;
    assert.throws(() => finishWindowsPrivateCreate(32, {
      write() { if (fault === 'write throws') throw Error('private native text'); return fault === 'short write' ? 31 : 32; },
      flush() { flushed++; if (fault === 'flush throws') throw Error('private native text'); return fault !== 'flush failure'; },
      discard() { discarded++; return true; },
    }), /标记删除/);
    assert.equal(discarded, 1);
    assert.equal(flushed, fault === 'short write' || fault === 'write throws' ? 0 : 1);
  }
  let discarded = 0;
  finishWindowsPrivateCreate(32, { write: () => 32, flush: () => true, discard() { discarded++; return true; } });
  assert.equal(discarded, 0);
  for (const throws of [false, true]) {
    assert.throws(() => finishWindowsPrivateCreate(32, {
      write: () => 0, flush: () => true,
      discard() { if (throws) throw Error('private native text'); return false; },
    }), /原生删除也未确认/);
  }
});
