import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assemble, closeFailed, closeUnrun, caseConclusion, deliveryReport, type Dispatch, type CaseOutcome, type ReportInput } from './delivery.ts';
const dispatch=(run:string,item:string):Dispatch=>({run,job:run,plan_run:run,sha256:'a'.repeat(64),items:[item],rows:[{item,dynamic_terminal:'pass',qualifier:{nature:'judgment',marks:['target_reported']},accepted_as_fact:false}]});
test('a correct observation outside the verified volume only leaves that case pending',()=>{
  const a=assemble(['a','b'],[dispatch('first','a'),dispatch('last','b')]);
  assert.deepEqual(a.pass?.items,['b']);assert.equal(a.cases[0].history.at(-1)?.terminal,'pass');assert.ok(a.cases[0].pending?.length);assert.equal(a.cases[1].status,'delivered');
});
test('every unwritten case gets a pending result without a fabricated closing credential',()=>{
  const cases:CaseOutcome[]=[{autoid:'a',status:'unrun',history:[]},{autoid:'b',status:'unrun',history:[]}];
  const result=closeUnrun(cases,{});assert.deepEqual(result.problems,[]);assert.equal(result.cases.length,2);assert.ok(result.cases.every(c=>c.pending?.length&&!c.closing));
});
test('failed cases preserve unverified attribution and invalid candidates as case-local missing evidence',()=>{
  const cases:CaseOutcome[]=[{autoid:'a',status:'failed',history:[]}];
  const notes={cases:{a:{judged:'model claim',remedy:'model remedy',defect_candidate:{repro:'repro',expected:'not authored',actual:'not observed'}}}};
  const result=closeFailed(cases,notes,{a:1},{a:['actual author']},{a:['actual output']});assert.deepEqual(result.problems,[]);assert.ok(result.cases[0].pending?.length);assert.equal(result.cases[0].closing,undefined);
});
test('device pass remains an unconfirmed report and output names match the generated volumes',()=>{
  const assembly=assemble(['a'],[dispatch('first','a')]);const input={name:'synthetic',generatedAt:'synthetic',assembly,notes:{cases:{}},originals:{a:{title:'synthetic',lines:[]}},excluded:[],files:{pass:{sha256:'a'.repeat(64)},unsuccessful:null},logs:{}} as unknown as ReportInput;
  const text=caseConclusion(input,assembly.cases[0]);assert.match(text,/状态未确认/);assert.doesNotMatch(text,/状态已确认/);const report=deliveryReport(input);assert.ok(!report.split('交付物：').at(-1)!.includes('unsuccessful_cases.xlsx'));
});
