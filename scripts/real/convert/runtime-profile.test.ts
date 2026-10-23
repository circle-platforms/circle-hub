import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeDocument, entry, signRuntime, profileDocument } from '../../../packs/workflow/case-compile/testing/runtime.ts';
import { parseRuntimeContract } from '../../../packs/workflow/case-compile/functions/runtime-contract.ts';
import { checkCoverage, checkProfile, draftProfile } from './runtime-profile.ts';
import { convertTopology } from './bed-topology.ts';
import { topology } from './testing.ts';
function setup() {
  const original = runtimeDocument();
  const contract = signRuntime({ ...original, entries: [...original.entries.filter((v) => v.f !== 'credential').map((v) => v.f === 'configure' ? { ...v, signature: { ...v.signature, parameters: v.signature.parameters.slice(0, 1), optional: [] } } : v), entry('widget-seat', 'inspect', [{ name: 'query', kind: 'positional_only', required: true, default: null }]), entry('widget-seat', 'opaque', [{ name: 'binary', kind: 'positional_only', required: true, default: null }])] });
  const profile = { ...profileDocument(contract), allowed: [...profileDocument(contract).allowed, { object: 'widget-seat', method: 'inspect', parameters: { query: 'device_cli' } }], unopened: [{ object: 'widget-seat', method: 'opaque', parameters: [{ name: 'binary', missing: '合成二进制参数没有角色', reason: '现有角色无法核验', next: '另开包检查任务，增加角色与筛查' }] }], pending: [] };
  const manifest = convertTopology(topology()); return { contract, profile, manifest };
}
test('profile draft includes all six enabled combinations and separates explicit unopened parameters', () => {
  const { contract, profile, manifest } = setup();
  const draft = draftProfile({ ready: true, device_count: 2 }, manifest, contract, { allowed: profile.allowed, unopened: profile.unopened });
  assert.equal(draft.allowed.length, 5); assert.equal(draft.unopened.length, 1); assert.ok(draft.pending.length);
  assert.ok(draft.allowed.every((v) => v.object !== 'widget-disabled'));
  assert.throws(() => checkProfile(draft, manifest, contract));
  assert.equal(checkProfile(profile, manifest, contract).allowed.length, 5);
});
test('profile check refuses missing extra duplicate roleless and undocumented unopened combinations', () => {
  const { contract, profile, manifest } = setup(); const parsed = parseRuntimeContract(contract); assert.ok(parsed.ok);
  for (const mutate of [(v: any) => v.allowed.pop(), (v: any) => v.allowed.push({ object: 'widget-disabled', method: 'cycle', parameters: {} }), (v: any) => v.unopened.push(v.unopened[0]), (v: any) => delete v.allowed[0].parameters.line, (v: any) => v.unopened[0].parameters[0].next = '']) {
    const bad = structuredClone(profile); mutate(bad); assert.throws(() => checkCoverage(bad, parsed.contract));
  }
  assert.throws(() => checkProfile({ ...profile, runtime: { ...profile.runtime, contract_sha256: 'b'.repeat(64) } }, manifest, contract));
});
test('profile drafts never guess parameter semantics or environment mappings', () => {
  const { contract, manifest } = setup(); const draft = draftProfile({ ready: true, device_count: 2 }, manifest, contract);
  assert.equal(draft.allowed.length, 6); assert.ok(draft.allowed.every((v) => Object.values(v.parameters).every((role) => role === null)));
  assert.equal(draft.seats, null); assert.equal(draft.denied.device, null);
  assert.throws(() => draftProfile({ ready: false, device_count: 2 }, manifest, contract));
  assert.throws(() => draftProfile({ ready: true }, manifest, contract));
});
