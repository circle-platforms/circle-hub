import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Documents} from '../../packages/connectors/src/documents.ts';
import {HttpSource} from '../../packages/connectors/src/readonly-sdk.ts';
import {ApiError,sha256} from '../../packages/contracts/src/index.ts';
test('Document search timeout returns only observed hits with the exact resume cursor and incomplete coverage',async()=>{
  const docs=new Documents(new HttpSource('http://127.0.0.1')),entries=['a.txt','b.txt','c.txt'].map(name=>({path:'/dav/'+name,etag:name,modifiedAt:null,size:20,directory:false})),raw=(path:string)=>{const bytes=Buffer.from('synthetic hit');return {path,bytes,sha256:sha256(bytes),mediaType:'text/plain',etag:path};};(docs as any).list=async()=>({result:entries,evidence:raw('/dav/')});let timeout=true;(docs as any).get=async(path:string)=>{if(path==='/dav/b.txt'&&timeout)throw new ApiError('UPSTREAM_TIMEOUT','synthetic timeout');return {result:{},evidence:{...raw(path),etag:null}};};const first=await docs.search({query:'synthetic',limit:20},'/dav/');assert.equal(first.result.hits.length,1);assert.equal(first.result.coverage.complete,false);assert.equal((first.result.coverage as any).stopped.code,'UPSTREAM_TIMEOUT');assert.ok(first.result.nextCursor);timeout=false;const next=await docs.search({query:'synthetic',limit:20,after:first.result.nextCursor!},'/dav/');assert.deepEqual(next.result.hits.map((hit:any)=>hit.file),['/dav/b.txt','/dav/c.txt']);assert.equal(next.result.nextCursor,null);
});
