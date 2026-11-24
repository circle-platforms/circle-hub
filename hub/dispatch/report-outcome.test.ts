import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportOutcome, runStop, type ReportCheck } from './report-outcome.ts';
import type { ExecutorDefinition } from './definition.ts';

const MARKER = '#######   end case: ';
const result = {
  ownership: { pointer: '/ownership', value: 'staging_directory', reason: '/ownership_reason' },
  request_id: '/request_id', id: '/task_id', sha256: '/xlsx_sha256', submitted_at: '/submitted_at',
  items: '/cases', item_id: '/case_id', item_outcome: '/result', log: '/log', sessions: '/sessions', closing_marker: MARKER, complete: '/complete',
  map: { PASS: 'pass', FAIL: 'fail' },
};
const declared = (patch: Record<string, unknown> = {}, drop: string[] = []): ExecutorDefinition => {
  const next: Record<string, unknown> = { ...result, ...patch };
  for (const key of drop) delete next[key];
  return { result: next } as unknown as ExecutorDefinition;
};
const OLD_FACT = '结果完整字段 /complete 尚不为 true，缺完整报告';
const OLD_NEXT = '按该指针对照已保存原件：原件未齐时稍后 job resume；原件已齐时修正执行器 result 相对指针或完全相等映射后 job resume；不重交';
const ITEMS = ['synthetic-1', 'synthetic-2', 'synthetic-3'];
const closed = (id: string) => `step lines of ${id}\n${MARKER}${id}`;
const unclosed = (id: string) => `step lines of ${id}\nthe runner's report of an uncaught exception\n######      FAIL      ######`;
const sessions = { 'device-a': 'session text' };
const report = (cases: unknown[], complete = false) => ({ task_id: 'synthetic-task', request_id: 'synthetic-request', complete, xlsx_sha256: 'f'.repeat(64), submitted_at: '2026-11-17T00:00:00.000Z', cases });
const run = (value: unknown, d = declared(), items: readonly string[] = ITEMS) => { const stop = runStop(value, d, items); return items.map(id => reportOutcome(value, d, id, stop).check); };
const bare = (value: unknown, d = declared(), items: readonly string[] = ITEMS) => items.map(id => reportOutcome(value, d, id).check);
const frame = (check: ReportCheck) => { const { missing_fact: _fact, next_action: _next, ...rest } = check; return rest; };

for (const aborted of [null, 'FAIL'] as const) test(`an execution that ended inside an item (its outcome ${aborted === null ? 'missing' : 'FAIL'}) is told with the item, and the missing items are not waited for`, () => {
  const value = report([
    { case_id: ITEMS[0], result: 'FAIL', log: closed(ITEMS[0]), sessions },
    { case_id: ITEMS[1], result: aborted, log: unclosed(ITEMS[1]), sessions },
    { case_id: ITEMS[2], result: null, log: '', log_stale: false },
  ]);
  const checks = run(value), before = bare(value);
  for (const [k, check] of checks.entries()) {
    assert.equal(check.condition, 'result.complete');
    assert.equal(check.resolved, false);
    assert.ok(check.missing_fact!.startsWith(OLD_FACT), check.missing_fact);
    assert.deepEqual(frame(check), frame(before[k]), 'pointers, presence and digests are those the Hub recorded before');
    assert.notEqual(check.next_action, OLD_NEXT);
    assert.doesNotMatch(check.next_action!, /稍后 job resume|原件未齐时/);
    assert.match(check.next_action!, /补读不到/);
    assert.ok(check.next_action!.includes(`条目 ${ITEMS[1]} 的日志`), 'the next step names the item whose log tells why the execution ended there');
    assert.match(check.next_action!, /另开一次上机验证/);
    assert.match(check.next_action!, /不必等也不必 resume/);
  }
  assert.match(checks[1].missing_fact!, /执行在本条处结束，本条日志没有收尾标记，其后 1 条（synthetic-3）没有日志、会话和结果/, 'the item it ended in');
  assert.match(checks[2].missing_fact!, /本条没有日志、会话和结果，执行在条目 synthetic-2 处结束，没有到达本条/, 'the item after it');
  assert.match(checks[0].missing_fact!, /执行在条目 synthetic-2 处结束，其后 1 条没有到达，整份报告因此不完整，本条没有判定/, 'the item before it');
  assert.equal(new Set(checks.map(check => check.next_action)).size, 1, 'one next step for the whole workbook, so the job record carries the same one');
});

