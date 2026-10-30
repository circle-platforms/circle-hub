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
  assert.equal(errorCode(startInput(twoCaseModel(AUTOID))), 'case-compile.autoid_ambiguous');
  const one = projectItems(startInput(twoCaseModel(), { autoid: SECOND })) as { items: Array<{ fields: Record<string, unknown> }> };
  assert.deepEqual(one.items.map((item) => item.fields.autoid), [SECOND]);
  assert.equal(errorCode(startInput(twoCaseModel(), { pipeline: 'recomposed' })), 'case-compile.invalid_parameter');
});

test('a workbook of several cases needs the plan run accepted result, and its plans are frozen in item order', () => {
  const workbook = { slot: 'workbook', parser: 'xlsx@1', sha256: 'b'.repeat(64), model: coreModel(generateWorkbook(generationFixture())) };
  assert.equal(errorCode(startInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook])), 'case-compile.workbook_context');
  const ids = (projectItems(startInput(twoCaseModel())) as { items: Array<{ id: string }> }).items.map((item) => item.id);
  const delivered = ids.map((item, k) => ({ item, requirements: [
    { requirement: 'plan', status: 'satisfied', claims: [{ statement: { verdict: 'support', data: { plan: k } } }] },
    { requirement: 'commands_known', status: 'satisfied', claims: [{ statement: { verdict: 'support', data: { command_catalog: { root: 'c'.repeat(64), entries: [] } } } }] },
  ] }));
  const result = (body: Record<string, unknown>) => ({ slot: 'plan_result', external: null, meta: { kind: 'validation_result', record: 'd'.repeat(64) }, model: { kind: 'validation_result', body: { schema: 'validation@1', acceptance: 'accepted', run: 'run_plan', locks: { pack: FORMAT.generator }, partitions: { delivered }, ...body } } });
  const out = projectItems(startInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook, result({})])) as { groups: Array<{ plan_set: Array<{ item: string; plan: unknown; fields: { autoid: string } }> }> };
  assert.deepEqual(out.groups[0].plan_set.map((entry) => [entry.item, entry.plan, entry.fields.autoid]), [[ids[0], { plan: 0 }, AUTOID], [ids[1], { plan: 1 }, SECOND]]);
  assert.equal(errorCode(startInput(twoCaseModel(), { plan_run: 'run_other' }, [workbook, result({})])), 'case-compile.workbook_context');
  assert.equal(errorCode(startInput(twoCaseModel(), { plan_run: 'run_plan' }, [workbook, result({ partitions: { delivered: delivered.slice(0, 1) } })])), 'case-compile.workbook_context');
});
