// Promotion of device-certified candidates (the case-compile-promotions task, decision 104): a candidate is enabled only when the
// runtime-contract@2 document names it with the device receipt set the original records and gives it typed authority.
// Synthetic contract only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntimeContract, runtimeMethod } from './runtime-contract.ts';
import { typedRuntimeDocument } from '../testing/runtime.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

const RECEIPTS = 'device_receipt_set:' + 'e'.repeat(64);
function candidateContract(options: { authority?: string; typed?: boolean; promotion?: Record<string, unknown> | null } = {}) {
  const doc = typedRuntimeDocument() as any;
  const entry = doc.entries.find((row: any) => row.e === 'widget-seat' && row.f === 'candidate');
  entry.status_authority = RECEIPTS;
  if (options.typed !== false) entry.typed_authority = { source: doc.entries.find((row: any) => row.typed_authority).typed_authority.source.replace(/[^/]*$/, 'candidate'), parameters: {}, effects: ['effect_0'] };
  if (options.promotion !== null) doc.promotions = [{ object: 'widget-seat', method: 'candidate', status_authority: options.authority ?? RECEIPTS, reason: '合成：设备认证已过，发布回放即本次派发', ...(options.promotion ?? {}) }];
  return signTypedRuntime(doc);
}

test('a certification candidate stays disabled without a promotion and is enabled by a promotion with the recorded receipt set', () => {
  const plain = parseRuntimeContract(candidateContract({ promotion: null }));
  assert.ok(plain.ok, JSON.stringify(!plain.ok && plain.problems)); if (!plain.ok) return;
  assert.equal(runtimeMethod(plain.contract, 'widget-seat', 'candidate'), null);
  const promoted = parseRuntimeContract(candidateContract());
  assert.ok(promoted.ok, JSON.stringify(!promoted.ok && promoted.problems)); if (!promoted.ok) return;
  assert.ok(runtimeMethod(promoted.contract, 'widget-seat', 'candidate'));
  assert.equal(promoted.contract.pinned.identity, plain.contract.pinned.identity, 'a promotion is an addition: the original identity is unchanged');
});

test('a promotion with another receipt set, without typed authority, for an entry that is not a candidate or that does not exist refuses the contract', () => {
  for (const doc of [
    candidateContract({ authority: 'device_receipt_set:' + 'f'.repeat(64) }),
    candidateContract({ typed: false }),
    candidateContract({ promotion: { method: 'configure' } }),
    candidateContract({ promotion: { method: 'absent' } }),
    candidateContract({ promotion: { reason: '' } }),
  ]) {
    const read = parseRuntimeContract(doc);
    assert.equal(read.ok, false);
    if (!read.ok) assert.ok(read.problems.some((problem) => problem.pointer.startsWith('/promotions')), JSON.stringify(read.problems));
  }
});
