import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SETUP_CODE_TTL_MS, checkSetupCode, issueSetupCode, normalizeSetupCode, removeSetupCode, setupCodePath } from './setup-code.ts';

test('a setup code is shown once, kept only as a digest, accepted as typed, and expires', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'circle-hub-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await checkSetupCode(dir, 'anything'), 'none');
  const now = new Date('2026-10-31T00:00:00Z');
  const code = await issueSetupCode(dir, now);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
  const stored = await readFile(setupCodePath(dir), 'utf8');
  assert.doesNotMatch(stored, new RegExp(normalizeSetupCode(code)), 'only the digest is kept');
  assert.equal((await lstat(setupCodePath(dir))).mode & 0o077, 0);
  assert.equal(await checkSetupCode(dir, code, now), 'ok');
  assert.equal(await checkSetupCode(dir, ` ${code.toLowerCase().replace(/-/g, ' ')} `, now), 'ok', 'case, spaces and dashes do not matter');
  assert.equal(await checkSetupCode(dir, code.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')), now), 'wrong');
  assert.equal(await checkSetupCode(dir, code, new Date(now.getTime() + SETUP_CODE_TTL_MS + 1)), 'expired');
  const second = await issueSetupCode(dir, now);
  assert.equal(await checkSetupCode(dir, code, now), 'wrong', 'a new code replaces the old one');
  assert.equal(await checkSetupCode(dir, second, now), 'ok');
  await removeSetupCode(dir);
  assert.equal(await checkSetupCode(dir, second, now), 'none');
});
