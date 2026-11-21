// A workbook holds several cases and the runner runs them in one test: an exception in one case ends the whole run, and the
// cases after it never begin (InfoTest lib/test_xlsx.py test_xlsx has no per-case guard). Synthetic logs and rows only.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as delivery from './delivery.ts';
import type { CaseOutcome, Dispatch, JobRow, ReportInput } from './delivery.ts';

const before = process.env.TZ;
process.env.TZ = 'Asia/Tokyo';
after(() => { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; });

const A = '990000000000000501', B = '990000000000000502', C = '990000000000000503';
const NEXT = '修正前一条后重新上机；本次不算本条的一次上机';
const why = (title: string, step: string) => `同一份自动化用例 Excel 中排在前面的原始用例 ${A} ${title} ${step}出现异常，运行器中止了整本，本条没有在设备上执行`;
/** The runner's log of a case whose step raised: the framework's closing block, then pytest's report of the exception (InfoTest conftest.py report.longreprtext, check_point.py close()). */
const aborted = [
  '2026-11-17 07:08:56 ***********************    case discription    ***********************',
  '2026-11-17 07:08:56 #######   step2: 合成分组>合成用例 501',
  '2026-11-17 07:08:56 192.0.2.10 - sends command in config: widget on',
  '2026-11-17 07:08:58 #######   step9: 按声明的行列结构取一格',
  '2026-11-17 07:09:01 192.0.2.10 - sends command in config: clear widget all',
  '2026-11-17 07:09:03 #',
  '2026-11-17 07:09:03 ################# The failed check point num:   0   ####',
  '2026-11-17 07:09:03 #',
  '2026-11-17 07:09:03 ################# The passed check point num:   0   ####',
  '2026-11-17 07:09:03 #',
  '2026-11-17 07:09:03 request = <FixtureRequest for <Function test_xlsx[case.xlsx]>>',
  '2026-11-17 07:09:03 ',
  '2026-11-17 07:09:03     def test_xlsx(request, logger, check_point):',
  '2026-11-17 07:09:03 >       return invoke(request, logger, check_point)',
  '2026-11-17 07:09:03 ',
  '2026-11-17 07:09:03 lib/test_xlsx.py:1101: in test_xlsx',
  '2026-11-17 07:09:03 E       lib.CellSelectionError: 取不到：没有符合声明形状的行；位置：数据行',
  '2026-11-17 07:09:03 E       设备原话：',
  '2026-11-17 07:09:03 ######################      FAIL      ####################',
  '2026-11-17 07:09:03 #',
].join('\n') + '\n';
/** A case that failed a check point and the run went on: the same FAIL banner, no exception. */
const failedCheck = [
  '2026-11-17 07:08:56 #######   step2: 合成分组>合成用例 501',
  '2026-11-17 07:08:58 #######   step3: 合成断言',
  '2026-11-17 07:08:58 fail to find: widget ready',
  '2026-11-17 07:09:03 ################# The failed check point num:   1   ####',
  '2026-11-17 07:09:03 ################# The passed check point num:   0   ####',
  '2026-11-17 07:09:03 ######################      FAIL      ####################',
].join('\n') + '\n';
const plain = '2026-11-17 07:08:58 #######   step2: 合成分组>合成用例 502\n2026-11-17 07:09:03 ######################      PASS      ####################\n';
const reach = (item: string, log: string | null, reached = log !== null) => ({ item, reached, log });

test('a log that ends in the runner exception names the last step it printed before it; a failed check point is no exception', () => {
  assert.deepEqual(delivery.runnerAbort(aborted), { step: 9 });
  assert.equal(delivery.runnerAbort(failedCheck), null, 'the same FAIL banner without a traceback is a failed case, and the run went on');
  assert.equal(delivery.runnerAbort(plain), null);
  const unnumbered = aborted.split('\n').filter((line) => !/#######\s+step/.test(line)).join('\n');
  assert.deepEqual(delivery.runnerAbort(unnumbered), { step: null }, 'no step line printed: the step is not made up');
  assert.deepEqual(delivery.runnerAbort(aborted.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} /gm, '')), { step: 9 }, 'the logger prefix is not part of the structure');
  assert.equal(delivery.runnerAbort('E       not a report: there is no source line marked above it\n'), null);
});

