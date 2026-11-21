import { test } from 'node:test';
import assert from 'node:assert/strict';
import check, { readWorkbook } from './workbook.ts';
import { generateWorkbook, generateWorkbookSet, GENERATOR, type GenerationInput } from './generate.ts';
import { generationFixture } from '../testing/workbook.ts';
import { coreModel, changedWorkbook, workbookCheckInput, digest } from '../testing/workbook-model.ts';
import { AUTOID } from './test-support.ts';
import { fixture as assertionFixture, call, EXPECTED_REF } from '../testing/blocks.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { parseRuntimeContract } from './runtime-contract.ts';
import { parseProfile } from './profile.ts';
import { parseManifest } from './manifest.ts';
import { templateDocument } from '../testing/template.ts';
import { checkExpectedSources, checkContractShape } from './checks.ts';
const SHEET = 'xl/worksheets/sheet1.xml';
function sheetChange(parts: Map<string, string>, change: (text: string) => string) { parts.set(SHEET, change(parts.get(SHEET)!)); }
function cell(reference: string, text: string) { return `<c r="${reference}" t="inlineStr"${reference.startsWith('A') ? ' s="1"' : ''}><is><t xml:space="preserve">${text}</t></is></c>`; }
function replaceCell(xml: string, reference: string, replacement: string) { return xml.replace(new RegExp(`<c r="${reference}"[^>]*>[\\s\\S]*?</c>`), replacement); }
test('core parser model independently reads every generated execution and supports only compact dispatch metadata', () => {
  const input = generationFixture(); const bytes = generateWorkbook(input); const read = readWorkbook(coreModel(bytes), input); assert.ok(read.ok, JSON.stringify(read)); if (!read.ok) return;
  assert.deepEqual(read.executions.map((v) => [v.method, v.row]), [['configure', 8], ['literal', 9], ['shell', 10], ['pause', 11]]);
  const result = check(workbookCheckInput(bytes)); assert.equal(result.length, 1); assert.equal(result[0].verdict, 'support', JSON.stringify(result));
  const data = result[0].data!; assert.deepEqual(Object.keys(data).sort(), ['sha256', 'autoids', 'bed', 'build', 'generator', 'plan_run'].sort()); assert.equal(data.sha256, digest(bytes)); assert.equal(data.generator, GENERATOR); assert.deepEqual(data.bed, { id: input.profile.bed, manifest_sha256: workbookCheckInput(bytes).subject.manifest_sha256 }); assert.ok(!JSON.stringify(result).includes('<worksheet'));
});
const mutations: Record<string, { rule: string; edit: (parts: Map<string, string>) => void }> = {
  'extra member': { rule: 'members', edit: (p) => p.set('fixture/extra.xml', '<fixture/>') },
  'two sheets': { rule: 'sheets', edit: (p) => { p.set('xl/workbook.xml', p.get('xl/workbook.xml')!.replace('</sheets>', '<sheet name="FixtureOther" sheetId="2" r:id="rId9"/></sheets>')); p.set('xl/_rels/workbook.xml.rels', p.get('xl/_rels/workbook.xml.rels')!.replace('</Relationships>', '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')); p.set('xl/worksheets/sheet2.xml', p.get(SHEET)!); } },
  'hidden sheet': { rule: 'sheets', edit: (p) => p.set('xl/workbook.xml', p.get('xl/workbook.xml')!.replace('state="visible"', 'state="hidden"')) },
  'shared strings': { rule: 'subset', edit: (p) => { sheetChange(p, (s) => replaceCell(s, 'A8', '<c r="A8" t="s" s="3"><v>0</v></c>')); p.set('xl/sharedStrings.xml', `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>${AUTOID}</t></si></sst>`); p.set('xl/_rels/workbook.xml.rels', p.get('xl/_rels/workbook.xml.rels')!.replace('</Relationships>', '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')); } },
  'missing identity': { rule: 'identity', edit: (p) => sheetChange(p, (s) => s.replace(/<row r="1"[^>]*>[\s\S]*?<\/row>/, '<row r="1"/>')) },
  'wrong contract digest': { rule: 'identity', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'C1', cell('C1', 'f'.repeat(64)))) },
  'wrong generator': { rule: 'generator', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'F1', cell('F1', 'fixture-old@0'))) },
  'duplicate header': { rule: 'header', edit: (p) => sheetChange(p, (s) => { const header = /<row r="6"[^>]*>[\s\S]*?<\/row>/.exec(s)![0].replace(/r="([A-I]?)6"/g, (_, column) => `r="${column}10"`); return s.replace(/<row r="10">[\s\S]*?<\/row>/, header); }) },
  'sheet scoped range': { rule: 'range', edit: (p) => p.set('xl/workbook.xml', p.get('xl/workbook.xml')!.replace('<definedName name="FixtureRange"', '<definedName localSheetId="0" name="FixtureRange"')) },
  'wrong range row': { rule: 'range', edit: (p) => p.set('xl/workbook.xml', p.get('xl/workbook.xml')!.replaceAll('$A$6:$I$6', '$A$7:$I$7')) },
  'description executes': { rule: 'description', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'E7', cell('E7', 'widget-seat'))) },
  'style-only row after closing': { rule: 'closing', edit: (p) => sheetChange(p, (s) => s.replace('</sheetData>', '<row r="81"><c r="A81" s="3"/></row></sheetData>')) },
  'autoid E empty': { rule: 'autoid', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'E8', '')) },
  'wrong autoid length': { rule: 'autoid', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'A8', cell('A8', AUTOID.slice(1)))) },
  'assertion follows waiting': { rule: 'assertion', edit: (p) => sheetChange(p, (s) => { const assertion = /<row r="9">[\s\S]*?<\/row>/.exec(s)![0].replace(/r="([A-I]?)9"/g, (_, column) => `r="${column}12"`); return s.replace(/<row r="9">[\s\S]*?<\/row>/, '<row r="9"/>').replace(/<row r="12">[\s\S]*?<\/row>/, assertion); }) },
  'formula cell': { rule: 'formula', edit: (p) => sheetChange(p, (s) => s.replace('<c r="G8" s="5" t="inlineStr">', '<c r="G8" s="5" t="inlineStr"><f>1+1</f>')) },
  'formula prefix': { rule: 'formula', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'G8', cell('G8', '=1'))) },
  'hidden row': { rule: 'subset', edit: (p) => sheetChange(p, (s) => s.replace('<row r="8">', '<row r="8" hidden="1">')) },
  'certification request': { rule: 'identity', edit: (p) => sheetChange(p, (s) => s.replace(/(<row r="1"[^>]*>[\s\S]*?)(<\/row>)/, '$1' + cell('D1', 'fixture-request') + '$2')) },
  'two cases': { rule: 'autoid', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'A10', cell('A10', '990000000000000032'))) },
  'output register': { rule: 'execution', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'H8', cell('H8', 'fixture-register'))) },
  'unknown keyword': { rule: 'signature', edit: (p) => sheetChange(p, (s) => replaceCell(s, 'G8', cell('G8', 'unknown=value'))) },
};
for (const [name, mutation] of Object.entries(mutations)) test(`independent reader rejects ${name}`, () => {
  const bytes = changedWorkbook(mutation.edit); const model = coreModel(bytes); const result = readWorkbook(model, generationFixture()); assert.equal(result.ok, false); if (!result.ok) assert.ok(result.problems.some((v) => v.rule === mutation.rule), JSON.stringify(result.problems));
  assert.ok(check(workbookCheckInput(bytes)).some((v) => v.verdict === 'refute'));
});
test('one changed original byte is refused even when the generic parsed model is unchanged', () => {
  const bytes = Buffer.from(generateWorkbook(generationFixture())); bytes[10] ^= 1;
  assert.equal(readWorkbook(coreModel(bytes), generationFixture()).ok, true);
  const result = check(workbookCheckInput(bytes)); assert.equal(result[0].verdict, 'refute'); assert.match(result[0].statement, /自动化用例 Excel 与重新生成的文件不一致，请重新生成并上传后继续脚本合并/);
});
test('verification does not turn a bad plan or invented expectation into a support receipt', () => {
  const input = workbookCheckInput(); input.subject.data = { ...generationFixture().slots, expects: [] };
  assert.ok(check(input).every((v) => v.verdict !== 'support'));
});

