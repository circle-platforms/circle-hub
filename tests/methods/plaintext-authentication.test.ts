import assert from 'node:assert/strict';
import {test} from 'node:test';
import {HttpSource} from '../../packages/connectors/src/readonly-sdk.ts';
test('Remote plaintext authentication is rejected by default and explicit authorized reads retain the permanent marker',async()=>{
  const fetchOriginal=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('synthetic',{status:200});};
  try{await assert.rejects(new HttpSource('http://source.example.test',{authorization:()=> 'synthetic-personal-token'}).read('/item'),(error:any)=>error.code==='SOURCE_FORBIDDEN');assert.equal(calls,0);const raw=await new HttpSource('http://source.example.test',{authorization:()=> 'synthetic-personal-token',allowPlaintextAuthentication:true} as any).read('/item');assert.equal((raw as any).plaintextAuthentication,true);assert.equal(calls,1);}finally{globalThis.fetch=fetchOriginal;}
});
