import assert from 'node:assert/strict';
import {test} from 'node:test';
import {authorStepCoverage,fidelityBrief,uncoveredAuthorStepText,unknownAuthorStepRefs} from './fidelity.ts';

const RECORD={
 schema:'recompose-record@1',
 contract:{intent:{text:'253 域名 widget 同步'}},
 atoms:[
  {id:'a1',kind:'intent',text:'253 域名 widget 同步'},
  {id:'a2',kind:'action',text:'HA 已配置'},
  {id:'a3',kind:'action',text:'主设备配置 253 域名'},
  {id:'a4',kind:'action',text:'widget sync to'},
  {id:'a5',kind:'action',text:'对端 show 查看'},
  {id:'a6',kind:'expectation',text:'对端同步完整'},
 ],
 ledgers:{
  original:[],
  adapted:[{atom:'a4',text:'在主设备上执行 widget sync to peer2，把运行配置同步到对端',commands:['widget challenge "x"','widget peer peer2 192.0.2.2','widget sync to peer2','widget sync to peer3'],equivalence_reason:'补上必填的 peer name'}],
  concretizations:[],rebindings:[],
 },
};
const step=(line:string,refs?:string[])=>({object:'DUT_0',method:'cmd_config',args:[line],keywords:{},...(refs!==undefined?{author_step_refs:refs}:{})});
const flat=(refs:Array<string[]|undefined>)=>({blocks:[],steps:refs.map((ids,index)=>step('cmd '+index,ids)),expects:[]});
const block=(id:string,refs?:string[])=>({id,kind:'CONFIG',call:{object:'DUT_0',method:'cmd_config',args:['cmd '+id],keywords:{}},...(refs!==undefined?{author_step_refs:refs}:{})});
const has=(text:string,...parts:string[])=>{for(const part of parts)assert.ok(text.includes(part),`missing ${JSON.stringify(part)} in: ${text}`);};
const coverageOf=(plan:unknown,record:unknown=RECORD)=>{const brief=fidelityBrief('doc:1',record,plan)!;return {brief,coverage:authorStepCoverage(brief,plan)};};

test('the author steps are the action atoms of the record, and the ones no step names are left, in the record\'s order',()=>{
 const plan=flat([['a3'],undefined,['a5']]);const {brief,coverage}=coverageOf(plan);
 assert.deepEqual(brief.author_steps.map(row=>row.n),['a2','a3','a4','a5']);
 assert.deepEqual(coverage.uncovered.map(row=>row.n),['a2','a4']);
 assert.deepEqual(coverage.carriers,[{index:1,refs:['a3']},{index:3,refs:['a5']}]);
 assert.deepEqual([coverage.noun,coverage.unit,coverage.list,coverage.total],['步骤','步','/steps',3]);
});

test('every action named by some step leaves nothing, whichever steps carry them and however many ids a step carries',()=>{
 assert.deepEqual(coverageOf(flat([['a2','a3'],['a4'],['a5','a2']])).coverage.uncovered,[]);
 assert.deepEqual(coverageOf(flat([['a2','a3','a4','a5']])).coverage.uncovered,[]);
});

test('a value that is no author step id covers nothing, but it is still listed among what the plan wrote',()=>{
 const plan=flat([['2','a3'],['a1'],['a6','a_4']]);const {coverage}=coverageOf(plan);
 assert.deepEqual(coverage.uncovered.map(row=>row.n),['a2','a4','a5']);
 assert.deepEqual(coverage.carriers.map(row=>row.refs),[['2','a3'],['a1'],['a6','a_4']]);
 const text=uncoveredAuthorStepText(coverageOf(plan).brief,coverage,coverage.uncovered[0]!);
 has(text,'"2"：第 1 步','"a1"：第 2 步','"a6"：第 3 步','"a_4"：第 3 步');
 assert.deepEqual(unknownAuthorStepRefs(coverageOf(plan).brief,plan).map(row=>row.value),['2','a1','a6','a_4']);
});

test('a block plan is counted in blocks, a block is named by its id, and a block without refs is listed as one that wrote none',()=>{
 const plan={blocks:[block('prepare',['a3']),block('observe'),block('send',['a4','a5'])],steps:[],expects:[]};
 const {brief,coverage}=coverageOf(plan);
 assert.deepEqual([coverage.noun,coverage.unit,coverage.list,coverage.total],['块','块','/blocks',3]);
 assert.deepEqual(coverage.uncovered.map(row=>row.n),['a2']);
 const text=uncoveredAuthorStepText(brief,coverage,coverage.uncovered[0]!);
 has(text,'没有任何计划块声明实现它','没有一块的 author_step_refs','/slots/plan/0/data/blocks/<序号>/author_step_refs','计划共 3 块','"a3"：第 1 块（prepare）','"a4"：第 3 块（send）','"a5"：第 3 块（send）','没写的是第 2 块（observe）','在实现它的块的 author_step_refs 里加上 "a2"');
});

test('a plan that names nothing says so, and the text carries the author\'s words, the closed set of ids, where they are disclosed and the next steps',()=>{
 const {brief,coverage}=coverageOf(flat([undefined,undefined]));
 const text=uncoveredAuthorStepText(brief,coverage,coverage.uncovered[0]!);
 has(text,
  '作者步骤 a2（"HA 已配置"）没有任何计划步骤声明实现它','没有一步的 author_step_refs 写了 "a2"',
  '位置：/slots/plan/0/data/steps/<序号>/author_step_refs','看到：计划共 2 步，没有一步写了 author_step_refs',
  '允许：a2、a3、a4、a5','items/<序号>.json（里面的 id 是 doc:1）的 /fields/recomposition/record/atoms 里 kind 为 action 的 id',
  '下一步：在实现它的步骤的 author_step_refs 里加上 "a2"','补上实现它的步骤并在那一步写上 "a2"','不要删这条作者步骤','在最终回复里向主代理报告缺什么、为什么实现不了');
 assert.ok(!text.includes('重组记录把这一步改写成'),'an action the record did not adapt has no adaptation clause: '+text);
});

test('an adapted action shows the author\'s words and the adaptation with its first three commands',()=>{
 const {brief,coverage}=coverageOf(flat([['a2'],['a3'],['a5']]));
 assert.deepEqual(coverage.uncovered.map(row=>row.n),['a4']);
 const text=uncoveredAuthorStepText(brief,coverage,coverage.uncovered[0]!);
 has(text,'作者步骤 a4（"widget sync to"）','重组记录把这一步改写成 "在主设备上执行 widget sync to peer2，把运行配置同步到对端"','命令 "widget challenge \\"x\\""','"widget sync to peer2"');
 assert.ok(!text.includes('widget sync to peer3'),'only the first three commands are shown, the rest counted: '+text);
 has(text,'共 4 个');
});

test('many carriers are listed up to the limit and counted, never dropped silently',()=>{
 const refs:Array<string[]|undefined>=Array.from({length:30},()=>['a3']);
 const {brief,coverage}=coverageOf(flat(refs));
 const text=uncoveredAuthorStepText(brief,coverage,coverage.uncovered[0]!);
 has(text,'计划共 30 步','共 30 个');
 assert.ok(!text.includes('、30 步'),'the list stops at the limit: '+text);
});

test('a record without authored actions has no brief and so nothing to cover',()=>{
 const none={...RECORD,atoms:RECORD.atoms.filter(row=>row.kind!=='action')};
 assert.equal(fidelityBrief('doc:1',none,flat([undefined])),null);
});
