import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDefaultRegistry, resolveReference } from './api.ts';
import { sha256Hex } from './canonical-json.ts';
import { IntegrityError } from '../records/api.ts';
const bytes = Buffer.from('synthetic source');
const reference = `src:${sha256Hex(bytes)}`;
const base = {retryReads:true,reader:{user:'usr_test',role:'user' as const},parsers:createDefaultRegistry()};
test('reader faults retry before exposing a scheduled retry; null stays neutral', async () => {
 let calls=0;
 const result=await resolveReference(reference,{...base,sources:{read(){calls++;throw new Error('synthetic timeout');}}});
 assert.equal(calls,3);
 assert.ok(!result.resolved);
 assert.equal(result.code,'SOURCE_RETRYABLE');
 assert.match(result.message,/下一次|重读/);
 const neutral=await resolveReference(reference,{...base,sources:{read:()=>null}});
 assert.ok(!neutral.resolved && neutral.code==='SOURCE_UNAVAILABLE');
});
test('transient reader recovery resolves bytes; integrity failure does not retry or become neutral', async () => {
 let calls=0;
 const recovered=await resolveReference(reference,{...base,sources:{read(){if(++calls<3)throw new Error('temporary');return {bytes,size:bytes.length,mediaType:'text/plain',readTier:'model_readable'};}}});
 assert.ok(recovered.resolved);assert.equal(calls,3);
 for(const read of [()=>{throw new IntegrityError('missing synthetic original');},()=>({bytes:Buffer.from('bad'),size:bytes.length,mediaType:'text/plain',readTier:'model_readable' as const}),()=>({bytes:null,size:bytes.length,mediaType:'text/plain',readTier:'model_readable' as const})]){
  const result=await resolveReference(reference,{...base,sources:{read}});
  assert.ok(!result.resolved && result.code==='SOURCE_INTEGRITY_UNPROVEN' && result.reason==='integrity_unproven');
  assert.match(result.fix,/备份恢复/);
 }
});
test('source tree entry and record retry deadlines use the resolving Hub clock',async()=>{
 const at=Date.parse('2035-06-07T08:09:10.000Z');
 for(const target of [reference,'tree:'+'a'.repeat(64)+'/','entry:'+'a'.repeat(64),'rec:'+'a'.repeat(64)]){
  let tick=at,calls=0;
  const fail=()=>{calls++;tick+=500;throw new Error('synthetic reader fault');};
  const result=await resolveReference(target,{...base,now:()=>new Date(tick),sources:{read:fail},trees:{read:fail,readEntry:fail},records:{read:fail}});
  assert.equal(calls,3);assert.ok(!result.resolved);assert.equal(result.code,'SOURCE_RETRYABLE');assert.ok(result.message.includes(new Date(tick+1000).toISOString()),result.message);
 }
});
