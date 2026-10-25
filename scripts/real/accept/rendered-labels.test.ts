// Synthetic current renderer output; no real client, records, models or devices.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {labelOf} from '../../../contracts/generated/vocabulary.ts';
import traceability,{type TraceGold} from './traceability.ts';
import scope,{type ScopeGold} from './regression-scope.ts';
import sweep from './maintenance-sweep.ts';
import type {LoggedTurn} from '../lib/accept.ts';

const turns=(text:string):LoggedTurn[]=>[{index:1,tools:[],toolResults:[{id:'synthetic-reply',isError:false,text}]}];
const traceGold:TraceGold={product:'synthetic-product',build:'Synthetic_10_7_1',defects:[{bug:'7300',status:'fixed',closed:true,cases:[{id:'9001:c1',title:'合成用例'}]}]};
const traceText=(row:string)=>['运行 run_synthetic 完成',row,'陈述：缺陷 7300（发布说明：已修复；缺陷系统：closed）：1 个已索引用例追溯：9001:c1 合成用例','已关闭缺陷 1 个：已追溯 1 个，未追溯 0 个'].join('\n');
const traceCheck=(row:string)=>traceability(traceGold).check(turns(traceText(row))).find(c=>c.name.includes('列出的用例'))!;

test('trace row accepts current titled label and reads count from summary rather than title',()=>{
 const row='- 7300 | 缺陷 7300：标题含 99 个用例 | 和分隔符 | 已修复；1 个用例 | 位置 src:'+'a'.repeat(64);
 assert.equal(traceCheck(row).ok,true);
});
for(const [index,row] of [
 '- 73001 | 缺陷 73001：合成标题 | 已修复；1 个用例',
 '- 7300 | 缺陷 7400：错位标题 | 已修复；1 个用例',
 '- 7400 | 缺陷 7300：错位编号 | 已修复；1 个用例',
 '- 7300 | 缺陷 7300：标题说 1 个用例 | 已修复；2 个用例',
 '- 7300 | 缺陷 7300：标题说 1 个用例 | 已修复',
].entries())test('trace row rejects wrong identity or missing/mismatched summary #'+index,()=>assert.equal(traceCheck(row).ok,false));
test('titled untraced row remains unknown; title does not stand in for an unknown summary',()=>{
 const gold:TraceGold={product:'synthetic',build:'Synthetic_10_7',defects:[{bug:'7402',status:'known',cases:[]}]};
 const check=(row:string)=>traceability(gold).check(turns('运行 run_synthetic\n'+row)).find(c=>c.name.includes('没有用例'))!;
 // 标题里的未知不能代替摘要。摘要写明未知时，核对仍是未完成，不能当成确定的缺席通过。
 const unknownRow=check('- 7402 | 缺陷 7402：合成标题 | 已知（未修复）；无已索引用例（未知）');
 assert.equal(unknownRow.ok,false);
 assert.match(unknownRow.actual,/追溯仍未知/);
 assert.equal(check('- 7402 | 缺陷 7402：无已索引用例（未知） | 已知（未修复）；1 个用例').ok,false);
});

const path='/commands/demo.show';
const gold:ScopeGold={product:'synthetic',earlier:'Synthetic_10_7_0',later:'Synthetic_10_7_1',caseCommandsUnplaced:0,changed:[path],removed:[],kinds:[{path,kind:'added'}],inScope:[],outOfScope:[]};
const kindCheck=(text:string)=>scope(gold).check(turns('运行 run_synthetic\n'+text)).find(c=>c.name.includes('变更种类'))!;
for(const form of [path+' '+labelOf('change_kind','added')+' 0 条',path+'（'+labelOf('change_kind','added')+'）'])test('change kind accepts current vocabulary label '+form.slice(-4),()=>assert.equal(kindCheck(form).ok,true));
for(const [i,text]of [path+' added',path+' '+labelOf('change_kind','modified'),path+' '+labelOf('change_kind','modified')+' 0 条 - /commands/other '+labelOf('change_kind','added')+' 0 条','/commands/demoXshow '+labelOf('change_kind','added'),path+'suffix '+labelOf('change_kind','added'),path+' 新增项'].entries())test('change kind rejects wrong label/path or neighboring evidence #'+i,()=>assert.equal(kindCheck(text).ok,false));
test('all provided kind checks including removed remain present',()=>{
 const checks=scope({...gold,kinds:[{path,kind:'added'},{path:'/commands/changed',kind:'modified'},{path:'/commands/deleted',kind:'removed'}]}).check(turns('运行 run_synthetic'));
 assert.equal(checks.filter(c=>c.name.includes('变更种类')).length,3);
 assert.ok(checks.filter(c=>c.name.includes('变更种类')).every(c=>!c.ok));
});
test('maintenance removal still requires an affirmative generated label and its path',()=>{
 const s=sweep({product:'synthetic',earlier:'Synthetic_10_7_0',later:'Synthetic_10_7_1',caseCommandsUnplaced:0,cases:[{id:'9001:c1',path,removed:true}]});
 const check=(word:string)=>s.check(turns('运行 run_synthetic\n9001:c1：命令'+word+'（'+path+'）')).find(c=>c.name.includes('原因')||c.name.includes('路径上'))!;
 assert.equal(check('已'+labelOf('change_kind','removed')).ok,true);
 assert.equal(check('未'+labelOf('change_kind','removed')).ok,false);
 assert.equal(check('已'+labelOf('change_kind','modified')).ok,false);
});
