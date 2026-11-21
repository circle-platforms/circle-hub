import assert from 'node:assert/strict';
import {test} from 'node:test';
import check, {readWorkbook, type ReadExecution} from './workbook.ts';
import dispatchPolicy from './dispatch-policy.ts';
import {generateWorkbookSet, GENERATOR, type GenerationInput} from './generate.ts';
import {readSlots, type PlanSlots} from './slots.ts';
import {compactModel, type WorkbookModel} from './generated/skills/runner-workbook/workbook-writer/xlsx-model.ts';
import {cellFixture, cellPlan, EXPECTED, EXPECTED_REF} from '../testing/blocks.ts';
import {TEMPLATE_HEADER_ROW} from '../testing/template.ts';
import {coreModel, digest} from '../testing/workbook-model.ts';
import DISPATCH from '../policies/dispatch.json' with {type: 'json'};

type Kind = 'block' | 'flat';
const RUN = 'run_00000000000000000000000000', BUILD = 'SYN-BUILD-A';
const autoidOf = (k: number) => `SYN-BLOCK-${k + 1}`;
const itemOf = (k: number) => `doc-1:c-${k + 1}`;
const flatPlan = (): PlanSlots => ({bucket: 'bed-a', blocks: [], steps: [{object: 'device0', method: 'command', args: ['demo show'], keywords: {}, description: '合成平铺步骤'}], expects: [{text: EXPECTED, quote: {reference: EXPECTED_REF, text: EXPECTED}, after: 1}], replacements: []});

function scenario(kinds: Kind[]) {
  const f = cellFixture();
  const inputs: GenerationInput[] = kinds.map((kind, k) => {
    const title = `${kind === 'block' ? '合成取格用例' : '合成平铺用例'}${k + 1}`;
    return {slots: kind === 'block' ? cellPlan() : flatPlan(), fields: {...f.fields, autoid: autoidOf(k), title, path: ['合成文档', '合成分组', title]}, contract: f.contract, profile: f.profile, plan_run: RUN, build: BUILD};
  });
  const bytes = generateWorkbookSet(inputs);
  return {f, kinds, inputs, bytes, model: coreModel(bytes)};
}
type Scenario = ReturnType<typeof scenario>;

function layout(inputs: GenerationInput[]): number[][] {
  let at = TEMPLATE_HEADER_ROW + 2;
  return inputs.map((input) => {
    const read = readSlots(input.slots); assert.ok(read.ok, JSON.stringify(read));
    const length = read.ok ? read.slots.steps.length + read.slots.expects.length : 0;
    const rows = Array.from({length}, (_, i) => at + i); at += length + 1; return rows;
  });
}
function put(model: WorkbookModel, number: number, column: string, text: string): WorkbookModel {
  const row = model.sheets[0].rows.find((value) => value.number === number)!; const cell = row.cells.find((value) => value.reference === column + number);
  if (cell) { cell.text = text; cell.type = 'inlineStr'; } else row.cells.push({reference: column + number, type: 'inlineStr', text, style: null, formula: false});
  return model;
}
function itemInput(s: Scenario, k: number, model: WorkbookModel = compactModel(s.model)) {
  const plans = s.inputs.map((input, j) => ({item: itemOf(j), fields: {autoid: input.fields.autoid, title: input.fields.title, path: input.fields.path, priority: input.fields.priority, steps: input.fields.steps, expected_nodes: input.fields.expected_nodes}, plan: input.slots, command_catalog: input.fields.command_catalog, command_identities: input.fields.command_identities}));
  const own = s.inputs[k];
  return s.f.subject(own.slots, {item: itemOf(k), fields: {...own.fields}, generation: {plan_run: own.plan_run, build: own.build, generator: GENERATOR}, workbook: {model, sha256: digest(s.bytes)}, plan_set: plans});
}

const MIXTURES: Kind[][] = [['block', 'flat'], ['flat', 'block'], ['block', 'flat', 'block']];

for (const kinds of MIXTURES) test(`a block plan with a cell selection and a flat plan share one workbook (${kinds.join(', ')}), each case read with its own plan`, () => {
  const s = scenario(kinds), read = readWorkbook(s.model, s.inputs);
  assert.ok(read.ok, JSON.stringify(read)); if (!read.ok) return;
  assert.deepEqual(read.autoids, kinds.map((_, k) => autoidOf(k)));
  const rows = layout(s.inputs);
  assert.equal(read.executions.length, rows.flat().length, 'every generated execution row is read');
  for (const [k, kind] of kinds.entries()) {
    const own: ReadExecution[] = read.executions.filter((row: ReadExecution) => rows[k].includes(row.row));
    assert.equal(own.length, rows[k].length, `case ${k + 1} keeps all of its rows`);
    if (kind === 'flat') assert.ok(own.every((row: ReadExecution) => !('h' in row) && !('i' in row)), 'a flat row carries no registers');
    else {
      const select = own.find((row: ReadExecution) => row.method === 'table_cell')!;
      assert.deepEqual([select.h, select.i], ['selected', 'source_text']);
      assert.deepEqual(own.find((row: ReadExecution) => row.i === 'selected' && row.method !== 'table_cell')!.args, ['demo set {}']);
    }
  }
  assert.equal(readWorkbook(s.model, [...s.inputs].reverse()).ok, false, 'another order of the same cases is refused');
});

