// The requirement table's two abstract column heads say what they mean beside the formal names (issue 229).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {axisUiLabel} from '../../../contracts/generated/vocabulary.ts';
import {ACCEPTED_PRODUCER_NOTE,DONE_RULE_NOTE,acceptedProducerHead,doneRuleHead} from './pack-display.ts';
import {wordingProblems} from './testing-wording.ts';

test('the delivery rule head keeps its formal name and says what the two rules mean in plain words',()=>{
 const shown=String(doneRuleHead());
 assert.ok(shown.includes(axisUiLabel('done_rule')),'the formal name stays');
 assert.ok(shown.includes(`title="${DONE_RULE_NOTE}"`)&&shown.includes(`aria-description="${DONE_RULE_NOTE}"`));
 for(const part of ['记账型：','门禁型：','不显示“通过”','全部必需的要求项都满足'])assert.ok(DONE_RULE_NOTE.includes(part),part);
 assert.deepEqual(wordingProblems(shown),[]);
});

test('the accepted producer head says who may produce a result: the Hub by rule, a model, or a model other than the drafter',()=>{
 const shown=String(acceptedProducerHead());
 assert.ok(shown.includes(axisUiLabel('accepted_producer')));
 assert.ok(shown.includes(`title="${ACCEPTED_PRODUCER_NOTE}"`));
 for(const part of ['事实由 Hub 按规则算出','判断由模型给出','独立判断要求给出判断的不是起草者自己'])assert.ok(ACCEPTED_PRODUCER_NOTE.includes(part),part);
 assert.deepEqual(wordingProblems(shown),[]);
});
