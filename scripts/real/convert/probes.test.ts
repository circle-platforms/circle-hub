import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeDocument, profileDocument } from '../../../packs/workflow/case-compile/testing/runtime.ts';
import { MANIFEST_DOC } from '../../../packs/workflow/case-compile/functions/test-support.ts';
import { draftProbes } from './probes.ts';
const probes = [{ seat: 'widget-seat', object: 'widget-seat', method: 'configure', command: 'show fixture-build', purpose: 'build', extract: { pattern: 'build=(?<value>.+)', group: 'value' } }, { seat: 'widget-seat', object: 'widget-seat', method: 'configure', command: 'get fixture-addresses', purpose: 'addresses', extract: { pattern: 'ip=(?<address>[0-9a-f:.]+)', group: 'address' } }];
test('probe drafts use only deployment declarations and exact locked build and seat interface set', () => {
  const contract = runtimeDocument(); const profile = { ...profileDocument(contract), probes };
  const draft = draftProbes(contract, profile, MANIFEST_DOC, 'synthetic-build');
  assert.equal(draft.probes.length, 2); assert.deepEqual(draft.pending, []);
  assert.equal(draft.probes[0]!.expected, 'synthetic-build'); assert.deepEqual(draft.probes[1]!.expected, ['192.0.2.10', '192.0.2.74', '2001:db8:1::10']);
  assert.equal(draft.probes[1]!.device, 'dut0'); assert.equal(draft.probes[1]!.ordinal, 0);
});
test('missing probe categories list seat missing fact and concrete next action without invented commands', () => {
  const contract = runtimeDocument();
  for (const list of [[], [probes[0]]]) {
    const draft = draftProbes(contract, { ...profileDocument(contract), probes: list }, MANIFEST_DOC, 'synthetic-build');
    assert.equal(draft.pending.length, 2 - list.length); assert.equal(draft.probes.length, list.length);
    assert.ok(draft.pending.every((v) => v.seat === 'widget-seat' && v.missing.includes('缺少') && v.next.includes('只读核对')));
  }
});
test('invalid probe commands or missing locked build refuse the entire draft', () => {
  const contract = runtimeDocument();
  assert.throws(() => draftProbes(contract, { ...profileDocument(contract), probes: [...probes, { ...probes[0], command: 'set fixture' }] }, MANIFEST_DOC, 'synthetic-build'));
  assert.throws(() => draftProbes(contract, { ...profileDocument(contract), probes }, MANIFEST_DOC, ''));
});
