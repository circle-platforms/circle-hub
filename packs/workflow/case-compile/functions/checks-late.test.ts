// A case whose recomposition is bound after the run started is not judged until its record is accepted: every check of its plan is
// unknown, awaiting_step (no repair round), with the five parts of a refusal (what, where, what was seen, what is allowed, next step).
// Once accepted, the record laid over the item (SubjectItem.late) is judged exactly as a frozen one. Synthetic inputs only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAuthorStepCoverage, checkContractShape, checkScenarioFidelity } from './checks.ts';
import { planSubject } from './subject.ts';
import { QUOTE, goodData, subjectOf } from './test-support.ts';
import { RECOMPOSE_RUN, digestOf as recordSha256 } from '../testing/late-binding.ts';

const AUTOID = '990000000000000031';
const waiting = (state: string, extra: Record<string, unknown> = {}) => ({ run: RECOMPOSE_RUN, result: state === 'no_result' ? null : 'rec:' + 'e'.repeat(64), state, item: 'recompose-item-2', autoid: AUTOID, ...extra });
const waitingSubject = (overlay: Record<string, unknown> | undefined, data: unknown = goodData()) => {
  const base = subjectOf(data).subject;
  return { subject: { ...base, recomposition_requested: true, recomposition_late: { slot: 'recomposition_result', run: RECOMPOSE_RUN, source: 'src:' + 'a'.repeat(64), node: 'n/c-2' }, ...(overlay ?? {}) } };
};

test('a plan whose late recomposition is not accepted yet waits, and says what, where, what was seen, what is allowed and what next', () => {
  const seen: Record<string, RegExp> = {
    no_result: new RegExp(`看到：重组运行 ${RECOMPOSE_RUN} 还没有已受理提交（Hub 本次核对时取的，Hub 的答复：合成的 Hub 答复）`),
    pending: new RegExp(`看到：重组运行 ${RECOMPOSE_RUN} 最近受理的结果 rec:eeeeeeeeeeee… 里这一条的 record 要求项 status 为 pending`),
    uncovered: /里没有这一条的 record 要求项/,
    partial: /里这一条的记录 status 为 partial/,
  };
  for (const [state, expected] of Object.entries(seen)) {
    const input = waitingSubject({ recomposition_problem: '合成问题', recomposition_waiting: waiting(state, state === 'no_result' ? { missing: '合成的 Hub 答复' } : {}) });
    const outcomes = checkContractShape(input);
    assert.equal(outcomes.length, 1, state);
    const [outcome] = outcomes;
    assert.equal(outcome.verdict, 'unknown', state);
    assert.equal(outcome.reason, 'awaiting_step', state);
    assert.equal(outcome.missing, outcome.statement);
    const text = outcome.statement;
    assert.ok(text.startsWith(`用例 ${AUTOID} 的重组记录还没有被 Hub 受理，这一条的计划先不核对；`), text);
    assert.ok(text.includes(`位置：inputs.recomposition_result → 重组运行 ${RECOMPOSE_RUN} 的条目 recompose-item-2（要求项 record）`), text);
    assert.match(text, expected);
    assert.ok(text.includes('允许：record 要求项已满足、记录 status 为 complete'), text);
    assert.ok(text.includes(`下一步：等这一条在重组运行 ${RECOMPOSE_RUN} 单条提交并被受理后，原样重交本计划，不用开新的计划运行；`) && text.includes('open-compile'), text);
    assert.deepEqual((outcome.data as any).waiting_for.step, 'recomposition_accepted');
  }
});

test('the checks that read the record wait too, instead of saying the case has no authored action', () => {
  const input = waitingSubject({ recomposition_problem: '合成问题', recomposition_waiting: waiting('no_result') });
  for (const check of [checkAuthorStepCoverage, checkScenarioFidelity]) {
    const outcomes = check(input);
    assert.deepEqual(outcomes.map((o) => [o.verdict, o.reason]), [['unknown', 'awaiting_step']], check.name);
  }
});

test('a late item without any overlay (the local check without late.json) waits and says where the overlay comes from', () => {
  const [outcome] = checkContractShape(waitingSubject(undefined));
  assert.equal(outcome.reason, 'awaiting_step');
  assert.match(outcome.statement, /late\.json/);
  assert.match(outcome.statement, /refresh-late\.ts/);
});

test('a late record that is not waiting but wrong keeps the refusal it always had', () => {
  const outcomes = checkContractShape(waitingSubject({ recomposition_problem: '重组运行的产品与本运行不同' }));
  assert.deepEqual(outcomes.map((o) => [o.verdict, o.reason]), [['unknown', 'missing_input']]);
  assert.match(outcomes[0].statement, /重组记录不可受理：重组运行的产品与本运行不同/);
});

test('the plan subject lays the item\'s late overlay over its frozen fields', () => {
  const proof = { record: { case: { id: AUTOID } }, receipt: 'rec:' + 'e'.repeat(64), late: true, record_sha256: 'f'.repeat(64) };
  const raw = (late?: Record<string, unknown>) => ({ item: { id: 'synthetic-map:case-1', label: '合成', location: QUOTE.reference, fields: { autoid: AUTOID, recomposition_late: { slot: 'recomposition_result', run: RECOMPOSE_RUN } }, ...(late ? { late } : {}) }, context: { groups: [{ kind: 'case-compile', recomposition_requested: true }] }, slots: { plan: [{ data: goodData() }] } });
  const accepted = planSubject(raw({ recomposition: proof }));
  assert.deepEqual(accepted.recomposition, proof);
  assert.equal(accepted.recomposition_waiting, undefined);
  const waits = planSubject(raw({ recomposition_problem: '合成问题', recomposition_waiting: waiting('pending') }));
  assert.equal(waits.recomposition, undefined);
  assert.equal(waits.recomposition_problem, '合成问题');
  assert.deepEqual(waits.recomposition_waiting, waiting('pending'));
  assert.deepEqual(planSubject(raw()).recomposition_late, { slot: 'recomposition_result', run: RECOMPOSE_RUN });
});

test('an accepted late record is judged as the frozen one: by its digest, whatever receipt the plan copied earlier', () => {
  const record = { case: { id: AUTOID, node: 'n/c-1', source_ref: 'src:' + 'a'.repeat(64) }, atoms: [{ id: 'a1', kind: 'expectation', quote_ref: QUOTE.reference, text: QUOTE.text }], expectation_slots: [{ slot: 'e1', atom: 'a1' }] };
  const declaration = { receipt: 'rec:' + '1'.repeat(64), record_sha256: recordSha256(record), case_id: AUTOID, slots: [{ slot: 'e1', assertions: ['1'] }], rebindings: [] };
  const data = { ...goodData(), recomposition: declaration };
  const late = checkContractShape({ subject: { ...subjectOf(data).subject, recomposition_requested: true, recomposition: { record, receipt: 'rec:' + '2'.repeat(64), late: true, record_sha256: recordSha256(record) } } });
  const frozen = checkContractShape({ subject: { ...subjectOf(data).subject, recomposition_requested: true, recomposition: { record, receipt: 'rec:' + '1'.repeat(64) } } });
  assert.deepEqual(late, frozen);
  assert.ok(late.every((o) => o.code !== 'case-compile.slots_invalid'), JSON.stringify(late));
});
