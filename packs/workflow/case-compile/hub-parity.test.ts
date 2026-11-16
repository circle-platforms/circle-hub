// The plan check against the real Hub: the same plans go through check-plan with the run's frozen inputs and through submit_result
// on the real engine (a temporary PostgreSQL, the published pack, synthetic documents); what the Hub refuses in a plan, check-plan
// refuses with the same pointer, code and text. Divergences of run 33 (a claim without its text, an effect budget) are fixtures.
import assert from 'node:assert/strict';
import {after,before,describe,it} from 'node:test';
import {osIsolationAvailable} from '../../../hub/rules/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../../hub/testing/postgres.ts';
import {createTestParserRegistry} from '../../../hub/testing/parsers.ts';
import {recognize} from '../../../hub/refs/api.ts';
import {call,openHub,sha,ROOT,type Hub} from './testing/hub.ts';
import {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,AUTOID,goodData} from './functions/test-support.ts';
import {checkPlanObject} from './tools/check-plan.ts';
import CHECKS from './checks.json' with {type:'json'};
import REQUIREMENTS from './requirements.json' with {type:'json'};

const skip=(await osIsolationAvailable())?false:'no OS network isolation on this machine (sandbox-exec)';
let postgres:TemporaryPostgres,hub:Hub;
const CASES=6;
const document={root:{data:{id:'doc-par',text:'合成文档'},children:Array.from({length:CASES},(_,i)=>({data:{id:'case-'+i,text:'健康检查间隔配置测试'+i,resource:['功能'],priority:2,autoid:String(BigInt(AUTOID)+BigInt(i)),auto:'1'},children:[{data:{id:'step-'+i,text:'widget health interval 60'},children:[{data:{id:'expected-'+i,text:'健康检查间隔设置成功'}}]}]}))}};
const bytes=Buffer.from(JSON.stringify(document));
const nodes=(recognize(createTestParserRegistry(),bytes,'application/json')!.document.model as {nodes:Array<{data:{id?:string};selector:string}>}).nodes;
const leaf=(i:number)=>`src:${sha(bytes.toString())}/kityminder@1/${nodes.find(node=>node.data.id==='expected-'+i)!.selector}`;
const start=()=>({pack:'case-compile',product:'widget',build:'Fixture_Build_A',inputs:{subject:{external:'agile:mindmap:doc-par'},contract:{external:'doc:doc:par-contract'},profile:{external:'doc:doc:par-profile'},inventory:{external:'doc:doc:par-bed'}},parameters:{pipeline:'legacy'}});
before(async()=>{
 postgres=await startPostgres();if(skip)return;
 hub=await openHub(postgres);
 const put=(id:string,value:Uint8Array)=>hub.external.put(id,{bytes:value,mediaType:'application/json'});
 put('agile:mindmap:doc-par',bytes);for(const [id,value] of [['par-contract',CONTRACT_DOC],['par-profile',PROFILE_DOC],['par-bed',MANIFEST_DOC]] as const)put('doc:doc:'+id,Buffer.from(JSON.stringify(value)));
});
after(async()=>{await hub?.close();await postgres?.stop();});

type Claim=Record<string,unknown>;
/** One plan the writer would put in a file, built for case `index`; `mutate` makes the flaw under test. */
const claim=(index:number,mutate:(claim:Claim,data:ReturnType<typeof goodData>)=>void=()=>{}):Claim=>{
 const data=goodData();data.expects[0].quote.reference=leaf(index);const value:Claim={text:'合成计划槽位',quotes:data.expects.map(row=>row.quote),data};mutate(value,data);return value;
};
const overBudget=(_:Claim,data:ReturnType<typeof goodData>)=>{data.steps=[...Array.from({length:11},(__,k)=>({object:'widget-seat',method:'configure',args:['widget health interval '+(60+k%2)],keywords:{}})),...data.steps.slice(1)];};
const STRUCTURE:Array<[string,(claim:Claim,data:ReturnType<typeof goodData>)=>void]>=[
 ['an accepted plan',()=>{}],
 ['a claim without its text',value=>{delete value.text;}],
 ['a claim with a field it does not have',value=>{value.extra=1;}],
 ['a text that is a number',value=>{value.text=7;}],
 ['a plan without its bucket',(_,data)=>{delete (data as Partial<typeof data>).bucket;}],
 ['a claim whose data is not an object',value=>{value.data='x';}],
];
const CHECKED:Array<[string,(claim:Claim,data:ReturnType<typeof goodData>)=>void]>=[
 ['an accepted plan',()=>{}],
 ['eleven calls against a budget of ten',overBudget],
 ['a method outside the frozen intersection',(_,data)=>{data.steps[0].method='nosuch';}],
 ['an expectation that is not its quote',(_,data)=>{data.expects[0].text='完全不同的文字';}],
 ['a replacement that is no authored address',(_,data)=>{data.replacements=[{case:'192.0.2.200',bed:'192.0.2.91'}];}],
 ['a command the locked tree does not have',(_,data)=>{data.steps[0].args=['widget unknown command 5'];}],
];

