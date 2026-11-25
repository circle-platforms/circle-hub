import { test } from 'node:test';
import assert from 'node:assert/strict';
import check, { readWorkbook } from './workbook.ts';
import dispatchPolicy from './dispatch-policy.ts';
import { generateWorkbook, generateWorkbookSet, type GenerationInput } from './generate.ts';
import { generationFixture } from '../testing/workbook.ts';
import { coreModel, workbookCheckInput, digest } from '../testing/workbook-model.ts';
import { AUTOID } from './test-support.ts';
import { SCOPED_REOPEN } from '../testing/scoped-reopen.ts';
import DISPATCH from '../policies/dispatch.json' with { type: 'json' };

const SECOND = '990000000000000032';
function twoCases(): GenerationInput[] { const first = generationFixture(), second = generationFixture(); second.fields = { ...second.fields, autoid: SECOND, title: '合成用例二', path: ['合成文档', '合成用例二'] }; return [first, second]; }
const itemOf = (k: number) => 'doc-1:c-' + (k + 1);
function planSet(inputs: GenerationInput[]) { return inputs.map((input, k) => ({ item: itemOf(k), fields: { autoid: input.fields.autoid, title: input.fields.title, path: input.fields.path, priority: input.fields.priority, steps: input.fields.steps }, plan: input.slots, command_catalog: input.fields.command_catalog, command_identities: input.fields.command_identities })); }
function itemInput(inputs: GenerationInput[], bytes: Uint8Array, k: number, data: unknown = inputs[k].slots) {
  const base = workbookCheckInput(bytes);
  return { subject: { ...base.subject, item: itemOf(k), data, fields: inputs[k].fields, plan_set: planSet(inputs) } };
}

test('two cases make one workbook: one identity, header and description, each case followed by a blank row, then the closing row', () => {
  const inputs = twoCases(); const bytes = generateWorkbookSet(inputs); const read = readWorkbook(coreModel(bytes), inputs);
  assert.ok(read.ok, JSON.stringify(read)); if (!read.ok) return;
  assert.deepEqual(read.autoids, [AUTOID, SECOND]);
  assert.deepEqual(read.executions.map((v) => v.row), [8, 9, 10, 11, 13, 14, 15, 16]);
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
  assert.ok(result.some((row) => row.verdict === 'refute' && row.statement.includes(inputs[1].plan_run) && row.statement.includes('已受理版本不一致') && row.statement.includes('start_run 新开一次脚本编写运行')), JSON.stringify(result));
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
  assert.match(capped[0].statement, /工作簿有 2 个用例，超过一次派发最多 1 个/); assert.doesNotMatch(capped[0].statement, /修正政策表/);
});

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
function startInput(value: unknown, parameters: Record<string, unknown> = {}, extra: unknown[] = [], extraContext: Record<string, unknown> = {}) { return { inputs: [
  { slot: 'subject', sha256: 'a'.repeat(64), parser: 'kityminder@1', model: value },
  { slot: 'contract', model: runtimeDocument() }, { slot: 'profile', model: profileDocument() }, { slot: 'inventory', model: MANIFEST_DOC }, ...extra,
], parameters, context: { leases: { now: '2026-10-23T02:00:00.000Z', entries: [] }, ...extraContext } }; }
function recomposedStartInput(value: unknown, parameters: Record<string, unknown> = {}, extra: unknown[] = []) {
  const rawNodes = (value as { nodes?: Array<{ data?: { id?: string; autoid?: string }; selector?: string }> })?.nodes ?? [];
  const cases = rawNodes.filter((n) => typeof n.data?.autoid === 'string');
  const context = { product: 'orbit', root: 'r'.repeat(64), product_pack_digest: 'p'.repeat(64) };
  const runBody = {
    run: 'run_recompose_whole_mindmap',
    pack: 'recompose@1.3.2',
    pack_digest: 'd'.repeat(64),
    ...context,
    predecessor: null,
    items: cases.map((n, index) => ({
      id: `recompose-item-${index + 1}`,
      fields: { source_ref: `src:${'a'.repeat(64)}`, node: n.selector ?? '', case_id: n.data!.autoid },
    })),
  };
  const resultBody = {
    schema: 'validation@1',
    run: runBody.run,
    acceptance: 'accepted',
    locks: { pack: runBody.pack, pack_digest: runBody.pack_digest },
    partitions: {},
  };
  return startInput(
    value,
    parameters,
    [
      { slot: 'recomposition_run', external: null, meta: { kind: 'run', record: 'f'.repeat(64) }, model: { kind: 'run', body: runBody } },
      { slot: 'recomposition_result', external: null, meta: { kind: 'validation_result', record: 'e'.repeat(64) }, model: { kind: 'validation_result', body: resultBody } },
      ...extra,
    ],
    context,
  );
}
const errorCode = (input: unknown) => { const out = projectItems(input) as { error?: { code: string; fix: string } }; assert.ok(out.error?.fix, JSON.stringify(out).slice(0, 400)); return out.error!.code; };

