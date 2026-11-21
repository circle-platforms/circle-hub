import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractScopeUserRulings } from './scope.ts';
import { buildCompileBrief, withScopeUserRulings, validateCompileBrief } from './authoring-brief.ts';

test('scope rulings bind exact declared headings and preserve the recorded wording', () => {
  const text = '# 范围\n## 全局\n使用者决定：全局原话  \n## 用例 case-a\n- 使用者决定：本条原话\n## 用例 case-b\n使用者决定：另一条原话\n';
  assert.deepEqual(extractScopeUserRulings(text, new Set(['case-a']), 'case-a'), [
    { target: 'case-a', ruling: '使用者决定：全局原话  ' },
    { target: 'case-a', ruling: '使用者决定：本条原话' },
  ]);
});
test('scope decisions refresh cached brief derivations without mutating sealed files or keeping withdrawn decisions', () => {
  const brief = buildCompileBrief({item:{id:'item-synthetic',fields:{autoid:'case-a',title:'合成裁定',recomposition:{receipt:`rec:${'b'.repeat(64)}`,record:{case:{id:'case-a'},atoms:[],sources:{states:[]},expectation_slots:[]}}}}, index:'0', knowledge:{root:'a'.repeat(64),nodes:new Map(),lines:new Map(),parameters:new Map()},policy:null,createdAt:'2026-01-01T00:00:00.000Z'})!;
  const original = JSON.stringify(brief);
  const current = withScopeUserRulings(brief,[{target:'case-a',ruling:'使用者决定：按原话重写'}],'cards/current.md');
  assert.deepEqual(current.task.user_rulings,[{source:'cards/current.md',target:'case-a',ruling:'使用者决定：按原话重写',from_scope:true}]);
  assert.notEqual(current.brief_sha256,brief.brief_sha256);
  assert.equal(validateCompileBrief(current).ok,true);
  assert.equal(JSON.stringify(brief),original);
  assert.deepEqual(withScopeUserRulings(current,[],'cards/current.md').task.user_rulings,[]);
  const legacy=structuredClone(current);
  legacy.task.user_rulings=[{source:'scope.md',target:'case-a',ruling:'使用者决定：旧记录'}];
  assert.deepEqual(withScopeUserRulings(legacy,[]).task.user_rulings,[]);
  assert.throws(()=>withScopeUserRulings(brief,[{target:'case-b',ruling:'使用者决定：其他用例'}]),/未绑定本条/);
});
test('scope headings are declared syntax, never global keywords, ID substrings or quoted evidence', () => {
  const text = '## 全局其他文字\n使用者决定：不属于全局声明\n## 用例 case-ab\n使用者决定：不属于case-a\n## case-a（显示标题）\n```text\n使用者决定：这是引用\n```\n使用者决定：这是明确记录\n### 未声明的标题\n使用者决定：没有明确归属\n';
  assert.deepEqual(extractScopeUserRulings(text, new Set(['case-a']), 'case-a'), [{ target: 'case-a', ruling: '使用者决定：这是明确记录' }]);
});
