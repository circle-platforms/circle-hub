import assert from 'node:assert/strict';
import {test} from 'node:test';
import {feedingText} from './text.ts';
import {TEXT_BUDGET} from './budget.ts';
test('feeding disclosure cannot overflow a full answer and retains recovery and trace',()=>{
 const text=Array.from({length:300},(_,i)=>`合成条目 ${i} `+'甲'.repeat(95)).join('\n')+'\n原结果可按引用逐页读取\n追踪 synthetic';
 const value={feeding_objects:['a'.repeat(64)],feeding_offset:{schema:'feeding-offset@1',offset:40},feeding_pending:[{missing:'缺模型判断',next_action:'补交逐字引文'}]};
 const result=feedingText(text,value);assert.ok(result.length<=TEXT_BUDGET);assert.match(result,/喂入未知：缺模型判断/);assert.match(result,/喂入清单/);assert.match(result,/略去了回答原文/);assert.match(result,/读其余部分/);assert.ok(result.endsWith('追踪 synthetic'));assert.equal(feedingText('短回答\n追踪 synthetic',{}),'短回答\n追踪 synthetic');
});
test('oversized feeding metadata is disclosed as omitted without dropping the primary receipt',()=>{
 const result=feedingText('回执：已受理\n追踪 synthetic',{feeding_objects:Array(1000).fill('a'.repeat(64)),feeding_pending:[]});
 assert.ok(result.length<=TEXT_BUDGET);assert.match(result,/回执：已受理/);assert.match(result,/喂入说明/);assert.match(result,/structuredContent/);assert.ok(result.endsWith('追踪 synthetic'));
});
test('the frozen offset is named only for a run: a content read has none, a run without one says the horizon is unknown',()=>{
 const content=feedingText('内容\n追踪 synthetic',{content:{},feeding_objects:[],feeding_pending:[]});
 assert.match(content,/喂入清单：\[\]\n/);assert.doesNotMatch(content,/冻结|旧运行/);
 const run=feedingText('运行\n追踪 synthetic',{run:{},feeding_objects:[],feeding_pending:[]});
 assert.match(run,/喂入清单：\[\]；这个运行没有冻结喂入序号，喂入边界未知/);assert.doesNotMatch(run,/旧运行/);
});
