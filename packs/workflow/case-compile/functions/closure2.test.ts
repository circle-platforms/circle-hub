import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorkbook, GenerationError } from './generate.ts';
import { generationFixture } from '../testing/workbook.ts';
import { goodData, subjectOf } from './test-support.ts';
import { checkContractShape, checkExpectedSources } from './checks.ts';
test('closure 01 refuses SpreadsheetML escape text before generation and during plan repair',()=>{
 const recipe=generationFixture();recipe.fields.title='literal _x0041_';assert.throws(()=>generateWorkbook(recipe),(e:unknown)=>e instanceof GenerationError&&(e as GenerationError&{rule:string}).rule==='xstring_escape');
 const plan=goodData();plan.steps[0].args=['widget _x0041_'];assert.ok(checkContractShape(subjectOf(plan)).some(v=>v.verdict==='refute'&&v.code==='case-compile.param_value'));
 plan.expects[0].text='_x000D_';plan.expects[0].quote.text='_x000D_';assert.ok(checkExpectedSources(subjectOf(plan)).some(v=>v.verdict==='refute'&&v.code==='case-compile.expect_value'));
});
test('closure 03 rejects G positional keyword ambiguity during the plan repair loop',()=>{const plan=goodData();plan.steps[1].args=['FOO=1 echo 192.0.2.90'];const result=checkContractShape(subjectOf(plan));assert.ok(result.some(v=>v.verdict==='refute'&&v.code==='case-compile.param_value'&&v.pointer==='/data/steps/1/G'&&v.statement.includes('positional_keyword')));});
