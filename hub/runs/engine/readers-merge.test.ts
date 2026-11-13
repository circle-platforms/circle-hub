import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Artifacts} from '../../records/api.ts';
import {sourceReader} from './readers.ts';
for(const consumer of ['function','model'] as const)test(`${consumer} reader keeps retained metadata without confusing intentional withholding with a read fault`,async()=>{
  let tier:'retain_only'|'function_bytes_only'='retain_only';
  const artifacts={source:async(_user:unknown,_sha:string,options:{consumer:string})=>{
    assert.equal(options.consumer,consumer);
    return {bytes:null,mediaType:'text/plain',size:7,readTier:tier};
  }} as unknown as Artifacts;
  const reader=sourceReader(artifacts,consumer);
  const principal={user:'synthetic-user',role:'user' as const};
  assert.equal((await reader.read('a'.repeat(64),principal))?.readTier,'retain_only');
  tier='function_bytes_only';
  const withheld=await reader.read('a'.repeat(64),principal);
  if(consumer==='model')assert.equal(withheld,null,'a policy-withheld model read stays neutral');
  else assert.equal(withheld?.readTier,'function_bytes_only','unexpected missing function bytes retain diagnostic metadata');
});
