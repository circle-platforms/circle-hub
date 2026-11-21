// The reference engine's pass review (decision 163): a pass whose words carry an execution-failure line that the case's own
// assertions do not read is no verdict, with the markers declared as a runtime-contract@2 addition. Synthetic contract and words only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRuntimeContract } from './runtime-contract.ts';
import { auditKey, auditPasses, failureLine, type Dispatch } from './delivery.ts';
import { CONTRACT_DOC } from './test-support.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';

const SHA = 'a'.repeat(64);
const MARKERS = { source: 'reference-engine/domain_grammar.json', sha256: SHA, lines: ['Failed to run the synthetic command', 'synthetic transfer failed'] };
function contractWith(additions: { markers?: unknown }) {
  const doc = structuredClone(CONTRACT_DOC) as Record<string, any>;
  if (additions.markers !== undefined) doc.exec_failure_markers = additions.markers;
  return signTypedRuntime(doc);
}

test('the markers are an @2 addition: declared, parsed, and removed when the original identity is recovered', () => {
  const plain = parseRuntimeContract(signTypedRuntime(structuredClone(CONTRACT_DOC)));
  const both = parseRuntimeContract(contractWith({ markers: MARKERS }));
  assert.ok(plain.ok && both.ok, JSON.stringify(both));
  assert.equal(both.contract.pinned.identity, plain.contract.pinned.identity, 'the original contract the gateway pins is the same');
  assert.deepEqual(both.contract.failureMarkers, MARKERS);
  assert.equal(plain.contract.failureMarkers, undefined);
  for (const [markers, pointer] of [[{ ...MARKERS, lines: ['two\nlines'] }, '/exec_failure_markers'], [{ ...MARKERS, sha256: 'x' }, '/exec_failure_markers'], [{ ...MARKERS, lines: [] }, '/exec_failure_markers'], [{ ...MARKERS, extra: 1 }, '/exec_failure_markers']] as const) {
    const refused = parseRuntimeContract(contractWith({ markers }));
    assert.ok(!refused.ok && refused.problems.some((p) => p.pointer === pointer), JSON.stringify(markers));
  }
});

test('a marker line its own assertions do not read is found; one an assertion reads is exempt, as in the reference engine', () => {
  const words = { '运行日志': 'sends command in config: configure widget\r\nFailed to run the synthetic command\r\nchecked' };
  assert.deepEqual(failureLine(words, MARKERS.lines, ['widget ready']), { where: '运行日志', line: 'Failed to run the synthetic command' });
  assert.equal(failureLine(words, MARKERS.lines, ['Failed to run the synthetic command']), null, 'a negative case asserting the refusal reads that line');
  assert.equal(failureLine({ '运行日志': 'nothing failed here' }, MARKERS.lines, []), null);
  assert.equal(failureLine(words, [], []), null, 'no declared markers, no review');
  // The runner prints each step's description before the step (`#######   stepN: <description>`): that line is the workbook's
  // own text, not device output, so a description quoting an earlier refusal is no failure line; the device's line still is.
  const banner = '2026-01-01 00:00:00 #######   step5: 前置（上一轮设备回显 Failed to run the synthetic command，已去掉预清除步）';
  assert.equal(failureLine({ '运行日志': banner + '\n2026-01-01 00:00:01 widget ready' }, MARKERS.lines, ['widget ready']), null, 'a step description is not output');
  assert.deepEqual(failureLine({ '运行日志': banner + '\n2026-01-01 00:00:01 Failed to run the synthetic command' }, MARKERS.lines, ['widget ready']), { where: '运行日志', line: '2026-01-01 00:00:01 Failed to run the synthetic command' });
});

test('an audited pass becomes no verdict carrying its line; other rows stay as reported', () => {
  const d: Dispatch = { run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), plan_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', sha256: SHA, items: ['990000000000000201', '990000000000000202', '990000000000000203'], rows: [
    { item: '990000000000000201', dynamic_terminal: 'pass' }, { item: '990000000000000202', dynamic_terminal: 'pass' }, { item: '990000000000000203', dynamic_terminal: 'fail' }] };
  const hit = { where: '运行日志', line: 'synthetic transfer failed' };
  const [audited] = auditPasses([d], new Map([[auditKey(d.run, '990000000000000201'), hit], [auditKey(d.run, '990000000000000203'), hit]]));
  assert.deepEqual(audited.rows.map((r) => [r.dynamic_terminal, r.audit ?? null]), [['no_verdict', hit], ['pass', null], ['fail', null]]);
  assert.equal(d.rows[0].dynamic_terminal, 'pass', 'the input is not changed');
});
