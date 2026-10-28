import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { windowsDataProtection } from './windows-dpapi.ts';

const runnerOnly = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true';
test('Windows runner DPAPI round trip uses only synthetic bytes without Electron', { skip: !runnerOnly }, () => {
  const cipher = windowsDataProtection();
  const key = randomBytes(64), original = Buffer.from(key);
  const sealed = cipher.protect(key);
  assert.notDeepEqual(sealed, key);
  assert.deepEqual(cipher.unprotect(sealed), Uint8Array.from(key));
  assert.deepEqual(key, original);
  assert.throws(() => cipher.unprotect(randomBytes(100)));
  assert.throws(() => cipher.protect(new Uint8Array()));
});

test('non-Windows construction fails closed before native loading', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => windowsDataProtection(), /只可在 Windows/);
});


test('Windows runner DPAPI owns one erasable input copy on success and native rejection', { skip: !runnerOnly }, (t) => {
  const cipher = windowsDataProtection();
  const key = randomBytes(64), original = Buffer.from(key);
  const malformed = randomBytes(64);
  const owned: Buffer[] = [];
  const from = Buffer.from;
  t.mock.method(Buffer, 'from', ((...args: unknown[]) => {
    if (args[0] instanceof Uint8Array && args[0].byteLength === 64) throw Error('untracked extra plaintext copy');
    const result = Reflect.apply(from, Buffer, args) as Buffer;
    if (args[0] instanceof ArrayBuffer && args[0].byteLength === 64) owned.push(result);
    return result;
  }) as typeof Buffer.from);
  cipher.protect(key);
  assert.throws(() => cipher.unprotect(malformed));
  assert.equal(owned.length, 2);
  for (const copy of owned) assert.ok(copy.every((byte) => byte === 0));
  assert.deepEqual(key, original);
});
