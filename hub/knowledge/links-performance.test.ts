// A synthetic root with about twenty thousand entries, exercised through stored production and the real reader.
import assert from 'node:assert/strict';
import { after,before,test } from 'node:test';
import { LINK_MATCH } from '../../contracts/generated/vocabulary.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import { createKnowledgeReader } from './api.ts';
import { catalogXml,extraProducer,makeWorld,startPostgres } from './test-support.ts';
import type { TemporaryPostgres } from '../testing/postgres.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
test('twenty thousand stored entries retain exact totals with bounded page details',async t=>{
  const fragment=[{parser:'xml@1',selector:'x/catalog'}];
  const entries=Array.from({length:20000},(_,i)=>({path:`/notes/g${i%100}`,kind:'behaviour',statement:`Synthetic note ${i}`,data:{mentions:[i%2?'alpha Value':'gone']},fragments:fragment,applicability:null}));
  entries.push({path:'/terms/alpha',kind:'definition',statement:'Alpha',data:{} as {mentions:string[]},fragments:fragment,applicability:null});
  const w=await makeWorld(postgres,{pack:{id:'measure',names:['MEASURE'],declaration:{catalogs:[],links:[{id:'mentions',field:'mentions',namespace:'/terms',match:LINK_MATCH[1],entry_kind:'definition'}],producers:[extraProducer('entities',{entries})]}}});t.after(()=>w.close());
  w.external.set('site:tree:large',{bytes:catalogXml({sample:[{name:'node'}]}),mediaType:'application/xml'});
  const build:KnownBuild={name:'Rel_MEASURE_10_6_1_1',family:'MEASURE',line:'10.6.1',base:'Rel_MEASURE_10_6_1_1',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:large'},root:null};
  const root=await w.knowledge.produceTree({product:w.product,build});assert.ok(root.ok,root.reason??'');
  const reader=createKnowledgeReader(w.knowledge),context={principal:w.admin,run:null,purpose:'synthetic performance',composition:root.composition};
  const start=performance.now(),first=await reader.read('knowledge:links:measure:10.6.1?limit=10',context),cold=performance.now()-start;assert.ok(first.ok,first.ok?'':first.reason);
  const warmStart=performance.now(),again=await reader.read('knowledge:links:measure:10.6.1?limit=10',context),warm=performance.now()-warmStart;assert.ok(again.ok,again.ok?'':again.reason);
  assert.equal(first.artifacts[0].artifact.body.sha256,again.artifacts[0].artifact.body.sha256);
  const bytes=await w.kit.objects.get(first.artifacts[0].artifact.body.sha256);assert.ok(bytes);const value=JSON.parse(Buffer.from(bytes).toString('utf8'));
  assert.equal(value.totals.entries,20000);assert.equal(value.totals.links,10000);assert.equal(value.totals.drift_occurrences,10000);assert.equal(value.totals.drift_literals,1);assert.equal(value.links.length,10);assert.ok(value.next);
  t.diagnostic(`Synthetic entries 20001; cold ${cold.toFixed(1)} ms; warm ${warm.toFixed(1)} ms; page bytes ${bytes.byteLength}`);
});

test('get_nodes over a deep twenty-thousand-entry root retains compact reverse counts on every target',async t=>{
  const fragments=[{parser:'xml@1',selector:'x/catalog'}];
  const entries=Array.from({length:20000},(_,index)=>({path:'/notes/b'+(index%500)+'/level/sub/leaf',kind:'behaviour',statement:'Deep synthetic note '+index,data:{mentions:['level sub alpha'+(index%20)+' Value']},fragments,applicability:null}));
  for(let index=0;index<20;index++)entries.push({path:'/terms/level/sub/alpha'+index,kind:'definition',statement:'Definition '+index,data:{} as {mentions:string[]},fragments,applicability:null});
  const w=await makeWorld(postgres,{pack:{id:'measure',names:['MEASURE'],declaration:{catalogs:[],links:[{id:'mentions',field:'mentions',namespace:'/terms',match:LINK_MATCH[1],entry_kind:'definition'}],producers:[extraProducer('entities',{entries})]}}});t.after(()=>w.close());
  w.external.set('site:tree:deep',{bytes:catalogXml({sample:[{name:'node'}]}),mediaType:'application/xml'});
  const build:KnownBuild={name:'Rel_MEASURE_10_6_2_1',family:'MEASURE',line:'10.6.2',base:'Rel_MEASURE_10_6_2_1',platform:null,built_at:null,released_at:null,sources:{tree:'site:tree:deep'},root:null};
  const root=await w.knowledge.produceTree({product:w.product,build});assert.ok(root.ok,root.reason??'');
  const query={root:root.root!,composition:root.composition!,paths:['/terms'],depth:4};
  const start=performance.now(),first=await w.knowledge.getNodes(query,w.admin),cold=performance.now()-start;
  const againStart=performance.now(),again=await w.knowledge.getNodes(query,w.admin),warm=performance.now()-againStart;
  assert.ok(first);assert.deepEqual(again,first);
  const definitions=first.nodes.filter(node=>node.entries.some(entry=>entry.kind==='definition'));assert.equal(definitions.length,20);
  assert.ok(definitions.every(node=>node.backlinks?.total===1000&&node.backlinks.entries.length===20&&node.backlinks.truncated));
  const composition=await w.knowledge.store.composition(root.composition!);assert.ok(composition);assert.ok(composition.counts.nodes>2000);
  t.diagnostic('Deep synthetic entries 20020; nodes '+composition.counts.nodes+'; first get_nodes '+cold.toFixed(1)+' ms; warm '+warm.toFixed(1)+' ms; page nodes '+first.nodes.length);
});