test('workbook_verified supports every case of a mixed workbook with the same data, and the dispatch policy binds all of them', () => {
  const s = scenario(['block', 'flat']);
  const results = [0, 1].map((k) => check(itemInput(s, k)));
  for (const result of results) { assert.equal(result.length, 1); assert.equal(result[0].verdict, 'support', JSON.stringify(result)); }
  assert.deepEqual(results[0][0].data!.autoids, [autoidOf(0), autoidOf(1)]);
  assert.deepEqual(results[0][0].data, results[1][0].data);
  assert.equal(results[0][0].data!.sha256, digest(s.bytes));
  const dispatched = dispatchPolicy({...itemInput(s, 0), table: DISPATCH});
  assert.equal(dispatched[0].verdict, 'support', JSON.stringify(dispatched));
  assert.deepEqual((dispatched[0].data!.parameters as {items: string[]}).items, [autoidOf(0), autoidOf(1)]);
});

for (const kinds of [['block', 'flat'], ['flat', 'block']] as Kind[][]) for (const [place, which] of [['step row', 0], ['assertion row', 1]] as const) for (const column of ['H', 'I']) {
  test(`${column} written on the ${place} of a flat case is refused although another case of the workbook is a block plan (${kinds.join(', ')})`, () => {
    const s = scenario(kinds), flat = kinds.indexOf('flat'), row = layout(s.inputs)[flat][which];
    put(s.model, row, column, 'rogue_register');
    const read = readWorkbook(s.model, s.inputs);
    assert.equal(read.ok, false);
    if (!read.ok) assert.ok(read.problems.some((problem) => problem.rule === 'execution' && problem.pointer === `/sheets/0/rows/${row - 1}`), JSON.stringify(read.problems));
    const result = check(itemInput(s, flat, compactModel(s.model)));
    assert.ok(result.length > 0 && result.every((outcome) => outcome.verdict === 'refute' && outcome.code === 'case-compile.workbook_invalid'), JSON.stringify(result));
    assert.ok(result.some((outcome) => outcome.statement.includes('H/I 必须为空')), JSON.stringify(result));
  });
}

const CORRUPTIONS: Record<string, (model: WorkbookModel, rows: number[]) => WorkbookModel> = {
  'a cell selection that reads a register no earlier row saved': (model, rows) => put(model, rows[1], 'I', 'absent'),
  'a cell fill that names a register nobody saved': (model, rows) => put(model, rows[2], 'I', 'absent'),
  'a fill that takes a raw capture where a selected cell belongs': (model, rows) => put(model, rows[2], 'I', 'source_text'),
  'a capture whose register was dropped': (model, rows) => put(model, rows[0], 'H', ''),
};
for (const kinds of [['block', 'flat'], ['flat', 'block']] as Kind[][]) for (const [name, corrupt] of Object.entries(CORRUPTIONS)) {
  test(`block case rows stay checked in a mixed workbook (${kinds.join(', ')}): ${name}`, () => {
    const s = scenario(kinds), block = kinds.indexOf('block'), rows = layout(s.inputs)[block];
    corrupt(s.model, rows);
    const read = readWorkbook(s.model, s.inputs);
    assert.equal(read.ok, false);
    if (!read.ok) assert.ok(read.problems.some((problem) => problem.rule === 'register' && rows.some((row) => problem.pointer === `/sheets/0/rows/${row - 1}`)), JSON.stringify(read.problems));
    const result = check(itemInput(s, block, compactModel(s.model)));
    assert.ok(result.length > 0 && result.every((outcome) => outcome.verdict === 'refute'), JSON.stringify(result));
  });
}

test('registers stay inside their case across a flat case between two block cases', () => {
  const s = scenario(['block', 'flat', 'block']), rows = layout(s.inputs);
  put(s.model, rows[2][0], 'H', '');
  const read = readWorkbook(s.model, s.inputs);
  assert.equal(read.ok, false);
  if (read.ok) return;
  const registers = read.problems.filter((problem) => problem.rule === 'register');
  assert.ok(registers.length > 0, JSON.stringify(read.problems));
  assert.ok(registers.every((problem) => rows[2].some((row) => problem.pointer === `/sheets/0/rows/${row - 1}`)), JSON.stringify(registers));
});
