import assert from 'node:assert/strict';
import {test} from 'node:test';
import {modelReferencesText} from './text.ts';

test('feeding details and complete text remain in the model reference block', () => {
  const lines = Array.from({length:300}, (_, index) => `合成原始用例 ${index} ` + '甲'.repeat(95));
  const text = lines.join('\n');
  const value = {content:{text},feeding_objects:['a'.repeat(64)],feeding_offset:{schema:'feeding-offset@1',offset:40},feeding_pending:[{missing:'缺模型判断',next_action:'模型补交逐字引文'}]};
  const result = modelReferencesText(value);
  assert.equal(result.split('\n')[0], '供模型引用');
  assert.deepEqual(JSON.parse(result.slice('供模型引用\n'.length)), value);
  assert.deepEqual(JSON.parse(modelReferencesText({}).slice('供模型引用\n'.length)), {});
});

test('all feeding identifiers and the offset remain in the model reference block', () => {
  const objects = Array.from({length:190}, (_, index) => index.toString(16).padStart(64,'0'));
  const value = {feeding_objects:objects,feeding_offset:{schema:'feeding-offset@1',run:'run_synthetic',root:null,offset:7},feeding_pending:[]};
  assert.deepEqual(JSON.parse(modelReferencesText(value).slice('供模型引用\n'.length)), value);
});

test('repeated pending facts retain their separate sources in the model reference block', () => {
  const pending = [{source:'a'.repeat(64),missing:'缺手册',next_action:'使用者补手册'},{source:'b'.repeat(64),missing:'缺手册',next_action:'使用者补手册'},{source:'c'.repeat(64),missing:'缺模型判断',next_action:'模型补交逐字引文'}];
  const value = {feeding_objects:[],feeding_pending:pending};
  assert.deepEqual(JSON.parse(modelReferencesText(value).slice('供模型引用\n'.length)), value);
});

test('ordinary reads and older results retain their exact feeding fields in the model reference block', () => {
  for (const value of [{content:{},feeding_objects:['a'.repeat(64)],feeding_pending:[]},{content:{},feeding_objects:[],feeding_pending:[]},{run:{},feeding_objects:[],feeding_pending:[]}]) {
    assert.deepEqual(JSON.parse(modelReferencesText(value).slice('供模型引用\n'.length)), value);
  }
});