test('without autoid the run takes every textual-autoid case of the document in order; duplicates refuse', () => {
  const out = projectItems(recomposedStartInput(twoCaseModel())) as { items: Array<{ id: string; fields: Record<string, unknown> }> };
  assert.deepEqual(out.items.map((item) => item.fields.autoid), [AUTOID, SECOND]);
  assert.deepEqual(out.items.map((item) => item.id), ['doc:case-1', 'doc:case-2']);
  assert.equal(errorCode(recomposedStartInput(twoCaseModel(AUTOID))), 'case-compile.autoid_ambiguous');
  const one = projectItems(startInput(twoCaseModel(), { autoid: SECOND })) as { items: Array<{ fields: Record<string, unknown> }> };
  assert.deepEqual(one.items.map((item) => item.fields.autoid), [SECOND]);
  assert.equal(errorCode(startInput(twoCaseModel(), { pipeline: 'recomposed' })), 'case-compile.invalid_parameter');
});

test('each case carries its mind-map path from the root, and the workbook shows it as AAA>BBB>CCC on the autoid row only', () => {
  const model = twoCaseModel(); model.nodes[0].children = [1, 7]; model.nodes.push({ text: '合成分组', data: { id: 'group' }, children: [4] });
  const out = projectItems(recomposedStartInput(model)) as { items: Array<{ fields: Record<string, unknown> }> };
  assert.deepEqual(out.items.map((item) => item.fields.path), [['合成文档', '合成标题一'], ['合成文档', '合成分组', '合成标题二']]);
  const inputs = twoCases(); inputs[1].fields = { ...inputs[1].fields, path: ['合成文档', '合成分组', '合成用例二'] };
  const bytes = generateWorkbookSet(inputs); const sheet = coreModel(bytes).sheets[0];
  const d = (row: number) => sheet.rows.find((r) => r.number === row)?.cells.find((c) => c.reference === `D${row}`)?.text;
  assert.equal(d(8), '合成文档>合成分组>合成用例'); assert.equal(d(13), '合成文档>合成分组>合成用例二');
  assert.equal(d(10) ?? '', ''); assert.equal(d(15) ?? '', '');
  assert.ok(readWorkbook(coreModel(bytes), inputs).ok);
  const other = structuredClone(inputs); other[1].fields.path = ['合成文档', '合成用例二'];
  const read = readWorkbook(coreModel(bytes), other); assert.ok(!read.ok);
  if (!read.ok) assert.deepEqual([...new Set(read.problems.map((v) => v.rule))].sort(), ['recipe', 'step']);
});

