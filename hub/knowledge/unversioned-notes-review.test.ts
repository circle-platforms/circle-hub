import assert from 'node:assert/strict';
import{before,after,test}from'node:test';
import{makeUnversionedWorld,startPostgres}from'./test-support.ts';
import{createKnowledgeReader}from'./api.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
test('a locked absent scope describes the snapshot and requests a new run even after the product has a root',async t=>{
 const w=await makeUnversionedWorld(pg);t.after(()=>w.close());assert.ok(await w.knowledge.unversionedRoot!('acme'));
 const build=(await w.knowledge.rootOfBuild('acme','Synthetic_10_6'))!,reader=createKnowledgeReader(w.knowledge);
 const context={principal:w.admin,run:'run_0123456789abcdefghjkmnpqrs',purpose:'synthetic absent scope snapshot',composition:build.composition,build:build.build.name,unversioned:null};
 for(const id of ['knowledge:index:acme:Synthetic_10_6?kind=case&key=document','knowledge:facets:acme:Synthetic_10_6?kind=case&by=module','knowledge:impact:acme:Synthetic_10_6..Synthetic_10_6','knowledge:links:acme:Synthetic_10_6']){
  const read=await reader.read(id,context);assert.ok(read.ok,JSON.stringify(read));const source=await w.kit.artifacts.source(w.admin,read.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.ok(source?.bytes);
  const view=JSON.parse(Buffer.from(source.bytes).toString()),notes=view.notes.join('\n');assert.equal(view.unversioned,null);
  assert.match(notes,/本次.*锁定.*没有不分版本/);assert.match(notes,/同样输入新开运行/);assert.ok(!notes.includes('这条产品线还没有不分版本的根'));
 }
 const explicit=await w.knowledge.views.index('acme',{build:build.build.name,root:build.root},'case','document',null,null,new Set(),null,undefined,null);assert.match(explicit.notes.join('\n'),/同样输入新开运行/);
});
