// The refusals of a plan's `recomposition` declaration against the admitted recomposition record say where the fault sits, the
// value that was seen, the allowed set and the next step, with the exact values to copy (round 36: the sync writer and the colon
// writer read the tool's source to learn what the refusal could have told them). The decisions stay what they were: which
// condition is a gap, and whether it is unknown or a refutation.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {recompositionGaps} from './recomposition.ts';
import type {PlanSlots} from './slots.ts';

const SOURCE = 'src:' + 'a'.repeat(64);
const QUOTE_REF = SOURCE + '/kityminder@1/n/f5c66ca69c44';
const QUOTE_TEXT = '对端同步完整';
const RECEIPT = 'rec:' + '9'.repeat(64);
const CASE_ID = '980000000000044789';
const ITEM = 'c8op2ikg2ao0:911edce9e217';
const DECLARED = '/slots/plan/0/data/recomposition';

const proof = (record: Record<string, unknown> = {}): any => ({
  receipt: RECEIPT, run: 'run_synthetic_recompose', source: SOURCE, conditional_on_judgment: true,
  record: {
    case: { id: CASE_ID, node: 'n/911edce9e217', source_ref: SOURCE },
    atoms: [{ id: 'a6', kind: 'expectation', quote_ref: QUOTE_REF, span: [0, 6], text: QUOTE_TEXT }],
    expectation_slots: [{ slot: 'e1', atom: 'a6', evidence: [], knowledge_location: 'has_verification_knowledge', proposal: null }],
    ...record,
  },
});
const expect = (over: Record<string, unknown> = {}): any => ({ text: QUOTE_TEXT, quote: { reference: QUOTE_REF, text: QUOTE_TEXT }, after: 1, ...over });
const plan = (recomposition?: unknown, expects: any[] = [expect(), expect({ after: 2 })]): PlanSlots =>
  ({ bucket: '103', blocks: [], steps: [], replacements: [], expects, ...(recomposition === undefined ? {} : { recomposition }) }) as unknown as PlanSlots;
const declared = (slots: Array<{ slot: string; assertions: string[] }>, over: Record<string, unknown> = {}) => ({ receipt: RECEIPT, case_id: CASE_ID, slots, rebindings: [], ...over });
const e1 = (...assertions: string[]) => [{ slot: 'e1', assertions }];
const only = (issues: Array<{ message: string; verdict: string }>) => { assert.equal(issues.length, 1, JSON.stringify(issues)); return issues[0]!; };
const has = (text: string, ...parts: string[]) => { for (const part of parts) assert.ok(text.includes(part), `missing ${JSON.stringify(part)} in: ${text}`); };

test('a plan without the declaration is told its position, the values to copy and where they are disclosed', () => {
  const gap = only(recompositionGaps(plan(), proof(), { item: ITEM }));
  assert.equal(gap.verdict, 'unknown');
  has(gap.message, DECLARED, JSON.stringify(RECEIPT), JSON.stringify(CASE_ID), '/fields/recomposition', '/fields/recomposition/receipt', '/fields/recomposition/record/case/id', '/fields/recomposition/record/expectation_slots', ITEM, '"slot":"e1"', '"assertions":["1","2"]', '下一步');
});

test('without the item the position and the values are still named', () => {
  const gap = only(recompositionGaps(plan(), proof()));
  assert.equal(gap.verdict, 'unknown');
  has(gap.message, DECLARED, JSON.stringify(RECEIPT), JSON.stringify(CASE_ID), '/fields/recomposition');
});

test('the assertions offered for a slot are those whose quotation is the slot\'s sentence, and a slot nothing quotes says so', () => {
  const other = expect({ quote: { reference: SOURCE + '/kityminder@1/n/other', text: '别的原句' } });
  const gap = only(recompositionGaps(plan(undefined, [other, expect(), other]), proof(), { item: ITEM }));
  has(gap.message, '"assertions":["2"]');
  const none = only(recompositionGaps(plan(undefined, [other]), proof(), { item: ITEM }));
  has(none.message, QUOTE_REF, QUOTE_TEXT, 'e1');
});

test('a wrong receipt or case id is refuted with the value seen and the value expected', () => {
  const wrongReceipt = 'rec:' + 'b'.repeat(64);
  const both = only(recompositionGaps(plan(declared(e1('1'), { receipt: wrongReceipt, case_id: '999' })), proof(), { item: ITEM }));
  assert.equal(both.verdict, 'refute');
  has(both.message, DECLARED + '/receipt', JSON.stringify(wrongReceipt), JSON.stringify(RECEIPT), DECLARED + '/case_id', JSON.stringify('999'), JSON.stringify(CASE_ID), '下一步');
  const caseOnly = only(recompositionGaps(plan(declared(e1('1'), { case_id: '999' })), proof(), { item: ITEM }));
  assert.equal(caseOnly.verdict, 'refute');
  has(caseOnly.message, JSON.stringify('999'), JSON.stringify(CASE_ID));
  assert.ok(!caseOnly.message.includes(DECLARED + '/receipt'), caseOnly.message);
});

test('an assertion the plan does not have is named with the assertion ids the plan has', () => {
  const issues = recompositionGaps(plan(declared(e1('expect_1', 'expect_2'))), proof(), { item: ITEM });
  assert.equal(issues.length, 2, JSON.stringify(issues));
  assert.ok(issues.every(issue => issue.verdict === 'refute'));
  has(issues[0]!.message, DECLARED + '/slots/0/assertions/0', JSON.stringify('expect_1'), '1、2', 'e1');
  has(issues[1]!.message, DECLARED + '/slots/0/assertions/1', JSON.stringify('expect_2'));
  assert.notEqual(issues[0]!.message, issues[1]!.message, 'two different assertions are two different refusals');
});

