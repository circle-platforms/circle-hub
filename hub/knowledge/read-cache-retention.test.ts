// One long-lived service, several roots and view types. Track only weak references so the observer cannot cause retention.
import assert from 'node:assert/strict';
import { before,after,test } from 'node:test';
import { Session } from 'node:inspector/promises';
import { setImmediate } from 'node:timers/promises';
import { LINK_MATCH } from '../../contracts/generated/vocabulary.ts';
import { Lru } from './store.ts';
import { entryDigest } from './digest.ts';
import { currentReadCache } from './read-cache.ts';
import { createKnowledgeReader } from './api.ts';
import { DEFAULT_PRODUCERS,catalogXml,extraProducer,makeWorld,startPostgres } from './test-support.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());

test('a long-lived service releases root, view, catalog and relation cache objects after each completed read', {timeout:120_000},async t=>{
  const entries=Array.from({length:700},(_,i)=>({kind:'case',path:i%2?null:'/notes/group'+i%20,statement:'Synthetic case '+i,data:{document:'document-'+i%40,node:'node-'+i,mentions:['alpha'],payload:'x'.repeat(1000)},fragments:[{parser:'xml@1',selector:'x/catalog'}],applicability:null}));
  const w=await makeWorld(postgres,{pack:{declaration:{links:[{id:'mentions',field:'mentions',namespace:'/terms',match:LINK_MATCH[0],entry_kind:'definition'}],producers:[...DEFAULT_PRODUCERS,extraProducer('extra',{entries:[...entries,{kind:'definition',path:'/terms/alpha',statement:'Alpha',data:{},fragments:[{parser:'xml@1',selector:'x/catalog'}],applicability:null}]})]}}});
  t.after(()=>w.close());
  const builds=[];
  for(let i=0;i<3;i++){
    const name='Rel_ACME_10_6_'+(20+i),tree='site:tree:retention-'+i;
    w.external.set(tree,{bytes:catalogXml({synthetic:[{name:'command'+i}]}),mediaType:'application/xml'});
    const result=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.6',base:name,platform:null,built_at:null,released_at:null,sources:{tree},root:null}});
    assert.ok(result.ok,result.reason??'');builds.push({name,root:result.root!});
  }
  const references:WeakRef<object>[]=[],scopes=new Set<NonNullable<ReturnType<typeof currentReadCache>>>();
  const original=Lru.prototype.set;
  Lru.prototype.set=function(this:Lru<unknown,unknown>,key:unknown,value:unknown,weight=0):void {
    const scope=currentReadCache();
    if(scope){scopes.add(scope);if(value!==null&&typeof value==='object')references.push(new WeakRef(value));}
    original.call(this,key,value,weight);
  };
  t.after(()=>{Lru.prototype.set=original;});
  const inspector=new Session();inspector.connect();t.after(()=>inspector.disconnect());
  const reader=createKnowledgeReader(w.knowledge),context={principal:w.user,run:null,purpose:'合成缓存生命周期验证'};
  const hashes=new Map<string,string>();
  for(const build of [...builds,...builds]){
    for(const type of ['index','links'] as const){
      const id=type==='index'?`knowledge:index:acme:${build.name}?kind=case&key=document&fields=document,node`:`knowledge:links:acme:${build.name}?limit=10`;
      const result=await reader.read(id,context);assert.ok(result.ok,result.ok?'':result.reason);
      const digest=result.artifacts[0].artifact.body.sha256;
      if(hashes.has(id))assert.equal(digest,hashes.get(id));else hashes.set(id,digest);
      assert.ok([...scopes].every(scope=>scope.closed&&scope.states.size===0));
    }
    assert.ok(await w.knowledge.getNodes({root:build.root,paths:['/terms'],depth:1},w.user));
    assert.ok(await w.knowledge.catalog(build.root,'catalog@1'));
    const unplaced=entryDigest(entries[1]);
    assert.ok(await w.knowledge.treeReader().read(build.root,'/',unplaced,{user:w.user.id,role:w.user.role}));
  }
  assert.ok(references.length>30,'the test exercised caches rather than disabling the reader');
  // This GC is a retention oracle after operation completion; it is not used by runtime code or the RSS budget.
  await setImmediate();await inspector.post('HeapProfiler.collectGarbage');await setImmediate();
  const live=references.filter(reference=>reference.deref()!==undefined);
  assert.equal(live.length,0,`${live.length} read-derived cache objects remain strongly referenced`);
  assert.deepEqual(w.knowledge.store.cachedEntries,{entries:0,bytes:0});
  assert.deepEqual(w.knowledge.store.cachedParts,{parts:0,bytes:0});
  t.diagnostic(JSON.stringify({roots:builds.length,reads:12,cachedObjects:references.length,retained:live.length}));
});
