import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDocumentCache,createParserRegistry,type ParsedDocument,type Parser} from '../../refs/api.ts';
import {sha256Hex} from '../../records/api.ts';
import {createResolver,resolveSubmission,type RunScope} from './exact.ts';
import type {EngineContext} from './deps.ts';
import type {LoadedWorkflow} from '../../ports.ts';
import type {ItemProjection} from '../../../contracts/src/run.ts';
import type {Submission} from '../../../contracts/src/submission.ts';

test('one document is prefetched once for item locations, cross-item grounds and criterion changes',async()=>{
 const bytes=Buffer.from('synthetic source');const sha=sha256Hex(bytes);const ref=(n:number)=>`src:${sha}/count@1/l/${n}`;
 const loaded=new Set<string>();const batches:string[][]=[];let singles=0;
 const document:ParsedDocument={parser:'count@1',model:{},summary:()=>({}),listSelectors:()=>[],
  async prefetch(selectors){const missing=[...new Set(selectors)].filter(selector=>!loaded.has(selector));if(missing.length){batches.push(missing);for(const selector of missing)loaded.add(selector);}},
  async locate(selector){if(!loaded.has(selector)){singles++;loaded.add(selector);}return {selector,text:'synthetic observation',byteRange:null};}};
 const parser:Parser={id:'count',version:1,mediaTypes:['text/plain'],limits:{maxBytes:10000,maxDepth:10,maxNodes:1000},parse:()=>document};
 const ctx={deps:{records:{artifacts:{source:async()=>({bytes,mediaType:'text/plain',size:bytes.length,readTier:'model_readable',artifact:{digest:'artifact-'+sha,body:{sha256:sha,provenance_type:'declared'}}})},store:{get:async()=>null}},knowledge:{treeReader:()=>({})}},parsers:createParserRegistry([parser]),documents:createDocumentCache(),log:()=>{}} as unknown as EngineContext;
 const scope:RunScope={reader:{user:'synthetic',role:'user'},sources:new Map([[sha,'expected']]),records:new Map(),subject:{shas:new Set([sha]),records:new Set()},root:null,catalogs:[],candidates:async()=>[]};
 const items=Array.from({length:40},(_,i)=>({id:'item-'+i,location:ref(i+1)})) as ItemProjection[];
 const submission={run:'synthetic',model:'synthetic',items:items.map(item=>({item:item.id,handling:'handled',slots:{}})),cross_item:items.map((_,i)=>({nature:'fact',statement:'synthetic',grounds:[ref(i+41)]})),criterion_changes:[{item:items[0].id,criterion:ref(81),assertion:'synthetic',old:'synthetic',new:'changed',grounds:[{reference:ref(82),quote:'synthetic'}]}]} as Submission;
 const workflow={slots:{item:{}}} as LoadedWorkflow;
 const result=await resolveSubmission(scope,createResolver(ctx,scope,'model'),workflow,items,submission);
 assert.deepEqual(result.errors,[]);
 assert.equal(batches.length,1,'all 82 selectors share the single simulated locate call');
 assert.equal(batches[0].length,82);
 assert.equal(singles,0,'no individual locate starts a second simulated sandbox call');
});
