import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolveCriterionChanges,type Resolver} from './exact.ts';
const expected='src:'+'a'.repeat(64)+'/text@1/l/1',subject='src:'+'b'.repeat(64)+'/text@1/l/1';
const criterion={item:'one',criterion:expected,assertion:'合成声明',old:'旧判据',new:'新判据',grounds:[{reference:expected,quote:'依据'}]};
const resolver:Resolver={resolve:async reference=>reference==='src:'+'c'.repeat(64)?{ok:false,message:'不可用'}:{ok:true,value:{reference,text:'旧判据；依据',role:reference===subject?'subject':'expected',source:'a'.repeat(64),digest:'a'.repeat(64)}}};
test('valid criterion declarations remain eligible without changing the original proposal',async()=>{
 const before=JSON.stringify(criterion);const result=await resolveCriterionChanges(resolver,[{id:'one'}],[criterion]);
 assert.equal(result.errors.length,0);assert.equal(result.refused.length,0);assert.equal(result.accepted.length,1);assert.equal(JSON.stringify(criterion),before);
});
test('unresolved locations, old text and grounds reject the whole submission with precise pointers',async()=>{
 for(const [patch,code,path] of [[{criterion:'src:'+'c'.repeat(64)},'REFERENCE_UNRESOLVED','criterion'],[{old:'伪造旧值'},'QUOTE_MISMATCH','old'],[{grounds:[{reference:expected,quote:'不是引文'}]},'QUOTE_MISMATCH','grounds/0/quote']] as const){const out=await resolveCriterionChanges(resolver,[{id:'one'}],[{...criterion,...patch,grounds:'grounds' in patch?[...patch.grounds]:criterion.grounds}]);assert.equal(out.errors[0]?.code,code);assert.equal(out.errors[0]?.path,'/criterion_changes/0/'+path);assert.equal(out.accepted.length,0);}
});
test('non-expected role refuses only that declaration and does not mask other exact failures',async()=>{
 const out=await resolveCriterionChanges(resolver,[{id:'one'}],[{...criterion,criterion:subject},criterion]);
 assert.equal(out.errors.length,0);assert.equal(out.refused[0]?.code,'core.criterion.source_role_mismatch');assert.deepEqual(out.accepted.map(value=>value.index),[1]);
 const bad=await resolveCriterionChanges(resolver,[{id:'one'}],[{...criterion,criterion:subject,grounds:[{reference:expected,quote:'不逐字'}]}]);assert.equal(bad.errors[0]?.code,'QUOTE_MISMATCH');
});
test('unknown items and canonical duplicate criterion locations are whole-submission schema problems',async()=>{
 const unknown=await resolveCriterionChanges(resolver,[],[criterion]);assert.equal(unknown.errors[0]?.code,'SUBMISSION_SCHEMA_VIOLATION');
 const duplicate=await resolveCriterionChanges(resolver,[{id:'one'}],[criterion,criterion]);assert.equal(duplicate.errors[0]?.path,'/criterion_changes/1/criterion');
});
