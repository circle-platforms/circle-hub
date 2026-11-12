// The source type 声明 and the team-source status carry what they mean beside them; the formal labels stay (issue 228).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {ATTRIBUTION_SCOPE,DECLARED_SCOPE,attributionBadge,sourceTypeLabel} from './knowledge-display.ts';
import {wordingProblems} from './testing-wording.ts';

test('a declared source says who provided it and that nothing independent was collected, beside the formal label',()=>{
 const shown=String(sourceTypeLabel('declared'));
 assert.ok(shown.includes(uiLabelOf('provenance_type','declared')),'the formal label stays');
 assert.ok(shown.includes(`title="${DECLARED_SCOPE}"`)&&shown.includes(`aria-description="${DECLARED_SCOPE}"`),shown);
 assert.match(DECLARED_SCOPE,/内容由上传的人提供/);assert.match(DECLARED_SCOPE,/没有独立采集的证明/);
 assert.deepEqual(wordingProblems(shown),[]);
});

test('the other source types are shown as they were, without a claim about collection',()=>{
 for(const type of ['observed','projected','candidate'] as const){
  const shown=String(sourceTypeLabel(type));
  assert.equal(shown,uiLabelOf('provenance_type',type),type);
 }
});

test('the team-source status separates the uploader from the team confirmation, and says a signature is neither a digital signature nor a copyright transfer',()=>{
 const unsigned=String(attributionBadge('unsigned')),attributed=String(attributionBadge('attributed'));
 assert.ok(unsigned.includes(uiLabelOf('source_attribution_status','unsigned'))&&attributed.includes(uiLabelOf('source_attribution_status','attributed')),'the formal labels stay');
 assert.ok(unsigned.includes(ATTRIBUTION_SCOPE.unsigned)&&attributed.includes(ATTRIBUTION_SCOPE.attributed));
 assert.match(ATTRIBUTION_SCOPE.unsigned,/与上传人是谁无关/);
 assert.match(ATTRIBUTION_SCOPE.attributed,/不是数字签名，也不转让版权/);
 assert.notEqual(ATTRIBUTION_SCOPE.unsigned,ATTRIBUTION_SCOPE.attributed);
 for(const markup of [unsigned,attributed])assert.deepEqual(wordingProblems(markup),[]);
});
