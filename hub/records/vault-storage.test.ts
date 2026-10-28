import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { FileVault, type FileVaultStorage } from './api.ts';

function storageFixture() {
  const entries = new Map<string, string>();
  let deny = false, failCommit = false;
  const storage: FileVaultStorage = {
    async read(file) { if (deny) throw Error('OS boundary denied'); return entries.get(file) ?? null; },
    async writeAtomic(file, text) { if (deny) throw Error('OS boundary denied'); if (failCommit) throw Error('atomic commit denied'); entries.set(file, text); },
    async create(file, text) { if (deny) throw Error('OS boundary denied'); if (entries.has(file)) return false; entries.set(file, text); return true; },
    async stat(file) { if (deny) throw Error('OS boundary denied'); return entries.has(file) ? { written_at: '2026-01-01T00:00:00.000Z' } : null; },
    async list() { if (deny) throw Error('OS boundary denied'); return [...entries.keys()]; },
    async remove(file) { if (deny) throw Error('OS boundary denied'); return entries.delete(file); },
  };
  const key = randomBytes(32);
  const provider = { async getKey() { return Uint8Array.from(key); } };
  return { entries, storage, provider, deny() { deny = true; }, failCommit() { failCommit = true; } };
}

test('vault OS seam preserves AES-GCM, replacement, metadata, AAD and key-check semantics', async () => {
  const { entries, storage, provider } = storageFixture();
  const vault = new FileVault('synthetic-unused-path', provider, storage);
  await vault.put('alpha', 'synthetic fixture');
  assert.equal(await vault.getText('alpha'), 'synthetic fixture');
  const old = entries.get('alpha.sealed')!;
  await vault.put('alpha', 'replacement fixture');
  assert.notEqual(entries.get('alpha.sealed'), old);
  assert.equal(await vault.getText('alpha'), 'replacement fixture');
  assert.deepEqual(await vault.list(), ['alpha']);
  assert.equal(await vault.has('alpha'), true);
  assert.deepEqual(await vault.stat('alpha'), { written_at: '2026-01-01T00:00:00.000Z' });
  entries.set('renamed.sealed', old);
  await assert.rejects(vault.get('renamed'), /无法解开/);
  const wrong = new FileVault('synthetic-unused-path', { async getKey() { return randomBytes(32); } }, storage);
  await assert.rejects(wrong.get('alpha'), /密钥与密钥库不符/);
  assert.equal(await vault.remove('alpha'), true);
  assert.equal(await vault.remove('alpha'), false);
});

test('native boundary and atomic failure propagate without replacing prior ciphertext or accepting unknown', async () => {
  const fixture = storageFixture();
  const vault = new FileVault('synthetic-unused-path', fixture.provider, fixture.storage);
  await vault.put('alpha', 'original fixture');
  const before = fixture.entries.get('alpha.sealed');
  fixture.failCommit();
  await assert.rejects(vault.put('alpha', 'new fixture'), /atomic commit denied/);
  assert.equal(fixture.entries.get('alpha.sealed'), before);
  fixture.deny();
  for (const action of [() => vault.get('alpha'), () => vault.has('alpha'), () => vault.stat('alpha'), () => vault.list(), () => vault.remove('alpha')]) {
    await assert.rejects(action(), /OS boundary denied/);
  }
});

test('missing key-check authenticates an existing entry before writing a replacement check', async () => {
  const fixture = storageFixture();
  const vault = new FileVault('synthetic-unused-path', fixture.provider, fixture.storage);
  await vault.put('alpha', 'original fixture');
  fixture.entries.delete('key-check');
  const wrong = new FileVault('synthetic-unused-path', { async getKey() { return randomBytes(32); } }, fixture.storage);
  await assert.rejects(wrong.get('alpha'), /密钥与密钥库不符/);
  assert.equal(fixture.entries.has('key-check'), false);
  fixture.deny();
  await assert.rejects(vault.get('alpha'), /OS boundary denied/);
});

test('Windows refuses a FileVault without its native OS boundary', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => new FileVault('synthetic-unused-path'), /原生文件访问控制/);
});
