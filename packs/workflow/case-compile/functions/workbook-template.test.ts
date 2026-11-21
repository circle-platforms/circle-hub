import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { generateWorkbook, generateWorkbookSet, GenerationError, GENERATOR } from './generate.ts';
import { readWorkbook } from './workbook.ts';
import { fillTemplate, readTemplate, TemplateError } from './generated/skills/runner-workbook/workbook-writer/workbook-template.ts';
import { compactModel } from './generated/skills/runner-workbook/workbook-writer/xlsx-model.ts';
import { zipStore } from './generated/skills/runner-workbook/workbook-writer/zip-store.ts';
import { coreModel } from '../testing/workbook-model.ts';
import { generationFixture } from '../testing/workbook.ts';
import { TEMPLATE_HEADER_ROW, TEMPLATE_LAST_ROW, templateDocument } from '../testing/template.ts';

const book = () => generationFixture().profile.workbook;
const members = (bytes: Uint8Array) => unzipSync(bytes);
const original = () => unzipSync(Buffer.from(book().template!.xlsx_base64, 'base64'));
const SHEET = 'xl/worksheets/sheet1.xml';
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

test('every member but the worksheet keeps the template bytes, in the template order', () => {
  const made = members(generateWorkbook(generationFixture())); const template = original();
  assert.deepEqual(Object.keys(made).sort(), Object.keys(template).sort());
  for (const name of Object.keys(template)) if (name !== SHEET) assert.deepEqual(made[name], template[name], name);
});

test('the notes, lists, drop-downs and column widths above and around the rows stay as the template has them', () => {
  const made = text(members(generateWorkbook(generationFixture()))[SHEET]); const template = text(original()[SHEET]);
  const rowsOfTemplate = template.slice(template.indexOf('<row r="2"'), template.indexOf(`<row r="${TEMPLATE_HEADER_ROW + 1}"`));
  assert.ok(made.includes(rowsOfTemplate), 'rows 2 to the header are the template\'s');
  assert.equal(made.slice(0, made.indexOf('<sheetData>')), template.slice(0, template.indexOf('<sheetData>')));
  assert.equal(made.slice(made.indexOf('</sheetData>')), template.slice(template.indexOf('</sheetData>')));
  assert.ok(made.includes(`<row r="${TEMPLATE_LAST_ROW}">`), 'the formatted empty rows stay');
});

test('rows read like the reference: statement types count up, id and priority only on the first row, a blank row, the closing case', () => {
  const input = generationFixture(); const rows = coreModel(generateWorkbook(input)).sheets[0].rows;
  const value = (number: number, column: string) => rows.find((row) => row.number === number)?.cells.find((cell) => cell.reference === `${column}${number}`)?.text ?? '';
  const first = TEMPLATE_HEADER_ROW + 2;
  assert.equal(value(TEMPLATE_HEADER_ROW + 1, 'C'), '0');
  assert.match(value(TEMPLATE_HEADER_ROW + 1, 'D'), new RegExp(`^Author {9}: ${GENERATOR}\\n计划运行 `));
  assert.deepEqual([0, 1, 2, 3].map((k) => value(first + k, 'C')), ['2', '3', '4', '5']);
  assert.deepEqual([0, 1, 2, 3].map((k) => value(first + k, 'A')), [input.fields.autoid, '', '', '']);
  assert.deepEqual([0, 1, 2, 3].map((k) => value(first + k, 'B')), ['P1', '', '', '']);
  assert.deepEqual(['A', 'C', 'E'].map((column) => value(first + 4, column)), ['', '', '']);
  assert.equal(value(first + 5, 'A'), input.profile.workbook.closing_row[0]);
});

