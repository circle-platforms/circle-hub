// Applicability grammar is authored pack data; prose never supplies structural fields.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {produceManualEntries} from './manual.ts';
import {markdown} from '../testing/test-support.ts';

const closed={components:['Card-A','Card-B'],licenses:['Permit-A'],deployment_forms:['Form-A']};
const declaration=(section:string[],conditions:unknown)=>'```famx-applicability@1\n'+JSON.stringify({schema:'famx-applicability@1',scope:{section,descendants:true},conditions})+'\n```';
function row(source:string){const out=produceManualEntries(markdown(source),null,closed),entry=out.entries.find(value=>value.statement==='Payload.');assert.ok(entry,JSON.stringify(out));return {out,entry};}

test('ordinary prose words and equal numbers never cause applicability extraction',()=>{
 for(const text of ['装有 Card-A 时，内存至少8GB。','装有 Card-A 时，内存大约8GB。','没有 Card-B 时，需要 Permit-A 许可。','适用于 Form-A，8GB 内存的设备。']){
  const {entry}=row('# Outer\n\n'+text+'\n\n## Child\n\nPayload.\n');assert.equal(entry.applicability,null,text);
 }
});
test('a structured declaration without prose trigger words supplies and inherits exact closed values',()=>{
 const {entry}=row('# Outer\n\n'+declaration(['Outer'],{components:{with:['Card-A']},licenses:['Permit-A'],deployment_forms:['Form-A'],memory:{minimum:{bytes:8589934592,inclusive:true},raw:'8589934592 bytes'}})+'\n\n## Child\n\nPayload.\n');
 assert.deepEqual(entry.applicability?.components,{with:['Card-A']});assert.deepEqual(entry.applicability?.licenses,['Permit-A']);assert.equal(entry.applicability?.memory?.minimum?.bytes,8589934592);assert.deepEqual(new Set(entry.applicability?.inherited),new Set(['components','licenses','deployment_forms','memory']));assert.ok(entry.fragments.some(fragment=>fragment.applicability?.length));
});
test('prose in an inner section cannot block an explicitly declared outer scope',()=>{
 const {entry}=row('# Outer\n\n'+declaration(['Outer'],{components:{with:['Card-A']}})+'\n\n## Child\n\n装有 Card-B 时，Card-A 可能例外。\n\nPayload.\n');assert.deepEqual(entry.applicability?.components,{with:['Card-A']});
});
test('invalid fields and non-members are structural failures, not an empty successful production',()=>{
 for(const conditions of [{component:{with:['Card-A']}},{components:{with:['Card-A','Unknown']}},{memory:{minimum:{bytes:1.5,inclusive:true},raw:'1.5'}}]){
  assert.throws(()=>produceManualEntries(markdown('# Outer\n\n'+declaration(['Outer'],conditions)+'\n\nPayload.\n'),null,closed),(error:unknown)=>error instanceof Error&&'code'in error&&error.code==='famx.applicability.declaration_invalid');
 }
});
