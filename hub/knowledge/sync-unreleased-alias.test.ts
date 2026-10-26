import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {BASE_CATALOG,catalogXml,makeWorld,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
for(const published of [false,true])test(`unpublished alias base has a production obligation only for a published alias: ${published}`,async t=>{
 const name='Rel_ACME_10_8_1_71';
 const base={name,family:'ACME',line:'10.8.1',base:name,platform:'zx-u',built_at:null,released_at:null,sources:{tree:'site:tree:synthetic'}};
 const alias={...base,name:'Rel_ZETA_10_8_1_72',family:'ZETA',released_at:published?'2026-10-01T00:00:00.000Z':null,sources:{}};
 const w=await makeWorld(postgres,{pack:{functions:{'plan.ts':`export default ()=>({fetch:[],builds:${JSON.stringify([base,alias])},done:true});`}}});t.after(()=>w.close());
 w.external.set('site:page:index',{bytes:'<p>synthetic index</p>',mediaType:'text/html'});w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 for(let round=0;round<2;round++){
  const report=await w.knowledge.syncProduct(w.product);assert.equal(report.error,null);assert.equal(report.counts.failed,0,JSON.stringify(report));
  assert.equal(report.counts.produced,published&&round===0?1:0);
  assert.equal(Boolean((await w.knowledge.resolveBuild('acme',alias.name))?.root),published);
  assert.equal(report.builds.find(row=>row.name===alias.name)?.outcome,'skipped');
 }
});
