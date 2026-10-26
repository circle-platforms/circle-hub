import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {BASE_CATALOG,DEFAULT_PRODUCERS,catalogXml,makeWorld,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
const name='Rel_ACME_10_6_1_71';
const base={name,family:'ACME',line:'10.6.1',base:name,platform:null,built_at:null,released_at:'2026-10-01T00:00:00.000Z',sources:{tree:'site:tree:synthetic'}};
test('a missing alias base is returned to the plan before build processing',async t=>{
 const alias={...base,name:'Rel_ZETA_10_6_1_72',family:'ZETA',sources:{}};
 const fn=`export default input=>({fetch:[],builds:input.options.required_builds?.includes(${JSON.stringify(name)})?${JSON.stringify([base,alias])}:${JSON.stringify([alias])},done:true});`;
 const w=await makeWorld(postgres,{pack:{functions:{'plan.ts':fn}}});t.after(()=>w.close());w.external.set('site:page:index',{bytes:'<p>synthetic index</p>',mediaType:'text/html'});w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const report=await w.knowledge.syncProduct(w.product);assert.equal(report.error,null);assert.ok(report.plan.rounds>1);assert.equal(report.counts.produced,1,JSON.stringify(report));
 assert.ok((await w.knowledge.resolveBuild('acme',alias.name))?.root);
});
test('an unfinished bounded plan resumes its pending pages instead of rereading its start forever',async t=>{
 const fn=`export default input=>input.read['site:page:next']?({fetch:[],builds:${JSON.stringify([base])},done:true}):({fetch:['site:page:next'],builds:[],done:false});`;
 const w=await makeWorld(postgres,{pack:{functions:{'plan.ts':fn},declaration:{sync:{start:['site:page:index'],plan:{module:'functions/plan.ts'},max_rounds:1,max_reads:1}}}});t.after(()=>w.close());
 for(const id of ['site:page:index','site:page:next'])w.external.set(id,{bytes:`<p>${id}</p>`,mediaType:'text/html'});w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const first=await w.knowledge.syncProduct(w.product);assert.equal(first.plan.done,false);
 const second=await w.knowledge.syncProduct(w.product);assert.equal(second.plan.done,true,JSON.stringify(second));assert.equal(second.counts.produced,1);
 assert.equal(w.external.reads.filter(id=>id==='site:page:index').length,1);assert.equal(w.external.reads.filter(id=>id==='site:page:next').length,1);
});

for(const status of [403,404])for(const completedAbsence of status===404?[false,true]:[false])test(`HTTP ${status} with completed absence ${completedAbsence} is a determined build observation with an explicit recovery path`,async t=>{
 const {ReadManifest}=await import('../../contracts/src/resources.ts');const {newId}=await import('../records/api.ts');
 const w=await makeWorld(postgres,{pack:{functions:{'plan.ts':`export default input=>({fetch:[],builds:input.options.builds??${JSON.stringify([base])},done:true});`},declaration:{producers:[...DEFAULT_PRODUCERS,{id:'manual',title:'synthetic manual',function:{module:'functions/manual.ts'},inputs:{manual:{source:'manual',optional:true}}}]}}});t.after(()=>w.close());
 w.external.set('site:page:index',{bytes:'<p>synthetic index version one</p>',mediaType:'text/html'});w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const previous=w.external.read.bind(w.external);let blocked=true,attempts=0,failedId='site:tree:synthetic';
 w.external.read=async(id,context)=>{
  if(id!==failedId||!blocked)return previous(id,context);attempts++;
  const at=new Date().toISOString(),code=status===404?'SOURCE_ABSENT':'SOURCE_FORBIDDEN';
  const body=ReadManifest.parse({action:'read',run:null,item:null,inputs:[],component:'connectors@1',lease:null,started_at:at,ended_at:at,result:'error',error_code:code,external:id,revision:null,resource:newId('res'),environment:'test',system_pack:{id:'synthetic-site',version:'1.0.0',digest:'b'.repeat(64)},read:'tree',principal:w.admin.id,purpose:'synthetic source refusal',requests:[{key:'page',round:1,route:'page',method:'GET',path:'/synthetic',query:{},started_at:at,ended_at:at,status,ok:false,error:code,sha256:null,size:null,media_type:null,etag:null,artifact:null,after_login:false}],reads:[],original:null,artifacts:[],coverage:{complete:false,examined:0,total:1},reason:'synthetic failure',warnings:[]});
  if(completedAbsence){body.result='completed';body.error_code=null;body.reason=null;body.original='page';body.coverage={complete:true,examined:1,total:1};body.requests[0].sha256='c'.repeat(64);body.requests[0].artifact='d'.repeat(64);}
  const record=await w.kit.store.put({kind:'action',schema:'read-manifest@1',provenance:'observed',body});
  if(completedAbsence)return {ok:true,id,revision:null,artifacts:[],manifest:record.digest,absent:{code:'SOURCE_ABSENT',system:'site',object:id,observed_at:at,responses:['page']}};
  return {ok:false,id,reason:'unrelated free text',manifest:record.digest};
 };
 const first=await w.knowledge.syncProduct(w.product);assert.equal(first.counts.failed,1);assert.equal((await w.knowledge.resolveBuild('acme',name))?.root,null);
 assert.equal((await w.knowledge.store.buildFailures('acme',{root:null})).length,1);
 const observations=await w.knowledge.store.productions('acme');assert.equal(observations.at(-1)?.detail.source_failures?.[0].status,status);
 if(status===404){
  const second=await w.knowledge.syncProduct(w.product);assert.equal(second.counts.failed,1);assert.equal(attempts,1,'unchanged listing must not retry a determined 404');
  blocked=false;w.external.set('site:page:index',{bytes:'<p>synthetic index version two</p>',mediaType:'text/html'});
  const recovered=await w.knowledge.syncProduct(w.product);assert.equal(recovered.counts.produced,1,JSON.stringify(recovered));
  blocked=true;failedId='site:manual:synthetic';
  const optional={...base,name:'Rel_ACME_10_6_1_73',base:'Rel_ACME_10_6_1_73',sources:{...base.sources,manual:failedId}};
  const withMissing=await w.knowledge.syncProduct(w.product,{options:{builds:[optional]}});assert.equal(withMissing.counts.produced,1,JSON.stringify(withMissing));
  const production=await w.knowledge.store.latestProduction('acme',optional.name);
  assert.ok(production!.detail.missing.some(row=>row.external===failedId&&row.conclusion?.includes('SOURCE_ABSENT')));
  const composition=await w.knowledge.store.composition(production!.detail.composition!);assert.ok(composition!.warnings.some(text=>text.includes('SOURCE_ABSENT')));
 }else{
  const requests=await w.kit.store.find<any>({key:'action.kind',value:'read',kind:'action',limit:100});
  assert.ok(requests.items.some(row=>row.body.detail?.audience_user===w.admin.id&&String(row.body.detail.next_action).includes('构建站负责人开放')));
 }
});
