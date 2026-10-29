import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDocumentCache,createParserRegistry,type ParsedDocument,type Parser} from '../../refs/api.ts';
import {sha256Hex} from '../../records/api.ts';
import {createResolver,type RunScope} from './exact.ts';
import type {EngineContext} from './deps.ts';

function fixture(text='synthetic'){
 const sources=new Map(Array.from({length:3},(_,i)=>Buffer.from('synthetic source '+i)).map(bytes=>[sha256Hex(bytes),bytes]));
 let parses=0,batches=0,singles=0,reads=0,readable=true;
 const parser:Parser={id:'count',version:1,mediaTypes:['text/plain'],limits:{maxBytes:10000,maxDepth:2,maxNodes:100},parse(){parses++;const loaded=new Set<string>();return {parser:'count@1',model:{},retainedBytes:()=>1,listSelectors:()=>[],summary:()=>({}),prefetch:async selectors=>{batches++;for(const selector of selectors)loaded.add(selector);},locate:async selector=>{if(!loaded.has(selector))singles++;return {selector,text,byteRange:null};}} as ParsedDocument;}};
 const ctx={deps:{records:{artifacts:{source:async(_user:unknown,sha:string)=>{reads++;const bytes=sources.get(sha);return bytes&&readable?{bytes,mediaType:'text/plain',size:bytes.length,readTier:'model_readable',artifact:{digest:'artifact-'+sha,body:{sha256:sha,provenance_type:'declared'}}}:null;}},store:{get:async()=>null}},knowledge:{treeReader:()=>({})}},parsers:createParserRegistry([parser]),documents:createDocumentCache(2,1024),log:()=>{}} as unknown as EngineContext;
 const scope:RunScope={reader:{user:'synthetic',role:'user'},sources:new Map([...sources.keys()].map(sha=>[sha,'expected' as const])),records:new Map(),subject:{shas:new Set(sources.keys()),records:new Set()},root:null,catalogs:[],candidates:async()=>[]};
 const references=Array.from({length:4},(_,i)=>[...sources.keys()].map(sha=>`src:${sha}/count@1/l/${i+1}`)).flat();
 return {resolver:createResolver(ctx,scope,'model'),references,stats:()=>({parses,batches,singles,reads}),setReadable:(value:boolean)=>{readable=value;}};
}

test('interleaved source references stay batched even after parsed-document eviction',async()=>{
 const f=fixture();await f.resolver.prefetch(f.references);const before=f.stats().reads;
 for(const ref of f.references)assert.ok((await f.resolver.resolve(ref,{grounds:true})).ok);
 const stats=f.stats();assert.deepEqual({parses:stats.parses,batches:stats.batches,singles:stats.singles},{parses:3,batches:3,singles:0});assert.ok(stats.reads>=before+f.references.length,'every use rechecks the source grant');
});

test('a prepared fragment is withheld immediately after source access is revoked',async()=>{
 const f=fixture();const ref=f.references[0];await f.resolver.prefetch([ref]);f.setReadable(false);
 const denied=await f.resolver.resolve(ref);assert.equal(denied.ok,false);assert.ok(!JSON.stringify(denied).includes('synthetic'));
 f.setReadable(true);const restored=await f.resolver.resolve(ref);assert.ok(restored.ok);if(restored.ok)assert.equal(restored.value.text,'synthetic');
});

test('resolved-text budget stops the operation instead of falling back to individual lookups',async()=>{
 const f=fixture('x'.repeat(34*1024*1024));const ref=f.references[0];
 await assert.rejects(()=>f.resolver.prefetch([ref]),/预算/);
 await assert.rejects(()=>f.resolver.resolve(ref),/预算/);
 assert.equal(f.stats().singles,0);
});

test('concurrent prefetches of the same large reference charge the result budget once',async()=>{
 const f=fixture('x'.repeat(20*1024*1024));const ref=f.references[0];
 await Promise.all([f.resolver.prefetch([ref]),f.resolver.prefetch([ref])]);
 assert.ok((await f.resolver.resolve(ref)).ok);
});
