import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDefaultRegistry, recognize, parserKey } from '../../../../hub/refs/api.ts';
import { unzipSync } from 'fflate';
import { generateWorkbook, GenerationError, GENERATOR } from './generate.ts';
import { crc32 } from './zip-store.ts';
import { generationFixture } from '../testing/workbook.ts';
import { readWorkbookModel } from './xlsx-model.ts';
import FORMAT from '../tables/workbook-format.json' with { type: 'json' };
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
test('same recipe gives identical XLSX bytes; a slot change changes the artifact digest', () => {
  const recipe = generationFixture(); const first = generateWorkbook(recipe); assert.deepEqual(first, generateWorkbook(recipe));
  const next = generationFixture(); next.slots.steps[0].args[0] = 'widget health interval 61'; assert.notEqual(hash(first), hash(generateWorkbook(next)));
});
test('STORE ZIP headers, CRC, offsets, timestamps, members and central directory are exact', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const b = Buffer.from(generateWorkbook(generationFixture())); const entries = unzipSync(b); assert.deepEqual(Object.keys(entries), FORMAT.members);
  const end = b.length - 22; const directory = b.readUInt32LE(end + 16); let local = 0; let central = directory;
  for (const name of FORMAT.members) {
    assert.equal(b.readUInt32LE(local), 0x04034b50); assert.equal(b.readUInt16LE(local + 8), 0); assert.equal(b.readUInt16LE(local + 10), 0); assert.equal(b.readUInt16LE(local + 12), 33);
    const length = b.readUInt16LE(local + 26); const size = b.readUInt32LE(local + 18); assert.equal(b.subarray(local + 30, local + 30 + length).toString(), name); assert.equal(b.readUInt32LE(local + 14), crc32(entries[name]));
    assert.equal(b.readUInt32LE(central), 0x02014b50); assert.equal(b.readUInt32LE(central + 42), local);
    local += 30 + length + size; central += 46 + length;
  }
  assert.equal(local, directory); assert.equal(central, end);
});
test('core xlsx@1 parses generator output; rows use textual autoid, numeric C and immediate assertions', () => {
  const parsed = recognize(createDefaultRegistry(), generateWorkbook(generationFixture()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(parsed && parserKey(parsed.parser) === 'xlsx@1'); const model = readWorkbookModel(parsed.document.model)!; assert.ok(model);
  assert.equal(model.sheets.length, 1); assert.equal(model.sheets[0].lastRow, 9);
  const rows = model.sheets[0].rows; assert.equal(rows[3].cells.find((c) => c.reference === 'A4')?.type, 'inlineStr'); assert.equal(rows[3].cells.find((c) => c.reference === 'C4')?.type, 'n');
  assert.equal(rows[4].cells.find((c) => c.reference === 'F5')?.text, 'literal'); assert.ok(rows.every((r) => !r.hidden));
  assert.equal(model.definedNames[0].reference, "'FixtureSheet'!$A$2:$I$2"); assert.ok(rows[0].cells.some((c) => c.text === GENERATOR));
});
test('multiple expectations follow the same command before the next step', () => {
  const input = generationFixture(); input.slots.expects.push({ ...input.slots.expects[0], text: '设置成功' });
  const parsed = recognize(createDefaultRegistry(), generateWorkbook(input), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')!;
  const rows = readWorkbookModel(parsed.document.model)!.sheets[0].rows;
  assert.equal(rows[4].cells.find((c) => c.reference === 'G5')?.text, input.slots.expects[0].text);
  assert.equal(rows[5].cells.find((c) => c.reference === 'G6')?.text, '设置成功');
});
test('XML and SpreadsheetML text are preserved without dropping invalid characters silently', () => {
  const input = generationFixture(); input.fields.title = '原文 _x000D_ & < >'; input.fields.steps = []; input.slots.expects[0].text = '原文 _x0041_\n值\r尾';
  const parsed = recognize(createDefaultRegistry(), generateWorkbook(input), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')!;
  const row = readWorkbookModel(parsed.document.model)!.sheets[0].rows[4]; assert.equal(row.cells.find((c) => c.reference === 'G5')?.text, input.slots.expects[0].text);
});
for (const [name, change] of Object.entries({
  autoid: (v: any) => { v.fields.autoid = Number(v.fields.autoid); }, codec: (v: any) => { v.slots.steps[0].args = ['k=value']; }, seat: (v: any) => { v.profile.device_count = 0; }, after: (v: any) => { v.slots.expects[0].after = 3; }, formula: (v: any) => { v.fields.title = '=unsafe'; v.fields.steps = []; }, control: (v: any) => { v.fields.title = 'a\u0001b'; v.fields.steps = []; }, version: (v: any) => { v.generator = 'fixture-old'; },
})) test(`generation refuses with a location: ${name}`, () => { const input = generationFixture(); change(input); assert.throws(() => generateWorkbook(input), (e: unknown) => e instanceof GenerationError && e.pointer.startsWith('/')); });
test('changing a quote or replacement changes bytes even when execution text stays the same', () => {
  const first = generationFixture(); const digest = hash(generateWorkbook(first));
  const quote = generationFixture(); quote.slots.expects[0].quote.reference += '/fixture'; assert.notEqual(hash(generateWorkbook(quote)), digest);
  const replaced = generationFixture(); replaced.slots.replacements.push({ case: '192.0.2.200', bed: '192.0.2.90' }); assert.notEqual(hash(generateWorkbook(replaced)), digest);
});
