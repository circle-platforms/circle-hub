import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { assemble, caseConclusion, deliveryReport, unsuccessfulReport, type CaseOutcome, type Dispatch, type ReportInput } from './delivery.ts';
import { markers } from './text.ts';

const before = process.env.TZ;
process.env.TZ = 'Asia/Tokyo';
after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });
const inputOf = (outcome: CaseOutcome): ReportInput => ({
  name: 'synthetic', generatedAt: '2026-11-16 09:00', build: null,
  assembly: { cases: [outcome], pass: null, unsuccessful: null, totals: { cases: 1, delivered: 0, failed: 0, unsettled: 0, unrun: 1 } },
  notes: { cases: { a: { judged: '合成说明', remedy: '由使用者补齐资料' } } },
  originals: { a: { title: '合成标题', lines: [] } }, excluded: [], files: { pass: null, unsuccessful: null }, logs: {},
});
test('run31 keeps the mapped device judgment apart from the Hub no-verdict', () => {
  const dispatch = { run: 'synthetic', job: 'j', plan_run: 'p', sha256: 'a'.repeat(64), items: ['a'], rows: [{ item: 'a', dynamic_terminal: 'no_verdict', report_check: { mapped_terminal: 'fail' }, missing_facts: ['closed'], missing_fact: '动态完整性前提 closed 未满足', next_action: '请管理员补齐前提 closed' }] } as Dispatch;
  const result = assemble(['a'], [dispatch]).cases[0];
  assert.equal(result.history[0].report_check?.mapped_terminal, 'fail');
  assert.equal(result.history[0].terminal, 'no_verdict');
  const text = caseConclusion(inputOf(result), result);
  assert.match(text, /上机验证的判断：错误（设备自报，状态未确认）/);
  assert.doesNotMatch(text, /设备原判未知|\bclosed\b|状态已确认/);
});
test('run31 shows recorded request roles and local minutes while preserving the raw exit', () => {
  const exit = { action: 'request', request_kind: 'disposition', audience: { user: 'usr_' + '1'.repeat(26) }, due: '2026-11-16T00:00:00.000Z' };
  const outcome: CaseOutcome = { autoid: 'a', status: 'unrun', history: [], pending: ['合成缺口'], basis: { plan_run: 'p', attributions: ['data_gap'], gaps: [{ requirement: 'plan', missing: '合成缺口', exit }] } };
  const text = caseConclusion(inputOf(outcome), outcome);
  assert.match(text, /由测试环境管理员发请求，期限 2026-11-16 09:00/);
  assert.equal(text.split('合成缺口').length - 1, 1);
  assert.doesNotMatch(text, /usr_|T00:00|\.000Z/);
  assert.deepEqual(outcome.basis!.gaps[0].exit, exit);
});
test('run31 never labels model evidence of an unrun case as checked device output', () => {
  const outcome: CaseOutcome = { autoid: 'a', status: 'unrun', history: [], pending: ['没有取得具名结论'] };
  const input = inputOf(outcome); input.notes.cases.a.evidence = '合成说明出处';
  const report = deliveryReport(input);
  assert.match(report, /模型给出的依据（没有设备输出，未核对）/);
  assert.doesNotMatch(report, /已按照规则核对设备输出/);
});
test('run31 user prose omits runtime identifiers and hashes', () => {
  assert.equal(markers(false, { runtimeVersion: 'synthetic.runtime', digest: 'a'.repeat(64) }), '（按发布的运行器合约核对；不证明在真实设备上跑得通）');
});
test('run31 does not print internal references from model prose as a user explanation', () => {
  const outcome: CaseOutcome = { autoid: 'a', status: 'unrun', history: [], pending: ['没有取得具名结论'] };
  const input = inputOf(outcome); input.notes.cases.a.judged = '据 run_' + 'a'.repeat(26) + ' 和 src:' + 'b'.repeat(64) + ' 判断';
  assert.doesNotMatch(deliveryReport(input), /run_[a-z0-9]{26}|src:[a-f0-9]{64}/);
});
test('run31 identifies which actual device attempt a log belongs to without exposing its job identity', () => {
  const outcome: CaseOutcome = { autoid: 'a', status: 'failed', history: [{ ordinal: 2, run: 'r', job: 'c'.repeat(64), terminal: 'fail' }] };
  const input = inputOf(outcome); input.logs.a = { reference: 'src:' + 'd'.repeat(64), job: 'c'.repeat(64), text: '合成设备原话' };
  const text = unsuccessfulReport(input);
  assert.match(text, /第 2 次上机验证的设备输出/);
  assert.doesNotMatch(text, /cccccccccccc/);
});

test('run31 an undeclared request kind retains its raw value without becoming a disposition', () => {
  const outcome: CaseOutcome = { autoid: 'a', status: 'unrun', history: [], pending: ['合成缺口'], basis: { plan_run: 'p', attributions: [], gaps: [{ requirement: 'plan', exit: { action: 'request', request_kind: 'UNDECLARED', audience: { user: 'usr_'+'1'.repeat(26) }, due: '2026-11-16T00:00:00.000Z' } }] } };
  assert.match(caseConclusion(inputOf(outcome), outcome), /由使用者发请求/);
  assert.doesNotMatch(caseConclusion(inputOf(outcome), outcome), /由测试环境管理员发请求/);
  assert.equal((outcome.basis!.gaps[0].exit as {request_kind:string}).request_kind, 'UNDECLARED');
});
