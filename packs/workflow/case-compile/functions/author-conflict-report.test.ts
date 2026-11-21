import assert from 'node:assert/strict';
import {test} from 'node:test';
import {caseConclusion,closingCounts,deliveryReport,type CaseOutcome,type ReportInput} from './delivery.ts';
import {labelOf} from './generated/vocabulary.ts';
function inputOf(outcome:CaseOutcome):ReportInput{
 return {name:'synthetic',generatedAt:'2026-11-16 09:00',build:null,assembly:{cases:[outcome],pass:null,unsuccessful:null,totals:{cases:1,delivered:0,failed:0,unsettled:0,unrun:1}},notes:{cases:{a:{judged:'合成模型说明',remedy:'合成下一步'}}},originals:{a:{title:'合成标题',lines:[]}},excluded:[],files:{pass:null,unsuccessful:null},logs:{}};
}
test('verified author conflict uses the generated author-input reason without replacing recorded causes or other closings',()=>{
 const conflict:CaseOutcome={autoid:'a',status:'unrun',history:[],closing:'author_conflict',basis:{plan_run:'synthetic',attributions:['unattributed'],gaps:[]}};
 const before=structuredClone(conflict);assert.ok(caseConclusion(inputOf(conflict),conflict).includes('原因：'+labelOf('attribution','author_input')));assert.ok(closingCounts([conflict]).includes(labelOf('attribution','author_input')));assert.deepEqual(conflict,before);
 for(const closing of ['authoring_failure','device_defect','missing_fact']as const){const other={...conflict,closing},input=inputOf(other),text=caseConclusion(input,other);assert.ok(text.includes('原因（模型的分析）：合成模型说明')&&!text.includes(labelOf('attribution','author_input')),text);assert.equal(caseConclusion({...input,userRulings:{a:[{source:'scope.md',target:'a',ruling:'使用者决定：合成决定'}]}},other),text);}
});
test('a scoped recorded user ruling routes an existing author conflict to the author and retains the actual ruling',()=>{
 const conflict:CaseOutcome={autoid:'a',status:'unrun',history:[],closing:'author_conflict'};const input=inputOf(conflict);
 assert.match(caseConclusion(input,conflict),/下一步：由作者或使用者根据/);
 const ruling='使用者决定：合成原文，不根据词语猜测其意思';
 const withRuling={...input,userRulings:{a:[{source:'scope.md',target:'a',ruling}]}};
 assert.match(caseConclusion(withRuling,conflict),/下一步：等作者裁定原始用例。/);assert.doesNotMatch(caseConclusion(withRuling,conflict),/由作者或使用者/);assert.ok(deliveryReport(withRuling).includes(ruling));
 assert.match(caseConclusion({...input,userRulings:{b:[{source:'scope.md',target:'b',ruling}]}} as ReportInput,conflict),/下一步：由作者或使用者根据/);
 const prose=inputOf(conflict);prose.notes.cases.a.judged='使用者决定：保留原始用例';assert.match(caseConclusion(prose,conflict),/下一步：由作者或使用者根据/);
});
