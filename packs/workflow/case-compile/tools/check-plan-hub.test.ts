// The plan check is the Hub's own boundary run offline: the same slot-record rule, the same check functions, the same frozen
// inputs. These are the divergences of run 33 (a claim without its text, a call budget) and the refusals of items 1 and 2
// reaching the writer before the Hub does.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkPlanObject} from './check-plan.ts';
import {frozenRun} from '../testing/frozen-run.ts';
import {cellFixture,cellPlan,fixture,plan as blockPlan,call as blockCall,assertion,quote as blockQuote} from '../testing/blocks.ts';
import {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,COMMAND_CATALOG,QUOTE,goodData} from '../functions/test-support.ts';

const LEASES={now:'2026-10-23T02:00:00.000Z',entries:[]};
const flatRun=()=>frozenRun({groups:[{kind:'case-compile',contract:CONTRACT_DOC,profile:PROFILE_DOC,manifest:MANIFEST_DOC,leases:LEASES}],items:[{id:'doc:case-1',label:'合成用例',location:QUOTE.reference,fields:{}}],root:(COMMAND_CATALOG as {root:string}).root,command_policy:(COMMAND_CATALOG as {policy:unknown}).policy});
const flatPlan=(data=goodData(),claim:Record<string,unknown>={})=>({item:'doc:case-1',handling:'handled',slots:{plan:[{text:'合成计划',quotes:[QUOTE],data,...claim}]}});
const check=(value:unknown,run:Record<string,unknown>=flatRun(),catalog:unknown=COMMAND_CATALOG)=>checkPlanObject('plan.json',value,run,catalog);

test('a plan the Hub accepts passes, and says which Hub checks ran and which did not',()=>{
 const result=check(flatPlan());
 assert.equal(result.ok,true,JSON.stringify(result.problems));assert.equal(result.structure_ok,true);assert.equal(result.authority_checked,true);
 const ran=Object.fromEntries((result.hub_checks??[]).map(row=>[row.check,row.ran]));
 assert.deepEqual(ran,{contract_shape:true,bed_addresses:true,commands_catalog:true,expected_sources:true,expected_quotes:false,scenario_fidelity:false,workbook_verified:false,dispatch_policy:false});
 for(const row of result.hub_checks!.filter(item=>!item.ran))assert.ok(row.why&&row.why.length>8,`${row.check} says why it did not run`);
 assert.match(result.disclosure!,/expected_quotes/);assert.match(result.disclosure!,/scenario_fidelity/);
});

test('a claim without its text is refused here as the Hub refuses it (run 33, submission 142237, item 0)',()=>{
 const value=flatPlan();delete (value.slots.plan[0] as Record<string,unknown>).text;
 const result=check(value);
 assert.equal(result.ok,false);assert.equal(result.structure_ok,false);
 const problem=result.problems.find(row=>row.pointer==='/slots/plan/0/text')!;assert.ok(problem,JSON.stringify(result.problems));
 assert.equal(problem.code,'SUBMISSION_SCHEMA_VIOLATION');assert.match(problem.message,/要的是"<string>"，收到的是undefined/);
 assert.ok(result.hub_checks!.every(row=>!row.ran),'the Hub runs no check on an item whose slot record has a structure problem');
});

test('a claim with a field it does not have, a text of the wrong type, a bad count or a bad data field is refused with its pointer',()=>{
 const extra=flatPlan(goodData(),{extra:1});assert.deepEqual(check(extra).problems.map(row=>row.pointer),['/slots/plan/0/extra']);
 const number=flatPlan(goodData(),{text:7});assert.deepEqual(check(number).problems.map(row=>row.pointer),['/slots/plan/0/text']);
 const none=flatPlan();none.slots.plan=[];assert.ok(check(none).problems.some(row=>row.pointer==='/slots/plan'));
 const data=goodData() as unknown as Record<string,unknown>;delete data.bucket;assert.deepEqual(check(flatPlan(data as unknown as ReturnType<typeof goodData>)).problems.map(row=>row.pointer),['/slots/plan/0/data/bucket']);
});

