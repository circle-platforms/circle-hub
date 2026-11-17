// The plan check refuses a plan that leaves an authored action of its recomposition record unrealized, before the audit does
// (round 36: the sync plan passed check-plan and the command check and was refused by the scenario audit for author step a2, a
// full writer rework). The rule is the program's half of InfoTest's author_procedure_coverage gate
// (main/case_compiler/mechanical_case_gate.py `_gate_author_procedure_coverage`: every authored occurrence must land in the plan);
// where InfoTest counts command signatures, this pack has no step structure and binds by explicit ids: every `action` atom of the
// bound record is named by at least one step's (or block's) `author_step_refs`.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkPlanObject} from './check-plan.ts';
import {frozenRun} from '../testing/frozen-run.ts';
import {lockedTreeOf,type FlatCatalog} from '../testing/locked-tree.ts';
import {cellFixture,cellPlan} from '../testing/blocks.ts';
import {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,COMMAND_CATALOG,QUOTE,goodData} from '../functions/test-support.ts';

const LEASES={now:'2026-10-23T02:00:00.000Z',entries:[]};
const CODE='case-compile.author_step_unreferenced';
const SOURCE='src:'+'a'.repeat(64),RECEIPT='rec:'+'9'.repeat(64),CASE_ID='253651793153344789';
const atom=(id:string,kind:string,text:string,node:string)=>({id,kind,quote_ref:SOURCE+'/kityminder@1/n/'+node,span:[0,[...text].length],text});
/** A bound recomposition record: the case intent, two authored actions, the authored expectation (which the plan quotes). */
const record=(extra:Array<Record<string,unknown>>=[])=>({
 case:{id:CASE_ID,node:'n/1',source_ref:SOURCE},
 contract:{intent:{text:'配置组件健康检查间隔'}},
 atoms:[atom('a1','intent','配置组件健康检查间隔','i1'),atom('a2','action','HA 已配置','s2'),atom('a3','action','配置组件健康检查间隔 60','s3'),{id:'a4',kind:'expectation',quote_ref:QUOTE.reference,span:[0,6],text:QUOTE.text},...extra],
 expectation_slots:[{slot:'e1',atom:'a4',evidence:[],knowledge_location:'has_verification_knowledge',proposal:null}],
 ledgers:{original:[],adapted:[],concretizations:[],rebindings:[]},
});
const proof=(rec:Record<string,unknown>=record())=>({receipt:RECEIPT,run:'run_synthetic_recompose',source:SOURCE,conditional_on_judgment:true,record:rec});
const group=()=>({kind:'case-compile',contract:CONTRACT_DOC,profile:PROFILE_DOC,manifest:MANIFEST_DOC,leases:LEASES});
const frozen=(fields:Record<string,unknown>)=>frozenRun({run:'run_synthetic_plan',groups:[group()],items:[{id:'doc:case-1',label:'合成用例',location:QUOTE.reference,fields}],root:(COMMAND_CATALOG as {root:string}).root,command_policy:(COMMAND_CATALOG as {policy:unknown}).policy,extra:{pack:'case-compile@3.21.6'}});
const declared=()=>({receipt:RECEIPT,case_id:CASE_ID,slots:[{slot:'e1',assertions:['1']}],rebindings:[]});
/** The flat plan of goodData(): step 1 configures, step 2 echoes on a host, step 3 pauses; `refs` is what each step names. */
const flat=(refs:Array<string[]|undefined>):Record<string,unknown>=>{
 const data=goodData() as unknown as Record<string,any>;data.recomposition=declared();
 refs.forEach((ids,index)=>{if(ids!==undefined)data.steps[index].author_step_refs=ids;});
 return {item:'doc:case-1',handling:'handled',slots:{plan:[{text:'合成计划',quotes:[QUOTE],data}]}};
};
const check=(value:unknown,fields:Record<string,unknown>={recomposition:proof()})=>checkPlanObject('plan.json',value,frozen(fields),lockedTreeOf(COMMAND_CATALOG as FlatCatalog));
const own=(result:ReturnType<typeof check>)=>result.problems.filter(row=>row.code===CODE);
const has=(text:string,...parts:string[])=>{for(const part of parts)assert.ok(text.includes(part),`missing ${JSON.stringify(part)} in: ${text}`);};

test('a flat plan whose steps name every authored action is accepted, and the Hub check that ran says so',()=>{
 const result=check(flat([['a2'],['a3'],undefined]));
 assert.equal(result.ok,true,JSON.stringify(result.problems));
 const row=result.hub_checks!.find(entry=>entry.check==='author_step_coverage')!;assert.ok(row,'the plan check runs the coverage check of the Hub');
 assert.equal(row.ran,true);assert.equal(row.problems,0);
});

test('an action no step names is refused with its id and text, the steps that do carry ids, the ids allowed and the next steps (round 36, a2)',()=>{
 const result=check(flat([['a3'],undefined,undefined]));
 assert.equal(result.ok,false);
 const problems=own(result);assert.equal(problems.length,1,JSON.stringify(result.problems));
 const problem=problems[0]!;
 assert.equal(problem.verdict,'refute');assert.equal(problem.pointer,'/steps');
 has(problem.message,
  '作者步骤 a2','"HA 已配置"','没有任何计划步骤声明实现它','author_step_refs',
  '/slots/plan/0/data/steps/<序号>/author_step_refs',
  '计划共 3 步','"a3"：第 1 步','没写的是第 2、3 步',
  '允许：a2、a3','/fields/recomposition/record/atoms',
  '下一步','在实现它的步骤的 author_step_refs 里加上 "a2"','补上实现它的步骤','最终回复','主代理');
 assert.ok(!problem.message.includes('作者步骤 a3'),'the covered action is not named as a gap: '+problem.message);
 assert.equal(result.hub_checks!.find(entry=>entry.check==='author_step_coverage')!.problems,1);
});

