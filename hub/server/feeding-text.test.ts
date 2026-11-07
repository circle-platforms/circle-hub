import assert from 'node:assert/strict';
import {test} from 'node:test';
import {feedingText} from './text.ts';
test('feeding disclosure goes out before the trace line, and the answer above it loses no line (decision 158)',()=>{
 const lines=Array.from({length:300},(_,i)=>`合成条目 ${i} `+'甲'.repeat(95));
 const text=[...lines,'原结果可按引用读取','追踪 synthetic'].join('\n');
 const value={feeding_objects:['a'.repeat(64)],feeding_offset:{schema:'feeding-offset@1',offset:40},feeding_pending:[{missing:'缺模型判断',next_action:'补交逐字引文'}]};
 const result=feedingText(text,value);
 assert.equal(result,[...lines,'原结果可按引用读取','喂入未知：缺模型判断；下一步：补交逐字引文','本运行累计喂入 1 个对象；冻结序号：'+JSON.stringify(value.feeding_offset),'追踪 synthetic'].join('\n'));
 assert.equal(feedingText('短回答\n追踪 synthetic',{}),'短回答\n追踪 synthetic');
});
test('a run\'s feeding list is counted, not repeated: its digests stay in structuredContent and the usage records',()=>{
 const objects=Array.from({length:190},(_,i)=>i.toString(16).padStart(64,'0'));
 const offset={schema:'feeding-offset@1',run:'run_synthetic',root:null,offset:7};
 const result=feedingText('回执：已受理\n追踪 synthetic',{feeding_objects:objects,feeding_offset:offset,feeding_pending:[]});
 assert.equal(result,'回执：已受理\n本运行累计喂入 190 个对象；冻结序号：'+JSON.stringify(offset)+'\n追踪 synthetic');
 for(const object of objects)assert.ok(!result.includes(object));
});
test('the same feeding unknown is said once however many sources repeat it',()=>{
 const pending=[{source:'a'.repeat(64),missing:'投影进行中',next_action:'不用等它'},{source:'b'.repeat(64),missing:'投影进行中',next_action:'不用等它'},{source:'c'.repeat(64),missing:'缺模型判断',next_action:'补交逐字引文'}];
 const result=feedingText('内容\n追踪 synthetic',{feeding_objects:[],feeding_pending:pending});
 assert.equal(result,'内容\n喂入未知：投影进行中；下一步：不用等它\n喂入未知：缺模型判断；下一步：补交逐字引文\n追踪 synthetic');
});
test('the frozen offset is named only for a run: a content read has none, a run without one says the horizon is unknown',()=>{
 const content=feedingText('内容\n追踪 synthetic',{content:{},feeding_objects:['a'.repeat(64)],feeding_pending:[]});
 assert.equal(content,'内容\n这次读取喂入 1 个对象\n追踪 synthetic');
 assert.equal(feedingText('内容\n追踪 synthetic',{content:{},feeding_objects:[],feeding_pending:[]}),'内容\n追踪 synthetic','a content read that fed nothing says nothing');
 const run=feedingText('运行\n追踪 synthetic',{run:{},feeding_objects:[],feeding_pending:[]});
 assert.match(run,/本运行累计喂入 0 个对象；这个运行没有冻结喂入序号，喂入边界未知/);assert.doesNotMatch(run,/旧运行/);
});