test('a workbook of several cases needs the plan run accepted result, and its plans are frozen in item order', () => {
  const workbook = { slot: 'workbook', parser: 'xlsx@1', sha256: 'b'.repeat(64), model: coreModel(generateWorkbook(generationFixture())) };
  const noPlanRun = projectItems(recomposedStartInput(twoCaseModel(), {}, [workbook])) as { error?: { code: string; pointer?: string; fix: string } };
  assert.equal(noPlanRun.error?.code, 'case-compile.workbook_context');
  assert.equal(noPlanRun.error?.pointer, '/parameters/plan_run');
  assert.match(noPlanRun.error?.fix ?? '', /parameters\.plan_run/);
  assert.match(noPlanRun.error?.fix ?? '', /predecessor/);
  assert.match(noPlanRun.error?.fix ?? '', /inputs\.plan_result/);
  const noPlanResult = projectItems(recomposedStartInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook])) as { error?: { code: string; pointer?: string; fix: string } };
  assert.equal(noPlanResult.error?.code, 'case-compile.workbook_context');
  assert.equal(noPlanResult.error?.pointer, '/inputs/plan_result');
  const ids = (projectItems(recomposedStartInput(twoCaseModel())) as { items: Array<{ id: string }> }).items.map((item) => item.id);
  const planClaim = (data: unknown, extra: Record<string, unknown> = {}) => ({ item: 'x', requirement: 'plan', pointer: '/items/0/slots/plan/0', statement: { text: '合成计划', ...(data === undefined ? {} : { data }), ...extra }, qualifier: { nature: 'judgment' } });
  const rows = (plan: (k: number) => unknown) => ids.map((item, k) => ({ item, requirements: [
    { requirement: 'plan', status: 'satisfied', claims: [plan(k)] },
    { requirement: 'commands_known', status: 'satisfied', claims: [{ statement: { verdict: 'support', data: { command_catalog: { root: 'c'.repeat(64), entries: [] } } } }] },
  ] }));
  const delivered = rows((k) => planClaim({ plan: k }));
  const result = (body: Record<string, unknown>) => ({ slot: 'plan_result', external: null, meta: { kind: 'validation_result', record: 'd'.repeat(64) }, model: { kind: 'validation_result', body: { schema: 'validation@1', acceptance: 'accepted', run: 'run_plan', locks: { pack: FORMAT.generator }, partitions: { delivered }, ...body } } });
  const out = projectItems(recomposedStartInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook, result({})])) as { groups: Array<{ plan_set: Array<{ item: string; plan: unknown; fields: { autoid: string } }> }> };
  assert.deepEqual(out.groups[0].plan_set.map((entry) => [entry.item, entry.plan, entry.fields.autoid]), [[ids[0], { plan: 0 }, AUTOID], [ids[1], { plan: 1 }, SECOND]]);
  const wrongRun = projectItems(recomposedStartInput(twoCaseModel(), { plan_run: 'run_other' }, [workbook, result({})])) as { error?: { code: string; pointer?: string } };
  assert.equal(wrongRun.error?.code, 'case-compile.workbook_context'); assert.equal(wrongRun.error?.pointer, '/inputs/plan_result');
  assert.equal(errorCode(recomposedStartInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook, result({ partitions: { delivered: delivered.slice(0, 1) } })])), 'case-compile.workbook_context');
  for (const plan of [(_k: number) => planClaim(undefined), (k: number) => planClaim({ plan: k }, { verdict: 'support' })])
    assert.equal(errorCode(recomposedStartInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook, result({ partitions: { delivered: rows(plan) } })])), 'case-compile.workbook_context');
});

import { createTestParserRegistry } from '../../../../hub/testing/parsers.ts';
import { recognize } from '../../../../hub/refs/api.ts';
import { fixture as blockFixture, positiveBlocks } from '../testing/blocks.ts';
type Projected = { error?: { code: string; message: string; fix: string }; items: Array<{ id: string; location: { selector: string }; fields: { autoid: string; title: string; steps: Array<{ text: string }> } }>; groups: Array<{ message: string }> };
const project = (input: unknown) => projectItems(input) as Projected;
import { mindmapSubject, type SyntheticCase } from '../testing/parsed-mindmap.ts';
const parsed = (cases: SyntheticCase[]) => mindmapSubject(cases).model;
const caseOne: SyntheticCase = { id: 'case-a', autoid: AUTOID, title: '合成用例一', step: 'widget health interval pool-a 60', expect: '生效一' };

test('a pasted case that kept the node id of its source is its own item with its own autoid', () => {
  const pasted = (auto = 'YES') => parsed([{ ...caseOne, id: 'pasted', auto }, { id: 'pasted', autoid: SECOND, title: '合成用例二', step: 'widget health interval pool-b 61', expect: '生效二' }]);
  const both = project(recomposedStartInput(pasted()));
  assert.equal(both.error, undefined, JSON.stringify(both.error));
  assert.deepEqual(both.items.map((item) => [item.fields.autoid, item.fields.title, item.location.selector, item.fields.steps.map((step) => step.text)]), [
    [AUTOID, '合成用例一', 'i/0', ['widget health interval pool-a 60']],
    [SECOND, '合成用例二', 'i/1', ['widget health interval pool-b 61']],
  ]);
  assert.equal(new Set(both.items.map((item) => item.id)).size, 2, 'a repeated node id takes the selector, so the item ids stay distinct');
  assert.deepEqual(project(startInput(pasted('NO'))).items.map((item) => [item.fields.autoid, item.fields.title, item.location.selector]), [[SECOND, '合成用例二', 'i/1']]);
  assert.deepEqual(project(startInput(parsed([caseOne]))).items.map((item) => item.id), ['synthetic-map:case-a']);
});

