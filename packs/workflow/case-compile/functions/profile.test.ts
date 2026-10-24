import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeDocument, profileDocument, signRuntime } from '../testing/runtime.ts';
import { parseRuntimeContract, runtimeDigest } from './runtime-contract.ts';
import { parseProfile } from './profile.ts';
import { bedsOf } from './test-support.ts';
const read = parseRuntimeContract(runtimeDocument()); if (!read.ok) throw new Error('fixture');
const contract = read.contract;
test('profile binds runtime identity, workbook literals, seats and allowed parameter roles', () => {
  const result = parseProfile(profileDocument(), contract, bedsOf()); assert.equal(result.ok, true, JSON.stringify(result));
});
for (const [name, mutate] of Object.entries({
  identity: (v: any) => { v.runtime.contract_sha256 = 'b'.repeat(64); }, seat: (v: any) => { v.seats[0].device = 'absent'; }, host: (v: any) => { v.hosts[0].device = 'absent'; },
  allowed: (v: any) => { v.allowed[0].method = 'hidden'; }, role: (v: any) => { v.allowed[0].parameters.line = 'unknown-role'; },
  ordinal: (v: any) => { v.seats[0].ordinal = -1; }, header: (v: any) => { v.workbook.header.pop(); }, pattern: (v: any) => { v.workbook.autoid_pattern = '['; }, synthetic: (v: any) => { delete v.synthetic; },
})) test(`whole-profile refusal with pointer: ${name}`, () => {
  const raw = profileDocument(); mutate(raw); const result = parseProfile(raw, contract, bedsOf()); assert.equal(result.ok, false); if (!result.ok) assert.ok(result.problems.every((p) => p.pointer.startsWith('/') && p.fix.length));
});
test('profile lists all independent problems in one refusal', () => {
  const raw = profileDocument(); raw.seats[0].device = 'missing'; raw.runtime.contract_sha256 = 'b'.repeat(64); raw.allowed[0].parameters.line = 'missing';
  const result = parseProfile(raw, contract, bedsOf()); assert.equal(result.ok, false); if (!result.ok) assert.ok(result.problems.length >= 3);
});
test('a signature name matching an object prototype member retains its declared role', () => {
  const raw = runtimeDocument(); raw.entries[0].signature.parameters[0].name = '__proto__'; raw.entries[0].signature.required[0] = '__proto__';
  const signed = { ...raw, contract_sha256: '' }; signed.contract_sha256 = runtimeDigest(signed);
  const parsed = parseRuntimeContract(signed); assert.ok(parsed.ok); if (!parsed.ok) return;
  const profile = profileDocument(signed); profile.allowed[0].parameters = JSON.parse('{"__proto__":"device_cli"}');
  const result = parseProfile(profile, parsed.contract, bedsOf()); assert.ok(result.ok); if (result.ok) assert.equal(Object.getOwnPropertyDescriptor(result.profile.allowed[0].parameters, '__proto__')?.value, 'device_cli');
});
test('device count is an explicit precheck fact and folded methods must be allowed', () => {
  const raw = profileDocument(); raw.device_count = 0;
  assert.equal(parseProfile(raw, contract, bedsOf()).ok, false);
  raw.device_count = 2; raw.fold_newlines = [{ object: 'widget-seat', method: 'configure' }];
  assert.equal(parseProfile(raw, contract, bedsOf()).ok, true);
  raw.fold_newlines.push({ object: 'widget-seat', method: 'missing' });
  assert.equal(parseProfile(raw, contract, bedsOf()).ok, false);
});

// ---- the two-argument checkpoints' `result` (the case-compile-real-contract task) ----
/** A contract whose assertion method is a two-argument checkpoint: required `result` (the executor provides the previous
 *  step's return) and required `expected` (the literal expectation). */
function checkpointDocuments() {
  const contractDoc = runtimeDocument();
  contractDoc.entries[2] = { ...contractDoc.entries[2], dispatch: 'checkpoint_two_argument', signature: { parameters: [
    { name: 'result', kind: 'positional_or_keyword', required: true, default: null },
    { name: 'expected', kind: 'positional_or_keyword', required: true, default: null },
  ], required: ['result', 'expected'], optional: [], text: '(result, expected)' } };
  const signed = signRuntime(contractDoc as unknown as Record<string, unknown>);
  const profileDoc = profileDocument(signed as unknown as ReturnType<typeof runtimeDocument>);
  delete (profileDoc as Record<string, unknown>).denied;
  (profileDoc.allowed[2] as Record<string, unknown>).parameters = { result: 'executor_return', expected: 'literal_assertion' };
  return { signed, profileDoc };
}
test("a two-argument checkpoint passes with result configured executor_return: the executor provides the previous return, not the model", () => {
  const { signed, profileDoc } = checkpointDocuments();
  const parsed = parseRuntimeContract(signed); assert.ok(parsed.ok); if (!parsed.ok) return;
  const result = parseProfile(profileDoc, parsed.contract, bedsOf());
  assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
  assert.equal(result.profile.digest, parsed.contract.pinned.identity);
});
test('the same checkpoint without the executor role on result is refused, and an unknown role stays refused', () => {
  const { signed, profileDoc } = checkpointDocuments();
  const parsed = parseRuntimeContract(signed); assert.ok(parsed.ok); if (!parsed.ok) return;
  const noRole = structuredClone(profileDoc); delete (noRole.allowed[2] as { parameters: Record<string, unknown> }).parameters.result;
  const refused = parseProfile(noRole, parsed.contract, bedsOf());
  assert.equal(refused.ok, false); if (!refused.ok) assert.ok(refused.problems.some((p) => p.pointer === '/allowed'));
  const unknown = structuredClone(profileDoc); ((unknown.allowed[2] as unknown as { parameters: Record<string, string> }).parameters).result = 'model_writes';
  assert.equal(parseProfile(unknown, parsed.contract, bedsOf()).ok, false);
});
