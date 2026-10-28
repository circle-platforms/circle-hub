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
