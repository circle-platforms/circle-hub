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
    assert.match(lines[0]!, /^\{"count":\d+,"sha256":"[a-f0-9]{64}"\}$/); assert.equal(lines[1], 'circle-hub doc put runner-contract runtime-contract.json');
    assert.equal(readFileSync(join(dir, 'out/runtime-contract.json'), 'utf8'), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('topology and profile CLIs print only counted digests and staged publication commands', async () => {
  const { topology } = await import('./testing.ts'); const dir = mkdtempSync(join(tmpdir(), 'convert-'));
  try {
    const { definition } = await import('../../../hub/dispatch/testing/definition.ts');
    const source = topology(); output(dir, 'topology.json', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { snapshot: source } } }));
    output(dir, 'executor.json', JSON.stringify({ ...definition('http://127.0.0.1/mcp'), capture_pointers: ['/snapshot'] }));
    const topologyRun = spawnSync(process.execPath, ['scripts/real/convert/bed-topology.ts', join(dir, 'topology.json'), '--definition', join(dir, 'executor.json'), '--out', join(dir, 'inventory')], { encoding: 'utf8' });
    assert.equal(topologyRun.status, 0, topologyRun.stderr); const topologyLines = topologyRun.stdout.trim().split('\n'); const counts = JSON.parse(topologyLines[0]); assert.equal(counts.count, 2); assert.match(counts.original_sha256, /^[a-f0-9]{64}$/); assert.match(counts.canonical_content_sha256, /^[a-f0-9]{64}$/); assert.equal(counts.pointer, '/snapshot'); assert.deepEqual(counts.services, { http: 1, https: 0, dns: 0 }); assert.equal(counts.reserved, 2); assert.equal(counts.ignored_neighbours, 0); assert.equal(topologyLines[1], 'circle-hub doc put bed-topology test-bed-manifest.json'); assert.equal(topologyLines.length, 2);
    const contract = runtimeDocument(); output(dir, 'contract.json', JSON.stringify(contract)); output(dir, 'environment.json', JSON.stringify({ ready: true, device_count: 2 }));
    const args = ['scripts/real/convert/runtime-profile.ts', join(dir, 'environment.json'), join(dir, 'inventory/test-bed-manifest.json'), join(dir, 'contract.json'), '--out', join(dir, 'profile')];
    const draft = spawnSync(process.execPath, args, { encoding: 'utf8' }); assert.equal(draft.status, 0, draft.stderr);
    assert.match(draft.stdout, /^\{"count":\d+,"sha256":"[a-f0-9]{64}"\}\n$/); assert.ok(!draft.stdout.includes('doc put'));
    const check = spawnSync(process.execPath, ['scripts/real/convert/runtime-profile.ts', join(dir, 'profile/runtime-profile.draft.json'), args[2]!, args[3]!, '--check', '--out', join(dir, 'verified')], { encoding: 'utf8' });
    assert.equal(check.status, 1); assert.equal(check.stdout, ''); assert.ok(!check.stderr.includes('widget-seat'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('case CLI keeps identifiers out of stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'convert-'));
  try {
    const map = { root: { data: { text: 'synthetic-root' }, children: Array.from({ length: 5 }, (_, i) => ({ data: { text: 'synthetic-case', priority: 2, auto: 'YES', autoid: `synthetic-case-${i}` } })) } };
    output(dir, 'map.json', JSON.stringify(map));
    const cases = spawnSync(process.execPath, ['scripts/real/convert/auto-cases.ts', join(dir, 'map.json'), '--out', join(dir, 'cases')], { encoding: 'utf8' });
    assert.equal(cases.status, 0, cases.stderr); const receipt = JSON.parse(cases.stdout); assert.equal(receipt.count, 5); assert.match(receipt.sha256, /^[a-f0-9]{64}$/); assert.match(receipt.normalized_sha256, /^[a-f0-9]{64}$/); assert.equal(receipt.transformations, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('original mind map CLI reports normalization hashes and retains the exact upload bytes privately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'convert-original-'));
  try {
    const map = { data: { text: '合成原件' }, children: Array.from({ length: 5 }, (_, i) => ({ data: { text: '合成用例', priority: 2, auto: 'YES', autoid: `synthetic-${i}` } })) };
    const original = '\uffff\uffff' + JSON.stringify([map]); output(dir, 'original.json', original);
    const child = spawnSync(process.execPath, ['scripts/real/convert/auto-cases.ts', join(dir, 'original.json'), '--out', join(dir, 'out')], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); const receipt = JSON.parse(child.stdout); assert.equal(receipt.transformations, 2);
    const provenance = JSON.parse(readFileSync(join(dir, 'out/case-source.normalization.json'), 'utf8')); assert.equal(provenance.transformations.length, 2);
    assert.equal(receipt.normalized_sha256, provenance.normalized_sha256); assert.ok(!child.stdout.includes('synthetic-0'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out/case-source.normalized.json'), 'utf8')), { root: map });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parser diagnostics and explicit bed mapping retain private provenance without exposing source values', async () => {
  const { topology } = await import('./testing.ts'); const { definition } = await import('../../../hub/dispatch/testing/definition.ts'); const { readJson } = await import('./io.ts');
  const dir = mkdtempSync(join(tmpdir(), 'convert-diagnostics-'));
  try {
    const raw = topology(); raw.topology._bed.conf = 'Synthetic_Private_Bed.conf';
    output(dir, 'answer.json', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { snapshot: raw } } })); output(dir, 'executor.json', JSON.stringify({ ...definition('http://127.0.0.1/mcp'), capture_pointers: ['/snapshot'] }));
    const command = ['scripts/real/convert/bed-topology.ts', join(dir, 'answer.json'), '--definition', join(dir, 'executor.json'), '--out', join(dir, 'out')];
    const rejected = spawnSync(process.execPath, command, { encoding: 'utf8' }); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /\/beds\/0\/name.*--bed-name/); assert.ok(!rejected.stderr.includes('Synthetic_Private_Bed.conf'));
    const accepted = spawnSync(process.execPath, [...command, '--bed-name', 'bed-mapped'], { encoding: 'utf8' }); assert.equal(accepted.status, 0, accepted.stderr); assert.ok(!accepted.stdout.includes('Synthetic_Private_Bed.conf'));
    const receipt = JSON.parse(readFileSync(join(dir, 'out/topology-accounting.json'), 'utf8')); assert.deepEqual(receipt.name_mapping, { source: 'Synthetic_Private_Bed.conf', manifest: 'bed-mapped', explicit: true });
    output(dir, 'bad.json', '{synthetic-private-value'); assert.throws(() => readJson(join(dir, 'bad.json'), '合成输入'), error => error instanceof Error && /合成输入.*JSON.*重跑/.test(error.message) && !error.message.includes('synthetic-private-value'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all conversion entries run through symlinked checkouts and refuse missing inputs with nonzero status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'convert-entry-'));
  try {
    symlinkSync(process.cwd(), join(dir, 'checkout'));
    const commands: Array<[string, string[]]> = [['auto-cases.ts', ['missing.json']], ['bed-topology.ts', ['missing.json', '--definition', 'missing-executor.json']], ['check-runtime-contract.ts', ['missing.json', '--expect', 'a'.repeat(64)]], ['runtime-profile.ts', ['missing.json', 'missing-inventory.json', 'missing-contract.json']]];
    for (const [entry, inputs] of commands) {
      const child = spawnSync(process.execPath, [join(dir, 'checkout/scripts/real/convert', entry), ...inputs, '--out', join(dir, 'out')], { encoding: 'utf8' });
      assert.equal(child.status, 1, entry); assert.ok(child.stderr.trim().length > 0, entry); assert.equal(child.stdout, '');
    }
    const contract = runtimeDocument(); output(dir, 'contract.json', JSON.stringify(contract));
    const child = spawnSync(process.execPath, [join(dir, 'checkout/scripts/real/convert/check-runtime-contract.ts'), join(dir, 'contract.json'), '--expect', contract.contract_sha256, '--out', join(dir, 'good')], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /doc put runner-contract/); assert.equal(readFileSync(join(dir, 'good/runtime-contract.json'), 'utf8'), JSON.stringify(contract));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
