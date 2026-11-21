// A recomposition bound after the run started is named in the plan by its own digest (record_sha256), not by the receipt of the
// whole recompose result: another case of the same recompose run being accepted makes a new result with a new receipt, and must
// not refute a plan whose own record did not change (docs/hub-r4-tasks/t18-late-binding.md, section 4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admittedRecomposition, recompositionGaps, recompositionProblem } from './recomposition.ts';
import type { PlanSlots } from './slots.ts';
import { RECOMPOSE_RUN, boundRecord, digestOf, recordRow, resultBody, runBody, twoCases } from '../testing/late-binding.ts';

const SOURCE = 'src:' + 'a'.repeat(64);
const QUOTE_REF = SOURCE + '/kityminder@1/n/e1';
const QUOTE_TEXT = '合成期望原句';
const RECORD = { case: { id: 'synthetic-case-1', node: 'n/c1', source_ref: SOURCE }, atoms: [{ id: 'a6', kind: 'expectation', quote_ref: QUOTE_REF, text: QUOTE_TEXT }], expectation_slots: [{ slot: 'e1', atom: 'a6' }] };
const DIGEST = digestOf(RECORD);
const OLD_RECEIPT = 'rec:' + '1'.repeat(64), NEW_RECEIPT = 'rec:' + '2'.repeat(64);
const lateProof = (receipt = NEW_RECEIPT): any => ({ record: RECORD, receipt, run: RECOMPOSE_RUN, source: SOURCE, conditional_on_judgment: true, record_sha256: DIGEST, late: true });
const plan = (recomposition?: unknown): PlanSlots => ({ bucket: 'bed-a', blocks: [], steps: [], replacements: [], expects: [{ text: QUOTE_TEXT, quote: { reference: QUOTE_REF, text: QUOTE_TEXT }, after: 1 }], ...(recomposition === undefined ? {} : { recomposition }) }) as unknown as PlanSlots;
const declared = (over: Record<string, unknown> = {}) => ({ receipt: OLD_RECEIPT, record_sha256: DIGEST, case_id: 'synthetic-case-1', slots: [{ slot: 'e1', assertions: ['1'] }], rebindings: [], ...over });

test('the admitted record carries sha256 of its canonical JSON', () => {
  const { records, context } = twoCases();
  const run = boundRecord('recomposition_run', 'run', runBody(records, context), 'f'.repeat(64));
  const result = boundRecord('recomposition_result', 'validation_result', resultBody([recordRow('recompose-item-1', records[0])]), 'e'.repeat(64));
  const proof = admittedRecomposition(run, result, context, records[0].case.source_ref, records[0].case.node);
  assert.ok(proof);
  assert.equal(proof.record_sha256, digestOf(records[0]));
  assert.match(proof.record_sha256, /^[0-9a-f]{64}$/);
});

test('a late record is checked by its digest: a plan written against an older result of the same record is not refuted', () => {
  // Red before: the receipt of the whole result was compared, and another case's acceptance refuted this plan.
  assert.deepEqual(recompositionGaps(plan(declared()), lateProof(), { item: 'synthetic-map:case-1' }), []);
});

test('a late record whose digest the plan does not name is refuted with the value seen, the value allowed and where late.json shows it', () => {
  const stale = 'b'.repeat(64);
  const issues = recompositionGaps(plan(declared({ record_sha256: stale })), lateProof(), { item: 'synthetic-map:case-1' });
  assert.equal(issues.length, 1, JSON.stringify(issues));
  assert.equal(issues[0].verdict, 'refute');
  for (const part of ['/slots/plan/0/data/recomposition/record_sha256', JSON.stringify(stale), JSON.stringify(DIGEST), 'late.json', 'synthetic-map:case-1', '/late/recomposition/record_sha256', '重新被受理过', '下一步'])
    assert.ok(issues[0].message.includes(part), `missing ${part} in ${issues[0].message}`);
  assert.ok(!issues[0].message.includes('/receipt：'), 'the receipt is not what is refused');
  // A plan that names no digest at all is told the same.
  const { record_sha256: _omitted, ...without } = declared();
  assert.equal(recompositionGaps(plan(without), lateProof()).map((issue) => issue.verdict).join(), 'refute');
});

test('a plan without the declaration is given one that names the late record by its digest', () => {
  const issues = recompositionGaps(plan(), lateProof(), { item: 'synthetic-map:case-1' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].verdict, 'unknown');
  assert.ok(issues[0].message.includes(`"record_sha256":"${DIGEST}"`), issues[0].message);
  assert.ok(issues[0].message.includes('late.json'), issues[0].message);
});

test('a frozen record is still checked by its receipt, and a digest it declares must be the record\'s', () => {
  const frozen = { ...lateProof(OLD_RECEIPT), late: undefined };
  assert.deepEqual(recompositionGaps(plan(declared()), frozen), []);
  assert.equal(recompositionGaps(plan(declared({ receipt: NEW_RECEIPT })), frozen)[0].verdict, 'refute');
  assert.equal(recompositionGaps(plan(declared({ record_sha256: 'b'.repeat(64) })), frozen)[0].verdict, 'refute');
  const { record_sha256: _omitted, ...without } = declared();
  assert.deepEqual(recompositionGaps(plan(without), frozen), [], 'a frozen plan need not name the digest');
});

test('a late result the Hub could not resolve yet reads as waiting, a frozen absent result keeps its binding words', () => {
  const { records, context } = twoCases();
  const run = boundRecord('recomposition_run', 'run', runBody(records, context), 'f'.repeat(64));
  const late = recompositionProblem(run, null, context, records[0].case.source_ref, records[0].case.node, { run: RECOMPOSE_RUN, missing: '运行还没有已受理提交' });
  assert.match(late, new RegExp(`重组运行 ${RECOMPOSE_RUN} 还没有已受理提交（Hub 的答复：运行还没有已受理提交）；等这一条在重组运行 ${RECOMPOSE_RUN} 单条提交并被受理`));
  assert.match(recompositionProblem(run, null, context, records[0].case.source_ref, records[0].case.node), /recomposition_result 绑的是 未绑定/);
});
