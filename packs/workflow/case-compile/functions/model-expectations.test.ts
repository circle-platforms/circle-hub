import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkExpectedSources} from './checks.ts';
import {goodData,subjectOf,QUOTE} from './test-support.ts';
import {readSlots} from './slots.ts';
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
