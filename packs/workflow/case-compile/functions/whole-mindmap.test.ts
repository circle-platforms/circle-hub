// One workbook for the whole document (decision 104): several cases of one run in one workbook, each item's check regenerating
// the whole workbook from the plans the plan run accepted. Synthetic cases only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import check, { readWorkbook } from './workbook.ts';
import dispatchPolicy from './dispatch-policy.ts';
import { generateWorkbook, generateWorkbookSet, type GenerationInput } from './generate.ts';
import { generationFixture } from '../testing/workbook.ts';
import { coreModel, workbookCheckInput, digest } from '../testing/workbook-model.ts';
import { AUTOID } from './test-support.ts';
import DISPATCH from '../policies/dispatch.json' with { type: 'json' };

const SECOND = '990000000000000032';
function twoCases(): GenerationInput[] { const first = generationFixture(), second = generationFixture(); second.fields = { ...second.fields, autoid: SECOND, title: '合成用例二' }; return [first, second]; }
const itemOf = (k: number) => 'doc-1:c-' + (k + 1);
function planSet(inputs: GenerationInput[]) { return inputs.map((input, k) => ({ item: itemOf(k), fields: { autoid: input.fields.autoid, title: input.fields.title, priority: input.fields.priority, steps: input.fields.steps }, plan: input.slots, command_catalog: input.fields.command_catalog, command_identities: input.fields.command_identities })); }
function itemInput(inputs: GenerationInput[], bytes: Uint8Array, k: number, data: unknown = inputs[k].slots) {
  const base = workbookCheckInput(bytes);
  return { subject: { ...base.subject, item: itemOf(k), data, fields: inputs[k].fields, plan_set: planSet(inputs) } };
}

test('two cases make one workbook: one identity, header and description, each case followed by a blank row, then the closing row', () => {
  const inputs = twoCases(); const bytes = generateWorkbookSet(inputs); const read = readWorkbook(coreModel(bytes), inputs);
  assert.ok(read.ok, JSON.stringify(read)); if (!read.ok) return;
  assert.deepEqual(read.autoids, [AUTOID, SECOND]);
  assert.deepEqual(read.executions.map((v) => v.row), [4, 5, 6, 7, 9, 10, 11, 12]);
  assert.equal(digest(generateWorkbookSet([inputs[0]])), digest(generateWorkbook(inputs[0])));
});

test('each item check regenerates the whole workbook from the frozen plans and supports with every autoid', () => {
  const inputs = twoCases(); const bytes = generateWorkbookSet(inputs);
  const results = [0, 1].map((k) => check(itemInput(inputs, bytes, k)));
  for (const result of results) { assert.equal(result.length, 1); assert.equal(result[0].verdict, 'support', JSON.stringify(result)); }
  assert.deepEqual(results[0][0].data!.autoids, [AUTOID, SECOND]);
  assert.deepEqual(results[0][0].data, results[1][0].data);
  assert.equal(results[0][0].data!.sha256, digest(bytes));
});

test('an item whose resubmitted plan differs from its frozen plan is refused', () => {
  const inputs = twoCases(); const bytes = generateWorkbookSet(inputs);
  const changed = structuredClone(inputs[1].slots); changed.steps[0] = { ...changed.steps[0], args: ['widget health interval 61'] };
  const result = check(itemInput(inputs, bytes, 1, changed));
  assert.ok(result.some((row) => row.verdict === 'refute' && row.statement.includes('本条重交的计划不等于计划运行受理的计划')), JSON.stringify(result));
});

test('a workbook read against one case, against another order, or one case missing from the frozen set is refused', () => {
  const inputs = twoCases(); const model = coreModel(generateWorkbookSet(inputs));
  assert.equal(readWorkbook(model, [inputs[0]]).ok, false);
  assert.equal(readWorkbook(model, [inputs[1], inputs[0]]).ok, false);
  const single = check(itemInput(inputs, generateWorkbook(inputs[0]), 0));
  assert.ok(single.some((row) => row.verdict !== 'support'), JSON.stringify(single));
});

test('duplicate autoids cannot share one workbook', () => {
  const inputs = twoCases(); inputs[1].fields = { ...inputs[1].fields, autoid: AUTOID };
  assert.throws(() => generateWorkbookSet(inputs), /autoid 重复/);
});

