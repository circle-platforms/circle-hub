// What the plan check says when it refuses, for the refusals of round 36 that sent a writer to the tool's source: the plan's item
// that is not in the frozen run, a recomposition declaration the plan does not carry or gets wrong, and a field a block does not
// have. Each says where, what was seen, what is allowed and what to do next; the decisions (ok, structure_ok, the verdict and the
// code of each problem) are the ones the check always gave.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkPlanObject} from './check-plan.ts';
import {frozenRun} from '../testing/frozen-run.ts';
import {lockedTreeOf,type FlatCatalog} from '../testing/locked-tree.ts';
import {cellFixture,positiveBlocks} from '../testing/blocks.ts';
import {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,COMMAND_CATALOG,QUOTE,goodData} from '../functions/test-support.ts';

const LEASES={now:'2026-10-23T02:00:00.000Z',entries:[]};
const group=()=>({kind:'case-compile',contract:CONTRACT_DOC,profile:PROFILE_DOC,manifest:MANIFEST_DOC,leases:LEASES});
const IDS=['c8op2ikg2ao0:1a29b18cf58e','c8op2ikg2ao0:9cd9df76eaa6','c8op2ikg2ao0:911edce9e217'];
const AUTOIDS=['253651793153360593','253651793153360434','253651793153344789'];
const items=()=>IDS.map((id,index)=>({id,label:'合成用例 '+index,location:QUOTE.reference,fields:{autoid:AUTOIDS[index]}}));
const run=(over:{groups?:unknown[];items?:Array<Record<string,unknown>>}={})=>frozenRun({run:'run_synthetic_plan',groups:over.groups??[group()],items:over.items??items(),root:(COMMAND_CATALOG as {root:string}).root,command_policy:(COMMAND_CATALOG as {policy:unknown}).policy,extra:{pack:'case-compile@3.21.6'}});
const plan=(item:string,data=goodData(),claim:Record<string,unknown>={})=>({item,handling:'handled',slots:{plan:[{text:'合成计划',quotes:[QUOTE],data,...claim}]}});
const check=(value:unknown,frozen:Record<string,unknown>=run(),catalog:FlatCatalog=COMMAND_CATALOG as FlatCatalog)=>checkPlanObject('plan.json',value,frozen,lockedTreeOf(catalog));
const has=(text:string,...parts:string[])=>{for(const part of parts)assert.ok(text.includes(part),`missing ${JSON.stringify(part)} in: ${text}`);};

test('a plan whose item is the case number is told the item ids of the run and which one is its case', () => {
  const result=check(plan(AUTOIDS[1]!));
  assert.equal(result.ok,false);assert.equal(result.structure_ok,true,'the plan\'s own structure is fine; only the run does not know it');assert.equal(result.authority_checked,false);
  const own=result.problems.filter(row=>row.pointer==='/item'||row.pointer==='/run');assert.equal(own.length,1,JSON.stringify(result.problems));
  has(own[0]!.message,JSON.stringify(AUTOIDS[1]!),...IDS.map(id=>JSON.stringify(id)),'run_synthetic_plan','/item','下一步');
  assert.ok(own[0]!.message.indexOf(IDS[1]!)>=0&&own[0]!.message.includes('用例号'),own[0]!.message);
  assert.equal(own[0]!.pointer,'/item');
});

test('a plan whose item is in no run item is told the closed set and no guess about which one it meant', () => {
  const result=check(plan('doc:nowhere'));
  const own=result.problems.filter(row=>row.pointer==='/item');assert.equal(own.length,1,JSON.stringify(result.problems));
  has(own[0]!.message,JSON.stringify('doc:nowhere'),...IDS.map(id=>JSON.stringify(id)),'下一步');
  assert.ok(!own[0]!.message.includes('用例号'),own[0]!.message);
});

test('a long set of run items is listed up to a limit and counted', () => {
  const many=Array.from({length:30},(_,index)=>({id:`syn:item-${String(index).padStart(2,'0')}`,label:'合成',location:QUOTE.reference,fields:{}}));
  const own=check(plan('doc:nowhere'),run({items:many})).problems.filter(row=>row.pointer==='/item');assert.equal(own.length,1);
  has(own[0]!.message,'syn:item-00','共 30 个');assert.ok(!own[0]!.message.includes('syn:item-29'),own[0]!.message);
});

test('a frozen run with no case-compile group says which groups and which pack it is, and that it is the wrong run', () => {
  const frozen=run({groups:[{kind:'recompose-scope@1'}]});frozen.pack='recompose@1.2.10';frozen.run='run_synthetic_recompose';
  const result=check(plan(IDS[0]!),frozen);
  assert.equal(result.ok,false);const own=result.problems.filter(row=>row.pointer==='/run');assert.equal(own.length,1,JSON.stringify(result.problems));
  has(own[0]!.message,'run_synthetic_recompose','recompose@1.2.10','recompose-scope@1','case-compile','下一步');
});

