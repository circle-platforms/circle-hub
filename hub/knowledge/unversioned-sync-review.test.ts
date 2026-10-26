import {osIsolationAvailable} from '../rules/api.ts';
import assert from 'node:assert/strict';
import{before,after,test}from'node:test';
import{makeWorld,startPostgres,catalogXml,BASE_CATALOG,DEFAULT_PRODUCERS,DEFAULT_SYNC}from'./test-support.ts';
import{createKnowledge}from'./api.ts';
import{createDefaultRegistry}from'../refs/api.ts';
import{pointerName}from'./store.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
async function world(t:{after(fn:()=>Promise<void>):void}){
 const build={name:'Synthetic_10_6',base:'Synthetic_10_6',family:'ACME',line:'10.6',platform:null,built_at:null,released_at:'2026-10-24T00:00:00.000Z',sources:{tree:'site:tree:build'}};
 const w=await makeWorld(pg,{pack:{functions:{'plan.ts':`export default()=>({fetch:[],builds:[${JSON.stringify(build)}],scope:{docs:'site:tree:scope'},done:true});`,'scope.ts':`export default input=>({entries:[{path:'/docs',kind:'case',statement:input.slots.docs.model.root.attributes.revision,data:{document:'synthetic'},applicability:null,fragments:[{slot:'docs',parser:'xml@1',selector:'x/catalog'}]}],warnings:[]});`},declaration:{sync:DEFAULT_SYNC,producers:[...DEFAULT_PRODUCERS,{id:'docs',title:'文档',unversioned:true,function:{module:'functions/scope.ts'},inputs:{docs:{source:'docs'}}}]}}});t.after(()=>w.close());
 w.external.set('site:tree:build',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});w.external.set('site:tree:scope',{bytes:'<catalog revision="first"/>',mediaType:'application/xml'});return w;
}
test('a product-wide storage failure retains the report and reconciles successful build roots',async t=>{
 const w=await world(t),latest=w.knowledge.store.latestProduction.bind(w.knowledge.store);
 w.knowledge.store.latestProduction=async(product,base)=>{if(base===null)throw Error('synthetic product-wide store fault');return latest(product,base);};
 const report=await w.knowledge.syncProduct(w.product);assert.equal(report.error,null);assert.equal(report.builds[0].outcome,'produced');assert.equal(report.scope?.outcome,'failed');assert.equal(report.counts.failed,1);assert.ok(report.ended_at);assert.equal(report.pointers.find(row=>row.line==='10.6')?.moved,true);assert.match(report.scope?.reason??'',/重新同步/);
});
test('a product-wide pointer failure is a separate failed row and never suppresses build reconciliation',async t=>{
 const w=await world(t),move=w.kit.pointers.move.bind(w.kit.pointers);
 w.kit.pointers.move=async(input,tx)=>{if(input.name===pointerName('acme',null))throw Error('synthetic pointer fault');return move(input,tx);};
 const report=await w.knowledge.syncProduct(w.product);assert.equal(report.scope?.outcome,'produced');assert.equal(report.pointers.find(row=>row.line===null)?.moved,false);assert.match(report.pointers.find(row=>row.line===null)?.reason??'',/重新同步/);assert.equal(report.pointers.find(row=>row.line==='10.6')?.moved,true);
});
test('an aborted product-wide scope does not consult production storage',async t=>{
 const w=await world(t),latest=w.knowledge.store.latestProduction.bind(w.knowledge.store);let calls=0;
 w.knowledge.store.latestProduction=async(product,base)=>{if(base===null)calls++;return latest(product,base);};
 const controller=new AbortController();controller.abort();const report=await w.knowledge.syncProduct(w.product,{signal:controller.signal});assert.equal(report.scope?.outcome,'failed');assert.match(report.scope?.reason??'',/中止/);assert.equal(calls,0);
});
test('concurrent product-wide producers use their own cause and cannot overwrite a later pointer',async t=>{
 const w=await world(t),other=createKnowledge({sandbox:{requireOsIsolation:await osIsolationAvailable()},records:w.kit,parsers:createDefaultRegistry(),packs:w.packs,external:w.external,admin:w.admin});
 let start!:()=>void;const ready=new Promise<void>(resolve=>{start=resolve;});
 const rival=ready.then(()=>other.syncProduct(w.product,{recheck:true}));
 const move=w.kit.pointers.move.bind(w.kit.pointers);let injected=false;
 w.kit.pointers.move=async(input,tx)=>{if(input.name===pointerName('acme',null)&&!injected){injected=true;w.external.set('site:tree:scope',{bytes:'<catalog revision="second"/>',mediaType:'application/xml'});start();await rival;}return move(input,tx);};
 const report=await w.knowledge.syncProduct(w.product),second=await rival;
 assert.notEqual(report.scope?.root,second.scope?.root);assert.equal(report.scope?.outcome,'produced');assert.equal(report.pointers.find(row=>row.line===null)?.moved,false);assert.equal((await other.unversionedRoot!('acme'))?.root,second.scope?.root);
});