test('two actions no step names are two refusals, each with its own text',()=>{
 const result=check(flat([undefined,undefined,undefined]));
 const problems=own(result);assert.equal(problems.length,2,JSON.stringify(result.problems));
 has(problems[0]!.message,'作者步骤 a2','"HA 已配置"','计划共 3 步，没有一步写了 author_step_refs');
 has(problems[1]!.message,'作者步骤 a3','"配置组件健康检查间隔 60"');
});

test('one step may name several actions and one action may be named by several steps',()=>{
 assert.equal(own(check(flat([['a2','a3'],undefined,undefined]))).length,0);
 assert.equal(own(check(flat([['a2'],['a3'],['a2','a3']]))).length,0);
});

test('an id that is no author step of the case covers nothing, and the refusal says which ids the plan wrote (an ordinal, a typo)',()=>{
 const result=check(flat([['a3'],['2'],undefined]));
 const problems=own(result);assert.equal(problems.length,1,JSON.stringify(result.problems));
 has(problems[0]!.message,'作者步骤 a2','"a3"：第 1 步','"2"：第 2 步','允许：a2、a3');
});

test('the intent and the expectation of the record are not author steps: an id naming them covers nothing and they need none',()=>{
 const result=check(flat([['a2'],['a3'],['a1','a4']]));
 assert.equal(own(result).length,0,JSON.stringify(result.problems));
});

test('a case whose record holds no authored action, or no record at all, has nothing to cover',()=>{
 const noAction=record();noAction.atoms=noAction.atoms.filter(entry=>entry.kind!=='action');
 assert.equal(own(check(flat([undefined,undefined,undefined]),{recomposition:proof(noAction)})).length,0);
 const withoutRecord=flat([undefined,undefined,undefined]);delete (withoutRecord.slots as any).plan[0].data.recomposition;
 const result=check(withoutRecord,{});
 assert.equal(own(result).length,0,JSON.stringify(result.problems));assert.equal(result.hub_checks!.find(entry=>entry.check==='author_step_coverage')!.ran,true);
});

test('a case declared skipped with its reason is not judged: nothing was planned that could cover anything',()=>{
 const result=check({item:'doc:case-1',handling:'skipped',reason:'测试环境没有这台设备'});
 assert.equal(result.ok,true);assert.equal(result.kind,'skipped');assert.deepEqual(result.problems,[]);
});

function blockRun(rec:Record<string,unknown>){
 const f=cellFixture();
 return {f,run:frozenRun({run:'run_synthetic_plan',groups:[{kind:'case-compile',contract:f.contractDoc,profile:f.profileDoc,manifest:f.inventory,manifest_sha256:f.manifest_sha256,leases:LEASES}],items:[{id:'synthetic-case',label:'合成取格用例',location:f.fields.expected_nodes[0].reference,fields:{...f.fields,recomposition:proof(rec)}}],root:f.catalog.root,command_policy:f.catalog.policy,extra:{pack:'case-compile@3.21.6'}})};
}
const blockItem=(data:unknown)=>({item:'synthetic-case',handling:'handled',slots:{plan:[{text:'合成块计划',quotes:[QUOTE],data}]}});
const blockRecord=()=>{const rec=record();rec.atoms=rec.atoms.map(entry=>entry.id==='a4'?{...entry,quote_ref:cellFixture().fields.expected_nodes[0].reference,text:cellFixture().fields.expected_nodes[0].text}:entry);return rec;};
const withRefs=(refs:Array<string[]|undefined>)=>{const data=cellPlan() as unknown as Record<string,any>;refs.forEach((ids,index)=>{if(ids!==undefined)data.blocks[index].author_step_refs=ids;});return data;};

test('a block plan is judged on its blocks: an action no block names is refused at /blocks with the block ids',()=>{
 const {f,run}=blockRun(blockRecord());
 const data=withRefs([['a3'],undefined]);
 const result=checkPlanObject('plan.json',blockItem(data),run,lockedTreeOf(f.catalog));
 const problems=own(result);assert.equal(problems.length,1,JSON.stringify(result.problems));
 assert.equal(problems[0]!.verdict,'refute');assert.equal(problems[0]!.pointer,'/blocks');
 has(problems[0]!.message,'作者步骤 a2','"HA 已配置"','没有任何计划块声明实现它','/slots/plan/0/data/blocks/<序号>/author_step_refs',`计划共 ${data.blocks.length} 块`,'"a3"：第 1 块','允许：a2、a3','在实现它的块的 author_step_refs 里加上 "a2"');
});

test('a block plan whose blocks name every authored action has no coverage refusal',()=>{
 const {f,run}=blockRun(blockRecord());
 const result=checkPlanObject('plan.json',blockItem(withRefs([['a2'],['a3']])),run,lockedTreeOf(f.catalog));
 assert.equal(own(result).length,0,JSON.stringify(result.problems));
 assert.equal(result.hub_checks!.find(entry=>entry.check==='author_step_coverage')!.problems,0);
});