test('a whole run refuses autoids of another shape, naming the cases and their autoids, and counts the cases without one', () => {
  const two = (second: unknown, auto = 'YES') => parsed([caseOne, { id: 'case-b', autoid: second, auto, title: '合成用例二', step: 'widget health interval pool-b 61', expect: '生效二' }]);
  for (const bad of [SECOND + ' ', SECOND.slice(1), SECOND.slice(0, -1) + '２', 12345]) {
    const refused = project(recomposedStartInput(two(bad))).error;
    assert.equal(refused?.code, 'case-compile.autoid_invalid', JSON.stringify(refused));
    assert.ok(refused!.message.includes('n/case-b') && refused!.message.includes(JSON.stringify(bad)), refused!.message);
    assert.match(refused!.fix, /删去这些 autoid 后重新上传/); assert.match(refused!.fix, /parameters\.autoid/);
  }
  assert.equal(project(startInput(two(SECOND + ' ', 'NO'))).error, undefined);
  assert.equal(project(startInput(two(SECOND + ' '), { autoid: AUTOID })).error, undefined);
  const without = project(startInput(two(undefined)));
  assert.deepEqual(without.items.map((item) => item.fields.autoid), [AUTOID]);
  assert.match(without.groups[0].message, /另有 1 个用例没有 autoid，不编译/);
  assert.doesNotMatch(project(recomposedStartInput(two(SECOND))).groups[0].message, /没有 autoid/);
  const listed = project(recomposedStartInput(parsed(Array.from({ length: 12 }, (_, k) => ({ ...caseOne, id: `case-${k}`, autoid: `synthetic-${k}` }))))).error!;
  assert.equal(listed.code, 'case-compile.autoid_invalid'); assert.equal(listed.message.match(/n\/case-\d+/g)?.length, 10); assert.match(listed.message, /等 12 个/);
});

test('two block-plan cases that both capture into baseline verify, and a register does not carry over to the next case', () => {
  const f = blockFixture();
  const recipe = (autoid: string) => ({ slots: positiveBlocks().CAPTURE_COMPARE, fields: { ...f.fields, autoid }, contract: f.contract, profile: f.profile, plan_run: 'run_00000000000000000000000000', build: 'SYN_ORBIT_10_8_1' });
  const recipes = [recipe('SYN-BLOCK-1'), recipe('SYN-BLOCK-2')];
  const bytes = generateWorkbookSet(recipes); const model = coreModel(bytes);
  const read = readWorkbook(model, recipes);
  assert.ok(read.ok, JSON.stringify(read)); if (!read.ok) return;
  assert.deepEqual(read.autoids, ['SYN-BLOCK-1', 'SYN-BLOCK-2']);
  assert.ok(read.executions.filter((row) => row.h === 'baseline' && !row.assertion).length === 2, 'each case captures baseline itself');
  assert.equal(digest(generateWorkbookSet(recipes)), digest(bytes));
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
  const over = project(recomposedStartInput(cases(DISPATCH.max_items + 1))).error;
  assert.equal(over?.code, 'case-compile.too_many_cases', JSON.stringify(over));
  assert.ok(over!.message.includes(`${DISPATCH.max_items + 1} 个自动化用例`) && over!.message.includes(`最多 ${DISPATCH.max_items} 个`), over!.message);
  assert.match(over!.fix, /拆成几份/); assert.match(over!.fix, /parameters\.autoid/);
  const full = project(recomposedStartInput(cases(DISPATCH.max_items)));
  assert.equal(full.error, undefined, JSON.stringify(full.error)); assert.equal(full.items.length, DISPATCH.max_items);
});

import { rootDocumentId } from './cases.ts';
const outline = (leaf = '期望成功') => { const bytes = new TextEncoder().encode(JSON.stringify({ root: { data: { text: '合成文档' }, children: [{ data: { text: '合成分组' }, children: [{ data: { text: '合成标题一', resource: ['功能'], autoid: AUTOID }, children: [{ data: { text: '执行 widget health interval 60' }, children: [{ data: { text: leaf } }] }] }] }] } }));
  const read = recognize(createTestParserRegistry(), bytes, 'application/json'); assert.ok(read); return read.document.model; };
test('an uploaded mind map is named by its root node id, not by its first case', () => {
  assert.equal(rootDocumentId(twoCaseModel()), 'doc');
  const out = projectItems(recomposedStartInput(twoCaseModel())) as { items: Array<{ id: string }> };
  assert.ok(out.items.every((item) => item.id.startsWith('doc:')), JSON.stringify(out.items.map((item) => item.id)));
  const agile = recomposedStartInput(twoCaseModel()); (agile.inputs[0] as { external?: string }).external = 'agile:mindmap:90001@2026-11-01';
  const external = projectItems(agile) as { items: Array<{ id: string }> };
  assert.deepEqual(external.items.map((item) => item.id), ['90001:case-1', '90001:case-2'], 'an agile document id still wins');
});
test('a tree without node ids is named by a digest of its whole tree: the same on every run, another when the content changes', () => {
  const first = rootDocumentId(outline()), again = rootDocumentId(outline()), changed = rootDocumentId(outline('期望失败'));
  assert.match(first, /^tree-[a-f0-9]{64}$/); assert.equal(first, again); assert.notEqual(first, changed);
  const moved = outline(); (moved as any).nodes[1].text = '另一分组'; assert.notEqual(rootDocumentId(moved), first, 'a group text is part of the tree');
  const out = projectItems(startInput(outline())) as { items: Array<{ id: string }> };
  assert.equal(out.items.length, 1); assert.ok(out.items[0].id.startsWith(first + ':'), out.items[0].id);
  assert.equal((projectItems(startInput(outline())) as { items: Array<{ id: string }> }).items[0].id, out.items[0].id, 'two starts give the same item id');
});

