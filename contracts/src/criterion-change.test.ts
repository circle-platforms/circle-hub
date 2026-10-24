import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Submission,CriterionChange} from './submission.ts';
import {RUN} from './fixtures.ts';
const ref='src:'+'a'.repeat(64)+'/text@1/l/1';
const change={item:'item-1',criterion:ref,assertion:'合成判据',old:'旧判据',new:'新判据',grounds:[{reference:ref,quote:'新依据'}]};
const base={run:RUN,model:'Scripted',items:[{item:'item-1',handling:'handled',slots:{}}]};
test('criterion changes preserve the six declared fields and leave legacy submissions unchanged',()=>{
 assert.deepEqual(CriterionChange.parse(change),change);
 assert.deepEqual(Submission.parse(base),base);
 assert.deepEqual(Submission.parse({...base,criterion_changes:[change]}).criterion_changes,[change]);
});
test('criterion changes reject missing or blank fields, malformed references and absent grounds',()=>{
 for(const key of Object.keys(change)){const value={...change};delete value[key as keyof typeof value];assert.equal(CriterionChange.safeParse(value).success,false,key);}
 for(const patch of [{assertion:' '},{old:''},{new:'\n'},{criterion:'not-a-reference'},{grounds:[]},{grounds:[{reference:ref,quote:''}]}])assert.equal(CriterionChange.safeParse({...change,...patch}).success,false);
});
test('one submission cannot declare the same criterion twice for one item',()=>{
 const parsed=Submission.safeParse({...base,criterion_changes:[change,{...change,new:'另一个'}]});
 assert.equal(parsed.success,false);if(!parsed.success)assert.ok(parsed.error.issues.some(issue=>issue.path.join('/')==='criterion_changes/1/criterion'));
 assert.ok(Submission.safeParse({...base,criterion_changes:[change,{...change,item:'item-2'}]}).success);
});
test('W04 runtime checks coexist with criterion changes in the same submission',()=>{
 assert.ok(Submission.safeParse({...base,checks:[{requirement:'demo',interpreter:'range@1',table:{},samples:[]}],criterion_changes:[change]}).success);
});
