import assert from 'node:assert/strict';
import{before,after,test}from'node:test';
import{makeWorld,startPostgres,extraProducer}from'./test-support.ts';
import{createKnowledgeReader}from'./api.ts';
import{LINK_MATCH}from'../../contracts/generated/vocabulary.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
for(const budget of [24576,262144])test(`links share one byte budget and deliver the scope payload only on the first page (${budget})`,async t=>{
 const fragment=[{slot:'tree',parser:'xml@1',selector:'x/catalog'}];
 const entry=(path:string,kind:string,statement:string,data:Record<string,unknown>)=>({path,kind,statement,data,applicability:null,fragments:fragment});
 const entities=[entry('/terms/term','definition','term',{}),...Array.from({length:10},(_,i)=>entry('/notes/n'+i,'behaviour','synthetic mention '+i,{mentions:['term']}))];
 const docs=Array.from({length:200},(_,i)=>entry('/docs/d'+i,'case','Synthetic document '+i,{document:'doc-'+i}));
 const build={name:'Synthetic_10_6',base:'Synthetic_10_6',family:'ACME',line:'10.6',platform:null,built_at:null,released_at:'2026-10-24T00:00:00.000Z',sources:{tree:'site:tree:build'}};
 const w=await makeWorld(pg,{knowledge:{limits:{maxViewBytes:budget}},pack:{functions:{'plan.ts':`export default()=>({fetch:[],builds:[${JSON.stringify(build)}],scope:{docs:'site:tree:scope'},done:true});`},declaration:{catalogs:[],links:[{id:'mentions',field:'mentions',namespace:'/terms',match:LINK_MATCH[0],entry_kind:'definition',source_producers:['entities'],target_producers:['entities']}],producers:[extraProducer('entities',{entries:entities}),{...extraProducer('docs',{entries:docs},{tree:{source:'docs'}}),unversioned:true}]}}});t.after(()=>w.close());
 for(const part of ['build','scope'])w.external.set('site:tree:'+part,{bytes:'<catalog/>',mediaType:'application/xml'});
 const sync=await w.knowledge.syncProduct(w.product);assert.equal(sync.error,null);assert.equal(sync.scope?.outcome,'produced');
 const reader=createKnowledgeReader(w.knowledge),id='knowledge:links:acme:Synthetic_10_6?limit=2';let cursor:string|null=null,pages=0,returned=0,cut:number|undefined;
 do{
  const read=await reader.read(id+(cursor?'&cursor='+encodeURIComponent(cursor):''),{principal:w.admin,run:null,purpose:'synthetic shared budget'});assert.ok(read.ok,JSON.stringify(read));
  const source=await w.kit.artifacts.source(w.admin,read.artifacts[0].artifact.body.sha256,{consumer:'function'});assert.ok(source?.bytes);assert.ok(source.bytes.byteLength<=budget);
  const view=JSON.parse(Buffer.from(source.bytes).toString()),n=Object.keys(view.entries??{}).length;
  if(pages===0){assert.ok(n>0,'even the smaller budget must deliver a scope prefix');cut=view.unversioned.totals.cut_entries;assert.equal(cut,200-n);if(budget===24576)assert.ok(cut!>0);else assert.equal(cut,0);}
  else assert.equal(n,0,'subsequent pages must not resend the scope payload');
  assert.equal(view.unversioned.totals.cut_entries,cut);assert.equal(view.totals.unversioned_entries_cut,cut);assert.equal(view.unversioned.totals.entries,200);
  if(pages===0&&budget===24576&&view.next){
   const forged=JSON.parse(Buffer.from(view.next,'base64url').toString());forged.scope_cut=0;
   const rejected=await reader.read(id+'&cursor='+encodeURIComponent(Buffer.from(JSON.stringify(forged)).toString('base64url')),{principal:w.admin,run:null,purpose:'synthetic inconsistent cut counter'});
   assert.equal(rejected.ok,false);if(!rejected.ok)assert.match(rejected.reason,/截断计数/);
  }
  returned+=n;cursor=view.next;assert.ok(++pages<20);
 }while(cursor);
 assert.ok(pages>1);assert.equal(returned+cut!,200);
});
