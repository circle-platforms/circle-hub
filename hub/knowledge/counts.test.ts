import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {labelOf} from '../../contracts/generated/vocabulary.ts';
import {formatSyncReport} from './cli.ts';
import {createKnowledgeReader} from './api.ts';
import {completeKnowledgeView} from './complete-view.ts';
import {countWorld} from './counts-test-support.ts';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
let postgres:TemporaryPostgres;before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
const EXPECTED={total:5,placed:2,unplaced:3};
for(const parts of [false,true])test(`report and views count content identities consistently with ${parts?'parted':'inline'} rows`,async t=>{
 const w=await countWorld(postgres,{parts});t.after(()=>w.close());
 const report=await w.knowledge.syncProduct(w.product);assert.equal(report.error,null);
 const build=report.builds[0];assert.equal(build.outcome,'produced',build.reason);
 const composition=await w.knowledge.store.composition(build.composition!);assert.ok(composition);
 // The old report called three placed (path, content) rows its total while four content rows were unplaced.
 assert.equal(composition.counts.entries,3);assert.equal(composition.counts.unplaced,4);assert.ok(composition.counts.unplaced>composition.counts.entries);
 const rows=await w.knowledge.store.composition(build.composition!);assert.equal(Boolean(rows?.parts),parts);
 assert.deepEqual(build.entry_counts,EXPECTED);
 const at={build:build.name,root:build.root!,composition:build.composition!};
 const facets=await w.knowledge.views.facets(w.product.id,at,'case',['commands'],new Set(), null, undefined, null);
 const index=await w.knowledge.views.index(w.product.id,at,'case','commands',null,null,new Set(), null, undefined, null);
 assert.equal(facets.total,5);assert.deepEqual(facets.totals.entry_counts,EXPECTED);
 assert.equal(index.total_entries,2,'index carrier total still means entries carrying an index key');assert.deepEqual(index.totals?.entry_counts,EXPECTED);
 assert.match(formatSyncReport(report),/条目共 5 个（按内容去重/);
 assert.ok(build.reason.includes(labelOf('knowledge_count','tree_unplaced_entries')+' 3 个'));
 assert.ok(facets.notes.some(note=>note.includes(labelOf('knowledge_count','tree_unplaced_entries')+' 3 个')));
 assert.ok(index.notes.some(note=>note.includes(labelOf('knowledge_count','tree_unplaced_entries')+' 3 个')));
});
test('a root containing only unplaced content reports it in the total',async t=>{
 const w=await countWorld(postgres,{onlyUnplaced:true});t.after(()=>w.close());
 const report=await w.knowledge.syncProduct(w.product);const build=report.builds[0];assert.equal(build.outcome,'produced',build.reason);
 assert.deepEqual(build.entry_counts,{total:3,placed:0,unplaced:3});assert.match(build.reason,/条目共 3 个/);
});
test('build and product-wide reports stay separate while a locked combined view deduplicates both roots',async t=>{
 const w=await countWorld(postgres,{scope:true});t.after(()=>w.close());
 const report=await w.knowledge.syncProduct(w.product),build=report.builds[0],scope=report.scope!;
 assert.equal(scope.outcome,'produced',scope.reason);assert.deepEqual(build.entry_counts,EXPECTED);assert.deepEqual(scope.entry_counts,{total:2,placed:0,unplaced:2});
 const combined=await w.knowledge.views.facets(w.product.id,{build:build.name,root:build.root!,composition:build.composition!},'case',['commands'],new Set(),null,undefined,{root:scope.root!,composition:scope.composition!});
 assert.equal(combined.total,6);assert.deepEqual(combined.totals.entry_counts,{total:6,placed:2,unplaced:4});
 assert.match(formatSyncReport(report),/不分版本 \[产出\]：构建未声明/);
});
test('detail truncation and an index value filter leave complete content counts intact', async t => {
 const w = await countWorld(postgres, { maxViewBytes: 65536+2100, pageKeys:true }); t.after(() => w.close());
 const report = await w.knowledge.syncProduct(w.product), build = report.builds[0];
 assert.equal(build.outcome, 'produced', build.reason);
 const at = { build: build.name, root: build.root!, composition: build.composition! };
 const facets = await w.knowledge.views.facets(w.product.id, at, 'case', ['page_key'], new Set(), null, undefined, null);
 const index = await w.knowledge.views.index(w.product.id, at, 'case', 'document', null, null, new Set(), null, undefined, null);
 const filtered = await w.knowledge.views.index(w.product.id, at, 'case', 'commands', ['/synthetic/a'], null, new Set(), null, undefined, null);
 assert.equal(facets.truncated, true);
 assert.equal(index.truncated, true);
 assert.equal(filtered.total_entries, 1, 'the filter still limits index carriers');
 assert.deepEqual(filtered.totals?.entry_counts, build.entry_counts);
 assert.deepEqual(facets.totals.entry_counts, build.entry_counts);
 assert.deepEqual(index.totals?.entry_counts, build.entry_counts);
 assert.deepEqual(build.entry_counts, EXPECTED);
});
test('a position in either locked root wins the summary without changing the build-preferred reference', async t => {
 const w = await countWorld(postgres, { scope: true, scopePlacesOverlap: true }); t.after(() => w.close());
 const report = await w.knowledge.syncProduct(w.product), build = report.builds[0], scope = report.scope!;
 assert.equal(scope.outcome, 'produced', scope.reason);
 assert.deepEqual(build.entry_counts, EXPECTED);
 assert.deepEqual(scope.entry_counts, { total: 2, placed: 1, unplaced: 1 });
 const at = { build: build.name, root: build.root!, composition: build.composition! };
 const scopeRoot = { root: scope.root!, composition: scope.composition! };
 const facets = await w.knowledge.views.facets(w.product.id, at, 'case', ['commands'], new Set(), null, undefined, scopeRoot);
 const index = await w.knowledge.views.index(w.product.id, at, 'case', 'module', null, null, new Set(), null, undefined, scopeRoot);
 assert.deepEqual(facets.totals.entry_counts, { total: 6, placed: 3, unplaced: 3 });
 assert.deepEqual(index.totals?.entry_counts, facets.totals.entry_counts);
 const filtered = await w.knowledge.views.index(w.product.id, at, 'case', 'commands', ['/synthetic/a'], null, new Set(), null, undefined, scopeRoot);
 assert.deepEqual(filtered.totals?.entry_counts, facets.totals.entry_counts, 'scope positions are counted even outside the requested index values');
 const overlap = Object.values(index.entries).find(entry => entry.statement === 'B');
 assert.ok(overlap);
 assert.ok(overlap.reference.startsWith(`tree:${build.root}/@`), overlap.reference);
 assert.ok(!Object.hasOwn(overlap, 'build'), 'existing main-root carrier preference stays intact');
});


