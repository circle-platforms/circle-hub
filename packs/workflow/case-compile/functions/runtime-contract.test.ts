import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { contractCanonical, runtimeDigest, parseRuntimeContract, runtimeMethod } from './runtime-contract.ts';
import { runtimeDocument, signRuntime } from '../testing/runtime.ts';
test('canonical bytes match the runner sorted compact UTF-8 algorithm independently', () => {
  const expected = '{"a":"文字","z":[1,true,null]}';
  assert.equal(contractCanonical({ z: [1, true, null], a: '文字' }), expected);
  assert.equal(runtimeDigest({ z: [1, true, null], contract_sha256: 'ignored', a: '文字' }), createHash('sha256').update(expected, 'utf8').digest('hex'));
});
test('original-format contract identity and enabled selection; defaults never copied', () => {
  const raw = runtimeDocument(); const read = parseRuntimeContract(raw, { digest: raw.contract_sha256, runtimeVersion: raw.runtime.minimum_version });
  assert.equal(read.ok, true, JSON.stringify(read)); if (!read.ok) return;
  assert.equal(read.contract.enabled.length, 5);
  for (const method of ['cycle', 'hidden', 'candidate']) assert.ok(!read.contract.enabled.some((e) => e.method === method));
  assert.equal(runtimeMethod(read.contract, 'widget-seat', 'credential')?.parameters[0].redacted, true);
  assert.ok(!JSON.stringify(read.contract).includes('default'));
});
test('one changed byte or an older correctly signed identity cannot match the published expectation', () => {
  const original = runtimeDocument(); const changed = structuredClone(original); changed.entries[0].reason = 'changed';
  assert.equal(parseRuntimeContract(changed).ok, false);
  const old = structuredClone(original); old.runtime.minimum_version = 'synthetic-runtime-v1';
  assert.equal(parseRuntimeContract(signRuntime(old), { runtimeVersion: original.runtime.minimum_version, digest: original.contract_sha256 }).ok, false);
});
for (const [name, mutate] of Object.entries({
  schema: (v: any) => { v.schema = 'compile-contract@1'; }, complete: (v: any) => { v.complete = false; },
  status: (v: any) => { v.entries[0].status = 'unknown-status'; }, dispatch: (v: any) => { v.entries[0].dispatch = 'unknown-dispatch'; }, kind: (v: any) => { v.entries[0].signature.parameters[0].kind = 'unknown-kind'; },
  authority: (v: any) => { v.entries[0].status_authority = 'unknown-source'; }, object: (v: any) => { v.objects.push(v.objects[0]); }, pair: (v: any) => { v.entries.push(v.entries[0]); }, disabled: (v: any) => { v.objects[0].status = 'disabled'; },
  partition: (v: any) => { v.entries[0].signature.required = []; },
})) test(`whole-document refusal with pointer: ${name}`, () => {
  const raw = runtimeDocument(); mutate(raw); const read = parseRuntimeContract(signRuntime(raw));
  assert.equal(read.ok, false); if (read.ok) return; assert.ok(read.problems.length); assert.ok(read.problems.every((p) => p.pointer.startsWith('/') && p.fix.length > 0));
});
for (const [key, value] of [['float', 1.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['astral-😀', 1]] as const) test(`cannot prove JSON identity for ${key}`, () => {
  const raw = { ...runtimeDocument(), atlas_snapshot: { [key]: value } }; const read = parseRuntimeContract(raw);
  assert.equal(read.ok, false); if (!read.ok) assert.ok(read.problems.some((p) => p.pointer.startsWith('/atlas_snapshot/')));
});
test('all fixed authorities and signed receipt sources are format values', () => {
  for (const authority of ['project_policy:excel-authoring-v1', 'mirror_ast:reachability-and-lifecycle', 'mirror_ast:active-runtime-call-chain', 'mirror_ast:pure-execute-action-v1', 'bed_topology:network_topology.json', `device_receipt_set:${'c'.repeat(64)}`]) {
    const raw = runtimeDocument(); raw.entries[0].status_authority = authority; assert.equal(parseRuntimeContract(signRuntime(raw)).ok, true);
  }
});
test('unpaired surrogate values refuse identity while ordinary astral text remains valid UTF-8', () => {
  assert.throws(() => runtimeDigest({ value: '\ud800' }));
  const raw = runtimeDocument(); (raw.atlas_snapshot as Record<string, unknown>).caption = '合成 😀'; assert.equal(parseRuntimeContract(signRuntime(raw)).ok, true);
});
