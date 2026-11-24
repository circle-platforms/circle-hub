import assert from 'node:assert/strict';
import {after,before,describe,it} from 'node:test';
import {osIsolationAvailable} from '../../../hub/rules/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../../hub/testing/postgres.ts';
import {createTestParserRegistry} from '../../../hub/testing/parsers.ts';
import {recognize} from '../../../hub/refs/api.ts';
import {call,openHub,sha,ROOT,type Hub} from './testing/hub.ts';
import {attachRecompositionFields,runSyntheticRecomposition,type RecompositionResult} from './testing/recompose-hub-helper.ts';
import {CONTRACT_DOC,PROFILE_DOC,MANIFEST_DOC,AUTOID,goodData} from './functions/test-support.ts';
import {checkPlanObject} from './tools/check-plan.ts';
import {lockedTreeOf} from './testing/locked-tree.ts';
import {hubProblems,unique} from './testing/hub-answer.ts';
import {PairKnowledge} from './testing/pair-knowledge.ts';
import {catalogFor,SYNTHETIC_COMMAND_POLICY} from './testing/command-catalog.ts';
import {COMMAND_IDENTITIES} from './functions/test-support.ts';
import {CHAPTER,FLAGS_INTRO,HOST_ROW,MANUAL,PUBLISH,SIGN,manualReference} from './testing/manual-fixture.ts';
import CHECKS from './checks.json' with {type:'json'};

const skip=(await osIsolationAvailable())?false:'no OS network isolation on this machine (sandbox-exec)';
let postgres:TemporaryPostgres,hub:Hub,recomp:RecompositionResult;
const CASES=6;
const document={root:{data:{id:'doc-par',text:'合成文档'},children:Array.from({length:CASES},(_,i)=>({data:{id:'case-'+i,text:'健康检查间隔配置测试'+i,resource:['功能'],priority:2,autoid:String(BigInt(AUTOID)+BigInt(i)),auto:'1'},children:[{data:{id:'step-'+i,text:'widget health interval 60'},children:[{data:{id:'expected-'+i,text:'健康检查间隔设置成功'}}]}]}))}};
const bytes=Buffer.from(JSON.stringify(document));
const nodes=(recognize(createTestParserRegistry(),bytes,'application/json')!.document.model as {nodes:Array<{data:{id?:string};selector:string}>}).nodes;
const leaf=(i:number)=>`src:${sha(bytes.toString())}/kityminder@1/${nodes.find(node=>node.data.id==='expected-'+i)!.selector}`;
const start=()=>({pack:'case-compile',product:'widget',build:'Fixture_Build_A',inputs:{subject:{external:'agile:mindmap:doc-par'},contract:{external:'doc:doc:par-contract'},profile:{external:'doc:doc:par-profile'},inventory:{external:'doc:doc:par-bed'},recomposition_run:{reference:recomp.runRef},recomposition_result:{reference:recomp.resultRef}}});
before(async()=>{
 postgres=await startPostgres();if(skip)return;
 hub=await openHub(postgres);
 const put=(id:string,value:Uint8Array)=>hub.external.put(id,{bytes:value,mediaType:'application/json'});
 put('agile:mindmap:doc-par',bytes);for(const [id,value] of [['par-contract',CONTRACT_DOC],['par-profile',PROFILE_DOC],['par-bed',MANIFEST_DOC]] as const)put('doc:doc:'+id,Buffer.from(JSON.stringify(value)));
 recomp=await runSyntheticRecomposition(hub,{product:'widget',build:'Fixture_Build_A',subject:{external:'agile:mindmap:doc-par'}});
});
after(async()=>{await hub?.close();await postgres?.stop();});

type Claim=Record<string,unknown>;
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

const EXTENDED=new Set(['a claim with a field it does not have']);