test('paginated scoped views keep complete deduplicated counts and scope on every page and end without truncation',async t=>{
 const w=await countWorld(postgres,{scope:true,pageKeys:true,maxViewBytes:65536+2100});t.after(()=>w.close());
 const report=await w.knowledge.syncProduct(w.product),build=report.builds[0];assert.equal(build.outcome,'produced',build.reason);
 const expected={total:6,placed:2,unplaced:4},reader=createKnowledgeReader(w.knowledge);
 const context={principal:w.user,run:null,purpose:'synthetic merged count pagination'};
 for(const type of ['facets','index']){
  const first=`knowledge:${type}:${w.product.id}:${build.name}?kind=case&${type==='facets'?'by=page_key':'key=document'}`;
  let next:string|null=first,pages=0,last:any,scope:unknown;const seen=new Set<string>();
  do{
   const read=await reader.read(next,context);assert.equal(read.ok,true,JSON.stringify(read));if(!read.ok)break;
   const source=await w.kit.artifacts.source(w.user,read.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.ok(source?.bytes);
   const view=JSON.parse(Buffer.from(source.bytes).toString());assert.deepEqual(view.totals.entry_counts,expected);assert.ok(view.scope);
   scope??=view.scope;assert.deepEqual(view.scope,scope);
   const members=type==='facets'?view.rows.map((row:any)=>row.values.page_key):Object.keys(view.entries);
   for(const member of members){assert.ok(!seen.has(member));seen.add(member);}
   next=view.next;last=view;assert.ok(++pages<20);
   if(next!==null)assert.equal(view.truncated,true);
  }while(next!==null);
  assert.ok(pages>1);assert.equal(seen.size,expected.total);assert.equal(last.truncated,false);assert.equal(last.next,null);
  const complete=await completeKnowledgeView(first,context,reader,w.kit);assert.equal(complete.ok,true,JSON.stringify(complete));if(!complete.ok)continue;
  const source=await w.kit.artifacts.source(w.user,complete.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.ok(source?.bytes);
  const view=JSON.parse(Buffer.from(source.bytes).toString());assert.deepEqual(view.totals.entry_counts,expected);assert.deepEqual(view.scope,scope);assert.equal(view.truncated,false);assert.equal(view.next,null);
 }
});
