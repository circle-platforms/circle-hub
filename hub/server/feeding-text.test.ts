import assert from 'node:assert/strict';
import {test} from 'node:test';
import {feedingText} from './text.ts';

test('feeding disclosures keep every answer line and name missing evidence', () => {
  const lines = Array.from({length:300}, (_, index) => `合成原始用例 ${index} ` + '甲'.repeat(95));
  const text = lines.join('\n');
  const value = {feeding_objects:['a'.repeat(64)],feeding_offset:{schema:'feeding-offset@1',offset:40},feeding_pending:[{missing:'缺模型判断',next_action:'模型补交逐字引文'}]};
  assert.equal(feedingText(text,value), text+'\n状态未知；原因缺资料；缺模型判断；下一步模型补交逐字引文');
  assert.equal(feedingText('短回答',{}), '短回答');
});

test('feeding identifiers and offsets stay in the machine-readable answer', () => {
  const objects = Array.from({length:190}, (_, index) => index.toString(16).padStart(64,'0'));
  const value = {feeding_objects:objects,feeding_offset:{schema:'feeding-offset@1',run:'run_synthetic',root:null,offset:7},feeding_pending:[]};
  const result = feedingText('脚本合并已核对。',value);
  assert.equal(result,'脚本合并已核对。');
  for (const object of objects) assert.ok(!result.includes(object));
});

test('the same missing evidence is said once however many sources repeat it', () => {
  const pending = [{source:'a'.repeat(64),missing:'缺手册',next_action:'使用者补手册'},{source:'b'.repeat(64),missing:'缺手册',next_action:'使用者补手册'},{source:'c'.repeat(64),missing:'缺模型判断',next_action:'模型补交逐字引文'}];
  assert.equal(feedingText('内容',{feeding_objects:[],feeding_pending:pending}),'内容\n状态未知；原因缺资料；缺手册；下一步使用者补手册\n状态未知；原因缺资料；缺模型判断；下一步模型补交逐字引文');
});

test('ordinary reads and older results do not display feeding bookkeeping', () => {
  assert.equal(feedingText('内容',{content:{},feeding_objects:['a'.repeat(64)],feeding_pending:[]}), '内容');
  assert.equal(feedingText('内容',{content:{},feeding_objects:[],feeding_pending:[]}), '内容');
  assert.equal(feedingText('核对结果',{run:{},feeding_objects:[],feeding_pending:[]}), '核对结果');
});
