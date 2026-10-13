import assert from 'node:assert/strict';
import {test} from 'node:test';
import {freezeReturns,hydrateReturn} from '../../packages/connectors/src/return-pointers.ts';
import {sha256} from '../../packages/contracts/src/index.ts';
test('Worker receipts point to immutable originals and SHA size or missing-object substitutions cannot be accepted',async()=>{
  const values=new Map<string,Buffer>(),objects:any={putObject:async({Key,Body}:any)=>values.set(Key,Body),getObject:async({Key}:any)=>{const bytes=values.get(Key);if(!bytes)throw new Error('absent');return bytes;}},bytes=Buffer.alloc(3*1024*1024,65),original={path:'/synthetic/large.txt',bytes,sha256:sha256(bytes),mediaType:'text/plain',etag:null},pointer=(await freezeReturns(objects,[original],'document'))[0];assert.ok(JSON.stringify(pointer).length<500);assert.equal(pointer.objectKey,original.sha256);assert.equal(Buffer.from((await hydrateReturn(objects,pointer)).contentBase64,'base64').length,bytes.length);for(const forged of [{...pointer,size:1},{...pointer,objectKey:'0'.repeat(64)},{...pointer,objectKey:'0'.repeat(64),sha256:'0'.repeat(64)}])await assert.rejects(hydrateReturn(objects,forged));
});
