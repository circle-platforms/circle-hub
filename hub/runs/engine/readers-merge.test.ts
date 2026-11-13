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

import {withRequestPermissions,type RequestPermissions} from '../../records/api.ts';

test('uninspected sources reuse bytes within one request while findings, truncation and acceptances stay uncached',async()=>{
  const by={id:'usr_'+'1'.repeat(26),name:'合成读取者',role:'user' as const};
  for(const flags of [{},{findings:[{}]},{truncated:true},{acceptance:{record:'synthetic'}}]){
    let reads=0;
    const artifacts={
      source:async()=>{
        reads++;
        return {bytes:Buffer.from('synthetic'),mediaType:'text/plain',size:9,readTier:'model_readable',
          artifact:{body:{scan:{inspected:false,clean:false,truncated:'truncated'in flags,findings:'findings'in flags?flags.findings:[]}}},
          ...('acceptance'in flags?{acceptance:flags.acceptance}:{})};
      },
      capturePermissionSnapshot:async()=>({principalId:by.id,active:true,cache:new Map(),cacheBytes:0}) as unknown as RequestPermissions,
    } as unknown as Artifacts;
    const reader=sourceReader(artifacts,'function');
    const twice=async()=>{for(let i=0;i<2;i++)assert.ok(await reader.read('a'.repeat(64),{user:by.id,role:by.role}));};
    await withRequestPermissions(artifacts,by,twice);
    const cacheable=Object.keys(flags).length===0;
    assert.equal(reads,cacheable?1:2);
    await withRequestPermissions(artifacts,by,twice);
    assert.equal(reads,cacheable?2:4,'request boundaries never retain cached bytes');
  }
});