test('the dispatch policy binds every case of the workbook and its declared maximum', () => {
  const inputs = twoCases(); const bytes = generateWorkbookSet(inputs);
  const supported = dispatchPolicy({ ...itemInput(inputs, bytes, 0), table: DISPATCH });
  assert.equal(supported[0].verdict, 'support', JSON.stringify(supported));
  assert.deepEqual((supported[0].data as any).parameters.items, [AUTOID, SECOND]);
  const capped = dispatchPolicy({ ...itemInput(inputs, bytes, 0), table: { ...DISPATCH, max_items: 1 } });
  assert.equal(capped[0].verdict, 'refute', JSON.stringify(capped));
  // The cap is the document's size, not a defect of the policy table.
  assert.match(capped[0].statement, /工作簿有 2 个用例，超过一次派发最多 1 个/); assert.doesNotMatch(capped[0].statement, /修正政策表/);
});

// ---- startup: the whole document without autoid
import { projectItems } from './project.ts';
import { MANIFEST_DOC } from './test-support.ts';
import { runtimeDocument, profileDocument } from '../testing/runtime.ts';
import FORMAT from '../tables/workbook-format.json' with { type: 'json' };
function twoCaseModel(second = SECOND) { return { nodes: [
  { text: '合成文档', data: { id: 'doc' }, children: [1, 4] },
  { text: '合成标题一', data: { id: 'case-1', resource: ['功能'], autoid: AUTOID, auto: '01', priority: '02' }, children: [2] },
  { text: '执行 widget health interval 60', data: {}, children: [3] },
  { text: '期望成功', data: {}, children: [] },
  { text: '合成标题二', data: { id: 'case-2', resource: ['功能'], autoid: second, auto: '01', priority: '02' }, children: [5] },
  { text: '执行 widget health interval 61', data: {}, children: [6] },
  { text: '期望成功', data: {}, children: [] },
] }; }
function startInput(value: unknown, parameters: Record<string, unknown> = {}, extra: unknown[] = []) { return { inputs: [
  { slot: 'subject', sha256: 'a'.repeat(64), parser: 'kityminder@1', model: value },
  { slot: 'contract', model: runtimeDocument() }, { slot: 'profile', model: profileDocument() }, { slot: 'inventory', model: MANIFEST_DOC }, ...extra,
], parameters, context: { leases: { now: '2026-10-23T02:00:00.000Z', entries: [] } } }; }
const errorCode = (input: unknown) => { const out = projectItems(input) as { error?: { code: string; fix: string } }; assert.ok(out.error?.fix, JSON.stringify(out).slice(0, 400)); return out.error!.code; };

test('without autoid the run takes every textual-autoid case of the document in order; duplicates refuse', () => {
  const out = projectItems(startInput(twoCaseModel())) as { items: Array<{ id: string; fields: Record<string, unknown> }> };
  assert.deepEqual(out.items.map((item) => item.fields.autoid), [AUTOID, SECOND]);
  assert.deepEqual(out.items.map((item) => item.id), ['case-1:case-1', 'case-1:case-2'], 'a node id that names one node keeps <document>:<node id>');
  assert.equal(errorCode(startInput(twoCaseModel(AUTOID))), 'case-compile.autoid_ambiguous');
  const one = projectItems(startInput(twoCaseModel(), { autoid: SECOND })) as { items: Array<{ fields: Record<string, unknown> }> };
  assert.deepEqual(one.items.map((item) => item.fields.autoid), [SECOND]);
  assert.equal(errorCode(startInput(twoCaseModel(), { pipeline: 'recomposed' })), 'case-compile.invalid_parameter');
});

test('a workbook of several cases needs the plan run accepted result, and its plans are frozen in item order', () => {
  const workbook = { slot: 'workbook', parser: 'xlsx@1', sha256: 'b'.repeat(64), model: coreModel(generateWorkbook(generationFixture())) };
  assert.equal(errorCode(startInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook])), 'case-compile.workbook_context');
  const ids = (projectItems(startInput(twoCaseModel())) as { items: Array<{ id: string }> }).items.map((item) => item.id);
  // The shapes the Hub records: the plan is the model's judgment claim (the plan slot's text and data, no rule verdict), the
  // catalog receipt the commands_known rule verdict.
  const planClaim = (data: unknown, extra: Record<string, unknown> = {}) => ({ item: 'x', requirement: 'plan', pointer: '/items/0/slots/plan/0', statement: { text: '合成计划', ...(data === undefined ? {} : { data }), ...extra }, qualifier: { nature: 'judgment' } });
  const rows = (plan: (k: number) => unknown) => ids.map((item, k) => ({ item, requirements: [
    { requirement: 'plan', status: 'satisfied', claims: [plan(k)] },
    { requirement: 'commands_known', status: 'satisfied', claims: [{ statement: { verdict: 'support', data: { command_catalog: { root: 'c'.repeat(64), entries: [] } } } }] },
  ] }));
  const delivered = rows((k) => planClaim({ plan: k }));
  const result = (body: Record<string, unknown>) => ({ slot: 'plan_result', external: null, meta: { kind: 'validation_result', record: 'd'.repeat(64) }, model: { kind: 'validation_result', body: { schema: 'validation@1', acceptance: 'accepted', run: 'run_plan', locks: { pack: FORMAT.generator }, partitions: { delivered }, ...body } } });
  const out = projectItems(startInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook, result({})])) as { groups: Array<{ plan_set: Array<{ item: string; plan: unknown; fields: { autoid: string } }> }> };
  assert.deepEqual(out.groups[0].plan_set.map((entry) => [entry.item, entry.plan, entry.fields.autoid]), [[ids[0], { plan: 0 }, AUTOID], [ids[1], { plan: 1 }, SECOND]]);
  assert.equal(errorCode(startInput(twoCaseModel(), { plan_run: 'run_other' }, [workbook, result({})])), 'case-compile.workbook_context');
  assert.equal(errorCode(startInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook, result({ partitions: { delivered: delivered.slice(0, 1) } })])), 'case-compile.workbook_context');
  // A plan claim without the plan's data, or a rule verdict standing in for the model's plan, freezes nothing.
  for (const plan of [(_k: number) => planClaim(undefined), (k: number) => planClaim({ plan: k }, { verdict: 'support' })])
    assert.equal(errorCode(startInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook, result({ partitions: { delivered: rows(plan) } })])), 'case-compile.workbook_context');
});

