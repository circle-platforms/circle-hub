import assert from 'node:assert/strict';
import{before,after,test}from'node:test';
import{makeWorld,startPostgres,BASE_CATALOG,catalogXml,DEFAULT_PRODUCERS}from'./test-support.ts';
import{createKnowledgeReader}from'./api.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
test('skipped totals disclose the build-plus-scope boundary and name scope source recovery',async t=>{
 const build={name:'Synthetic_10_6',base:'Synthetic_10_6',family:'ACME',line:'10.6',platform:null,built_at:null,released_at:'2026-10-24T00:00:00.000Z',sources:{tree:'site:tree:build'}};
 const w=await makeWorld(pg,{pack:{functions:{'plan.ts':`export default()=>({fetch:[],builds:[${JSON.stringify(build)}],scope:{docs:['site:tree:good','site:tree:missing']},done:true});`,'scope.ts':`export default input=>({entries:input.lists.docs.map(source=>({path:'/docs/'+source.model.root.attributes.id,kind:'case',statement:'synthetic case',data:{document:source.model.root.attributes.id},applicability:null,fragments:[{slot:'docs',source:source.sha256,parser:'xml@1',selector:'x/catalog'}]})),warnings:[]});`},declaration:{producers:[...DEFAULT_PRODUCERS,{id:'scope_docs',title:'文档',unversioned:true,function:{module:'functions/scope.ts'},inputs:{docs:{source:'docs',many:true,optional:true}}}]}}});t.after(()=>w.close());
 w.external.set('site:tree:build',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});w.external.set('site:tree:good',{bytes:'<catalog id="good"/>',mediaType:'application/xml'});
 const sync=await w.knowledge.syncProduct(w.product);assert.equal(sync.scope?.outcome,'produced',JSON.stringify(sync));const root=sync.scope.root!;
 for(const id of ['knowledge:index:acme:Synthetic_10_6?kind=case&key=document','knowledge:facets:acme:Synthetic_10_6?kind=case&by=document','knowledge:impact:acme:Synthetic_10_6..Synthetic_10_6','knowledge:links:acme:Synthetic_10_6']){
  const read=await createKnowledgeReader(w.knowledge).read(id,{principal:w.admin,run:null,purpose:'synthetic skipped scope'});assert.ok(read.ok,JSON.stringify(read));const source=await w.kit.artifacts.source(w.admin,read.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.ok(source?.bytes);
  const view=JSON.parse(Buffer.from(source.bytes).toString()),notes=view.notes.join('\n');assert.equal(view.unversioned.skipped_sources,1);
  if(view.schema==='impact-view@1')assert.deepEqual(view.skipped,{from:1,to:1});else if(view.schema!=='links-view@1')assert.equal(view.skipped,1);
  assert.ok(notes.includes(root));assert.match(notes,/不分版本.*1 份.*来源/);assert.match(notes,/生产器.*scope_docs/);assert.match(notes,/自动重读|重新同步/);assert.match(notes,/不能.*没有|不能.*不存在/);
 }
});
