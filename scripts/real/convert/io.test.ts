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

test('topology and profile CLIs print only counted digests and staged publication commands', async () => {
  const { topology } = await import('./testing.ts'); const dir = mkdtempSync(join(tmpdir(), 'convert-'));
  try {
    const source = topology(); output(dir, 'topology.json', JSON.stringify(source));
    const topologyRun = spawnSync(process.execPath, ['scripts/real/convert/bed-topology.ts', join(dir, 'topology.json'), '--out', join(dir, 'inventory')], { encoding: 'utf8' });
    assert.equal(topologyRun.status, 0, topologyRun.stderr); assert.match(topologyRun.stdout, /^\{"count":2,"sha256":"[a-f0-9]{64}"\}\ncircle-hub doc put test-bed-manifest test-bed-manifest.json\n$/);
    const contract = runtimeDocument(); output(dir, 'contract.json', JSON.stringify(contract)); output(dir, 'environment.json', JSON.stringify({ ready: true, device_count: 2 }));
    const args = ['scripts/real/convert/runtime-profile.ts', join(dir, 'environment.json'), join(dir, 'inventory/test-bed-manifest.json'), join(dir, 'contract.json'), '--out', join(dir, 'profile')];
    const draft = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(draft.status, 0, draft.stderr);
    assert.match(draft.stdout, /^\{"count":\d+,"sha256":"[a-f0-9]{64}"\}\ncircle-hub doc put runtime-profile runtime-profile.draft.json\n$/);
    const check = spawnSync(process.execPath, ['scripts/real/convert/runtime-profile.ts', join(dir, 'profile/runtime-profile.draft.json'), args[2]!, args[3]!, '--check', '--out', join(dir, 'verified')], { encoding: 'utf8' });
    assert.equal(check.status, 1); assert.equal(check.stdout, ''); assert.ok(!check.stderr.includes('widget-seat'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('case and probe CLIs keep identifiers commands addresses and build values out of stdout', async () => {
  const { profileDocument } = await import('../../../packs/workflow/case-compile/testing/runtime.ts');
  const { MANIFEST_DOC } = await import('../../../packs/workflow/case-compile/functions/test-support.ts'); const dir = mkdtempSync(join(tmpdir(), 'convert-'));
  try {
    const map = { root: { data: { text: 'synthetic-root' }, children: Array.from({ length: 5 }, (_, i) => ({ data: { text: 'synthetic-case', priority: 2, auto: 'YES', autoid: `synthetic-case-${i}` } })) } };
    output(dir, 'map.json', JSON.stringify(map));
    const cases = spawnSync(process.execPath, ['scripts/real/convert/auto-cases.ts', join(dir, 'map.json'), '--out', join(dir, 'cases')], { encoding: 'utf8' });
    assert.equal(cases.status, 0, cases.stderr); assert.match(cases.stdout, /^\{"count":5,"sha256":"[a-f0-9]{64}"\}\n$/);
    const contract = runtimeDocument(); const profile = { ...profileDocument(contract), probes: [{ seat: 'widget-seat', object: 'widget-seat', method: 'configure', command: 'show fixture-build', purpose: 'build', extract: { pattern: '(?<value>.+)', group: 'value' } }] };
    output(dir, 'contract.json', JSON.stringify(contract)); output(dir, 'profile.json', JSON.stringify(profile)); output(dir, 'manifest.json', JSON.stringify(MANIFEST_DOC));
    const probes = spawnSync(process.execPath, ['scripts/real/convert/probes.ts', join(dir, 'contract.json'), join(dir, 'profile.json'), join(dir, 'manifest.json'), '--build', 'synthetic-build', '--out', join(dir, 'probes')], { encoding: 'utf8' });
    assert.equal(probes.status, 0, probes.stderr); assert.match(probes.stdout, /^\{"count":1,"sha256":"[a-f0-9]{64}"\}\n$/);
    const draft = JSON.parse(readFileSync(join(dir, 'probes/probes.draft.json'), 'utf8')); assert.equal(draft.pending.length, 1); assert.equal(draft.probes[0].expected, 'synthetic-build');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