const absenceLiteral='record+a.[x](value)$\\tail';
type SequentialRecipe=GenerationInput&{frozen:ReturnType<ReturnType<typeof assertionFixture>['subject']>};
function sequentialAbsence(change?: (document: ReturnType<typeof assertionFixture>['contractDoc']) => void, methods=['literal','not_found']): SequentialRecipe {
  const fixture=assertionFixture(),document=structuredClone(fixture.contractDoc);
  change?.(document);
  const contractDocument=signTypedRuntime(document),contract=parseRuntimeContract(contractDocument),beds=parseManifest(fixture.inventory);
  assert.ok(contract.ok);assert.ok(beds.ok);
  const profileDocument=structuredClone(fixture.profileDoc);
  profileDocument.block_model=false;
  profileDocument.allowed=profileDocument.allowed.filter((entry: {method: string;parameters: Record<string,string>})=>!Object.values(entry.parameters).includes('literal_assertion')||methods.includes(entry.method));
  profileDocument.workbook.template=templateDocument(profileDocument.workbook,contract.contract.runtimeVersion,contract.contract.pinned.identity);
  const profile=parseProfile(profileDocument,contract.contract,beds.beds);
  assert.ok(profile.ok,JSON.stringify(profile));
  const original={reference:EXPECTED_REF,text:`合成记录 ${absenceLiteral} 不存在`};
  const slots:GenerationInput['slots']={bucket:'bed-a',blocks:[],steps:[call()],expects:[{op:'not_found',text:absenceLiteral,quote:{...original},after:1}],replacements:[]};
  const fields={...fixture.fields,expected_nodes:[{...original}]};
  const frozen=fixture.subject(slots,{contract:contractDocument,profile:profileDocument,expected_nodes:fields.expected_nodes,command_catalog:fields.command_catalog});
  return {slots,fields,contract:contract.contract,profile:profile.profile,plan_run:'run_00000000000000000000000000',build:'SYN_ORBIT_10_8_1',frozen};
}
test('one sequential workbook preserves absence and ordinary expectations without the block format',()=>{
  const absent=sequentialAbsence(),found=sequentialAbsence();
  found.fields.autoid='SYN-BLOCK-2';
  found.slots.expects=[{text:absenceLiteral,quote:{reference:EXPECTED_REF,text:absenceLiteral},after:1}];
  for(const input of [absent,found]){
    const source=checkExpectedSources(input.frozen),contract=checkContractShape(input.frozen);
    assert.ok(source.every(row=>row.verdict==='support'),JSON.stringify(source));
    assert.ok(contract.every(row=>row.verdict==='support'),JSON.stringify(contract));
  }
  const inputs=[absent,found],read=readWorkbook(coreModel(generateWorkbookSet(inputs)),inputs);
  assert.ok(read.ok,JSON.stringify(read));if(!read.ok)return;
  assert.deepEqual(read.autoids,['SYN-BLOCK-1','SYN-BLOCK-2']);
  const assertions=read.executions.filter(row=>row.assertion);
  assert.deepEqual(assertions.map(row=>row.method),['not_found','literal']);
  assert.equal(new RegExp(assertions[0].args[0],'s').test(absenceLiteral),true);
  assert.equal(new RegExp(assertions[0].args[0],'s').test('recordaaZxvalue$tail'),false);
  assert.equal(assertions[1].args[0],absenceLiteral);
});
for(const corruption of ['method','pattern'])test('sequential absence readback rejects changed '+corruption,()=>{
  const input=sequentialAbsence(),model=coreModel(generateWorkbook(input));
  const row=model.sheets[0].rows.find(row=>row.cells.some(cell=>cell.reference.startsWith('F')&&cell.text==='not_found'))!;
  if(corruption==='method')row.cells.find(cell=>cell.reference.startsWith('F'))!.text='literal';
  else row.cells.find(cell=>cell.reference.startsWith('G'))!.text=absenceLiteral;
  const read=readWorkbook(model,input);
  assert.equal(read.ok,false);if(!read.ok)assert.ok(read.problems.some(problem=>problem.rule==='assertion'));
});
test('sequential absence needs its declared operator and published allowed method',()=>{
  const missing=sequentialAbsence(document=>{document.runtime.block_model.operators=document.runtime.block_model.operators.filter((row: {op: string})=>row.op!=='not_found');});
  assert.throws(()=>generateWorkbook(missing));
  const duplicate=sequentialAbsence(document=>{document.runtime.block_model.operators.push({...document.runtime.block_model.operators.find((row: {op: string})=>row.op==='not_found')});});
  assert.throws(()=>generateWorkbook(duplicate));
  const disallowed=sequentialAbsence();disallowed.profile.allowed=disallowed.profile.allowed.filter(row=>row.method!=='not_found');
  assert.throws(()=>generateWorkbook(disallowed));
});
test('sequential absence does not need an unused ordinary assertion method',()=>{
  const input=sequentialAbsence(undefined,['not_found']);
  const read=readWorkbook(coreModel(generateWorkbook(input)),input);
  assert.ok(read.ok,JSON.stringify(read));if(read.ok)assert.deepEqual(read.executions.filter(row=>row.assertion).map(row=>row.method),['not_found']);
});
