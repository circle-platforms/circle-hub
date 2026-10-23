import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeDocument, profileDocument } from '../testing/runtime.ts';
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
