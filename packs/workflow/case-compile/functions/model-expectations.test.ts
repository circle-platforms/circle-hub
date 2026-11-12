import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkExpectedSources} from './checks.ts';
import {goodData,subjectOf,QUOTE} from './test-support.ts';
import {readSlots} from './slots.ts';
import {fixture as blockFixture,call,BLOCK_ROOT,EXPECTED_REF} from '../testing/blocks.ts';
import type {PlanSlots} from './slots.ts';
const description='[check1]合成配置添加成功';
function fixture(){const data=goodData();data.expects[0]={text:'service enabled',quote:{reference:QUOTE.reference,text:description},after:1,basis:'model_judgment',rationale:'模型选择合成设备明确输出的状态文字作为观察检查；这是判断，不声称语义已由 Hub 证明'};const {subject}=subjectOf(data);subject.expected_nodes=[{reference:QUOTE.reference,text:description}];return {data,subject};}
test('descriptive case expectation may ground an explicit model-selected observable literal',()=>{
 const {subject}=fixture();const out=checkExpectedSources({subject});assert.equal(out[0].verdict,'support',JSON.stringify(out));assert.match(out[0].statement,/以判断为前提/);assert.deepEqual(out[0].judgment_sources,['/plan/0/data/expects/0']);assert.ok((out[0].data!.model_expectations as any[])[0].rationale);
});
test('omitting basis retains the exact quotation-fragment rule',()=>{
 const {data,subject}=fixture();delete data.expects[0].basis;delete data.expects[0].rationale;assert.ok(checkExpectedSources({subject}).some(row=>row.verdict==='refute'&&row.code==='case-compile.expect_not_in_quote'));
});
for(const change of ['reference','text','record','missing-node'] as const)test('model basis cannot invent or move the original expected node: '+change,()=>{
 const {data,subject}=fixture();if(change==='reference')data.expects[0].quote.reference=QUOTE.reference+'/other_case';if(change==='text')data.expects[0].quote.text='标题或其他步骤的原文';if(change==='record')data.expects[0].quote.reference='rec:'+'a'.repeat(64);if(change==='missing-node')subject.expected_nodes=undefined;
 assert.ok(checkExpectedSources({subject}).some(row=>row.verdict===(change==='missing-node'?'unknown':'refute')));
});
for(const value of ['service\nenabled','=service','service {0}',' enabled '])test('model basis preserves assertion value rules: '+JSON.stringify(value),()=>{const {data,subject}=fixture();data.expects[0].text=value;assert.ok(checkExpectedSources({subject}).some(row=>row.verdict==='refute'));});
test('model basis requires explicit exact enum and rationale and after still names a command or host step',()=>{
 for(const patch of [{basis:'MODEL_JUDGMENT'},{rationale:''},{rationale:undefined}]){const {data}=fixture();Object.assign(data.expects[0],patch);assert.equal(readSlots(data).ok,false);}
 const {data,subject}=fixture();data.expects[0].after=3;assert.ok(checkExpectedSources({subject}).some(row=>row.code==='case-compile.expect_after'));
});
test('only explicitly cited expected nodes enter model checks; defaults do not expand original source references',async()=>{
 const {selectedExpectedNodes}=await import('./expected-nodes.ts');const {data}=fixture();const nodes=Array.from({length:10000},(_,index)=>({reference:QUOTE.reference+'/'+index,text:'合成原始期望 '+index}));nodes.push({reference:QUOTE.reference,text:description});
 assert.deepEqual(selectedExpectedNodes(nodes,data),[{reference:QUOTE.reference,text:description}]);delete data.expects[0].basis;delete data.expects[0].rationale;assert.equal(selectedExpectedNodes(nodes,data),undefined);
});