test('a whole mind map requires recomposition bindings and rejects legacy pipeline mode, while a single case does not', () => {
  const two = parsed([caseOne, { ...caseOne, id: 'case-b', autoid: SECOND }]);
  const refused = project(startInput(two, {})).error;
  assert.equal(refused?.code, 'case-compile.invalid_parameter');
  assert.match(refused!.message, /要先走重组/);
  assert.doesNotMatch(refused!.fix, /legacy/);
  const legacyRefused = project(startInput(two, { pipeline: 'legacy' })).error;
  assert.equal(legacyRefused?.code, 'case-compile.invalid_parameter');
  assert.equal(project(recomposedStartInput(two, {})).error, undefined);
  assert.equal(project(startInput(two, { autoid: AUTOID })).error, undefined);
});

test('parameters.exclude leaves cases out of a whole-document run, and only there', () => {
  const two = parsed([caseOne, { ...caseOne, id: 'case-b', autoid: SECOND }]);
  assert.deepEqual(project(recomposedStartInput(two, { exclude: [AUTOID] })).items.map((item) => item.fields.autoid), [SECOND]);
  assert.equal(project(recomposedStartInput(two, { exclude: [AUTOID], autoid: SECOND })).error?.code, 'case-compile.invalid_parameter', 'exclude and autoid do not go together');
  for (const bad of [[], [AUTOID, AUTOID], ['not-an-autoid'], 'x']) assert.equal(project(recomposedStartInput(two, { exclude: bad })).error?.code, 'case-compile.invalid_parameter', JSON.stringify(bad));
  assert.equal(project(recomposedStartInput(two, { exclude: ['990000000000000099'] })).error?.code, 'case-compile.autoid_not_found', 'an autoid the rule does not take');
  const nothingLeft = project(recomposedStartInput(two, { exclude: [AUTOID, SECOND] })).error as { code: string; message: string; pointer?: string } | undefined;
  assert.deepEqual([nothingLeft?.code, nothingLeft?.pointer], ['case-compile.invalid_parameter', '/parameters/exclude'], 'nothing left to compile');
  assert.match(nothingLeft?.message ?? '', /exclude 排除了本次能编译的全部用例/);
});

test('parameters.scope projects only in-scope cases, freezes out_of_scope metadata, and refuses autoid/shape conflicts', () => {
  const THIRD = '990000000000000033';
  const three = parsed([caseOne, { ...caseOne, id: 'case-b', autoid: SECOND }, { ...caseOne, id: 'case-c', autoid: THIRD }]);
  const withAutoid = project(recomposedStartInput(three, { scope: { words: '本次只编译一条', cases: [AUTOID] }, autoid: AUTOID }));
  assert.equal(withAutoid.error?.code, 'case-compile.invalid_parameter', 'scope and autoid must be mutually exclusive');
  for (const bad of [
    '只做第一条',
    { words: '   ', cases: [AUTOID] },
    { words: '只做第一条', cases: [] },
    { words: '只做第一条', cases: [AUTOID, AUTOID] },
    { words: '只做第一条', cases: ['not-an-autoid'] },
    { words: '只做第一条', cases: [AUTOID], extra: true },
  ]) {
    assert.equal(project(recomposedStartInput(three, { scope: bad })).error?.code, 'case-compile.invalid_parameter', JSON.stringify(bad));
  }
  assert.equal(project(recomposedStartInput(three, { scope: { words: '缺编号', cases: ['990000000000000099'] } })).error?.code, 'case-compile.autoid_not_found');
  const picked = projectItems(recomposedStartInput(three, { scope: { words: '本次只编第一、三条', cases: [THIRD, AUTOID] } })) as {
    items: Array<{ fields: { autoid: string } }>;
    groups: Array<{ scope?: { words: string; cases: string[]; out_of_scope: Array<{ autoid: string; title: string }> } }>;
  };
  assert.deepEqual(picked.items.map((item) => item.fields.autoid), [AUTOID, THIRD]);
  assert.equal(picked.groups[0].scope?.words, '本次只编第一、三条');
  assert.deepEqual(picked.groups[0].scope?.out_of_scope.map((entry) => entry.autoid), [SECOND]);

  const workbook = { slot: 'workbook', parser: 'xlsx@1', sha256: 'b'.repeat(64), model: coreModel(generateWorkbook(generationFixture())) };
  const delivered = picked.items.map((item: any) => ({
    item: item.id,
    requirements: [
      { requirement: 'plan', status: 'satisfied', claims: [{ item: item.id, requirement: 'plan', statement: { text: '合成计划', data: { plan: 1 } } }] },
      { requirement: 'commands_known', status: 'satisfied', claims: [{ statement: { verdict: 'support', data: { command_catalog: { root: 'c'.repeat(64), entries: [] } } } }] },
    ],
  }));
  const planResult = { slot: 'plan_result', external: null, meta: { kind: 'validation_result', record: 'd'.repeat(64) }, model: { kind: 'validation_result', body: { schema: 'validation@1', acceptance: 'accepted', run: 'run_plan', locks: { pack: FORMAT.generator }, partitions: { delivered } } } };
  const narrowed = project(recomposedStartInput(three, { plan_run: 'run_plan', scope: { words: '中途改成一条', cases: [AUTOID] } }, [workbook, planResult]));
  assert.equal(narrowed.error?.code, 'case-compile.workbook_context');
});