test('runStop names the last item the report holds something of, whether its log is closed, and the items after it', () => {
  const rows = (...made: Array<[string, unknown, string]>) => report(made.map(([id, outcome, log]) => ({ case_id: id, result: outcome, log })));
  assert.deepEqual(runStop(rows([ITEMS[0], 'PASS', closed(ITEMS[0])], [ITEMS[1], null, unclosed(ITEMS[1])], [ITEMS[2], null, '']), declared(), ITEMS), { last: ITEMS[1], closed: false, unreached: [ITEMS[2]] });
  assert.deepEqual(runStop(rows([ITEMS[0], 'PASS', closed(ITEMS[0])], [ITEMS[1], null, ''], [ITEMS[2], null, '']), declared(), ITEMS), { last: ITEMS[0], closed: true, unreached: [ITEMS[1], ITEMS[2]] });
  assert.deepEqual(runStop(rows([ITEMS[0], 'PASS', ''], [ITEMS[1], null, ''], [ITEMS[2], null, '']), declared(), ITEMS), { last: ITEMS[0], closed: null, unreached: [ITEMS[1], ITEMS[2]] }, 'an item with an outcome and no log is not said to be closed or open');
  assert.deepEqual(runStop(rows([ITEMS[0], 'PASS', closed(ITEMS[0])], [ITEMS[1], null, ''], [ITEMS[2], null, '']), declared({}, ['closing_marker']), ITEMS)?.closed, null, 'no marker declared');
  assert.equal(runStop(report([{ case_id: ITEMS[0], result: '  ', log: ' ', sessions: { 'device-a': '' } }, { case_id: ITEMS[1], result: null, log: '' }]), declared(), ITEMS.slice(0, 2)), null);
  assert.deepEqual(runStop(report([{ case_id: ITEMS[2], result: null, log: '' }, { case_id: ITEMS[1], result: null, log: '' }, { case_id: ITEMS[0], result: 'PASS', log: closed(ITEMS[0]) }]), declared(), ITEMS), { last: ITEMS[0], closed: true, unreached: [ITEMS[1], ITEMS[2]] });
  assert.equal(runStop(report([{ case_id: 'another', result: 'PASS', log: closed('another') }, { case_id: ITEMS[0], result: 'PASS', log: closed(ITEMS[0]) }, { case_id: ITEMS[1], result: null, log: '' }]), declared(), ITEMS.slice(0, 2))?.last, ITEMS[0], 'an item the job does not hold is not read');
});

test('the item an execution ended in is told as closed or not only when the executor declares a closing marker', () => {
  const value = report([
    { case_id: ITEMS[0], result: 'PASS', log: closed(ITEMS[0]) },
    { case_id: ITEMS[1], result: null, log: '' },
    { case_id: ITEMS[2], result: null, log: '' },
  ]);
  const withMarker = run(value)[0], without = run(value, declared({}, ['closing_marker']))[0];
  assert.doesNotMatch(withMarker.missing_fact!, /收尾标记/, 'a log that is closed says nothing about the marker');
  assert.match(withMarker.missing_fact!, /执行在本条处结束，其后 2 条（synthetic-2、synthetic-3）没有日志、会话和结果/);
  assert.doesNotMatch(without.missing_fact!, /收尾标记/);
  const open = report([{ case_id: ITEMS[0], result: null, log: unclosed(ITEMS[0]) }, { case_id: ITEMS[1], result: null, log: '' }, { case_id: ITEMS[2], result: null, log: '' }]);
  assert.match(run(open)[0].missing_fact!, /本条日志没有收尾标记/);
  assert.doesNotMatch(run(open, declared({}, ['closing_marker']))[0].missing_fact!, /收尾标记/, 'no declared marker, no statement about it');
});

