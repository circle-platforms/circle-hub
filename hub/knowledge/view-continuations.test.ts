import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {BASE_CATALOG,DEFAULT_PRODUCERS,catalogXml,extraProducer,makeWorld,startPostgres} from './test-support.ts';
import {completeKnowledgeView} from './complete-view.ts';
import {createKnowledgeReader} from './api.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
test('index and facet continuations exhaust all keys and reject cursors for a different query',async t=>{
 const entries=Array.from({length:40},(_,i)=>({kind:'case',path:null,statement:`synthetic ${i}`,data:{document:`doc-${String(i).padStart(3,'0')}`,shared:'same'},fragments:[{parser:'xml@1',selector:'x/catalog/group[1]/command[1]'}],applicability:null}));
 const w=await makeWorld(postgres,{pack:{declaration:{producers:[DEFAULT_PRODUCERS[0],extraProducer('cases',{entries})]}},knowledge:{limits:{maxViewBytes:65536+1000}}});t.after(()=>w.close());
 const name='Rel_ACME_10_6_1_71';w.external.set(`site:tree:${name}`,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const result=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.6.1',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:`site:tree:${name}`}}});assert.equal(result.ok,true,result.reason??'');
 const reader=createKnowledgeReader(w.knowledge);
 for(const type of ['index','facets']){
  const first=`knowledge:${type}:acme:${name}?kind=case&${type==='index'?'key=document':'by=document'}`;
  let next:string|null=first,continuation:string|null=null,rounds=0;const seen=new Set<string>();
  do{
   const read=await reader.read(next,{principal:w.user,run:null,purpose:'synthetic pagination'});assert.equal(read.ok,true,JSON.stringify(read));if(!read.ok)break;
   const source=await w.kit.artifacts.source(w.user,read.artifacts[0].artifact.body.sha256,{consumer:'function'});
   const view=JSON.parse(Buffer.from(source!.bytes!).toString());
   for(const key of type==='index'?Object.keys(view.keys):view.rows.map((row:any)=>row.values.document)){assert.ok(!seen.has(key));seen.add(key);}
   next=view.next??null;
   if(rounds===0){continuation=next;assert.ok(next,'an incomplete first page must supply a continuation');assert.ok(next.includes('after='));
    const mismatch=await reader.read(next.replace(type==='index'?'key=document':'by=document',type==='index'?'key=shared':'by=shared'),{principal:w.user,run:null,purpose:'synthetic wrong query'});
    assert.equal(mismatch.ok,false);if(!mismatch.ok)assert.match(mismatch.reason,/游标/);
   }
   assert.ok(++rounds<100,'continuation must advance');
  }while(next!==null);
  assert.equal(seen.size,40);assert.ok(rounds>1);
  if(type==='index'){
   const tied=await completeKnowledgeView(first.replace('key=document','key=shared'),{principal:w.user,run:null,purpose:'synthetic single-key continuation'},reader,w.kit);
   assert.equal(tied.ok,true,JSON.stringify(tied));if(tied.ok){const bytes=await w.kit.artifacts.source(w.user,tied.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.equal(JSON.parse(Buffer.from(bytes!.bytes!).toString()).keys.same.length,40);}
  }
  const fromCursor=await completeKnowledgeView(continuation!,{principal:w.user,run:null,purpose:'synthetic binding from a continuation'},reader,w.kit);
  assert.equal(fromCursor.ok,true,JSON.stringify(fromCursor));if(fromCursor.ok){const bytes=await w.kit.artifacts.source(w.user,fromCursor.artifacts[0].artifact.body.sha256,{consumer:'function'});const all=JSON.parse(Buffer.from(bytes!.bytes!).toString());assert.equal(type==='index'?Object.keys(all.keys).length:all.rows.length,40,'a run binding must begin at the first page even when the caller supplies a continuation');}
  const completed=await completeKnowledgeView(first,{principal:w.user,run:null,purpose:'synthetic full binding'},reader,w.kit);
  assert.equal(completed.ok,true,JSON.stringify(completed));if(completed.ok){
   const source=await w.kit.artifacts.source(w.user,completed.artifacts[0].artifact.body.sha256,{consumer:'function'});
   const all=JSON.parse(Buffer.from(source!.bytes!).toString());assert.equal(all.next,null);assert.equal(all.truncated,false);
   assert.equal(type==='index'?Object.keys(all.keys).length:all.rows.length,40);
  }
 }
});

test('impact continuations deliver every changed path with both sides and stable totals',async t=>{
 const w=await makeWorld(postgres,{knowledge:{limits:{maxViewBytes:65536+3000}}});t.after(()=>w.close());
 const names=['Rel_ACME_10_6_1_71','Rel_ACME_10_6_1_72'];
 for(const [side,name] of names.entries()){
  w.external.set(`site:tree:${name}`,{bytes:catalogXml({synthetic:Array.from({length:12},(_,i)=>({name:`cmd${i}`,help:`synthetic description ${side}`}))}),mediaType:'application/xml'});
  const result=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.6.1',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:`site:tree:${name}`}}});assert.equal(result.ok,true,result.reason??'');
 }
 const reader=createKnowledgeReader(w.knowledge),first=`knowledge:impact:acme:${names.join('..')}?changed=definition&attached=case`;
 let next:string|null=first,rounds=0;const seen=new Set<string>();
 do{
  const read=await reader.read(next,{principal:w.user,run:null,purpose:'synthetic impact pagination'});assert.equal(read.ok,true,JSON.stringify(read));if(!read.ok)break;
  const source=await w.kit.artifacts.source(w.user,read.artifacts[0].artifact.body.sha256,{consumer:'function'});
  const view=JSON.parse(Buffer.from(source!.bytes!).toString());assert.equal(view.totals.changed_paths,12);
  for(const change of view.changes){assert.ok(!seen.has(change.path));seen.add(change.path);assert.ok(view.entries[change.before[0]]);assert.ok(view.entries[change.after[0]]);}
  next=view.next??null;assert.ok(++rounds<20);
 }while(next!==null);
 assert.equal(seen.size,12);assert.ok(rounds>1);
 const completed=await completeKnowledgeView(first,{principal:w.user,run:null,purpose:'synthetic full impact'},reader,w.kit);
 assert.equal(completed.ok,true,JSON.stringify(completed));
});

test('a complete binding may accumulate more than a single page limit under one key',async t=>{
 const entries=Array.from({length:2101},(_,i)=>({kind:'case',path:null,statement:`synthetic case ${i}`,data:{shared:'same'},fragments:[{parser:'xml@1',selector:'x/catalog/group[1]/command[1]'}],applicability:null}));
 const w=await makeWorld(postgres,{pack:{declaration:{producers:[DEFAULT_PRODUCERS[0],extraProducer('cases',{entries})]}},knowledge:{limits:{maxViewBytes:65536+2*1024*1024}}});t.after(()=>w.close());
 const name='Rel_ACME_10_6_1_71';w.external.set(`site:tree:${name}`,{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const result=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.6.1',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:`site:tree:${name}`}}});assert.equal(result.ok,true,result.reason??'');
 const reader=createKnowledgeReader(w.knowledge),read=await completeKnowledgeView(`knowledge:index:acme:${name}?kind=case&key=shared`,{principal:w.user,run:null,purpose:'synthetic complete large key'},reader,w.kit);
 assert.equal(read.ok,true,JSON.stringify(read));if(read.ok){const source=await w.kit.artifacts.source(w.user,read.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.equal(JSON.parse(Buffer.from(source!.bytes!).toString()).keys.same.length,2101);}
});
