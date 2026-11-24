import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { assemble, unsentOf, caseConclusion, deliveryReport, unsuccessfulReport, type CaseOutcome, type Dispatch, type ReportInput } from './delivery.ts';
import { markers, reportStatement } from './text.ts';

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
  assert.match(text, /上机 1 次，最后一次运行器报未通过，这次结果没有被采用，尚不能交付。/);
  assert.doesNotMatch(text, /没有得出结论|\bclosed\b|已确认/);
});
test('run31 shows recorded request roles and local minutes while preserving the raw exit', () => {
  const exit = { action: 'request', request_kind: 'disposition', audience: { user: 'usr_' + '1'.repeat(26) }, due: '2026-11-16T00:00:00.000Z' };
  const originalExit = structuredClone(exit);
  const outcome: CaseOutcome = { autoid: 'a', status: 'unrun', history: [], pending: ['合成缺口'], basis: { plan_run: 'p', attributions: ['data_gap'], gaps: [{ requirement: 'plan', missing: '合成缺口', exit }] } };
  const text = caseConclusion(inputOf(outcome), outcome);
  assert.match(text, /由测试环境管理员处理具名请求，期限 2026-11-16 09:00/);
  assert.equal(text.split('合成缺口').length - 1, 1);
  assert.doesNotMatch(text, /usr_|T00:00|\.000Z/);
  assert.deepEqual(outcome.basis!.gaps[0].exit, originalExit);
});
test('run31 never labels model evidence of an unrun case as checked device output', () => {
  const outcome: CaseOutcome = { autoid: 'a', status: 'unrun', history: [], pending: ['没有取得具名结论'] };
  const input = inputOf(outcome); input.notes.cases.a.evidence = '合成说明出处';
  const report = deliveryReport(input);
  assert.match(report, /模型给出的依据（没有设备输出，未核对）/);
  assert.doesNotMatch(report, /已按照规则核对设备输出/);
});
test('run31 reports omit technical provenance while upstream statements and source identities remain complete', () => {
  const raw = `合成已核对的事实${markers(false, { runtimeVersion: 'synthetic.runtime', digest: 'a'.repeat(64) })}`;
  assert.match(raw, /运行时 synthetic.runtime；身份 aaaaaaaaaaaa/);
  const outcome: CaseOutcome = { autoid: 'a', status: 'unrun', history: [], pending: [raw], basis: { plan_run: 'p', attributions: [], gaps: [{ requirement: 'plan', missing: raw }] } };
  const text = caseConclusion(inputOf(outcome), outcome);
  assert.doesNotMatch(text, /synthetic\.runtime|aaaaaaaaaaaa/);
  assert.match(text, /按发布的运行器合约核对；不证明在真实设备上跑得通/);
  assert.equal(outcome.basis!.gaps[0].missing, raw);
  const other = '用户说明有运行时 synthetic.runtime 与身份 aaaaaaaaaaaa，未提供完整的本包尾注';
  assert.equal(reportStatement(other), other, 'unrecognized prose is never classified or rewritten');
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
  assert.match(caseConclusion(inputOf(outcome), outcome), /由使用者处理具名请求/);
  assert.doesNotMatch(caseConclusion(inputOf(outcome), outcome), /由测试环境管理员处理具名请求/);
  assert.equal((outcome.basis!.gaps[0].exit as {request_kind:string}).request_kind, 'UNDECLARED');
});

test('run31 a writing that appears earlier in the actual history is not described as unissued', () => {
  const outcome: CaseOutcome={autoid:'a',status:'failed',history:[{ordinal:1,run:'r1',job:'j1',terminal:'fail'},{ordinal:2,run:'r2',job:'j2',terminal:'fail'}]};
  const input=inputOf(outcome);input.assembly.unsuccessful={items:['a'],sources:{a:{plan_run:'p1',run:'r1'}}};input.files.unsuccessful={sha256:'a'.repeat(64)};
  const text=deliveryReport(input);
  assert.match(text,/本卷这条写法已在第 1 次上机验证中执行/);
  assert.doesNotMatch(text,/这份写法尚未发到设备/);
});

test('run31 machine data retain the caller facts while reports select the member-safe projection', () => {
  const run='run_'+'a'.repeat(26),admin=[{fact:'synthetic private diagnostic',next_action:'synthetic private recovery'}],member=[{fact:'合成成员可读配置差异',next_action:'由测试环境管理员处理'}];
  const original=structuredClone({admin,member});
  const unissued=unsentOf(run,[{job:'b'.repeat(64),verification_run:run,plan_run:'run_'+'c'.repeat(26),items:['a'],sha256:'d'.repeat(64),ended:'done',outcome:'not_dispatched',frozen:false,result:null,device_return:null,rows:null,missing_facts:admin,member_missing_facts:member}]);
  assert.deepEqual(unissued.missing_facts,original.admin);
  assert.deepEqual(unissued.member_missing_facts,original.member);
  const outcome:CaseOutcome={autoid:'a',status:'unrun',history:[]};const input=inputOf(outcome);input.unsent=[unissued];
  const text=deliveryReport(input);
  assert.match(text,/合成成员可读配置差异/);assert.doesNotMatch(text,/synthetic private/);
  assert.deepEqual(unissued.missing_facts,original.admin,'presentation keeps the original authorized facts intact');
});
