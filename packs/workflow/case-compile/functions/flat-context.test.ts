// Precondition leaves of a case (the author's priority-3 leaves): every one is stated by the plan, as the steps that
// establish it or as a fact the plan cannot establish. The Hub checks the references and the order of steps, never what a
// step means. Also the two expectation rules that go with a plan that may assert an absence. Synthetic names only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkExpectedSources } from './checks.ts';
import { readSlots } from './slots.ts';
import { fixture, positiveBlocks, quote, call, EXPECTED } from '../testing/blocks.ts';

const f = fixture();
const LEAF = { reference: 'src:' + 'a'.repeat(64) + '/kityminder@1/n/leaf', text: '功能已启用' };
const OTHER = { reference: 'src:' + 'a'.repeat(64) + '/kityminder@1/n/other', text: '有客户端' };
/** Step 1 configures, step 2 observes, step 3 waits, step 4 is the cleanup; the one expectation reads step 2. */
function flat(extra: Record<string, unknown> = {}, operator?: string) {
  return {
    bucket: 'bed-a', blocks: [], replacements: [],
    steps: [call('demo set 5'), call('demo show'), { object: 'clock', method: 'pause', args: ['1'], keywords: {} }, { ...call('no demo set'), cleanup: true }],
    expects: [{ text: EXPECTED, quote: quote(), after: 2, ...(operator ? { operator } : {}) }],
    ...extra,
  } as any;
}
const run = (data: unknown, leaves: unknown[] | null = [LEAF]) => checkExpectedSources(f.subject(data, leaves === null ? {} : { preconditions: leaves }));
const kinds = (rows: Array<{ verdict: string; code?: string }>) => rows.map((row) => row.verdict + (row.code ? ':' + row.code.split('.').pop() : ''));

test('a leaf stated by earlier steps passes; a case without leaves, and a run that froze none, are unchanged', () => {
  assert.deepEqual(kinds(run(flat({ preconditions: [{ reference: LEAF.reference, established_by: [1] }] }))), ['support']);
  assert.deepEqual(kinds(run(flat(), [])), ['support']);
  assert.deepEqual(kinds(run(flat(), null)), ['support'], 'an older run has no leaves to cover');
});

test('a leaf the plan does not state is refused with its text, its reference and where to write it', () => {
  const rows = run(flat());
  assert.deepEqual(kinds(rows), ['refute:precondition_missing']);
  assert.match(rows[0].statement, /前置叶子「功能已启用」/); assert.ok(rows[0].statement.includes(LEAF.reference)); assert.match(rows[0].statement, /preconditions 里 reference 等于该叶子的一项/);
  assert.deepEqual(kinds(run(flat({ preconditions: [] }), [LEAF, OTHER])), ['refute:precondition_missing', 'refute:precondition_missing']);
});

test('the steps that establish a leaf exist, are device or host commands, are not cleanup and come before the first asserted step', () => {
  for (const [steps, why] of [[[9], /不存在/], [[3], /不是设备命令或主机命令/], [[4], /清理步骤/], [[2], /不早于第一个被断言的步骤/]] as const) {
    const rows = run(flat({ preconditions: [{ reference: LEAF.reference, established_by: [...steps] }] }));
    assert.deepEqual(kinds(rows), ['refute:slots_invalid'], String(steps)); assert.match(rows[0].statement, why);
  }
});

test('a leaf is stated once, and only a leaf of the case can be stated', () => {
  const twice = run(flat({ preconditions: [{ reference: LEAF.reference, established_by: [1] }, { reference: LEAF.reference, established_by: [1] }] }));
  assert.deepEqual(kinds(twice), ['refute:slots_invalid']);
  const foreign = run(flat({ preconditions: [{ reference: LEAF.reference, established_by: [1] }, { reference: OTHER.reference, established_by: [1] }] }));
  assert.deepEqual(kinds(foreign), ['refute:slots_invalid']); assert.match(foreign[0].statement, /不是本用例的前置叶子/);
});

test('a fact the plan cannot establish is an unknown that names what is missing and the way out', () => {
  const rows = run(flat({ preconditions: [{ reference: LEAF.reference, unmet: { missing: '床上没有该能力', next_action: '管理员补清单后重开运行' } }] }));
  assert.deepEqual(kinds(rows), ['unknown']);
  assert.match(rows[0].statement, /模型声明，Hub 未核对.*床上没有该能力.*管理员补清单后重开运行.*parameters\.exclude/);
});

test('the shape of a statement is checked when the plan is read', () => {
  for (const bad of [{ reference: LEAF.reference }, { reference: LEAF.reference, established_by: [1], unmet: { missing: 'a', next_action: 'b' } }, { reference: LEAF.reference, established_by: [] }, { reference: LEAF.reference, established_by: [1, 1] }, { reference: LEAF.reference, unmet: { missing: '', next_action: 'b' } }, { reference: LEAF.reference, established_by: [0] }, { established_by: [1] }]) {
    assert.equal(readSlots(flat({ preconditions: [bad] })).ok, false, JSON.stringify(bad));
  }
});

test('a block plan states its leaves in block_context.preconditions, quoting the leaf', () => {
  const data = positiveBlocks().CONFIG;
  assert.deepEqual(kinds(run(data)), ['refute:precondition_missing']);
  data.block_context!.preconditions = [{ id: 'p1', state: 'present', for: 'observe', established_by: ['configure'], quote: { reference: LEAF.reference, text: LEAF.text } }];
  assert.deepEqual(kinds(run(data)), ['support']);
});

test('an expectation whose text is already in the command it reads is refused, as a presence and as an absence', () => {
  const inCommand = { ...flat({ preconditions: [{ reference: LEAF.reference, established_by: [1] }] }) };
  inCommand.expects = [{ text: 'demo show', quote: { reference: quote().reference, text: 'demo show' }, after: 2 }];
  const rows = run(inCommand); assert.deepEqual(kinds(rows), ['refute:expect_in_command']); assert.match(rows[0].statement, /不管设备答什么都成立/);
  inCommand.expects[0].operator = 'not_found';
  assert.match(run(inCommand)[0].statement, /必然失败/);
});

test('a plan may assert an absence with operator not_found, and no other operator', () => {
  assert.equal(readSlots(flat({}, 'not_found')).ok, true);
  for (const operator of ['found', 'abs_found', 'found_times', 'differs']) assert.equal(readSlots(flat({}, operator)).ok, false, operator);
});
