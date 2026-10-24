import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Applicability } from '../../contracts/src/product.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { canonicalize, sha256Hex } from '../records/api.ts';
import { entryContentOf, entryDigest, normaliseApplicability } from './digest.ts';
import { applicabilityText } from './read.ts';

const base={kind:'behaviour',statement:'Synthetic unchanged statement',data:{form:'text'},applicability:null};
test('new applicability lists normalize independently of order or repetitions',()=>{
  const a={components:{with:['Card-B','Card-A','Card-A'],without:['Card-D','Card-C']},licenses:['Permit-B','Permit-A','Permit-A'],deployment_forms:['Form-B','Form-A'],inherited:['licenses','components','licenses']} as Applicability;
  const b={components:{with:['Card-A','Card-B'],without:['Card-C','Card-D']},licenses:['Permit-A','Permit-B'],deployment_forms:['Form-A','Form-B'],inherited:['components','licenses']} as Applicability;
  assert.deepEqual(normaliseApplicability(a),b);
  assert.equal(entryDigest(entryContentOf({...base,applicability:a})),entryDigest(entryContentOf({...base,applicability:b})));
});
test('entries with no applicability keep their original digest',()=>{
  assert.equal(entryDigest(base),sha256Hex(canonicalize(base)));
});
test('display uses vocabulary field labels and inherited section provenance',()=>{
  const value={components:{with:['Card-A']},memory:{minimum:{bytes:1024**2,inclusive:true},raw:'内存至少 1M'},licenses:['Permit-A'],deployment_forms:['Form-A'],inherited:['components']} as Applicability;
  const text=applicabilityText(value,[{field:'components',section:['Synthetic chapter']}]);
  for(const field of ['components','memory','licenses','deployment_forms'] as const)assert.ok(text.includes(labelOf('applicability_field',field)));
  assert.match(text,/继承自章节开头：Synthetic chapter/);
});

test('conflicted and unread declarations disclose their next action even without a chapter path',()=>{
  const conflict=applicabilityText(null,[{field:'components',section:['Inner'],declaration:{components:{with:['Card-A']}},conflict:true}]);
  assert.ok(conflict.includes('下一步：来源维护者核对这些片段，修订或明确保留矛盾后重新同步'));
  const unread=applicabilityText(null,[{field:'licenses',section:[],declaration:{}}]);
  assert.ok(unread.includes('出处未取得'));
  assert.ok(unread.includes('下一步：读取组成记录里的来源片段核对原文'));
  assert.ok(!unread.includes('：）'));
});
test('component presence and absence stay inside one labelled field',()=>{
  const text=applicabilityText({components:{with:['Card-A'],without:['Card-B']},licenses:['Permit-A']});
  assert.equal(text,'部件 装有 Card-A，没有 Card-B；许可 Permit-A');
});

test('superseded conflicts and unread declarations remain provenance rather than effective conditions',()=>{
 const text=applicabilityText({components:{with:['Card-C']},inherited:['components']},[
   {field:'components',section:['Outer'],declaration:{components:{with:['Card-A']}},conflict:true,superseded:true},
   {field:'components',section:['Outer'],declaration:{},superseded:true},
   {field:'components',section:['Inner'],declaration:{components:{with:['Card-C']}}}
 ]);
 assert.equal(text,'部件 装有 Card-C（继承自章节开头：Inner）');
});