test('each case of a set counts its statements from the start again', () => {
  const one = generationFixture(); const two = generationFixture(); two.fields = { ...two.fields, autoid: '990000000000000032' };
  const rows = coreModel(generateWorkbookSet([one, two])).sheets[0].rows;
  const value = (number: number) => rows.find((row) => row.number === number)?.cells.find((cell) => cell.reference === `C${number}`)?.text ?? '';
  assert.equal(value(TEMPLATE_HEADER_ROW + 2), '2'); assert.equal(value(TEMPLATE_HEADER_ROW + 7), '2');
});

test('a closing case that calls something, as the reference writes it, is read as the closing case and no execution', () => {
  const input = generationFixture(); input.profile = structuredClone(input.profile); input.profile.workbook.closing_row = ['999999999999999', 'P9', '2', 'sentinel', 'widget-clock', 'pause', '1', '', ''];
  const read = readWorkbook(coreModel(generateWorkbook(input)), input); assert.ok(read.ok, JSON.stringify(read)); if (!read.ok) return;
  assert.equal(read.executions.length, 4);
});

test('a step description reads back; a changed one no longer matches the plan', () => {
  const input = generationFixture(); input.slots.steps[1].description = '第二步描述';
  const bytes = generateWorkbook(input); assert.ok(readWorkbook(coreModel(bytes), input).ok);
  const other = structuredClone(input); other.slots.steps[1].description = '另一句';
  const read = readWorkbook(coreModel(bytes), other); assert.equal(read.ok, false); if (!read.ok) assert.ok(read.problems.some((row) => row.rule === 'step'), JSON.stringify(read.problems));
});

test('a stored template works as well as a deflated one', () => {
  const input = generationFixture(); const files = original();
  const stored = zipStore(Object.entries(files).map(([name, bytes]) => ({ name, bytes })));
  input.profile = structuredClone(input.profile);
  input.profile.workbook.template = { sha256: createHash('sha256').update(stored).digest('hex'), xlsx_base64: Buffer.from(stored).toString('base64') };
  assert.ok(readWorkbook(coreModel(generateWorkbook(input)), input).ok);
});

test('no template, a wrong digest and too many rows are refused with the next step; a template saved for another contract is filled like any other', () => {
  const refused = (change: (input: ReturnType<typeof generationFixture>) => void, message: RegExp) => {
    const input = generationFixture(); input.profile = structuredClone(input.profile); change(input);
    assert.throws(() => generateWorkbook(input), (error: unknown) => error instanceof GenerationError && error.pointer === '/profile/workbook/template' && message.test(error.message));
  };
  refused((input) => { delete input.profile.workbook.template; }, /没有运行器模板/);
  refused((input) => { input.profile.workbook.template!.sha256 = 'f'.repeat(64); }, /摘要不符/);
  assert.throws(() => fillTemplate(readTemplate(book()), {}, Array.from({ length: TEMPLATE_LAST_ROW }, () => []), (value) => value), TemplateError);
  const input = generationFixture(); const other = generationFixture(); other.profile = structuredClone(other.profile);
  other.profile.workbook.template = templateDocument(other.profile.workbook, 'another-runtime', 'e'.repeat(64));
  const firstRow = (bytes: Uint8Array) => { const sheet = text(members(bytes)[SHEET]); return ['A', 'B', 'C'].map((column) => new RegExp(`<c r="${column}1"[^>]*><is><t[^>]*>([^<]*)</t>`).exec(sheet)?.[1]); };
  assert.deepEqual(firstRow(generateWorkbook(other)), firstRow(generateWorkbook(input)));
  assert.deepEqual(firstRow(generateWorkbook(other)).slice(1), [input.contract.runtimeVersion, input.contract.pinned.identity]);
  assert.ok(readWorkbook(coreModel(generateWorkbook(other)), other).ok);
});