async function parity(variants:typeof STRUCTURE){
 const started=await hub.service.startRunDetailed(hub.alice,start() as never,call());assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer.errors));
 const run=started.answer.run!,exported=await hub.service.exportRun!(hub.alice,run.run);assert.ok(exported);
 const frozen=JSON.parse(JSON.stringify(exported.run)) as Record<string,unknown>;
 const view=await hub.knowledge.catalog(ROOT,'commands@1');assert.ok(view);
 const catalog=lockedTreeOf({root:ROOT,complete:view.complete,entries:view.entries()});
 const items=run.items.map((item,index)=>{const slot=claim(index,variants[index][1]);attachRecompositionFields(item,recomp.resultRef,slot.data);return {item:item.id,handling:'handled' as const,slots:{plan:[slot]}};});
 const answer=await hub.service.submitResult(hub.alice,{run:run.run,model:'synthetic-model',items} as never,call());
 return {run,frozen,catalog,items,answer};
}
describe('check-plan against the real Hub',{skip},()=>{
 it('names the same structure problems for the same slot records',{timeout:180_000},async()=>{
  const result=await parity(STRUCTURE);
  for(const [index,[label]] of STRUCTURE.entries()){
   const item=result.run.items[index].id,local=checkPlanObject('plan.json',result.items[index],result.frozen,result.catalog),hubSide=hubProblems(result.answer,item,index);
   const localStructure=local.problems.filter(problem=>problem.code==='SUBMISSION_SCHEMA_VIOLATION').map(({code,pointer,message})=>({code,pointer,message}));
   assert.deepEqual(localStructure.map(row=>[row.code,row.pointer]).sort(),hubSide.structure.map(row=>[row.code,row.pointer]).sort(),label);
   if(index<=4&&!EXTENDED.has(label))assert.deepEqual(unique(localStructure),unique(hubSide.structure),label);
   if(EXTENDED.has(label))for(const row of localStructure)assert.ok(hubSide.structure.some(hub=>hub.code===row.code&&hub.pointer===row.pointer&&row.message.startsWith(hub.message)),`${label}: the Hub's words lead: ${row.message}`);
   assert.equal(local.ok,hubSide.structure.length===0&&local.problems.length===0,label);
   if(hubSide.structure.length)assert.equal(local.ok,false,`${label}: the Hub refuses it, so the local check does not pass it`);
  }
  assert.equal(checkPlanObject('plan.json',result.items[1],result.frozen,result.catalog).ok,false);
 });
 it('names the same problems of the Hub checks for the same plans, and passes the plan the Hub passes',{timeout:180_000},async()=>{
  const result=await parity(CHECKED);
  for(const [index,[label]] of CHECKED.entries()){
   const item=result.run.items[index].id,local=checkPlanObject('plan.json',result.items[index],result.frozen,result.catalog),hubSide=hubProblems(result.answer,item,index);
   assert.deepEqual(hubSide.structure,[],label);
   assert.deepEqual(unique(local.problems),unique(hubSide.checks),label);
   assert.equal(local.ok,hubSide.checks.length===0,label);
  }
  const over=checkPlanObject('plan.json',result.items[1],result.frozen,result.catalog);assert.equal(over.ok,false);assert.ok(over.problems.some(problem=>problem.message==='效果 effect_0 的计划调用 11 次超过声明预算 10 次'));
  assert.equal(checkPlanObject('plan.json',result.items[0],result.frozen,result.catalog).ok,true,'the plan the Hub passes is passed here');
 });
 it('lists every check the Hub runs on a plan and says why the ones it cannot run were not',{timeout:180_000},async()=>{
  const result=await parity(CHECKED),local=checkPlanObject('plan.json',result.items[0],result.frozen,result.catalog);
  assert.deepEqual(local.hub_checks!.map(row=>row.check),CHECKS.checks.map(row=>row.id),'one row per declared check, in declaration order');
  const ran=local.hub_checks!.filter(row=>row.ran).map(row=>row.check),notRun=local.hub_checks!.filter(row=>!row.ran);
  assert.deepEqual(ran,['contract_shape','bed_addresses','commands_catalog','expected_sources','expected_quotes','author_step_coverage']);
  assert.deepEqual(notRun.map(row=>row.check),['scenario_fidelity','workbook_verified','dispatch_policy']);
  for(const row of notRun)assert.ok(row.why&&row.why.length>8,row.check);
  assert.equal(local.hub_checks!.find(row=>row.check==='expected_quotes')!.unread,undefined);
  const reported=new Set(Object.values(result.answer.result?.partitions??{}).flat().filter(row=>row.item===result.run.items[0].id).flatMap(row=>row.requirements.map(requirement=>requirement.requirement)));
  const covered=new Set(local.hub_checks!.flatMap(row=>row.requirements));
  for(const requirement of reported)if(requirement!=='plan')assert.ok(covered.has(requirement),`requirement ${requirement} is served by a listed check`);
 });
});

