import assert from 'node:assert/strict';
import {test} from 'node:test';
import {feedingText} from './text.ts';
test('feeding disclosure goes out whole before the trace line, and the answer above it loses no line (decision 158)',()=>{
 const lines=Array.from({length:300},(_,i)=>`合成条目 ${i} `+'甲'.repeat(95));
 const text=[...lines,'原结果可按引用读取','追踪 synthetic'].join('\n');
 const value={feeding_objects:['a'.repeat(64)],feeding_offset:{schema:'feeding-offset@1',offset:40},feeding_pending:[{missing:'缺模型判断',next_action:'补交逐字引文'}]};
 const result=feedingText(text,value);
 assert.equal(result,[...lines,'原结果可按引用读取','喂入未知：缺模型判断；下一步：补交逐字引文','喂入清单：'+JSON.stringify(value.feeding_objects)+'；冻结序号：'+JSON.stringify(value.feeding_offset),'追踪 synthetic'].join('\n'));
 assert.equal(feedingText('短回答\n追踪 synthetic',{}),'短回答\n追踪 synthetic');
});
test('a large feeding list is given whole: the model reads only this text, structuredContent never reaches it',()=>{
 const objects=Array(1000).fill('a'.repeat(64));
 const result=feedingText('回执：已受理\n追踪 synthetic',{feeding_objects:objects,feeding_pending:[]});
 assert.equal(result,'回执：已受理\n喂入清单：'+JSON.stringify(objects)+'\n追踪 synthetic');
 assert.doesNotMatch(result,/structuredContent|部分：/);
});
test('the frozen offset is named only for a run: a content read has none, a run without one says the horizon is unknown',()=>{
 const content=feedingText('内容\n追踪 synthetic',{content:{},feeding_objects:[],feeding_pending:[]});
 assert.match(content,/喂入清单：\[\]\n/);assert.doesNotMatch(content,/冻结|旧运行/);
 const run=feedingText('运行\n追踪 synthetic',{run:{},feeding_objects:[],feeding_pending:[]});
 assert.match(run,/喂入清单：\[\]；这个运行没有冻结喂入序号，喂入边界未知/);assert.doesNotMatch(run,/旧运行/);
});
