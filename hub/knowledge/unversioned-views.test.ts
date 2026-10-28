import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import { after,before,test } from 'node:test';
import { makeUnversionedWorld,startPostgres } from './test-support.ts';
import { createKnowledgeReader } from './api.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
test('build views retain product-wide documents, provenance and uncut totals',async t=>{
 const w=await makeUnversionedWorld(pg);t.after(()=>w.close());
 const root=(await w.knowledge.unversionedRoot!('acme'))!;
 const reader=createKnowledgeReader(w.knowledge);
 for(const id of ['knowledge:index:acme:Synthetic_10_6?kind=case&key=document','knowledge:facets:acme:Synthetic_10_6?kind=case&by=module','knowledge:impact:acme:Synthetic_10_6..Synthetic_10_6','knowledge:links:acme:Synthetic_10_6']){
  const read=await reader.read(id,{principal:w.admin,run:null,purpose:'synthetic scope view'});assert.ok(read.ok,JSON.stringify(read));
  const source=await w.kit.artifacts.source(w.admin,read.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.ok(source?.bytes);
  const view=JSON.parse(new TextDecoder().decode(source.bytes));
  assert.equal(view.unversioned.root,root.root,id);assert.equal(view.unversioned.build,null);
  assert.equal(view.unversioned.totals.entries,1);assert.equal(view.unversioned.totals.documents,1);
  assert.match(JSON.stringify(view),/构建未声明/);
  if(view.schema==='index-view@1'){assert.equal(view.total_entries,1);const entry=Object.values(view.entries)[0] as any;assert.equal(entry.root,root.root);assert.equal(entry.build,null);}
  if(view.schema==='facet-view@1'){assert.equal(view.total,1);assert.equal(view.rows[0].count,1);}
  const again=await reader.read(id,{principal:w.admin,run:null,purpose:'synthetic scope view'});assert.ok(again.ok);assert.equal(again.artifacts[0].artifact.body.sha256,read.artifacts[0].artifact.body.sha256);
 }
});

test('a startup snapshot stays pinned across pointer movement and changes external revision identity',async t=>{
 const w=await makeUnversionedWorld(pg);t.after(()=>w.close());
 const scope=(await w.knowledge.unversionedRoot!('acme'))!;
 const build=(await w.knowledge.rootOfBuild('acme','Synthetic_10_6'))!;
 const reader=createKnowledgeReader(w.knowledge),id='knowledge:index:acme:Synthetic_10_6?kind=case&key=document';
 const locked={principal:w.admin,run:'run_0123456789abcdefghjkmnpqrs',purpose:'synthetic startup',composition:build.composition,build:build.build.name,unversioned:{root:scope.root,composition:scope.composition}};
 const before=await reader.read(id,locked);assert.ok(before.ok);
 w.external.set('site:tree:scope',{bytes:'<catalog changed="yes"/>',mediaType:'application/xml'});
 await w.knowledge.syncProduct(w.product,{recheck:true});
 assert.notEqual((await w.knowledge.unversionedRoot!('acme'))?.composition,scope.composition);
 const pinned=await reader.read(`${id}@${before.revision}`,locked);assert.ok(pinned.ok,JSON.stringify(pinned));
 assert.equal(pinned.artifacts[0].artifact.body.sha256,before.artifacts[0].artifact.body.sha256);
 const current=await reader.read(id,{principal:w.admin,run:null,purpose:'synthetic current'});assert.ok(current.ok);
 assert.notEqual(current.revision,before.revision);
 assert.equal((await reader.read(`${id}@${before.revision}`,{principal:w.admin,run:null,purpose:'synthetic current'})).ok,false);
});

test('moving an identical document out of the build root preserves index and facet coverage',async t=>{
 const w=await makeUnversionedWorld(pg,true);t.after(()=>w.close());
 const reader=createKnowledgeReader(w.knowledge);
 const ids=['knowledge:index:acme:Synthetic_10_6?kind=case&key=document','knowledge:facets:acme:Synthetic_10_6?kind=case&by=module'];
 const read=async(id:string)=>{const r=await reader.read(id,{principal:w.admin,run:null,purpose:'synthetic move'});assert.ok(r.ok,JSON.stringify(r));const s=await w.kit.artifacts.source(w.admin,r.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.ok(s?.bytes);return JSON.parse(new TextDecoder().decode(s.bytes));};
 const before=await Promise.all(ids.map(read));
 assert.equal(before[0].total_entries,1);assert.equal(before[1].total,1);
 const entry=Object.keys(before[0].entries)[0];
 w.product.product.producers.find(p=>p.id==='docs')!.unversioned=true;
 w.product.digest='d'.repeat(64);
 await w.knowledge.syncProduct(w.product,{options:{scope:true}});
 const after=await Promise.all(ids.map(read));
 assert.equal(after[0].total_entries,1);assert.equal(after[1].total,1);
 assert.deepEqual(Object.keys(after[0].entries),[entry]);
 assert.equal(after[0].entries[entry].build,null);
 assert.equal(after[1].rows[0].unversioned_count,1);
 assert.ok(after.every(v=>v.unversioned.totals.documents===1));
});

test('scope totals survive detail truncation and callback roots must match product and scope',async t=>{
 const w=await makeUnversionedWorld(pg,false,{entries:5,statementBytes:1600});t.after(()=>w.close());
 const {createKnowledge}=await import('./api.ts');const {createDefaultRegistry}=await import('../refs/api.ts');
 const options={records:w.kit,parsers:createDefaultRegistry(),packs:w.packs,external:w.external,admin:w.admin};
 const impossible=createKnowledge({...options,limits:{maxViewBytes:1400}});
 const small=createKnowledge({...options,limits:{maxViewBytes:65536+2600}});
 const at=(await small.rootOfBuild('acme','Synthetic_10_6'))!;
 await assert.rejects(impossible.views.index('acme',{build:at.build.name,root:at.root},'case','document',null),/单条.*超过.*上限/);
 const view=await small.views.index('acme',{build:at.build.name,root:at.root},'case','document',null);
 assert.equal(view.truncated,true);assert.equal(view.unversioned?.totals.documents,5);
 assert.equal(view.totals?.unversioned_entries,5);assert.ok(Object.keys(view.entries).length>0&&Object.keys(view.entries).length<5);assert.ok(view.next);
 const wrong=createKnowledge({records:w.kit,parsers:createDefaultRegistry(),packs:w.packs,external:w.external,admin:w.admin,additionalScopeRoots:async()=>[{root:"a".repeat(64),composition:at.composition}]});
 await assert.rejects(wrong.views.index('acme',{build:at.build.name,root:at.root},'case','document',null),/匹配的组成/);
});