test('an assertion whose quotation is not the slot\'s sentence shows the reference and the text seen and expected', () => {
  const wrongRef = SOURCE + '/kityminder@1/n/other';
  const reference = only(recompositionGaps(plan(declared(e1('1')), [expect({ quote: { reference: wrongRef, text: QUOTE_TEXT } })]), proof(), { item: ITEM }));
  assert.equal(reference.verdict, 'refute');
  has(reference.message, '/slots/plan/0/data/expects/0/quote', JSON.stringify(wrongRef), JSON.stringify(QUOTE_REF));
  const text = only(recompositionGaps(plan(declared(e1('1')), [expect({ quote: { reference: QUOTE_REF, text: '另一句' } })]), proof(), { item: ITEM }));
  has(text.message, JSON.stringify('另一句'), JSON.stringify(QUOTE_TEXT));
  const criterion = only(recompositionGaps(plan(declared(e1('1')), [expect({ criterion: 'c2' })]), proof({ expectation_slots: [{ slot: 'e1', atom: 'a6', criterion_id: 'c1' }] }), { item: ITEM }));
  has(criterion.message, JSON.stringify('c2'), JSON.stringify('c1'));
});

test('a slot the record does not have, a shared assertion and a slot without an assertion are refused with their allowed sets', () => {
  const outside = only(recompositionGaps(plan(declared([...e1('1'), { slot: 'e9', assertions: ['2'] }])), proof(), { item: ITEM }));
  assert.equal(outside.verdict, 'refute');
  has(outside.message, DECLARED + '/slots/1/slot', JSON.stringify('e9'), 'e1');
  const twice = proof({ expectation_slots: [{ slot: 'e1', atom: 'a6' }, { slot: 'e2', atom: 'a6' }] });
  const shared = recompositionGaps(plan(declared([{ slot: 'e1', assertions: ['1'] }, { slot: 'e2', assertions: ['1'] }])), twice, { item: ITEM });
  assert.ok(shared.some(issue => issue.verdict === 'refute' && issue.message.includes(JSON.stringify('1')) && issue.message.includes('e1') && issue.message.includes('e2')), JSON.stringify(shared));
  const empty = recompositionGaps(plan(declared([{ slot: 'e1', assertions: [] }])), proof(), { item: ITEM });
  const gap = empty.find(issue => issue.verdict === 'unknown')!;
  assert.ok(gap, JSON.stringify(empty));
  has(gap.message, DECLARED + '/slots', 'e1', '"assertions":["1","2"]');
});

// The decisions: for each input the verdicts the check has always given, in order. A refusal that changed its words only keeps
// its row; one that changed its verdict, appeared or went away breaks this test.
const MATRIX: Array<[string, () => PlanSlots, string[]]> = [
  ['no declaration', () => plan(), ['unknown']],
  ['right declaration', () => plan(declared(e1('1', '2'))), []],
  ['wrong receipt', () => plan(declared(e1('1'), { receipt: 'rec:' + 'b'.repeat(64) })), ['refute']],
  ['wrong case id', () => plan(declared(e1('1'), { case_id: '999' })), ['refute']],
  ['wrong receipt and case id', () => plan(declared(e1('1'), { receipt: 'rec:' + 'b'.repeat(64), case_id: '999' })), ['refute']],
  ['unknown assertions', () => plan(declared(e1('x', 'y'))), ['refute', 'refute']],
  ['slot outside the record', () => plan(declared([...e1('1'), { slot: 'e9', assertions: ['2'] }])), ['refute']],
  ['slot without a row', () => plan(declared([])), ['unknown']],
  ['slot with an empty row', () => plan(declared([{ slot: 'e1', assertions: [] }])), ['unknown']],
  ['slot with two rows', () => plan(declared([{ slot: 'e1', assertions: ['1'] }, { slot: 'e1', assertions: ['2'] }])), ['unknown']],
];
test('the verdicts of the declaration check are what they were', () => {
  for (const [label, build, expected] of MATRIX) assert.deepEqual(recompositionGaps(build(), proof(), { item: ITEM }).map(issue => issue.verdict), expected, label);
  for (const [label, build, expected] of MATRIX) assert.deepEqual(recompositionGaps(build(), proof()).map(issue => issue.verdict), expected, label + ' without the item');
});

test('a record the check cannot read is judged as it always was: unknown without a declaration, an error where the old code threw', () => {
  const stub = (record: any): any => ({ receipt: RECEIPT, record });
  const declaredFor = (over: Record<string, unknown> = {}) => plan(declared(e1('1'), over));
  assert.deepEqual(recompositionGaps(plan(), stub({})).map(issue => issue.verdict), ['unknown']);
  assert.deepEqual(recompositionGaps(plan(), stub({ case: { id: CASE_ID }, atoms: [] })).map(issue => issue.verdict), ['unknown']);
  assert.deepEqual(recompositionGaps(declaredFor({ receipt: 'rec:' + 'b'.repeat(64) }), stub({})).map(issue => issue.verdict), ['refute']);
  assert.throws(() => recompositionGaps(declaredFor(), stub({})), TypeError);
  assert.throws(() => recompositionGaps(declaredFor(), stub({ case: { id: CASE_ID } })), TypeError);
  assert.throws(() => recompositionGaps(declaredFor(), stub({ case: { id: CASE_ID }, expectation_slots: [{ slot: 'e1', atom: 'a1' }] })), TypeError);
});

test('a plan checked against no admitted recomposition has nothing to refuse', () => {
  assert.deepEqual(recompositionGaps(plan(), null, { item: ITEM }), []);
});
