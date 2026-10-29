import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {declareResourceTags} from './functions/generated/vocabulary.ts';
import {checkDraftShape} from './functions/checks.ts';

for(const file of ['submission.json','submit-result.json','SKILL.md'])test('published '+file+' declares exact resource tags and stable draft identity',()=>{
  const content=readFileSync(new URL(file==='SKILL.md'?'./SKILL.md':'./examples/'+file,import.meta.url),'utf8');
  const document=JSON.parse(file==='SKILL.md'?content.split('```json\n')[1]!.split('\n```')[0]:content);
  const submission=document.submit_result??document;
  const cases=submission.items.flatMap((item:any)=>item.slots?.cases??[]);
  assert.ok(cases.length);
  for(const entry of cases){
    const data=entry.data,declared=declareResourceTags(data.resource);
    assert.equal(declared.status,'declared');
    assert.equal(declared.issues.length,0);
    assert.equal(data.negative,declared.negative);
    assert.equal(typeof data.id,'string');assert.ok(data.id.length);
    const outcomes=checkDraftShape({subject:{slots:{cases:[entry]}}});
    assert.ok(!outcomes.some(outcome=>outcome.pointer==='/cases/0/resource'||outcome.pointer==='/cases/0/negative'));
    assert.ok(!outcomes.some(outcome=>outcome.missing?.includes('草稿 id')));
  }
});
