import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { staging, output } from './io.ts';
import { checkContract } from './check-runtime-contract.ts';
import { runtimeDocument, signRuntime } from '../../../packs/workflow/case-compile/testing/runtime.ts';
test('staging refuses repositories and symlinked repository destinations without overwriting files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'convert-'));
  try { mkdirSync(join(dir, 'repo')); mkdirSync(join(dir, 'repo', '.git')); symlinkSync(join(dir, 'repo'), join(dir, 'link'));
    assert.throws(() => staging(join(dir, 'repo', 'child'))); assert.throws(() => staging(join(dir, 'link', 'child')));
    output(join(dir, 'out'), 'fixture.json', 'original'); assert.throws(() => output(join(dir, 'out'), 'fixture.json', 'changed'));
    assert.equal(readFileSync(join(dir, 'out', 'fixture.json'), 'utf8'), 'original');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('contract checker rejects stale identity and changed bytes', () => {
  const raw = runtimeDocument(); const bytes = Buffer.from(JSON.stringify(raw));
  assert.equal(checkContract(bytes, raw.contract_sha256).contract.digest, raw.contract_sha256);
  assert.throws(() => checkContract(bytes, 'b'.repeat(64)));
  assert.throws(() => checkContract(Buffer.from(JSON.stringify({ ...raw, complete: false })), raw.contract_sha256));
  const newer = signRuntime({ ...raw, atlas_snapshot: { revision: 2 } }); assert.throws(() => checkContract(bytes, newer.contract_sha256));
});
test('contract CLI keeps exact bytes in staging and prints only summary and publication command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'convert-'));
  try { const raw = runtimeDocument(); const bytes = JSON.stringify(raw, null, 3) + '\n'; output(dir, 'source.json', bytes);
    const result = spawnSync(process.execPath, ['scripts/real/convert/check-runtime-contract.ts', join(dir, 'source.json'), '--expect', raw.contract_sha256, '--out', join(dir, 'out')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^\{"count":\d+,"sha256":"[a-f0-9]{64}"\}$/); assert.equal(lines[1], 'circle-hub doc put runtime-contract runtime-contract.json');
    assert.equal(readFileSync(join(dir, 'out/runtime-contract.json'), 'utf8'), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