test('only the fields the executor declares are named as missing', () => {
  const value = report([{ case_id: ITEMS[0], result: 'PASS' }, { case_id: ITEMS[1], result: null }, { case_id: ITEMS[2] }]);
  const plain = declared({}, ['log', 'sessions', 'closing_marker']);
  assert.match(run(value, plain)[0].missing_fact!, /执行在本条处结束，其后 2 条（synthetic-2、synthetic-3）没有结果$/);
  assert.match(run(value, plain)[2].missing_fact!, /本条没有结果，执行在条目 synthetic-1 处结束，没有到达本条$/);
  const logged = declared({}, ['sessions']);
  assert.match(run(value, logged)[1].missing_fact!, /本条没有日志和结果，/);
});

test('a long run of items that were not reached is named by its first few', () => {
  const ids = Array.from({ length: 9 }, (_, k) => `synthetic-${k + 1}`);
  const value = report(ids.map((id, k) => ({ case_id: id, result: k === 0 ? 'PASS' : null, log: k === 0 ? closed(id) : '' })));
  const first = run(value, declared(), ids)[0].missing_fact!;
  assert.match(first, /其后 8 条（synthetic-2、synthetic-3、synthetic-4、synthetic-5、synthetic-6 等）没有/);
});

test('a report that is incomplete without an execution that ended keeps the advice to read it again later', () => {
  const kept = (checks: ReportCheck[], why: string) => {
    for (const check of checks) { assert.equal(check.missing_fact, OLD_FACT, why); assert.equal(check.next_action, OLD_NEXT, why); }
  };
  kept(run(report(ITEMS.map(id => ({ case_id: id, result: 'PASS', log: closed(id) })))), 'every item reached');
  kept(run(report([])), 'no item in the report');
  kept(run(report(ITEMS.map(id => ({ case_id: id, result: null, log: '' })))), 'no item reached');
  kept(run({ complete: false }), 'no list of items');
  kept(run(report([{ case_id: ITEMS[0], result: 'PASS', log: closed(ITEMS[0]) }, { case_id: ITEMS[1], result: null, log: '' }, { case_id: ITEMS[2], result: 'PASS', log: closed(ITEMS[2]) }])), 'a gap inside');
  kept(run(report([{ case_id: ITEMS[0], result: 'PASS', log: closed(ITEMS[0]) }, { case_id: ITEMS[1], result: null, log: '' }])), 'an item missing from the list');
  kept(run(report([{ case_id: ITEMS[0], result: 'PASS', log: closed(ITEMS[0]) }, { case_id: ITEMS[1], result: null, log: '' }, { case_id: ITEMS[2], result: null, log: '' }, { case_id: ITEMS[2], result: null, log: '' }])), 'an item listed twice');
  kept(run(report([{ case_id: ITEMS[0], result: null, log: unclosed(ITEMS[0]) }]), declared(), [ITEMS[0]]), 'one item');
  kept(bare(report([{ case_id: ITEMS[0], result: 'FAIL', log: closed(ITEMS[0]) }, { case_id: ITEMS[1], result: null, log: '' }, { case_id: ITEMS[2], result: null, log: '' }])), 'stop not given');
});

test('a complete report is read as before', () => {
  const rows = [
    { case_id: ITEMS[0], result: 'PASS', log: closed(ITEMS[0]) },
    { case_id: ITEMS[1], result: null, log: '' },
    { case_id: ITEMS[2], result: null, log: '' },
  ];
  const complete = report(rows, true);
  const withItems = run(complete), without = bare(complete);
  assert.deepEqual(withItems, without, 'the list of the items of the job changes nothing once the executor says the report is complete');
  assert.equal(withItems[0].resolved, true);
  assert.equal(withItems[1].condition, 'result.item_outcome');
});