describe('check-plan against the real Hub: the quotation check',{skip},()=>{
 const ENTRIES=catalogFor(COMMAND_IDENTITIES,ROOT).entries.map(entry=>({words:entry.words as string[],signatures:entry.signatures as unknown[]}));
 const ref=(statement:string)=>manualReference(ROOT,CHAPTER,statement);
 const VARIANTS:Array<[string,{reference:string;text:string}|null]>=[
  ['a quote the cited entry holds',{reference:ref(PUBLISH),text:PUBLISH}],
  ['a sentence cited with the reference of the entry beside it',{reference:ref(HOST_ROW),text:PUBLISH}],
  ['a second sentence cited with the reference of the entry before it',{reference:ref(FLAGS_INTRO),text:SIGN}],
  ['a sentence that stands in no entry',{reference:ref(SIGN),text:SIGN+'（改写）'}],
  ['a reference that is no reference',{reference:ref(PUBLISH).replace('Widget%20Signing','Widget Signing'),text:PUBLISH}],
  ['an entry of another root',{reference:ref(PUBLISH).replace(ROOT,'e'.repeat(64)),text:PUBLISH}],
  ['an entry the tree does not have',{reference:ref(PUBLISH).replace(/@[0-9a-f]{64}$/,'@'+'c'.repeat(64)),text:PUBLISH}],
  ['a quote of white space',{reference:ref(PUBLISH),text:' '}],
  ['no quote at all',null],
 ];
 let quoteHub:Hub,quoteRecomp:RecompositionResult;
 const document={root:{data:{id:'doc-quote',text:'合成文档'},children:VARIANTS.map((_,i)=>({data:{id:'case-'+i,text:'健康检查间隔配置测试'+i,resource:['功能'],priority:2,autoid:String(BigInt(AUTOID)+BigInt(i)),auto:'1'},children:[{data:{id:'step-'+i,text:'widget health interval 60'},children:[{data:{id:'expected-'+i,text:'健康检查间隔设置成功'}}]}]}))}};
 const quoteBytes=Buffer.from(JSON.stringify(document));
 const quoteNodes=(recognize(createTestParserRegistry(),quoteBytes,'application/json')!.document.model as {nodes:Array<{data:{id?:string};selector:string}>}).nodes;
 const quoteLeaf=(i:number)=>`src:${sha(quoteBytes.toString())}/kityminder@1/${quoteNodes.find(node=>node.data.id==='expected-'+i)!.selector}`;
 before(async()=>{
  if(skip)return;
  quoteHub=await openHub(postgres,{knowledge:new PairKnowledge(ENTRIES,SYNTHETIC_COMMAND_POLICY,MANUAL)});
  const put=(id:string,value:Uint8Array)=>quoteHub.external.put(id,{bytes:value,mediaType:'application/json'});
  put('agile:mindmap:doc-quote',quoteBytes);for(const [id,value] of [['quote-contract',CONTRACT_DOC],['quote-profile',PROFILE_DOC],['quote-bed',MANIFEST_DOC]] as const)put('doc:doc:'+id,Buffer.from(JSON.stringify(value)));
  quoteRecomp=await runSyntheticRecomposition(quoteHub,{product:'widget',build:'Fixture_Build_A',subject:{external:'agile:mindmap:doc-quote'}});
 });
 after(async()=>{await quoteHub?.close();});
 const claimOf=(index:number)=>{
  const data=goodData();data.expects[0].quote.reference=quoteLeaf(index);
  const quote=VARIANTS[index][1];if(quote!==null)data.steps[0].precondition_source=quote;
  return {text:'合成计划槽位',quotes:data.expects.map(row=>row.quote),data};
 };
 it('refuses the quotes the Hub refuses, with the Hub\'s words first, and passes the ones it passes',{timeout:240_000},async()=>{
  const started=await quoteHub.service.startRunDetailed(quoteHub.alice,{pack:'case-compile',product:'widget',build:'Fixture_Build_A',inputs:{subject:{external:'agile:mindmap:doc-quote'},contract:{external:'doc:doc:quote-contract'},profile:{external:'doc:doc:quote-profile'},inventory:{external:'doc:doc:quote-bed'},recomposition_run:{reference:quoteRecomp.runRef},recomposition_result:{reference:quoteRecomp.resultRef}}} as never,call());
  assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer.errors));
  const run=started.answer.run!,exported=await quoteHub.service.exportRun!(quoteHub.alice,run.run);assert.ok(exported);
  const frozen=JSON.parse(JSON.stringify(exported.run)) as Record<string,unknown>;
  assert.equal(frozen.root,ROOT);
  const tree=lockedTreeOf({root:ROOT,complete:true,entries:ENTRIES,manual:MANUAL},String(frozen.run));
  const items=run.items.map((item,index)=>{const slot=claimOf(index);attachRecompositionFields(item,quoteRecomp.resultRef,slot.data);return {item:item.id,handling:'handled' as const,slots:{plan:[slot]}};});
  const answer=await quoteHub.service.submitResult(quoteHub.alice,{run:run.run,model:'synthetic-model',items} as never,call());
  let refused=0;
  for(const [index,[label]] of VARIANTS.entries()){
   const item=run.items[index].id,local=checkPlanObject('plan.json',items[index],frozen,tree),hubSide=hubProblems(answer,item,index);
   assert.deepEqual(hubSide.structure,[],label);
   const isQuote=(row:unknown)=>(row as {code?:string}).code==='QUOTE_MISMATCH';
   const hubQuotes=hubSide.checks.filter(isQuote) as Array<{message:string;verdict:string}>,localQuotes=local.problems.filter(isQuote);
   assert.deepEqual(localQuotes.map(row=>row.message.split('；位置：')[0]).sort(),hubQuotes.map(row=>row.message).sort(),`${label}: the same quote refusals`);
   for(const row of localQuotes){assert.equal(row.verdict,'refute',label);assert.ok(row.message.includes('位置：/slots/plan/0/data/steps/0/precondition_source/'),`${label}: ${row.message}`);}
   assert.deepEqual(unique(local.problems.filter(row=>!isQuote(row))),unique(hubSide.checks.filter(row=>!isQuote(row))),`${label}: the other checks`);
   assert.equal(local.ok,hubSide.checks.length===0,`${label}: the verdict of the Hub`);
   refused+=hubQuotes.length>0?1:0;
  }
  assert.equal(refused,VARIANTS.length-2,'every variant but the accepted one and the one without a quote is refused by the Hub');
 });
});
