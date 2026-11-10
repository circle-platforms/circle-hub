// The verified status carries what it covers beside it; the other statuses are unchanged (issue 227).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {VERIFIED_SCOPE,knowledgeState} from './knowledge-display.ts';

test('a verified status names what was checked and what it does not establish, in the tooltip next to it',()=>{
 const shown=String(knowledgeState('verified'));
 assert.ok(shown.includes(uiLabelOf('knowledge_entry_status','verified')),'the formal label stays');
 assert.ok(shown.includes(`title="${VERIFIED_SCOPE}"`)&&shown.includes(`aria-description="${VERIFIED_SCOPE}"`),shown);
 assert.match(VERIFIED_SCOPE,/逐字核对/);assert.match(VERIFIED_SCOPE,/不代表陈述已获事实确认/);
 assert.ok(!VERIFIED_SCOPE.includes('验证不代表'),'one wording, not two');
});

test('the other statuses show no verification claim',()=>{
 for(const state of ['unverified','withdrawn','superseded'] as const){
  const shown=String(knowledgeState(state));
  assert.ok(shown.includes(uiLabelOf('knowledge_entry_status',state)),state);
  assert.ok(!shown.includes('逐字核对')&&!shown.includes('ch-tip'),state);
 }
});