test('the cases after the last case the run reached are not executed when that case ended in the exception, and only then', () => {
  const titles = (item: string) => ({ [A]: '合成用例 501' })[item];
  const found = delivery.unexecutedRows([A, B, C], [reach(A, aborted), reach(B, null), reach(C, null)], titles);
  assert.deepEqual([...found.keys()], [B, C]);
  assert.deepEqual(found.get(B), { by: { item: A, step: 9 }, reason: why('合成用例 501', '在第 9 步'), next_action: NEXT });
  assert.deepEqual(found.get(C), found.get(B), 'every later case names the same case and step');
  assert.equal(delivery.unexecutedRows([A, B], [reach(A, aborted), reach(B, null)]).get(B)?.reason, why('标题未知', '在第 9 步'), 'no title known');
  assert.equal(delivery.unexecutedRows([A, B], [reach(A, aborted.replace(/#######\s+step\d+:.*\n/g, '')), reach(B, null)], titles).get(B)?.reason, why('合成用例 501', ''), 'no step known: the sentence leaves the step out');
  assert.equal(delivery.unexecutedRows([A, B, C], [reach(A, plain), reach(B, aborted), reach(C, null)], titles).get(C)?.by.item, B, 'the case that ended it is the last one reached');

  // A run that reached every case, or whose last reached case shows no exception, proves nothing about the others.
  assert.equal(delivery.unexecutedRows([A, B], [reach(A, aborted), reach(B, plain)], titles).size, 0, 'both have logs: unchanged');
  assert.equal(delivery.unexecutedRows([A, B], [reach(A, failedCheck), reach(B, null)], titles).size, 0, 'a failed check point does not stop the run');
  assert.equal(delivery.unexecutedRows([A, B], [reach(A, plain), reach(B, null)], titles).size, 0);
  assert.equal(delivery.unexecutedRows([A, B], [reach(A, aborted), reach(B, null, true)], titles).size, 0, 'a later case with a session or a log reference was reached');
  assert.equal(delivery.unexecutedRows([A, B], [reach(A, null, true), reach(B, null)], titles).size, 0, 'the last reached case has no log text to read');
  assert.equal(delivery.unexecutedRows([A], [reach(A, aborted)], titles).size, 0, 'nothing after it');
  assert.equal(delivery.unexecutedRows([A, B], [reach(A, null), reach(B, null)], titles).size, 0, 'nothing reached: not a stopped run');
  // The order is the workbook's, not the order the rows happen to be listed in.
  assert.deepEqual([...delivery.unexecutedRows([A, B], [reach(B, null), reach(A, aborted)], titles).keys()], [B]);
});

test('the dispatch as a whole names the case and the step that ended its run, and nothing is said when no case was left unreached', () => {
  const titles = (item: string) => ({ [A]: '合成用例 501' })[item];
  const abort = (found: ReturnType<typeof delivery.unexecutedRows>, titled = true) => delivery.workbookAbort(found, titled ? titles : undefined);
  const found = delivery.unexecutedRows([A, B, C], [reach(A, aborted), reach(B, null), reach(C, null)], titles);
  assert.deepEqual(abort(found), {
    by: { item: A, step: 9 },
    reason: `同一份自动化用例 Excel 中的原始用例 ${A} 合成用例 501 在第 9 步出现异常，运行器中止了整本：其后 2 条没有在设备上执行，整份报告因此不完整`,
    next_action: `修正原始用例 ${A} 后重新上机，异常报告在它的设备输出里；等待和 job resume 都补不出缺的报告，也不重新提交这次上机验证`,
  });
  assert.match(abort(found, false)!.reason, /^同一份自动化用例 Excel 中的原始用例 \d+ 标题未知 在第 9 步出现异常，/, 'no title known');
  const unnumbered = delivery.unexecutedRows([A, B], [reach(A, aborted.replace(/#######\s+step\d+:.*\n/g, '')), reach(B, null)], titles);
  assert.equal(abort(unnumbered)!.reason, `同一份自动化用例 Excel 中的原始用例 ${A} 合成用例 501 出现异常，运行器中止了整本：其后 1 条没有在设备上执行，整份报告因此不完整`, 'no step known: the sentence leaves the step out');
  assert.match(abort(unnumbered)!.next_action, /^修正原始用例 \d+ 后重新上机，异常报告在它的设备输出里；/);
  assert.equal(abort(delivery.unexecutedRows([A, B], [reach(A, plain), reach(B, null)], titles)), null, 'no exception in the last case reached: nothing is said');
  assert.equal(abort(new Map()), null);
  const copy = abort(found)!;
  copy.by.step = 1;
  assert.equal(found.get(B)!.by.step, 9, 'the sentence does not share the cases\' own record');
});

const notExecuted = (title = '合成用例 501') => delivery.unexecutedRows([A, B], [reach(A, aborted), reach(B, null)], () => title).get(B)!;
const dispatch = (run: string, items: string[], rows: JobRow[]): Dispatch => ({ run, job: `job-${run}`, plan_run: 'plan', sha256: 'a'.repeat(64), items, rows });
const first = (rowOfB: JobRow = { item: B, dynamic_terminal: 'not_run', not_executed: notExecuted() }) => dispatch('d1', [A, B], [{ item: A, dynamic_terminal: 'no_verdict', evidence: { log: `src:${'1'.repeat(64)}` } }, rowOfB]);

test('a case the run did not reach has no device attempt: no history, no verdict, the first case keeps its own', () => {
  const result = delivery.assemble([A, B], [first()]);
  const [one, two] = result.cases;
  assert.deepEqual([one.status, one.history.length, one.history[0].terminal], ['unsettled', 1, 'no_verdict'], 'the case that stopped the run keeps the verdict the Hub gave it');
  assert.deepEqual([two.status, two.history.length], ['unrun', 0], 'not on the device: no attempt');
  assert.deepEqual(two.not_executed?.map((n) => [n.ordinal, n.run, n.plan_run, n.by.item, n.by.step]), [[1, 'd1', 'plan', A, 9]]);
  assert.deepEqual(result.totals, { cases: 2, delivered: 0, failed: 0, unsettled: 1, unrun: 1 });
  assert.equal(result.unsuccessful?.items.includes(B), false, 'assemble leaves it out of the unsuccessful volume, as it does a case never dispatched; the delivery tool adds it with the plan it last had (assemble-delivery.test.ts)');
});

test('the real run of that case later is its first attempt, and the not-executed dispatch never breaks an earlier whole pass', () => {
  const later = dispatch('d2', [B], [{ item: B, dynamic_terminal: 'fail', evidence: { log: `src:${'2'.repeat(64)}` } }]);
  const two = delivery.assemble([A, B], [first(), later]).cases[1];
  assert.deepEqual([two.status, two.history.length, two.history[0].ordinal, two.history[0].terminal], ['failed', 1, 2, 'fail'], 'one attempt, the second dispatch');
  assert.deepEqual(two.not_executed?.map((n) => n.ordinal), [1]);
  // an earlier dispatch where B and C passed whole stays the pass volume when a later dispatch held them without reaching them
  const whole = dispatch('d0', [B, C], [{ item: B, dynamic_terminal: 'pass' }, { item: C, dynamic_terminal: 'pass' }]);
  const stopped = dispatch('d1', [A, B, C], [{ item: A, dynamic_terminal: 'no_verdict', evidence: { log: `src:${'1'.repeat(64)}` } }, { item: B, dynamic_terminal: 'not_run', not_executed: notExecuted() }, { item: C, dynamic_terminal: 'not_run', not_executed: notExecuted() }]);
  const kept = delivery.assemble([A, B, C], [whole, stopped]);
  assert.deepEqual([kept.pass?.run, kept.pass?.items], ['d0', [B, C]]);
  assert.deepEqual(kept.totals, { cases: 3, delivered: 2, failed: 0, unsettled: 1, unrun: 0 });
  assert.deepEqual(kept.cases[1].not_executed?.map((n) => n.ordinal), [2]);
  // a later dispatch that did run the case and did not pass it is another matter
  const failedLater = dispatch('d1', [A, B, C], [{ item: A, dynamic_terminal: 'no_verdict', evidence: { log: `src:${'1'.repeat(64)}` } }, { item: B, dynamic_terminal: 'fail' }, { item: C, dynamic_terminal: 'not_run', not_executed: notExecuted() }]);
  assert.equal(delivery.assemble([A, B, C], [whole, failedLater]).pass, null);
});

const inputOf = (outcome: CaseOutcome): ReportInput => ({
  name: 'synthetic', generatedAt: '2026-11-17 10:00', build: null,
  assembly: { cases: [outcome], pass: null, unsuccessful: null, totals: { cases: 1, delivered: 0, failed: 0, unsettled: 0, unrun: 1 } },
  notes: { cases: { [B]: { judged: '合成说明', remedy: '合成下一步' } } },
  originals: { [A]: { title: '合成用例 501', lines: [] }, [B]: { title: '合成用例 502', lines: [] } }, excluded: [], files: { pass: null, unsuccessful: null }, logs: {},
});

test('the report says the case was not executed, why, and what to do, and does not call it a device observation', () => {
  const two = delivery.assemble([A, B], [first()]).cases[1];
  const settled = delivery.closeUnrun([two], {}).cases[0];
  assert.equal(settled.closing, undefined);
  assert.deepEqual(settled.pending, [`${notExecuted().reason}；${NEXT}`], 'the named exit is the program-decided one, not "no verified plan result"');
  const text = delivery.caseConclusion(inputOf(settled), settled);
  assert.equal(text, `原始用例 ${B} 合成用例 502：没有在设备上执行，无结论。原因：${why('合成用例 501', '在第 9 步')}。下一步：${NEXT}。`);
  assert.doesNotMatch(text, /运行器报告|Hub 尚未取得|job resume|完整字段/);
  assert.equal(delivery.timeline(settled, false), `第 1 次未执行：${why('合成用例 501', '在第 9 步')}。`);
  // when the case also ran on the device in another dispatch, the line lists both and counts one
  const later = dispatch('d2', [B], [{ item: B, dynamic_terminal: 'fail', evidence: { log: `src:${'2'.repeat(64)}` } }]);
  const ran = delivery.assemble([A, B], [first(), later]).cases[1];
  assert.equal(delivery.timeline(ran, false), `第 1 次未执行：${why('合成用例 501', '在第 9 步')}；第 2 次上机验证，运行器报告未通过。`);
});

test('a case that did not run is not asked for a round, and it needs no further named exit', () => {
  const settled = delivery.closeUnrun(delivery.assemble([A, B], [first()]).cases, {}).cases;
  assert.deepEqual(delivery.closingHints(settled, { cases: { [A]: { judged: 'x', remedy: 'y' }, [B]: { judged: 'x', remedy: 'y' } } }), [], 'the program-decided reason is the exit');
  const hints = delivery.closingHints(settled, { cases: { [B]: { judged: 'x', remedy: 'y', round: 1 } } });
  assert.deepEqual(hints.map((hint) => [hint.autoid, hint.missing]), [[B, '本条没有到过设备，不能声明上机轮次']], 'it has not been to the device, so no round is claimed');
});

test('a run where both cases have logs is read as before', () => {
  const both = dispatch('d1', [A, B], [{ item: A, dynamic_terminal: 'fail', evidence: { log: `src:${'1'.repeat(64)}` } }, { item: B, dynamic_terminal: 'pass', evidence: { log: `src:${'2'.repeat(64)}` } }]);
  const result = delivery.assemble([A, B], [both]);
  assert.deepEqual(result.cases.map((c) => [c.status, c.history.length, c.not_executed]), [['failed', 1, undefined], ['unsettled', 1, undefined]]);
});