// ---- 3.9.6: node identity, autoid shape, registers per case and the item cap
import { createTestParserRegistry } from '../../../../hub/testing/parsers.ts';
import { recognize } from '../../../../hub/refs/api.ts';
import { fixture as blockFixture, positiveBlocks } from '../testing/blocks.ts';
type Projected = { error?: { code: string; message: string; fix: string }; items: Array<{ id: string; location: { selector: string }; fields: { autoid: string; title: string; steps: Array<{ text: string }> } }>; groups: Array<{ message: string }> };
const project = (input: unknown) => projectItems(input) as Projected;
interface SyntheticCase { id: string; autoid?: unknown; auto?: string; title: string; step: string; expect: string }
/** A synthetic KityMinder document read by the kityminder@1 parser, so the selectors are the parser's. */
function parsed(cases: SyntheticCase[]): unknown {
  const map = { root: { data: { id: 'synthetic-map', text: '合成用例' }, children: cases.map((c, i) => ({ data: { id: c.id, text: c.title, priority: 2, resource: ['合成'], auto: c.auto ?? 'YES', ...(c.autoid === undefined ? {} : { autoid: c.autoid }) }, children: [{ data: { id: `step-${i}`, text: c.step }, children: [{ data: { id: `expected-${i}`, text: c.expect } }] }] })) } };
  return recognize(createTestParserRegistry(), Buffer.from(JSON.stringify(map)), 'application/json')!.document.model;
}
const caseOne: SyntheticCase = { id: 'case-a', autoid: AUTOID, title: '合成用例一', step: 'widget health interval pool-a 60', expect: '生效一' };

test('a pasted case that kept the node id of its source is its own item with its own autoid', () => {
  const pasted = (auto = 'YES') => parsed([{ ...caseOne, id: 'pasted', auto }, { id: 'pasted', autoid: SECOND, title: '合成用例二', step: 'widget health interval pool-b 61', expect: '生效二' }]);
  const both = project(startInput(pasted()));
  assert.equal(both.error, undefined, JSON.stringify(both.error));
  assert.deepEqual(both.items.map((item) => [item.fields.autoid, item.fields.title, item.location.selector, item.fields.steps.map((step) => step.text)]), [
    [AUTOID, '合成用例一', 'i/0', ['widget health interval pool-a 60']],
    [SECOND, '合成用例二', 'i/1', ['widget health interval pool-b 61']],
  ]);
  assert.equal(new Set(both.items.map((item) => item.id)).size, 2, 'a repeated node id takes the selector, so the item ids stay distinct');
  // The first copy declared not automatable: the only item is the second case, under its own autoid, title and node.
  assert.deepEqual(project(startInput(pasted('NO'))).items.map((item) => [item.fields.autoid, item.fields.title, item.location.selector]), [[SECOND, '合成用例二', 'i/1']]);
  // A node id that names one node keeps the item id <document>:<node id>.
  assert.deepEqual(project(startInput(parsed([caseOne]))).items.map((item) => item.id), ['case-a:case-a']);
});