test('two case-compile groups are counted', () => {
  const result=check(plan(IDS[0]!),run({groups:[group(),group()]}));
  const own=result.problems.filter(row=>row.pointer==='/run');assert.equal(own.length,1,JSON.stringify(result.problems));
  has(own[0]!.message,'2');
});

test('the decision of the frozen-run refusal is the one it was: not ok, nothing of the Hub checks ran', () => {
  for(const value of [plan('doc:nowhere'),plan(AUTOIDS[0]!)]){
    const result=check(value);
    assert.equal(result.ok,false);assert.equal(result.authority_checked,false);assert.equal(result.cleanup_checked,false);assert.equal(result.problems.length,1,JSON.stringify(result.problems));
  }
  assert.equal(check(plan(IDS[0]!)).problems.some(row=>row.pointer==='/item'||row.pointer==='/run'),false,'a plan whose item is in the run has no such refusal');
});

const RECEIPT='rec:'+'9'.repeat(64),CASE_ID='253651793153344789';
const proofFor=(reference:string,text:string)=>({receipt:RECEIPT,run:'run_synthetic_recompose',source:'src:'+'a'.repeat(64),conditional_on_judgment:true,record:{case:{id:CASE_ID,node:'n/1',source_ref:'src:'+'a'.repeat(64)},atoms:[{id:'a6',kind:'expectation',quote_ref:reference,span:[0,6],text}],expectation_slots:[{slot:'e1',atom:'a6',evidence:[],knowledge_location:'has_verification_knowledge',proposal:null}]}});
const withProof=()=>run({items:[{id:'doc:case-1',label:'合成用例',location:QUOTE.reference,fields:{recomposition:proofFor(QUOTE.reference,QUOTE.text)}}]});

test('a plan that does not declare the recomposition it consumes gets the position and the values to copy', () => {
  const result=check(plan('doc:case-1'),withProof());
  assert.equal(result.ok,false);
  const own=result.problems.filter(row=>row.code==='missing_input');assert.equal(own.length,1,JSON.stringify(result.problems));
  assert.equal(own[0]!.verdict,'unknown');
  has(own[0]!.message,'/slots/plan/0/data/recomposition',JSON.stringify(RECEIPT),JSON.stringify(CASE_ID),'/fields/recomposition','doc:case-1','"assertions":["1"]','下一步');
});

test('the declaration that names an assertion the plan does not have is refuted with the plan\'s assertion ids', () => {
  const data=goodData() as unknown as Record<string,unknown>;data.recomposition={receipt:RECEIPT,case_id:CASE_ID,slots:[{slot:'e1',assertions:['expect_1']}],rebindings:[]};
  const result=check(plan('doc:case-1',data as unknown as ReturnType<typeof goodData>),withProof());
  const own=result.problems.filter(row=>row.code==='case-compile.slots_invalid');assert.equal(own.length,1,JSON.stringify(result.problems));
  assert.equal(own[0]!.verdict,'refute');
  has(own[0]!.message,JSON.stringify('expect_1'),'允许：1','下一步');
});

test('a block carrying precondition_source is told where the field is declared and what a block plan writes instead', () => {
  const f=cellFixture(),data=positiveBlocks().CONFIG as unknown as Record<string,any>;
  data.blocks[0]={...data.blocks[0],precondition_source:{reference:QUOTE.reference,text:QUOTE.text}};
  const frozen=frozenRun({groups:[{kind:'case-compile',contract:f.contractDoc,profile:f.profileDoc,manifest:f.inventory,manifest_sha256:f.manifest_sha256,leases:LEASES}],items:[{id:'synthetic-case',label:'合成用例',location:'src:'+'a'.repeat(64)+'/kityminder@1/n/expected',fields:f.fields}],root:f.catalog.root,command_policy:(f.catalog as {policy:unknown}).policy});
  const result=checkPlanObject('plan.json',{item:'synthetic-case',handling:'handled',slots:{plan:[{text:'合成块计划',quotes:[QUOTE],data}]}},frozen,lockedTreeOf(f.catalog));
  assert.equal(result.ok,false);assert.equal(result.structure_ok,false);
  const own=result.problems.filter(row=>row.pointer==='/slots/plan/0/data/blocks/0/precondition_source');assert.equal(own.length,1,JSON.stringify(result.problems));
  assert.equal(own[0]!.code,'SUBMISSION_SCHEMA_VIOLATION');
  has(own[0]!.message,'不认识的字段 precondition_source','允许：','id、kind、call','/slots/plan/0/data/steps/<序号>/precondition_source','block_context.preconditions','下一步');
});