/** The pointer of a Hub path inside the item, and the text of a Hub message without the item position. */
const inItem=(text:string,index:number):string=>text.replaceAll(`/items/${index}`,'');
const stripData=(pointer:string):string=>pointer==='/data'?'':pointer.startsWith('/data/')?pointer.slice('/data'.length):pointer;
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,inner)=>inner!==null&&typeof inner==='object'&&!Array.isArray(inner)?Object.fromEntries(Object.entries(inner).sort(([a],[b])=>a<b?-1:1)):inner);
const unique=(rows:unknown[]):string[]=>[...new Set(rows.map(canonical))].sort();
// The requirements whose checks all judge the plan itself; the workbook requirement waits for an upload and is not compared.
const PLAN_STAGE_CHECKS=['contract_shape','bed_addresses','commands_catalog','expected_sources','expected_quotes'];
const PLAN_REQUIREMENTS=new Set(REQUIREMENTS.requirements.filter(row=>(row.checks as string[]).length>0&&(row.checks as string[]).every(id=>PLAN_STAGE_CHECKS.includes(id))).map(row=>row.key));

/** The problems the Hub's answer holds for one item, in the shape check-plan reports them. */
function hubProblems(answer:Awaited<ReturnType<Hub['service']['submitResult']>>,item:string,index:number){
 const structure=(answer.errors??[]).filter(error=>error.item===item&&error.code==='SUBMISSION_SCHEMA_VIOLATION').map(error=>({code:error.code,pointer:inItem(error.path??'',index),message:inItem(error.message,index)}));
 const checks:unknown[]=[];
 for(const rows of Object.values(answer.result?.partitions??{}))for(const row of rows)if(row.item===item)for(const requirement of row.requirements)if(PLAN_REQUIREMENTS.has(requirement.requirement))for(const entry of requirement.claims){
  const statement=entry.statement as {verdict?:string;code?:string;reason?:string;text?:string;data?:{problems?:Array<Record<string,unknown>>}};
  if(statement.verdict!=='refute'&&statement.verdict!=='unknown'||statement.reason==='awaiting_step')continue;
  const code=statement.code??statement.reason,gaps=statement.data?.problems??[];
  if(gaps.length)checks.push(...gaps.map(gap=>({...gap,...(code!==undefined?{code}:{})})));
  else checks.push({...(code!==undefined?{code}:{}),pointer:stripData(String((entry as {pointer?:string}).pointer??'')),message:statement.text,verdict:statement.verdict});
 }
 return {structure,checks};
}