test('parameters.exclude inside parameters.scope leaves those cases out of the run and keeps the scope as it was given: what tools/open-compile.ts sends for a later plan run', () => {
  const THIRD = '990000000000000033';
  const three = parsed([caseOne, { ...caseOne, id: 'case-b', autoid: SECOND }, { ...caseOne, id: 'case-c', autoid: THIRD }]);
  assert.deepEqual([SCOPED_REOPEN.scope.cases, SCOPED_REOPEN.exclude], [[AUTOID, SECOND], [SECOND]], 'the shared example names the cases of this model');
  type Scoped = { error?: { code: string; message: string; fix: string; pointer?: string }; items: Array<{ id: string; fields: { autoid: string } }>; groups: Array<{ scope?: { words: string; cases: string[]; out_of_scope: Array<{ autoid: string }> } }> };
  const reopened = projectItems(recomposedStartInput(three, SCOPED_REOPEN)) as Scoped;
  assert.equal(reopened.error, undefined, JSON.stringify(reopened.error));
  assert.deepEqual(reopened.items.map((item) => item.fields.autoid), [AUTOID], 'the excluded case of the scope is not compiled');
  assert.deepEqual([reopened.groups[0].scope?.words, reopened.groups[0].scope?.cases], [SCOPED_REOPEN.scope.words, SCOPED_REOPEN.scope.cases], 'the frozen scope is the whole one');
  assert.deepEqual(reopened.groups[0].scope?.out_of_scope.map((entry) => entry.autoid), [THIRD], 'an excluded case of the scope is not out of scope');
  assert.match(JSON.stringify(reopened), /按开运行 scope 纳入 1 条，scope 里另有 1 条由 exclude 排除，另有 1 条未纳入本次范围/);
  const outside = projectItems(recomposedStartInput(three, { scope: { words: '本次只编译第一条', cases: [AUTOID] }, exclude: [SECOND] })) as Scoped;
  assert.deepEqual([outside.error?.code, outside.error?.pointer], ['case-compile.invalid_parameter', '/parameters/exclude'], 'an exclude that names a case outside the scope is refused');
  assert.match(outside.error?.message ?? '', new RegExp(`exclude 里的 ${SECOND} 不在 parameters\\.scope\\.cases 里`));
  const nothingLeft = projectItems(recomposedStartInput(three, { ...SCOPED_REOPEN, exclude: [AUTOID, SECOND] })) as Scoped;
  assert.deepEqual([nothingLeft.error?.code, nothingLeft.error?.pointer], ['case-compile.invalid_parameter', '/parameters/exclude'], 'nothing left to compile, as without a scope');
  assert.deepEqual([(projectItems(recomposedStartInput(three, { ...SCOPED_REOPEN, exclude: ['990000000000000099'] })) as Scoped).error?.code], ['case-compile.autoid_not_found'], 'an exclude that names no case of the document is refused as before');

  const workbook = { slot: 'workbook', parser: 'xlsx@1', sha256: 'b'.repeat(64), model: coreModel(generateWorkbook(generationFixture())) };
  const planResultOf = (items: Scoped['items']) => ({ slot: 'plan_result', external: null, meta: { kind: 'validation_result', record: 'd'.repeat(64) }, model: { kind: 'validation_result', body: { schema: 'validation@1', acceptance: 'accepted', run: 'run_plan', locks: { pack: FORMAT.generator }, partitions: { delivered: items.map((item) => ({
    item: item.id,
    requirements: [
      { requirement: 'plan', status: 'satisfied', claims: [{ item: item.id, requirement: 'plan', statement: { text: '合成计划', data: { plan: 1 } } }] },
      { requirement: 'commands_known', status: 'satisfied', claims: [{ statement: { verdict: 'support', data: { command_catalog: { root: 'c'.repeat(64), entries: [] } } } }] },
    ],
  })) } } } });
  const merged = projectItems(recomposedStartInput(three, { plan_run: 'run_plan', ...SCOPED_REOPEN }, [workbook, planResultOf(reopened.items)])) as Scoped;
  assert.equal(merged.error, undefined, JSON.stringify(merged.error));
  assert.deepEqual(merged.items.map((item) => item.fields.autoid), [AUTOID]);
  const withoutExclude = project(recomposedStartInput(three, { plan_run: 'run_plan', scope: SCOPED_REOPEN.scope }, [workbook, planResultOf(reopened.items)]));
  assert.equal(withoutExclude.error?.code, 'case-compile.workbook_context', 'a merge run that leaves the exclude out asks for a case the plan run did not take');
  const whole = projectItems(recomposedStartInput(three, { scope: SCOPED_REOPEN.scope })) as Scoped;
  const addedExclude = projectItems(recomposedStartInput(three, { plan_run: 'run_plan', ...SCOPED_REOPEN }, [workbook, planResultOf(whole.items)])) as Scoped;
  assert.deepEqual([addedExclude.error?.code, addedExclude.error?.pointer], ['case-compile.workbook_context', '/parameters'], 'a merge run that excludes a case the plan run took is refused');
  assert.match(addedExclude.error?.message ?? '', /选出 1 条用例，所核对的脚本编写运行受理了 2 条，两次运行的 parameters\.scope 或 parameters\.exclude 不一致/);
  assert.match(addedExclude.error?.fix ?? '', /相同的 parameters\.scope 和 parameters\.exclude/);
});

