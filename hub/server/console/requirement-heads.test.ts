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
 for(const part of ['记账型：','门禁型：','不要求每项都满足','不显示“通过”','全部必需的要求项都满足'])assert.ok(DONE_RULE_NOTE.includes(part),part);
 assert.deepEqual(wordingProblems(shown),[]);
});

test('the accepted producer head says who may produce a result: the Hub by rule, a model, or a model other than the drafter',()=>{
 const shown=String(acceptedProducerHead());
 assert.ok(shown.includes(axisUiLabel('accepted_producer')));
 assert.ok(shown.includes(`title="${ACCEPTED_PRODUCER_NOTE}"`));
 for(const part of ['这项要求认哪一类结论','事实是规则算出的','判断是模型给出的','独立判断是另一个模型给出的，不是起草者自己'])assert.ok(ACCEPTED_PRODUCER_NOTE.includes(part),part);
 assert.deepEqual(wordingProblems(shown),[]);
});
