// Source declarations only: target observations are deliberately not inferred here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Applicability } from './product.ts';

const memory={minimum:{bytes:8*1024**3,inclusive:true},maximum:{bytes:16*1024**3,inclusive:false},raw:'内存至少 8G 且小于 16G'};
test('applicability carries components, memory, licenses, deployment forms and inherited field codes',()=>{
  assert.ok(Applicability.safeParse({components:{with:['Card-A'],without:['Card-B']},memory,licenses:['Permit-A'],deployment_forms:['Form-A'],inherited:['components','memory']}).success);
  assert.ok(Applicability.safeParse({}).success);
});
test('applicability rejects malformed bounds and provenance embedded as inherited field names',()=>{
  for(const value of [
    {memory:{...memory,minimum:{bytes:-1,inclusive:true}}},
    {memory:{...memory,maximum:{bytes:1,inclusive:'yes'}}},
    {memory:{raw:'内存较大'}},
    {licenses:[4]},
    {inherited:['unknown_field']},
    {inherited:[{field:'memory',section:['Synthetic chapter']}]},
  ])assert.equal(Applicability.safeParse(value).success,false,JSON.stringify(value));
});