function absenceFixture(literal='record+a.[x]'){
 const f=blockFixture(),quote={reference:EXPECTED_REF,text:'删除后查询不再包含本条记录'};
 const parameter={name:'name',type:'string',native_type:{name:'synthetic-name',declaration:'src:'+BLOCK_ROOT+'/json@1/p/types/name',grammar:'synthetic-tree@1'}};
 const native=(path:string,params:unknown[])=>({words:path.split('/').slice(2),reference:'tree:'+BLOCK_ROOT+path,signatures:[{id:path,reference:'src:'+BLOCK_ROOT+'/xml@1/x'+path+'/arguments',params}]});
 const catalog={...f.catalog,policy:{schema:'command-policy@1',read_only:['/commands/demo/show'],inverse_rules:[{source_prefix:'/commands/demo/set',inverse_prefix:'/commands/no/demo/set',leading_parameters:1}]},entries:[native('/commands/demo/show',[]),native('/commands/demo/set',[parameter]),native('/commands/no/demo/set',[parameter])]};
 const data:PlanSlots={bucket:'bed-a',blocks:[],replacements:[],steps:[call(`demo set "${literal}"`),call(`no demo set "${literal}"`),call()],expects:[{op:'not_found',text:literal,quote:{...quote},after:3}]};
 const input=f.subject(data,{expected_nodes:[quote],command_catalog:catalog});
 return {f,data,quote,catalog,input,native};
}
test('flat absence reads an explicit operator without changing the default expectation shape',()=>{
 const {data}=absenceFixture(),parsed=readSlots(data);assert.ok(parsed.ok);if(parsed.ok)assert.equal(parsed.slots.expects[0].op,'not_found');
 assert.equal(readSlots({...data,expects:[{...data.expects[0],op:'NOT_FOUND'}]}).ok,false);
 assert.equal(readSlots(goodData()).ok,true);
});
test('flat absence uses a complete configured name and its declared inverse before observation',()=>{
 const {data,input}=absenceFixture(),result=checkExpectedSources(input);assert.ok(result.every(row=>row.verdict==='support'),JSON.stringify(result));
 assert.deepEqual(result[0].data?.configured_expectations,[{expect:1,configured_step:1,inverse_step:2,object:'ORBIT_0'}]);
 data.expects[0].basis='model_judgment';data.expects[0].rationale='The literal is a configured name, not this explanation';
 const conditional=checkExpectedSources(input);assert.ok(conditional.every(row=>row.verdict==='support'),JSON.stringify(conditional));assert.deepEqual(conditional[0].data?.configured_expectations,result[0].data?.configured_expectations);
});
for(const change of ['substring','case-fold','not-a-parameter','wrong-inverse','query-before-inverse','recreated'] as const)test('flat absence cannot borrow a configured name from '+change,()=>{
 const {data,input}=absenceFixture();
 if(change==='substring')data.expects[0].text='record+a';
 if(change==='case-fold')data.expects[0].text='RECORD+a.[x]';
 if(change==='not-a-parameter')data.expects[0].text='demo set';
 if(change==='wrong-inverse')data.steps[1]=call('no demo set another-record');
 if(change==='query-before-inverse'){[data.steps[1],data.steps[2]]=[data.steps[2],data.steps[1]];data.expects[0].after=2;}
 if(change==='recreated'){data.steps=[data.steps[0],data.steps[1],data.steps[0],call(),data.steps[1]];data.expects[0].after=4;}
 assert.ok(checkExpectedSources(input).some(row=>row.verdict==='refute'),JSON.stringify(checkExpectedSources(input)));
});
test('flat absence follows actual execution order across the cleanup suffix',()=>{
 const {data,input}=absenceFixture();data.steps[1].cleanup=true;data.steps[2].cleanup=true;
 const result=checkExpectedSources(input);assert.ok(result.every(row=>row.verdict==='support'),JSON.stringify(result));
});
test('configured absence values use declared text or name parameters, not numbers or enums',()=>{
 for(const type of ['int','enum']){
  const literal=type==='int'?'42':'record-a',f=absenceFixture(literal);
  for(const entry of f.catalog.entries)for(const signature of entry.signatures)for(const raw of signature.params){
   const parameter=raw as Record<string,unknown>;parameter.type=type;
   if(type==='int'){parameter.minimum=1;parameter.maximum=100;}else parameter.values=['record-a','record-b'];
  }
  f.data.steps[0]=call(`demo set ${literal}`);f.data.steps[1]=call(`no demo set ${literal}`);
  const result=checkExpectedSources(f.input);assert.ok(result.some(row=>row.verdict==='refute'),JSON.stringify(result));
 }
});
test('flat absence leaves a bidirectional configuration source unknown instead of guessing its direction',()=>{
 const {input,catalog}=absenceFixture();catalog.policy.inverse_rules.push({source_prefix:'/commands/no/demo/set',inverse_prefix:'/commands/demo/set',leading_parameters:1});
 const result=checkExpectedSources(input);assert.ok(result.some(row=>row.verdict==='unknown'),JSON.stringify(result));assert.ok(!result.some(row=>row.verdict==='support'));
});
test('flat absence uses a later directed source when an earlier same-value source is ambiguous',()=>{
 const {data,input,catalog,native}=absenceFixture(),literal=data.expects[0].text,parameter=catalog.entries[1].signatures[0].params;
 catalog.entries.push(native('/commands/demo/old',parameter),native('/commands/no/demo/old',parameter));
 catalog.policy.inverse_rules.push({source_prefix:'/commands/demo/old',inverse_prefix:'/commands/no/demo/old',leading_parameters:1},{source_prefix:'/commands/no/demo/old',inverse_prefix:'/commands/demo/old',leading_parameters:1});
 data.steps=[call(`demo old "${literal}"`),call(`no demo old "${literal}"`),...data.steps];data.expects[0].after=5;
 const result=checkExpectedSources(input);assert.ok(result.every(row=>row.verdict==='support'),JSON.stringify(result));
 assert.deepEqual(result[0].data?.configured_expectations,[{expect:1,configured_step:3,inverse_step:4,object:'ORBIT_0'}]);
});
test('flat absence does not use model rationale or a criterion record as a new source',()=>{
 const {data,input}=absenceFixture();data.expects[0]={...data.expects[0],text:'invented descriptive output',basis:'model_judgment',rationale:'the model chose this sentence'};
 assert.ok(checkExpectedSources(input).some(row=>row.verdict==='refute'));
 data.expects[0].quote.reference='rec:'+'a'.repeat(64);assert.ok(checkExpectedSources(input).some(row=>row.verdict==='refute'));
});
test('flat absence retains original-fragment checks without requiring configuration provenance',()=>{
 const f=blockFixture(),quote={reference:EXPECTED_REF,text:'ABSENT 不应出现'};
 const data:PlanSlots={bucket:'bed-a',blocks:[],replacements:[],steps:[{object:'client',method:'shell',args:['echo SYNTHETIC_READY'],keywords:{}}],expects:[{op:'not_found',text:'ABSENT',quote,after:1}]};
 const input=f.subject(data,{expected_nodes:[quote],command_catalog:undefined});
 const result=checkExpectedSources(input);assert.ok(result.every(row=>row.verdict==='support'),JSON.stringify(result));
});
test('flat absence stays bound to the original expected node and its explicit operator',()=>{
 for(const change of ['other-node','different-quote','missing-node','opposite-declaration'] as const){
  const {data,input,quote}=absenceFixture();
  if(change==='other-node')data.expects[0].quote.reference+='/other';
  if(change==='different-quote')data.expects[0].quote.text='another original expectation';
  if(change==='missing-node')input.subject.expected_nodes=undefined as never;
  if(change==='opposite-declaration')input.subject.expected_nodes=[{...quote,declaration:{op:'found',literal:data.expects[0].text}}] as never;
  assert.ok(checkExpectedSources(input).some(row=>row.verdict===(change==='missing-node'?'unknown':'refute')),change);
 }
});
test('flat absence selects the frozen expected node even without model judgment',async()=>{
 const {selectedExpectedNodes}=await import('./expected-nodes.ts');const {data,quote}=absenceFixture();
 assert.deepEqual(selectedExpectedNodes([quote,{reference:EXPECTED_REF+'/other',text:'other'}],data),[quote]);
});
