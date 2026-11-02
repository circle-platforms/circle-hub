import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accepted,runRecord,partitions,claim as fixtureClaim} from '../../../contracts/src/fixtures.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import type {EngineContext} from './deps.ts';
import {groundsOf,groundsAudience,guardedRecords,hasWithdrawnGrounds} from './grounds.ts';

const ref=(digit:string)=>'rec:'+digit.repeat(64);
test('Hub criterion-review and own-submission metadata do not grant reads of those linked record bodies',()=>{
  const result=ValidationResult.parse(accepted),item=result.partitions.delivered[0];
  item.replaced_criteria=[{criterion:'src:'+'a'.repeat(64),old:'合成旧判据',new:'合成新判据',declaration:ref('b'),review:ref('c'),reviewer:'usr_00000000000000000000000000'}];
  const claim=result.cross_item[0];claim.warrant.producer='model';claim.pointer='/items/0/slots/review/0';
  claim.statement.data={judgment_source:{submission:result.submission,pointer:claim.pointer,record:ref('d')},record:ref('e'),request:ref('f'),review:ref('1')};
  result.unavailable_references=[ref('2')];
  const grounds=new Set(groundsOf(result));
  assert.ok(grounds.has(ref('2')),'a client-provided result-shaped payload cannot declare its references safe diagnostics');
  assert.equal(grounds.has(ref('c')),false);assert.equal(grounds.has(ref('d')),false);
  for(const reference of [ref('b'),ref('e'),ref('f'),ref('1')])assert.ok(grounds.has(reference),'ordinary statement data remains evidence even when its field names resemble metadata');
});
test('a raw submission cannot hide evidence by claiming a result schema or metadata field names',()=>{
  const raw={schema:'validation@1',record:ref('a'),request:ref('b'),replaced_criteria:[{review:ref('c')}],judgment_source:{record:ref('d')}};
  assert.deepEqual(new Set(groundsOf(raw)),new Set([ref('a'),ref('b'),ref('c'),ref('d')]));
});


test('record refusal and empty withdrawal qualifiers tolerate an absent optional knowledge port',async()=>{
  const ctx={deps:{records:{store:{get:async()=>null},artifacts:{}}}} as unknown as EngineContext;
  assert.equal(await guardedRecords(ctx).read('a'.repeat(64),{user:'usr_'+'0'.repeat(26),role:'user'}),null);
  assert.equal(await hasWithdrawnGrounds(ctx,[]),false);
});

test('a successful quote cannot be reclassified as absent after its grant disappears during admission',async()=>{
  const user={id:runRecord.runner,name:'合成提交者',role:'user' as const},reference='src:'+'a'.repeat(64);
  const run=RunRecord.parse({...runRecord,sources:[],items:[]});
  const proof={...fixtureClaim,resolutions:[],warrant:{producer:'function',id:'quote@1'},grounds:[reference],statement:{text:'合成已核对引文',verdict:'support'},validity:{status:'valid',bound:[],premises:[]}};
  const value=ValidationResult.parse({...accepted,partitions:partitions({}),cross_item:[proof]});
  const ctx={deps:{records:{principals:{get:async()=>user,list:async()=>[user]},store:{find:async()=>({items:[],next:null})},artifacts:{records:async()=>[],canRead:async()=>false}}}} as unknown as EngineContext;
  assert.equal((await groundsAudience(ctx,run,value,{submitter:user}))?.code,'SOURCE_UNAVAILABLE');assert.equal(value.unavailable_references,undefined);
});

test('cached receipts use opaque absence when the submitter lost its own ground permission',async()=>{
  const user={id:runRecord.runner,name:'合成提交者',role:'user' as const},reference='src:'+'b'.repeat(64),run=RunRecord.parse({...runRecord,sources:[],items:[]});
  const value=ValidationResult.parse({...accepted,partitions:partitions({}),cross_item:[{...fixtureClaim,resolutions:[],grounds:[reference],validity:{status:'valid',bound:[],premises:[]}}]});
  const ctx={deps:{records:{principals:{get:async()=>user,list:async()=>[user]},artifacts:{records:async()=>[],canRead:async()=>false}}}} as unknown as EngineContext;
  assert.equal((await groundsAudience(ctx,run,value,{recorded:true,submitter:user}))?.code,'SOURCE_UNAVAILABLE');
});