test('a whole run refuses autoids of another shape, naming the cases and their autoids, and counts the cases without one', () => {
  const two = (second: unknown, auto = 'YES') => parsed([caseOne, { id: 'case-b', autoid: second, auto, title: '合成用例二', step: 'widget health interval pool-b 61', expect: '生效二' }]);
  for (const bad of [SECOND + ' ', SECOND.slice(1), SECOND.slice(0, -1) + '２', 12345]) {
    const refused = project(startInput(two(bad))).error;
    assert.equal(refused?.code, 'case-compile.autoid_invalid', JSON.stringify(refused));
    assert.ok(refused!.message.includes('n/case-b') && refused!.message.includes(JSON.stringify(bad)), refused!.message);
    assert.match(refused!.fix, /删去这些 autoid 后重新上传/); assert.match(refused!.fix, /parameters\.autoid/);
  }
  // A case declared not automatable, or a run that names another case: nothing to refuse.
  assert.equal(project(startInput(two(SECOND + ' ', 'NO'))).error, undefined);
  assert.equal(project(startInput(two(SECOND + ' '), { autoid: AUTOID })).error, undefined);
  // Without an autoid the case is not compiled, and the selection summary says how many.
  const without = project(startInput(two(undefined)));
  assert.deepEqual(without.items.map((item) => item.fields.autoid), [AUTOID]);
  assert.match(without.groups[0].message, /另有 1 个用例没有 autoid，不编译/);
  assert.doesNotMatch(project(startInput(two(SECOND))).groups[0].message, /没有 autoid/);
  // Ten cases are named, then the count.
  const listed = project(startInput(parsed(Array.from({ length: 12 }, (_, k) => ({ ...caseOne, id: `case-${k}`, autoid: `synthetic-${k}` }))))).error!;
  assert.equal(listed.code, 'case-compile.autoid_invalid'); assert.equal(listed.message.match(/n\/case-\d+/g)?.length, 10); assert.match(listed.message, /等 12 个/);
});

test('two block-plan cases that both capture into baseline verify, and a register does not carry over to the next case', () => {
  // InfoTest keeps registers within one case (the runner's static preflight resets them at every case start).
  const f = blockFixture();
  const recipe = (autoid: string) => ({ slots: positiveBlocks().CAPTURE_COMPARE, fields: { ...f.fields, autoid }, contract: f.contract, profile: f.profile, plan_run: 'run_00000000000000000000000000', build: 'SYN_ORBIT_10_8_1' });
  const recipes = [recipe('SYN-BLOCK-1'), recipe('SYN-BLOCK-2')];
  const bytes = generateWorkbookSet(recipes); const model = coreModel(bytes);
  const read = readWorkbook(model, recipes);
  assert.ok(read.ok, JSON.stringify(read)); if (!read.ok) return;
  assert.deepEqual(read.autoids, ['SYN-BLOCK-1', 'SYN-BLOCK-2']);
  assert.ok(read.executions.filter((row) => row.h === 'baseline' && !row.assertion).length === 2, 'each case captures baseline itself');
  assert.equal(digest(generateWorkbookSet(recipes)), digest(bytes));
  // Rename the second case's own capture: its checkpoint then reads a register only the first case captured.
  const rows = (model as any).sheets[0].rows as Array<{ cells: Array<{ reference: string; text: string }> }>;
  const start = rows.findIndex((row) => row.cells.some((cell) => cell.reference.startsWith('A') && cell.text === 'SYN-BLOCK-2'));
  const capture = rows.slice(start).find((row) => row.cells.some((cell) => cell.reference.startsWith('H') && cell.text === 'baseline'))!;
  capture.cells.find((cell) => cell.reference.startsWith('H'))!.text = 'other';
  const moved = readWorkbook(model, recipes);
  assert.equal(moved.ok, false);
  assert.ok(!moved.ok && moved.problems.some((problem) => problem.rule === 'register' && /寄存器未先捕获/.test(problem.message)), JSON.stringify(moved));
});

test('more cases than one dispatch takes are refused at the start with the cap and a split the workflow offers', () => {
  const cases = (n: number) => parsed(Array.from({ length: n }, (_, k) => ({ ...caseOne, id: `case-${k}`, autoid: String(990000000000000100n + BigInt(k)) })));
  const over = project(startInput(cases(DISPATCH.max_items + 1))).error;
  assert.equal(over?.code, 'case-compile.too_many_cases', JSON.stringify(over));
  assert.ok(over!.message.includes(`${DISPATCH.max_items + 1} 个自动化用例`) && over!.message.includes(`最多 ${DISPATCH.max_items} 个`), over!.message);
  assert.match(over!.fix, /拆成几份/); assert.match(over!.fix, /parameters\.autoid/);
  const full = project(startInput(cases(DISPATCH.max_items)));
  assert.equal(full.error, undefined, JSON.stringify(full.error)); assert.equal(full.items.length, DISPATCH.max_items);
});
