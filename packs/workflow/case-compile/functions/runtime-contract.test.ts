import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { contractCanonical, runtimeDigest, parseRuntimeContract, runtimeMethod, RUNTIME_ADDITIONS, stripAdditions } from './runtime-contract.ts';
import { isRecord } from './text.ts';
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

// ---- real-contract shape (the case-compile-real-contract task): object names in `e`, @2 carries the pinned original ----
function eKeyedDocument() {
  const raw = runtimeDocument();
  raw.objects = raw.objects.map((object: { name: string; status: string }) => ({ e: object.name, status: object.status })) as unknown as typeof raw.objects;
  return signRuntime(raw);
}
test('object names in the key e are read; name stays accepted; both present and equal is fine', () => {
  const read = parseRuntimeContract(eKeyedDocument(), { digest: eKeyedDocument().contract_sha256, runtimeVersion: 'synthetic-runtime-v2' });
  assert.equal(read.ok, true, JSON.stringify(read)); if (!read.ok) return;
  assert.deepEqual(read.contract.objects, ['widget-seat', 'widget-host', 'widget-check', 'widget-clock', 'widget-disabled']);
  const both = eKeyedDocument(); (both.objects[0] as unknown as Record<string, unknown>).name = 'widget-seat';
  assert.equal(parseRuntimeContract(signRuntime(both)).ok, true);
});
test('an object writing both e and name with different values is refused whole-document', () => {
  const raw = eKeyedDocument(); (raw.objects[0] as unknown as Record<string, unknown>).name = 'another-seat';
  const read = parseRuntimeContract(signRuntime(raw));
  assert.equal(read.ok, false); if (!read.ok) assert.ok(read.problems.some((p) => p.pointer === '/objects/0/e'));
});
/** A @2 document built on an original: additions on top, the original declared by identity and byte digest. */
function v2Document(original: ReturnType<typeof runtimeDocument>) {
  const originalBytes = Buffer.from(contractCanonical(original), 'utf8');
  const originalIdentity = runtimeDigest(original);
  const bytes = createHash('sha256').update(originalBytes).digest('hex');
  const base: Record<string, unknown> = { ...original, schema: 'runtime-contract@2' };
  base.entries = (base.entries as Array<Record<string, unknown>>).map((entry) => ({ ...entry, typed_authority: { source: 'fixture:synthetic' } }));
  const withAdditions = { ...base, types: { fixture: true }, roles: {}, effects: {} };
  return { document: signRuntime({ ...withAdditions, original: { contract_sha256: originalIdentity, sha256: bytes } }), originalIdentity, bytes, canonical: contractCanonical(original) };
}
test('a runtime-contract@2 document declares the pinned original: stripping the additions recovers it and the pinned identity is the original one', () => {
  const original = runtimeDocument(); const v2 = v2Document(original);
  const read = parseRuntimeContract(v2.document);
  assert.equal(read.ok, true, JSON.stringify(read)); if (!read.ok) return;
  assert.equal(read.contract.pinned.identity, v2.originalIdentity, '钉住的身份是原合约的规范身份，不是 @2 重算的摘要');
  assert.notEqual(read.contract.digest, v2.originalIdentity);
  assert.equal(read.contract.pinned.bytes, v2.bytes);
  // Removing the additions recovers the original contract exactly: same canonical bytes, same identity.
  const recovered = stripAdditions(v2.document as Record<string, unknown>)!;
  assert.equal(contractCanonical(recovered), v2.canonical, '去掉增补后逐字节恢复原合约的规范形式');
  assert.equal(runtimeDigest(recovered), v2.originalIdentity);
});
test('stripping runtime.block_model recovers the original canonical digest and the @2 document still parses', () => {
  const original = runtimeDocument();
  const built = v2Document(original);
  const document = structuredClone(built.document) as Record<string, any>;
  document.runtime = { ...document.runtime, block_model: { schema: 'case-compile.block-runtime@1', synthetic: true } };
  delete document.contract_sha256;
  const signed = signRuntime(document);
  const recovered = stripAdditions(signed)!;
  assert.ok(isRecord(recovered.runtime));
  assert.equal(recovered.runtime.block_model, undefined);
  assert.equal(recovered.runtime.runner_sha256, original.runtime.runner_sha256);
  assert.equal(recovered.runtime.found_times_supported, original.runtime.found_times_supported);
  assert.equal(runtimeDigest(recovered), built.originalIdentity);
  assert.equal(contractCanonical(recovered), built.canonical);
  const read = parseRuntimeContract(signed);
  assert.equal(read.ok, true, JSON.stringify(read));
});
test('runtime.block_model and runtime.checkpoint_two_argument strip back to the original digest and the @2 document still parses', () => {
  const original = runtimeDocument();
  const built = v2Document(original);
  const document = structuredClone(built.document) as Record<string, any>;
  document.runtime = { ...document.runtime, checkpoint_two_argument: true, block_model: { schema: 'case-compile.block-runtime@1', synthetic: true } };
  delete document.contract_sha256;
  const signed = signRuntime(document);
  const recovered = stripAdditions(signed)!;
  assert.ok(isRecord(recovered.runtime));
  assert.equal(recovered.runtime.block_model, undefined);
  assert.equal(recovered.runtime.checkpoint_two_argument, undefined);
  assert.equal(recovered.runtime.runner_sha256, original.runtime.runner_sha256);
  assert.equal(recovered.runtime.found_times_supported, original.runtime.found_times_supported);
  assert.equal(runtimeDigest(recovered), built.originalIdentity);
  assert.equal(contractCanonical(recovered), built.canonical);
  const read = parseRuntimeContract(signed);
  assert.equal(read.ok, true, JSON.stringify(read));
});
test('a runtime field other than the closed additions still refuses the pinned original identity', () => {
  const built = v2Document(runtimeDocument());
  const document = structuredClone(built.document) as Record<string, any>;
  document.runtime = { ...document.runtime, checkpoint_two_argument: true, block_model: { schema: 'case-compile.block-runtime@1' } };
  for (const mutate of [
    (value: Record<string, any>) => { value.runtime.found_times_supported = true; },
    (value: Record<string, any>) => { value.runtime.runner_sha256 = 'b'.repeat(64); },
    (value: Record<string, any>) => { value.runtime.synthetic_extra = true; },
  ]) {
    const tampered = structuredClone(document);
    mutate(tampered);
    delete tampered.contract_sha256;
    const read = parseRuntimeContract(signRuntime(tampered));
    assert.equal(read.ok, false);
    if (!read.ok) assert.ok(read.problems.some((problem) => problem.pointer === '/original'));
  }
});
test('a runtime without block_model or checkpoint_two_argument recovers the same original identity', () => {
  const built = v2Document(runtimeDocument());
  const document = built.document as Record<string, unknown>;
  assert.deepEqual(RUNTIME_ADDITIONS, ['block_model', 'checkpoint_two_argument']);
  assert.ok(isRecord(document.runtime));
  assert.equal(document.runtime.block_model, undefined);
  assert.equal(document.runtime.checkpoint_two_argument, undefined);
  const recovered = stripAdditions(document)!;
  assert.equal(recovered.runtime, document.runtime);
  assert.equal(runtimeDigest(recovered), built.originalIdentity);
  assert.equal(contractCanonical(recovered), built.canonical);
  assert.equal(parseRuntimeContract(built.document).ok, true);
});
test('the expected identity of a @2 document is the pinned original, not the recomputed @2 digest', () => {
  const v2 = v2Document(runtimeDocument());
  const good = parseRuntimeContract(v2.document, { digest: v2.originalIdentity, runtimeVersion: 'synthetic-runtime-v2' });
  assert.equal(good.ok, true, JSON.stringify(good));
  const wrong = parseRuntimeContract(v2.document, { digest: (v2.document as { contract_sha256: string }).contract_sha256, runtimeVersion: 'synthetic-runtime-v2' });
  assert.equal(wrong.ok, false);
});
for (const [name, mutate] of Object.entries({
  missing: (v: any) => { delete v.original; },
  shape: (v: any) => { v.original = { contract_sha256: 'not-a-digest' }; },
  wrongIdentity: (v: any) => { v.original.contract_sha256 = 'b'.repeat(64); },
})) test(`a @2 document without a verifiable original declaration is refused: ${name}`, () => {
  const v2 = v2Document(runtimeDocument()); mutate(v2.document);
  const read = parseRuntimeContract(signRuntime(v2.document));
  assert.equal(read.ok, false); if (!read.ok) assert.ok(read.problems.some((p) => p.pointer.startsWith('/original') || p.pointer === '/contract_sha256'));
});