test('the call budget of an effect is counted here as the Hub counts it (run 33, 54 steps against a budget of 50)',()=>{
 const data=goodData();data.steps=[...Array.from({length:11},(_,index)=>({object:'widget-seat',method:'configure',args:['widget health interval '+(60+index%2)],keywords:{}})),...data.steps.slice(1)];
 const result=check(flatPlan(data));
 assert.equal(result.ok,false);
 const budget=result.problems.filter(row=>row.message.includes('超过声明预算'));assert.equal(budget.length,1,JSON.stringify(result.problems));
 assert.equal(budget[0].message,'效果 effect_0 的计划调用 11 次超过声明预算 10 次');assert.equal(budget[0].pointer,'/steps/10');assert.equal(budget[0].code,'case-compile.method_forbidden');
});

test('the checks of the Hub that need no upload run here: addresses, commands and expected sources',()=>{
 const address=goodData();address.replacements=[{case:'192.0.2.200',bed:'192.0.2.91'}];
 assert.ok(check(flatPlan(address)).problems.some(row=>row.code==='case-compile.replacement_invalid'));
 const command=goodData();command.steps[0].args=['widget unknown command 5'];
 assert.ok(check(flatPlan(command)).problems.some(row=>row.pointer==='/steps/0/args/0'));
 const expected=goodData();expected.expects[0].text='完全不同的文字';
 assert.ok(check(flatPlan(expected)).problems.some(row=>row.code==='case-compile.expect_not_in_quote'));
});

test('without the frozen run only the shape is checked and the answer says so',()=>{
 const result=checkPlanObject('plan.json',flatPlan(),undefined);
 assert.equal(result.ok,false);assert.equal(result.authority_checked,false);assert.deepEqual(result.problems.map(row=>row.code),['missing_input']);assert.match(result.disclosure!,/冻结/);
});

test('a frozen run without the slot schema is refused instead of passing the plan unchecked',()=>{
 const run=flatRun();delete run.slots;
 const result=check(flatPlan(),run);assert.equal(result.ok,false);assert.ok(result.problems.some(row=>row.code==='SUBMISSION_SCHEMA_VIOLATION'&&row.message.includes('run.slots.schema')),JSON.stringify(result.problems));
});

function blockRun(f:ReturnType<typeof cellFixture>){
 return frozenRun({groups:[{kind:'case-compile',contract:f.contractDoc,profile:f.profileDoc,manifest:f.inventory,manifest_sha256:f.manifest_sha256,leases:LEASES}],items:[{id:'synthetic-case',label:'合成取格用例',location:'src:'+'a'.repeat(64)+'/kityminder@1/n/expected',fields:f.fields}],root:f.catalog.root,command_policy:(f.catalog as {policy:unknown}).policy});
}
const blockItem=(data:unknown)=>({item:'synthetic-case',handling:'handled',slots:{plan:[{text:'合成块计划',quotes:[blockQuote()],data}]}});

test('the refusal of a one-space separator reaches the writer here with its field, value and rule (item 1)',()=>{
 const f=cellFixture(),data=cellPlan();data.blocks[1].table={format:'delimited',separator:' ',columns:2,header:false};data.blocks[1].column=2;data.blocks[1].select={row:1};
 const result=check(blockItem(data),blockRun(f),f.catalog);
 const own=result.problems.filter(row=>row.pointer==='/blocks/1/table/separator');assert.equal(own.length,1,JSON.stringify(result.problems));
 assert.ok(own[0].message.includes('" "')&&own[0].message.includes('首尾带空白'),own[0].message);assert.ok(!own[0].message.includes('不以 = 开头'));
});

test('a responder output that is a saved name is refused here with the observation ids and the block id (item 2)',()=>{
 const f=fixture(),data=blockPlan([{kind:'CAPTURE',id:'b_show',call:blockCall(),register:'keys_raw'},{kind:'OBSERVE_ASSERT',id:'b_dig',call:{object:'client',method:'shell',args:['echo SYNTHETIC_READY'],keywords:{}},assertions:[assertion('a_sig','b_dig')]}]);
 data.block_context!.responders=[{output:'keys_raw',kind:'device',ref:'dut0',quote:blockQuote()},{output:'b_dig',kind:'device',ref:'dut0',quote:blockQuote()}];
 const result=check(blockItem(data),blockRun(f as ReturnType<typeof cellFixture>),f.catalog);
 const own=result.problems.find(row=>row.pointer==='/block_context/responders/0/output')!;assert.ok(own,JSON.stringify(result.problems));
 assert.ok(own.message.includes('"keys_raw"')&&own.message.includes('应填块 id b_show')&&own.message.includes('b_dig'),own.message);
});
