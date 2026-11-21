// The closing reply answers what the person asked for (owner, 2026-11-21): how many cases the mind map holds, how many became
// automated cases, how many did not and why, and where the workbook is. It follows the closing card of the reference engine
// (docs/engine/07_display_contract.md §11.2: a result line, one line for each case that needs attention, the paths), and says
// nothing of how the Hub records a result.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { readNotes, resultLine, type CaseNote, type CaseOutcome, type ReportInput, type ScopeSummary } from './delivery.ts';
import { replyText } from '../tools/assemble-delivery.ts';

const FILES = ['case.xlsx', 'delivery_report.md', 'unsuccessful_cases.md', 'delivery.json'];
const passed = (autoid: string): CaseOutcome => ({ autoid, status: 'delivered', history: [{ ordinal: 1, run: 'first', job: 'first', terminal: 'pass' }] });
const thrice: CaseOutcome = { autoid: 'b', status: 'failed', closing: 'authoring_failure', rounds: 3, history: [1, 2, 3].map((ordinal) => ({ ordinal, run: `run-${ordinal}`, job: 'job', terminal: 'fail' })) };
function input(cases: CaseOutcome[], notes: Record<string, CaseNote> = {}, scope?: ScopeSummary): ReportInput {
  const count = (status: CaseOutcome['status']) => cases.filter((outcome) => outcome.status === status).length;
  return {
    name: 'synthetic', generatedAt: '2026-11-21 09:00', build: null, notes: { cases: notes }, excluded: [], logs: {},
    originals: { a: { title: '合成甲', lines: [] }, b: { title: '合成乙', lines: [] }, c: { title: '合成丙', lines: [] } },
    assembly: { cases, pass: null, unsuccessful: null, totals: { cases: cases.length, delivered: count('delivered'), failed: count('failed'), unsettled: count('unsettled'), unrun: count('unrun') } },
    files: { pass: count('delivered') ? { sha256: 'a'.repeat(64) } : null, unsuccessful: null },
    ...(scope ? { scope } : {}),
  };
}
const reply = (cases: CaseOutcome[], notes?: Record<string, CaseNote>, files = FILES, scope?: ScopeSummary): string[] => { const given = input(cases, notes, scope); return replyText('/out', given.assembly.totals, files, cases, given).split('\n'); };

test('every case succeeded: the reply is the result, the workbook and the report', () => {
  assert.deepEqual(reply([passed('a'), passed('c')]), ['原始脑图共 2 条用例：生成成功 2 条，失败 0 条。', `自动化用例 Excel：${join('/out', 'case.xlsx')}`, `交付报告：${join('/out', 'delivery_report.md')}`]);
});

test('a case that did not succeed has one line: what happened and why, the model\'s sentence of the cause named as the model\'s', () => {
  const lines = reply([passed('a'), thrice], { b: { judged: '合成的长说明：第一轮怎样，第二轮怎样，第三轮怎样', remedy: '合成下一步', cause: '设备拒绝了作者写的名字' } }, [...FILES, 'unsuccessful_cases.xlsx']);
  assert.deepEqual(lines, [
    '原始脑图共 2 条用例：生成成功 1 条，失败 1 条。',
    `自动化用例 Excel：${join('/out', 'case.xlsx')}`,
    '',
    '失败的 1 条：',
    '- 原始用例 b 合成乙：上机 3 次、写过 3 版自动化用例，都没有通过。原因（模型的分析）：设备拒绝了作者写的名字。',
    '',
    `失败用例的详细说明：${join('/out', 'unsuccessful_cases.md')}`,
    `失败用例的 Excel（没有整卷上机验证）：${join('/out', 'unsuccessful_cases.xlsx')}`,
    `交付报告：${join('/out', 'delivery_report.md')}`,
  ]);
  // without that sentence the line holds the start of the model's explanation, cut where it gets long
  const long = '合成说明'.repeat(60);
  const fallen = reply([passed('a'), thrice], { b: { judged: long, remedy: '合成下一步' } })[4];
  assert.equal(fallen, `- 原始用例 b 合成乙：上机 3 次、写过 3 版自动化用例，都没有通过。原因（模型的分析）：${long.slice(0, 160)}…。`);
  // a note the model has not written yet says nothing of a cause
  assert.match(reply([passed('a'), thrice], { b: { judged: '尚未提供模型说明', remedy: '尚未提供模型建议', absent: true } })[4], /都没有通过。原因：还没查清。$/);
});

test('nothing succeeded: the reply says there is no workbook', () => {
  const lines = reply([thrice], { b: { judged: '合成说明', remedy: '合成下一步' } }, ['delivery_report.md', 'unsuccessful_cases.md', 'delivery.json']);
  assert.deepEqual(lines.slice(0, 2), ['原始脑图共 1 条用例：生成成功 0 条，失败 1 条。', '没有生成成功的用例，没有自动化用例 Excel。']);
});

test('a compile of part of the mind map counts the whole document and the part', () => {
  const scope: ScopeSummary = { words: '只编译合成甲', cases: ['a'], outOfScope: [{ autoid: 'b', title: '合成乙' }, { autoid: 'c', title: '合成丙' }], totalCases: 3 };
  assert.equal(resultLine(input([passed('a')], {}, scope)), '原始脑图共 3 条用例，本次范围 1 条：生成成功 1 条，失败 0 条；其余 2 条不在本次范围内。');
  assert.equal(reply([passed('a')], {}, FILES, scope)[0], '原始脑图共 3 条用例，本次范围 1 条：生成成功 1 条，失败 0 条；其余 2 条不在本次范围内。');
});

test('the sentence of the cause is one line of at most 200 characters', () => {
  const note = (cause: string) => ({ cases: { b: { judged: '合成说明', remedy: '合成下一步', cause } } });
  assert.equal(readNotes(note('设备拒绝了作者写的名字'), ['b']).cases.b.cause, '设备拒绝了作者写的名字');
  assert.throws(() => readNotes(note('第一行\n第二行'), ['b']), /一句话原因要是一句话：不换行，不超过 200 字/);
  assert.throws(() => readNotes(note('字'.repeat(201)), ['b']), /一句话原因要是一句话：不换行，不超过 200 字/);
  assert.equal(readNotes({ cases: { b: { judged: '合成说明', remedy: '合成下一步' } } }, ['b']).cases.b.cause, undefined);
});
