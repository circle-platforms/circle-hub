import {createTestParserRegistry as createDefaultRegistry} from '../../../../hub/testing/parsers.ts';
import {planCommands} from './plan-commands.ts';
import {COMMAND_CATALOG} from './test-support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { recognize, parserKey } from '../../../../hub/refs/api.ts';
import { unzipSync } from 'fflate';
import { generateWorkbook, GenerationError, GENERATOR } from './generate.ts';
import { crc32 } from './generated/skills/runner-workbook/workbook-writer/zip-store.ts';
import { generationFixture } from '../testing/workbook.ts';
import { runtimeDocument } from '../testing/runtime.ts';
import { parseRuntimeContract } from './runtime-contract.ts';
import { parseProfile } from './profile.ts';
import { bedsOf } from './test-support.ts';
import { interfaceDigest, runtimeDigest, stripAdditions, contractCanonical } from './runtime-contract.ts';
import { readFileSync } from 'node:fs';
/** The shipped runtime-contract@2 example, with the pause method gaining a required `result` the executor provides. */
function withTemplate(doc: unknown, contract: { runtimeVersion: string; pinned: { identity: string } }) {
  const profile = doc as { workbook: Parameters<typeof templateDocument>[0] & { template?: unknown } };
  return { ...profile, workbook: { ...profile.workbook, template: templateDocument(profile.workbook, contract.runtimeVersion, contract.pinned.identity) } };
}
function executorDocuments() {
  const contractDoc: Record<string, unknown> = JSON.parse(readFileSync(new URL('../examples/runtime-contract-v2.json', import.meta.url), 'utf8'));
  const entries = contractDoc.entries as Array<Record<string, unknown>>;
  const pause = entries.find((e) => e.f === 'pause')!;
  const signature = pause.signature as Record<string, unknown>;
  (signature.parameters as unknown[]).push({ name: 'result', kind: 'positional_or_keyword', required: true, default: null });
  signature.required = [...(signature.required as string[]), 'result'];
  const authority = pause.typed_authority as Record<string, unknown>;
  (authority.parameters as Record<string, unknown>).result = { type: 'text', role: 'executor_return' };
  (contractDoc.roles as Record<string, unknown>).executor_return = { source: 'src:786752a4d8c54da85c42174fcb37c8299a13989ae7fa0dee98e9a6eedd29a03c/json@1/p/roles/executor_return' };
  const effect = (contractDoc.effects as Record<string, { roles: string[] }>).effect_3;
  effect.roles = [...effect.roles, 'executor_return'];
  // the mutation changes the original too: rebuild the original declaration from the mutated document
  const recovered = stripAdditions(contractDoc)!;
  const recoveredDigest = runtimeDigest(recovered);
  contractDoc.original = { contract_sha256: recoveredDigest, sha256: createHash('sha256').update(Buffer.from(contractCanonical(recovered), 'utf8')).digest('hex') };
  delete contractDoc.contract_sha256;
  contractDoc.contract_sha256 = runtimeDigest(contractDoc);
  const profileDoc: Record<string, unknown> = JSON.parse(readFileSync(new URL('../examples/runtime-profile-v2.json', import.meta.url), 'utf8'));
  const allowedPause = (profileDoc.allowed as Array<Record<string, unknown>>).find((a) => a.method === 'pause')!;
  allowedPause.parameters = { seconds: 'wait', result: 'executor_return' };
  return { contractDoc, profileDoc };
}
import { readWorkbookModel } from './generated/skills/runner-workbook/workbook-writer/xlsx-model.ts';
import { TEMPLATE_LAST_ROW, templateDocument } from '../testing/template.ts';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
test('same recipe gives identical XLSX bytes; a slot change changes the artifact digest', () => {
  const recipe = generationFixture(); const first = generateWorkbook(recipe); assert.deepEqual(first, generateWorkbook(recipe));
  const next = generationFixture(); next.slots.steps[0].args[0] = 'widget health interval 61';next.fields.command_catalog=planCommands(next.contract,next.profile,next.slots,COMMAND_CATALOG).catalog; assert.notEqual(hash(first), hash(generateWorkbook(next)));
});
test('STORE ZIP headers, CRC, offsets, timestamps, members and central directory are exact', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const b = Buffer.from(generateWorkbook(generationFixture())); const entries = unzipSync(b); const members = Object.keys(entries); assert.deepEqual(members, ['[Content_Types].xml', '_rels/.rels', 'docProps/app.xml', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/theme/theme1.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort());
  const end = b.length - 22; const directory = b.readUInt32LE(end + 16); let local = 0; let central = directory;
  for (const name of members) {
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
  assert.equal(model.sheets.length, 1); assert.equal(model.sheets[0].lastRow, TEMPLATE_LAST_ROW);
  const rows = model.sheets[0].rows; assert.equal(rows[7].cells.find((c) => c.reference === 'A8')?.type, 'inlineStr'); assert.equal(rows[7].cells.find((c) => c.reference === 'C8')?.type, 'n');
  assert.equal(rows[8].cells.find((c) => c.reference === 'F9')?.text, 'literal'); assert.ok(rows.slice(1).every((r) => !r.hidden));
  assert.equal(model.definedNames.find((v) => v.name === 'FixtureRange')?.reference, "'FixtureSheet'!$A$6:$I$6"); assert.ok(rows[0].cells.some((c) => c.text === GENERATOR));
});
test('multiple expectations follow the same command before the next step', () => {
  const input = generationFixture(); input.slots.expects.push({ ...input.slots.expects[0], text: '设置成功' });
  const parsed = recognize(createDefaultRegistry(), generateWorkbook(input), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')!;
  const rows = readWorkbookModel(parsed.document.model)!.sheets[0].rows;
  assert.equal(rows[8].cells.find((c) => c.reference === 'G9')?.text, input.slots.expects[0].text);
  assert.equal(rows[9].cells.find((c) => c.reference === 'G10')?.text, '设置成功');
});
test('SpreadsheetML escape-looking text is refused with a fixed reason', () => { const input=generationFixture(); input.fields.title='_x0041_'; input.fields.path=['合成文档','_x0041_']; assert.throws(()=>generateWorkbook(input),(e:unknown)=>e instanceof GenerationError&&e.rule==='xstring_escape'); });
for (const [name, change] of Object.entries({
  autoid: (v: any) => { v.fields.autoid = Number(v.fields.autoid); }, codec: (v: any) => { v.slots.steps[0].args = ['k=value']; }, seat: (v: any) => { v.profile.device_count = 0; }, after: (v: any) => { v.slots.expects[0].after = 3; }, formula: (v: any) => { v.fields.title = '=unsafe'; v.fields.path = ['=unsafe']; v.fields.steps = []; }, control: (v: any) => { v.fields.title = 'a\u0001b'; v.fields.path = ['合成文档', 'a\u0001b']; v.fields.steps = []; }, path: (v: any) => { delete v.fields.path; }, path_end: (v: any) => { v.fields.path = ['合成文档', '别的用例']; }, version: (v: any) => { v.generator = 'fixture-old'; },
})) test(`generation refuses with a location: ${name}`, () => { const input = generationFixture(); change(input); assert.throws(() => generateWorkbook(input), (e: unknown) => e instanceof GenerationError && e.pointer.startsWith('/')); });
test('changing a quote or replacement changes bytes even when execution text stays the same', () => {
  const first = generationFixture(); const digest = hash(generateWorkbook(first));
  const quote = generationFixture(); quote.slots.expects[0].quote.reference += '/fixture'; assert.notEqual(hash(generateWorkbook(quote)), digest);
  const replaced = generationFixture(); replaced.slots.replacements.push({ case: '192.0.2.200', bed: '192.0.2.90' }); assert.notEqual(hash(generateWorkbook(replaced)), digest);
});


// ---- the executor-provided parameter and the pinned original identity (the case-compile-real-contract task) ----
test('a required executor_return parameter is omitted by the plan and the model cannot write it', () => {
  const { contractDoc, profileDoc } = executorDocuments();
  const parsed = parseRuntimeContract(contractDoc); assert.ok(parsed.ok, JSON.stringify(parsed)); if (!parsed.ok) return;
  const profile = parseProfile(withTemplate(profileDoc, parsed.contract), parsed.contract, bedsOf()); assert.ok(profile.ok, JSON.stringify(profile)); if (!profile.ok) return;
  const fixture = generationFixture();
  fixture.slots.steps = [fixture.slots.steps[1], { object: 'widget-clock', method: 'pause', args: ['1'], keywords: {} }];
  const base = { ...fixture, contract: parsed.contract, profile: profile.profile };
  const without = generateWorkbook(base); assert.ok(without.length > 0, '缺的 result 由执行器提供上一步返回，计划不写也能生成');
  const model = structuredClone(base); model.slots.steps[1].keywords = { result: '上一步返回' };
  assert.throws(() => generateWorkbook(model), (e: unknown) => e instanceof GenerationError && e.message.includes('模型不能填写'));
});
test('the identity row carries the pinned original identity of a runtime-contract@2 contract', () => {
  const contractDoc: unknown = JSON.parse(readFileSync(new URL('../examples/runtime-contract-v2.json', import.meta.url), 'utf8'));
  const profileDoc: unknown = JSON.parse(readFileSync(new URL('../examples/runtime-profile-v2.json', import.meta.url), 'utf8'));
  const parsed = parseRuntimeContract(contractDoc); assert.ok(parsed.ok, JSON.stringify(parsed)); if (!parsed.ok) return;
  const profile = parseProfile(withTemplate(profileDoc, parsed.contract), parsed.contract, bedsOf()); assert.ok(profile.ok, JSON.stringify(profile)); if (!profile.ok) return;
  const fixture = generationFixture();
  fixture.slots.steps = [fixture.slots.steps[1]];
  const input = { ...fixture, contract: parsed.contract, profile: profile.profile };
  const model = readWorkbookModel(recognize(createDefaultRegistry(), generateWorkbook(input), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')!.document.model)!;
  assert.equal(model.sheets[0].rows[0].cells.find((c) => c.reference === 'C1')?.text, parsed.contract.pinned.identity);
});
test('the identity row is written from the locked contract: the declared interface identity and the runtime, whatever the template was saved with', () => {
  const contractDoc = JSON.parse(readFileSync(new URL('../examples/runtime-contract-v2.json', import.meta.url), 'utf8')) as Record<string, unknown> & { original: Record<string, unknown> };
  const declared = interfaceDigest(stripAdditions(contractDoc)!);
  contractDoc.original = { ...contractDoc.original, interface_sha256: declared };
  delete contractDoc.contract_sha256; contractDoc.contract_sha256 = runtimeDigest(contractDoc);
  const profileDoc: unknown = JSON.parse(readFileSync(new URL('../examples/runtime-profile-v2.json', import.meta.url), 'utf8'));
  const parsed = parseRuntimeContract(contractDoc); assert.ok(parsed.ok, JSON.stringify(parsed)); if (!parsed.ok) return;
  assert.deepEqual(parsed.contract.pinned, { identity: declared, build: contractDoc.original.contract_sha256, bytes: contractDoc.original.sha256 });
  assert.notEqual(declared, contractDoc.original.contract_sha256);
  const stale = withTemplate(profileDoc, { runtimeVersion: 'another-runtime', pinned: { identity: 'e'.repeat(64) } });
  const profile = parseProfile(stale, parsed.contract, bedsOf()); assert.ok(profile.ok, JSON.stringify(profile)); if (!profile.ok) return;
  const fixture = generationFixture();
  fixture.slots.steps = [fixture.slots.steps[1]];
  const input = { ...fixture, contract: parsed.contract, profile: profile.profile };
  const bytes = generateWorkbook(input);
  const model = readWorkbookModel(recognize(createDefaultRegistry(), bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')!.document.model)!;
  const first = (column: string) => model.sheets[0].rows[0].cells.find((c) => c.reference === column + '1')?.text;
  assert.deepEqual([first('B'), first('C')], [parsed.contract.runtimeVersion, declared]);
  const sheet = Buffer.from(unzipSync(bytes)['xl/worksheets/sheet1.xml']).toString('utf8');
  assert.deepEqual([sheet.split('<c r="B1"').length - 1, sheet.split('<c r="C1"').length - 1, sheet.includes('e'.repeat(64)), sheet.includes('another-runtime')], [1, 1, false, false]);
  const fresh = parseProfile(withTemplate(profileDoc, parsed.contract), parsed.contract, bedsOf()); assert.ok(fresh.ok); if (!fresh.ok) return;
  const again = readWorkbookModel(recognize(createDefaultRegistry(), generateWorkbook({ ...input, profile: fresh.profile }), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')!.document.model)!;
  assert.deepEqual(['A', 'B', 'C'].map((column) => again.sheets[0].rows[0].cells.find((c) => c.reference === column + '1')?.text), ['A', 'B', 'C'].map(first));
});