async function parity(variants:typeof STRUCTURE){
 const started=await hub.service.startRunDetailed(hub.alice,start() as never,call());assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer.errors));
 const run=started.answer.run!,exported=await hub.service.exportRun!(hub.alice,run.run);assert.ok(exported);
 const frozen=JSON.parse(JSON.stringify(exported.run)) as Record<string,unknown>;
 const view=await hub.knowledge.catalog(ROOT,'commands@1');assert.ok(view);
 const catalog={root:ROOT,complete:view.complete,entries:view.entries()};
 const items=run.items.map((item,index)=>({item:item.id,handling:'handled' as const,slots:{plan:[claim(index,variants[index][1])]}}));
 const answer=await hub.service.submitResult(hub.alice,{run:run.run,model:'synthetic-model',items} as never,call());
 return {run,frozen,catalog,items,answer};
}
describe('check-plan against the real Hub',{skip},()=>{
 it('names the same structure problems for the same slot records',async()=>{
  const result=await parity(STRUCTURE);
  for(const [index,[label]] of STRUCTURE.entries()){
   const item=result.run.items[index].id,local=checkPlanObject('plan.json',result.items[index],result.frozen,result.catalog),hubSide=hubProblems(result.answer,item,index);
   const localStructure=local.problems.filter(problem=>problem.code==='SUBMISSION_SCHEMA_VIOLATION').map(({code,pointer,message})=>({code,pointer,message}));
   // Pointer and code always agree; the text agrees where the Hub's own words are specific (a missing or mistyped value, an unknown field).
   assert.deepEqual(localStructure.map(row=>[row.code,row.pointer]).sort(),hubSide.structure.map(row=>[row.code,row.pointer]).sort(),label);
   if(index<=4)assert.deepEqual(unique(localStructure),unique(hubSide.structure),label);
   assert.equal(local.ok,hubSide.structure.length===0&&local.problems.length===0,label);
   if(hubSide.structure.length)assert.equal(local.ok,false,`${label}: the Hub refuses it, so the local check does not pass it`);
  }
  // The very fixture of run 33: the Hub refuses a claim without its text and the local check no longer says ok.
  assert.equal(checkPlanObject('plan.json',result.items[1],result.frozen,result.catalog).ok,false);
 });
 it('names the same problems of the Hub checks for the same plans, and passes the plan the Hub passes',async()=>{
  const result=await parity(CHECKED);
  for(const [index,[label]] of CHECKED.entries()){
   const item=result.run.items[index].id,local=checkPlanObject('plan.json',result.items[index],result.frozen,result.catalog),hubSide=hubProblems(result.answer,item,index);
   assert.deepEqual(hubSide.structure,[],label);
   assert.deepEqual(unique(local.problems),unique(hubSide.checks),label);
   assert.equal(local.ok,hubSide.checks.length===0,label);
  }
  // Run 33, 54 calls against a budget of 50: the over-budget plan is refused here with the Hub's text.
  const over=checkPlanObject('plan.json',result.items[1],result.frozen,result.catalog);assert.equal(over.ok,false);assert.ok(over.problems.some(problem=>problem.message==='效果 effect_0 的计划调用 11 次超过声明预算 10 次'));
  assert.equal(checkPlanObject('plan.json',result.items[0],result.frozen,result.catalog).ok,true,'the plan the Hub passes is passed here');
 });
 it('lists every check the Hub runs on a plan and says why the ones it cannot run were not',async()=>{
  const result=await parity(CHECKED),local=checkPlanObject('plan.json',result.items[0],result.frozen,result.catalog);
  assert.deepEqual(local.hub_checks!.map(row=>row.check),CHECKS.checks.map(row=>row.id),'one row per declared check, in declaration order');
  const ran=local.hub_checks!.filter(row=>row.ran).map(row=>row.check),notRun=local.hub_checks!.filter(row=>!row.ran);
  assert.deepEqual(ran,['contract_shape','bed_addresses','commands_catalog','expected_sources']);
  assert.deepEqual(notRun.map(row=>row.check),['expected_quotes','scenario_fidelity','workbook_verified','dispatch_policy']);
  for(const row of notRun)assert.ok(row.why&&row.why.length>8,row.check);
  // Everything the Hub judged for this item is in the list: each requirement it reported is served by a check named there.
  const reported=new Set(Object.values(result.answer.result?.partitions??{}).flat().filter(row=>row.item===result.run.items[0].id).flatMap(row=>row.requirements.map(requirement=>requirement.requirement)));
  const covered=new Set(local.hub_checks!.flatMap(row=>row.requirements));
  for(const requirement of reported)if(requirement!=='plan')assert.ok(covered.has(requirement),`requirement ${requirement} is served by a listed check`);
 });
});
