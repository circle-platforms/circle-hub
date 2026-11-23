import assert from 'node:assert/strict';
import {after,before,describe,it} from 'node:test';
import {osIsolationAvailable} from '../../../hub/rules/api.ts';
import {startPostgres,type TemporaryPostgres} from '../../../hub/testing/postgres.ts';
import {createTestParserRegistry} from '../../../hub/testing/parsers.ts';
import {recognize} from '../../../hub/refs/api.ts';
import {call,openHub,sha,ROOT,type Hub} from './testing/hub.ts';
import {PairKnowledge} from './testing/pair-knowledge.ts';
import {hubProblems,unique} from './testing/hub-answer.ts';
import {lockedTreeOf} from './testing/locked-tree.ts';
import {fixture,cleanup,catalog,policy} from './testing/inverse-alternatives.ts';
import {runtimeDigest} from './functions/runtime-contract.ts';
import {PROFILE_DOC,MANIFEST_DOC,AUTOID,goodData} from './functions/test-support.ts';
import {checkPlanObject} from './tools/check-plan.ts';

type Doc=Record<string,any>;
type Step=Parameters<typeof fixture>[0][number];
const skip=(await osIsolationAvailable())?false:'no OS network isolation on this machine (sandbox-exec)';
let postgres:TemporaryPostgres,hub:Hub;

const clearAll={words:['clear','demo','all'],signatures:[{id:'1',reference:`src:${'b'.repeat(64)}/xml@1/x/clear/arguments`,params:[]}]};
const ENTRIES=[...catalog.entries.map(entry=>({words:entry.words,signatures:entry.signatures})),clearAll];
const POLICY={...structuredClone(policy),read_only:[...policy.read_only,'/commands/clear']};
const CONTRACT=(()=>{
 const doc=structuredClone(fixture([]).subject.contract) as Doc;
 doc.cleanup={source:'fixture/clear',sha256:'a'.repeat(64),objects:['widget-seat'],rules:[{prefixes:['demo'],clears:['clear demo all']}]};
 doc.effects.effect_0.command_scope.push('/commands/clear');
 doc.contract_sha256=runtimeDigest(doc);
 return doc;
})();

const VARIANTS:Array<[string,Step[],string|null]>=[
 ['a switch turned on and never off',['demo switch on'],'demo switch off'],
 ['the switch turned off in the cleanup',['demo switch on',cleanup('demo switch off')],null],
 ['enable without disable',['demo relay enable'],'demo relay disable'],
 ['the inverse before the runner\'s clear',['demo switch on','demo switch off','clear demo all'],null],
 ['the runner\'s clear before the cleanup',['demo switch on','clear demo all',cleanup('demo switch off')],'先执行同设备的产品声明逆操作'],
 ['an enum argument turned on and never off',['demo feature on'],'demo feature off'],
 ['a removal ahead of the configuration it clears, which the runner clears at the end',['no demo pool add one','demo pool add one 10'],null],
 ['the same removal with the cleanup written as well',['no demo pool add one','demo pool add one 10',cleanup('no demo pool add one')],null],
 ['a delete of something the plan never makes',['no demo pool add one'],'缺唯一的产品逆操作规则'],
];
const document={root:{data:{id:'doc-inv',text:'合成文档'},children:VARIANTS.map((_,i)=>({data:{id:'case-'+i,text:'开关配置测试'+i,resource:['功能'],priority:2,autoid:String(BigInt(AUTOID)+BigInt(i)),auto:'1'},children:[{data:{id:'step-'+i,text:'打开开关并检查'},children:[{data:{id:'expected-'+i,text:'健康检查间隔设置成功'}}]}]}))}};
const bytes=Buffer.from(JSON.stringify(document));
const nodes=(recognize(createTestParserRegistry(),bytes,'application/json')!.document.model as {nodes:Array<{data:{id?:string};selector:string}>}).nodes;
const leaf=(i:number)=>`src:${sha(bytes.toString())}/kityminder@1/${nodes.find(node=>node.data.id==='expected-'+i)!.selector}`;

before(async()=>{
 postgres=await startPostgres();if(skip)return;
 hub=await openHub(postgres,{knowledge:new PairKnowledge(ENTRIES,POLICY)});
 const put=(id:string,value:Uint8Array)=>hub.external.put(id,{bytes:value,mediaType:'application/json'});
 put('agile:mindmap:doc-inv',bytes);for(const [id,value] of [['inv-contract',CONTRACT],['inv-profile',PROFILE_DOC],['inv-bed',MANIFEST_DOC]] as const)put('doc:doc:'+id,Buffer.from(JSON.stringify(value)));
});
after(async()=>{await hub?.close();await postgres?.stop();});

function claim(index:number,steps:Step[]){
 const data=goodData();
 data.steps=steps.map(value=>({object:'widget-seat',method:'configure',args:[typeof value==='string'?value:value.line],keywords:{},...(typeof value==='string'?{}:{cleanup:true as const})}));
 data.expects[0].quote.reference=leaf(index);
 return {text:'合成计划槽位',quotes:data.expects.map(row=>row.quote),data};
}

describe('check-plan against the real Hub: the cleanup a declared pair owes',{skip},()=>{
 it('refuses a plan that turns a switch on and never off, accepts it with the inverse, and says the same here and there',{timeout:180_000},async()=>{
  const started=await hub.service.startRunDetailed(hub.alice,{pack:'case-compile',product:'widget',build:'Fixture_Build_A',inputs:{subject:{external:'agile:mindmap:doc-inv'},contract:{external:'doc:doc:inv-contract'},profile:{external:'doc:doc:inv-profile'},inventory:{external:'doc:doc:inv-bed'}},parameters:{pipeline:'legacy'}} as never,call());
  assert.equal(started.answer.call_result,'ok',JSON.stringify(started.answer.errors));
  const run=started.answer.run!,exported=await hub.service.exportRun!(hub.alice,run.run);assert.ok(exported);
  const frozen=JSON.parse(JSON.stringify(exported.run)) as Record<string,unknown>;
  assert.equal(frozen.root,ROOT);assert.ok(frozen.command_policy,'the frozen run carries the product\'s command policy');
  const tree=lockedTreeOf({root:ROOT,complete:true,entries:ENTRIES},String(frozen.run));
  const items=run.items.map((item,index)=>({item:item.id,handling:'handled' as const,slots:{plan:[claim(index,VARIANTS[index][1])]}}));
  const answer=await hub.service.submitResult(hub.alice,{run:run.run,model:'synthetic-model',items} as never,call());
  assert.ok(hub.knowledge.selectedCatalogReads>0&&hub.knowledge.fullCatalogReads===0,'the engine reads the catalog through the selection of the check');
  for(const [index,[label,,owed]] of VARIANTS.entries()){
   const item=run.items[index].id,local=checkPlanObject('plan.json',items[index],frozen,tree),hubSide=hubProblems(answer,item,index);
   assert.deepEqual(hubSide.structure,[],label);
   assert.deepEqual(unique(local.problems),unique(hubSide.checks),`${label}: check-plan says what the Hub says`);
   assert.equal(local.ok,hubSide.checks.length===0,label);
   if(owed===null)assert.deepEqual(hubSide.checks,[],`${label}: the Hub accepts the plan`);
   else assert.ok(hubSide.checks.some(row=>String((row as {message?:string}).message).includes(owed)),`${label}: the Hub's refusal names ${owed}: ${JSON.stringify(hubSide.checks).slice(0,300)}`);
  }
 });
});
