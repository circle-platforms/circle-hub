import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prefetchFragmentSelectors,singleSources} from './verify.ts';
import type {ParsedSource,SourceLoader} from './sources.ts';
import type {ParsedDocument} from '../refs/api.ts';
import type {FragmentRef} from '../../contracts/src/product.ts';

test('interleaved alternate parsers are located in one batch per source even with a four-document cache',async()=>{
 const sources=new Map<string,ParsedSource>();
 for(let i=0;i<5;i++)sources.set('slot'+i,{sha256:String(i).repeat(64),mediaType:'text/plain',parser:'text@1',document:{} as ParsedDocument} as ParsedSource);
 const fragments:FragmentRef[]=Array.from({length:4},(_,row)=>Array.from({length:5},(_,i)=>({slot:'slot'+i,parser:'count@1',selector:'l/'+row}))).flat();
 const documents=new Map<string,ParsedDocument>();let opens=0,batches=0,singles=0;
 const loader={async documentWith(source:ParsedSource){let document=documents.get(source.sha256);if(!document){opens++;const loaded=new Set<string>();document={parser:'count@1',model:{},summary:()=>({}),listSelectors:()=>[],async prefetch(selectors){batches++;for(const selector of selectors)loaded.add(selector);},async locate(selector){if(!loaded.has(selector))singles++;return {selector,text:'synthetic',byteRange:null};}};documents.set(source.sha256,document);if(documents.size>4)documents.delete(documents.keys().next().value!);}return document;}} as unknown as SourceLoader;
 const out=await prefetchFragmentSelectors(fragments,singleSources(sources),loader);
 assert.equal(out.size,20);assert.ok([...out.values()].every(value=>value.ok));
 assert.equal(opens,5);assert.equal(batches,5);assert.equal(singles,0);
});

test('an alternate parser sandbox failure propagates from prefetch without a per-fragment retry',async()=>{
 const {SandboxError}=await import('../rules/api.ts');
 const source={sha256:'a'.repeat(64),mediaType:'text/plain',parser:'text@1',document:{} as ParsedDocument} as ParsedSource;
 const fragment:FragmentRef={slot:'source',parser:'count@1',selector:'l/1'};let calls=0;
 const loader={async documentWith(){calls++;throw new SandboxError('SANDBOX_TIMEOUT');}} as unknown as SourceLoader;
 await assert.rejects(()=>prefetchFragmentSelectors([fragment,fragment],singleSources(new Map([['source',source]])),loader),error=>error instanceof SandboxError&&error.code==='SANDBOX_TIMEOUT');
 assert.equal(calls,1);
});