test('the first row\'s cells are set where they stand: text replaced, style kept, a missing cell added in column order', () => {
  const template = readTemplate(book());
  const start = template.sheet.indexOf('<row r="1"'), end = template.sheet.indexOf('</row>', start) + '</row>'.length;
  const rowOf = (sheet: string) => sheet.slice(sheet.indexOf('<row r="1"'), sheet.indexOf('</row>', sheet.indexOf('<row r="1"')) + '</row>'.length);
  const filled = (row: string, cells: Record<string, string>) => {
    const made = fillTemplate({ ...template, sheet: template.sheet.slice(0, start) + row + template.sheet.slice(end) }, cells, [], (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;'));
    return rowOf(text(unzipSync(made)[SHEET]));
  };
  const cell = (reference: string, value: string, attributes = '') => `<c r="${reference}"${attributes} t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`;
  assert.equal(filled('<row r="1" hidden="1"><c r="A1" t="inlineStr"><is><t>M</t></is></c><c r="B1" s="7" t="inlineStr"><is><t>old</t></is><extLst><ext uri="x"/></extLst></c></row>', { B: 'new & <b>' }),
    '<row r="1" hidden="1"><c r="A1" t="inlineStr"><is><t>M</t></is></c><c r="B1" s="7" t="inlineStr"><is><t xml:space="preserve">new &amp; &lt;b></t></is><extLst><ext uri="x"/></extLst></c></row>');
  assert.equal(filled('<row r="1"><c r="A1" t="inlineStr"><is><t>M</t></is></c><c r="B1" s="3"/><c r="C1" t="s" s="4"><v>9</v></c></row>', { B: 'b', C: 'c' }),
    `<row r="1"><c r="A1" t="inlineStr"><is><t>M</t></is></c>${cell('B1', 'b', ' s="3"')}${cell('C1', 'c', ' s="4"')}</row>`);
  assert.equal(filled('<row r="1"><c r="A1" t="inlineStr"><is><t>M</t></is></c><c r="K1" t="inlineStr"><is><t>k</t></is></c><c r="AB1" t="inlineStr"><is><t>ab</t></is></c></row>', { C: 'c', B: 'b', Z: 'z', AA: 'aa', AC: 'ac' }),
    `<row r="1"><c r="A1" t="inlineStr"><is><t>M</t></is></c>${cell('B1', 'b')}${cell('C1', 'c')}<c r="K1" t="inlineStr"><is><t>k</t></is></c>${cell('Z1', 'z')}${cell('AA1', 'aa')}<c r="AB1" t="inlineStr"><is><t>ab</t></is></c>${cell('AC1', 'ac')}</row>`);
  const whole = text(unzipSync(fillTemplate(template, { B: 'only-first-row' }, [], (value) => value))[SHEET]);
  assert.equal(whole.split('only-first-row').length - 1, 1);
  assert.equal(whole.slice(whole.indexOf('<row r="2"')), template.sheet.slice(template.sheet.indexOf('<row r="2"')));
});

test('a template without the defined name or with another header is no template for this profile', () => {
  const other = structuredClone(book());
  assert.throws(() => readTemplate({ ...other, range_name: 'FixtureMissing' }), /没有定义名/);
  const header = [...other.header]; header[3] = 'FixtureOther';
  assert.throws(() => readTemplate({ ...other, header }), /表头和配置不一致/);
  assert.throws(() => readTemplate({ ...other, identity_marker: 'FixtureOther' }), /身份标记/);
});

test('the frozen model drops the empty cells and reads the same; a hidden row and the last row survive', () => {
  const input = generationFixture(); const model = coreModel(generateWorkbook(input)); const compact = compactModel(model);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(model).length / 2);
  assert.equal(compact.sheets[0].lastRow, TEMPLATE_LAST_ROW);
  assert.deepEqual(readWorkbook(compact, input), readWorkbook(model, input));
  const hidden = structuredClone(model); const row = hidden.sheets[0].rows.find((value) => value.number === TEMPLATE_HEADER_ROW + 40)!; row.hidden = true;
  const read = readWorkbook(compactModel(hidden), input); assert.equal(read.ok, false); if (!read.ok) assert.ok(read.problems.some((value) => value.rule === 'subset'), JSON.stringify(read.problems));
});