import projectRecompose from '../recompose/functions/project.ts';
import sealRecompose from '../recompose/functions/seal.ts';

test('recompose parameters.scope filters items & seal batch while retaining full mindmap out_of_scope, and case-compile refuses exceeding bound recomposition_run (red-then-green)', () => {
  const THIRD = '990000000000000033';
  const SHA = 'a'.repeat(64);
  const threeModel = parsed([
    caseOne,
    { id: 'case-b', autoid: SECOND, title: '合成用例二', step: 'widget health interval pool-b 61', expect: '生效二' },
    { id: 'case-c', autoid: THIRD, title: '合成用例三', step: 'widget health interval pool-c 62', expect: '生效三' },
  ]);

  const recomposeInput = (scope?: unknown) => ({
    inputs: [{ slot: 'subject', sha256: SHA, parser: 'kityminder@1', model: threeModel }],
    parameters: scope === undefined ? {} : { scope },
    context: { run: 'run_recompose_scoped' },
  });

  for (const bad of [
    {},
    { words: '   ', cases: [AUTOID] },
    { words: '仅第一条', cases: [] },
    { words: '仅第一条', cases: [AUTOID, AUTOID] },
    { words: '仅第一条', cases: ['990000000000000099'] },
    { words: '仅第一条', cases: [AUTOID], extra: 1 },
  ]) {
    const out = projectRecompose(recomposeInput(bad)) as { error?: { code: string; fix: string } };
    assert.equal(out.error?.code, 'SUBMISSION_SCHEMA_VIOLATION', JSON.stringify(bad));
    assert.ok(out.error?.fix);
  }

  const recomposeOut = projectRecompose(recomposeInput({ words: '本次仅编第一、三条', cases: [THIRD, AUTOID] })) as unknown as {
    items: Array<{ id: string; fields: { case_id: string; source_ref: string; node: string } }>;
    groups: Array<{ kind: string; items: string[]; scope?: { words: string; cases: string[]; out_of_scope: Array<{ autoid: string; title: string }> } }>;
  };
  assert.deepEqual(recomposeOut.items.map((i) => i.fields.case_id), [AUTOID, THIRD]);
  assert.deepEqual(recomposeOut.groups[0].items, recomposeOut.items.map((i) => i.id));
  assert.equal(recomposeOut.groups[0].scope?.words, '本次仅编第一、三条');
  assert.deepEqual(recomposeOut.groups[0].scope?.cases, [THIRD, AUTOID]);
  assert.deepEqual(recomposeOut.groups[0].scope?.out_of_scope.map((c) => c.autoid), [SECOND]);

  const sealOk = sealRecompose({
    subject: {
      items: recomposeOut.items.map((i) => ({
        id: i.id,
        fields: i.fields,
        slots: { record: [{ data: { case: { source_ref: i.fields.source_ref, node: i.fields.node } } }] },
      })),
    },
  });
  assert.equal(sealOk[0].verdict, 'support');
  assert.equal((sealOk[0].data as { total: number; supplied: number }).total, 2);

  const recompRunBound = {
    slot: 'recomposition_run',
    external: null,
    meta: { kind: 'run', record: 'f'.repeat(64) },
    model: {
      kind: 'run',
      body: {
        run: 'run_recompose_scoped',
        pack: 'recompose@1.2.7',
        product: 'orbit',
        root: 'r'.repeat(64),
        product_pack_digest: 'p'.repeat(64),
        items: recomposeOut.items,
        groups: recomposeOut.groups,
      },
    },
  };
  const recompResultBound = {
    slot: 'recomposition_result',
    external: null,
    meta: { kind: 'validation_result', record: 'e'.repeat(64) },
    model: {
      kind: 'validation_result',
      body: {
        schema: 'validation@1',
        run: 'run_recompose_scoped',
        acceptance: 'accepted',
        locks: { pack: 'recompose@1.2.7', pack_digest: 'd'.repeat(64) },
        partitions: {},
      },
    },
  };
  const compileWithRecomp = (parameters: Record<string, unknown>) => ({
    inputs: [
      { slot: 'subject', sha256: SHA, parser: 'kityminder@1', model: threeModel },
      { slot: 'contract', model: runtimeDocument() },
      { slot: 'profile', model: profileDocument() },
      { slot: 'inventory', model: MANIFEST_DOC },
      recompRunBound,
      recompResultBound,
    ],
    parameters,
    context: { leases: { now: '2026-10-23T02:00:00.000Z', entries: [] }, product: 'orbit', root: 'r'.repeat(64), product_pack_digest: 'p'.repeat(64) },
  });

  const wholeTooWide = projectItems(compileWithRecomp({ pipeline: 'recomposed' })) as { error?: { code: string; message: string; fix: string; pointer?: string } };
  assert.equal(wholeTooWide.error?.code, 'case-compile.invalid_parameter', JSON.stringify(wholeTooWide));
  assert.match(wholeTooWide.error?.message ?? '', /超出.*冻结范围|不在.*冻结条目/);
  assert.match(wholeTooWide.error?.fix ?? '', /扩大范围.*recompose|重开.*recompose/);

  const scopeTooWide = projectItems(compileWithRecomp({ pipeline: 'recomposed', scope: { words: '临时加第二条', cases: [AUTOID, SECOND, THIRD] } })) as { error?: { code: string; pointer?: string; message: string; fix: string } };
  assert.equal(scopeTooWide.error?.code, 'case-compile.invalid_parameter', JSON.stringify(scopeTooWide));
  assert.equal(scopeTooWide.error?.pointer, '/parameters/scope/cases');
  assert.match(scopeTooWide.error?.message ?? '', new RegExp(SECOND));

  const autoidOutside = projectItems(compileWithRecomp({ autoid: SECOND, pipeline: 'recomposed' })) as { error?: { code: string; pointer?: string } };
  assert.equal(autoidOutside.error?.code, 'case-compile.invalid_parameter', JSON.stringify(autoidOutside));
  assert.equal(autoidOutside.error?.pointer, '/parameters/autoid');

  const leftOut = projectItems(compileWithRecomp({ scope: { words: '本次仅编第一、三条', cases: [THIRD, AUTOID] }, exclude: [THIRD] })) as { error?: unknown; items: Array<{ fields: { autoid: string } }> };
  assert.equal(leftOut.error, undefined, JSON.stringify(leftOut.error));
  assert.deepEqual(leftOut.items.map((item) => item.fields.autoid), [AUTOID], 'a case of the scope the recompose run froze is left out of a later plan run');

  const exactOk = projectItems(compileWithRecomp({ pipeline: 'recomposed', scope: { words: '本次仅编第一、三条', cases: [AUTOID, THIRD] } })) as { error?: unknown; items: Array<{ fields: { autoid: string } }> };
  assert.equal(exactOk.error, undefined, JSON.stringify(exactOk.error));
  assert.deepEqual(exactOk.items.map((i) => i.fields.autoid), [AUTOID, THIRD]);

  const narrowOk = projectItems(compileWithRecomp({ pipeline: 'recomposed', scope: { words: '再收窄到第一条', cases: [AUTOID] } })) as { error?: unknown; items: Array<{ fields: { autoid: string } }> };
  assert.equal(narrowOk.error, undefined, JSON.stringify(narrowOk.error));
  assert.deepEqual(narrowOk.items.map((i) => i.fields.autoid), [AUTOID]);
});
