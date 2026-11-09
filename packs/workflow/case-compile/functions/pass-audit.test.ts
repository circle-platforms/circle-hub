// The reference engine's pass review (decision 163): a pass whose words carry an execution-failure line that the case's own
// assertions do not read is no verdict, with the markers and the check point's match register declared as runtime-contract@2
// additions. Synthetic contract and words only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRuntimeContract } from './runtime-contract.ts';
import { auditKey, auditPasses, failureLine, type Dispatch } from './delivery.ts';
import { CONTRACT_DOC } from './test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

const SHA = 'a'.repeat(64);
const MARKERS = { source: 'reference-engine/domain_grammar.json', sha256: SHA, lines: ['Failed to run the synthetic command', 'synthetic transfer failed'] };
const REGISTER = { source: 'lib/check_point.py', sha256: 'b'.repeat(64), attribute: 'matched' };
function contractWith(additions: { markers?: unknown; register?: unknown }) {
  const doc = structuredClone(CONTRACT_DOC) as Record<string, any>;
  if (additions.markers !== undefined) doc.exec_failure_markers = additions.markers;
  if (additions.register !== undefined) doc.runtime = { ...doc.runtime, checkpoint_match_register: additions.register };
  return signTypedRuntime(doc);
}

test('the markers and the match register are @2 additions: declared, parsed, and removed when the original identity is recovered', () => {
  const plain = parseRuntimeContract(signTypedRuntime(structuredClone(CONTRACT_DOC)));
  const both = parseRuntimeContract(contractWith({ markers: MARKERS, register: REGISTER }));
  assert.ok(plain.ok && both.ok, JSON.stringify(both));
  assert.equal(both.contract.pinned.identity, plain.contract.pinned.identity, 'the original contract the gateway pins is the same');
  assert.deepEqual(both.contract.failureMarkers, MARKERS);
  assert.deepEqual(both.contract.matchRegister, REGISTER);
  assert.equal(plain.contract.failureMarkers, undefined);
  for (const [markers, pointer] of [[{ ...MARKERS, lines: ['two\nlines'] }, '/exec_failure_markers'], [{ ...MARKERS, sha256: 'x' }, '/exec_failure_markers'], [{ ...MARKERS, lines: [] }, '/exec_failure_markers'], [{ ...MARKERS, extra: 1 }, '/exec_failure_markers']] as const) {
    const refused = parseRuntimeContract(contractWith({ markers }));
    assert.ok(!refused.ok && refused.problems.some((p) => p.pointer === pointer), JSON.stringify(markers));
  }
  const badRegister = parseRuntimeContract(contractWith({ register: { ...REGISTER, attribute: 'Matched' } }));
  assert.ok(!badRegister.ok && badRegister.problems.some((p) => p.pointer === '/runtime/checkpoint_match_register'));
});

test('a marker line its own assertions do not read is found; one an assertion reads is exempt, as in the reference engine', () => {
  const words = { '设备会话 dev-a.txt': 'seat# configure widget\r\nFailed to run the synthetic command\r\nseat#', '运行日志': 'sends command in config: configure widget' };
  assert.deepEqual(failureLine(words, MARKERS.lines, ['widget ready']), { where: '设备会话 dev-a.txt', line: 'Failed to run the synthetic command' });
  assert.equal(failureLine(words, MARKERS.lines, ['Failed to run the synthetic command']), null, 'a negative case asserting the refusal reads that line');
  assert.equal(failureLine({ '运行日志': 'nothing failed here' }, MARKERS.lines, []), null);
  assert.equal(failureLine(words, [], []), null, 'no declared markers, no review');
});

test('an audited pass becomes no verdict carrying its line; other rows stay as reported', () => {
  const d: Dispatch = { run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), plan_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', sha256: SHA, items: ['990000000000000201', '990000000000000202', '990000000000000203'], rows: [
    { item: '990000000000000201', dynamic_terminal: 'pass' }, { item: '990000000000000202', dynamic_terminal: 'pass' }, { item: '990000000000000203', dynamic_terminal: 'fail' }] };
  const hit = { where: '设备会话 dev-a.txt', line: 'synthetic transfer failed' };
  const [audited] = auditPasses([d], new Map([[auditKey(d.run, '990000000000000201'), hit], [auditKey(d.run, '990000000000000203'), hit]]));
  assert.deepEqual(audited.rows.map((r) => [r.dynamic_terminal, r.audit ?? null]), [['no_verdict', hit], ['pass', null], ['fail', null]]);
  assert.equal(d.rows[0].dynamic_terminal, 'pass', 'the input is not changed');
});
