import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {ReadManifest} from '../../contracts/src/resources.ts';
import {newId} from '../records/api.ts';
import {BASE_CATALOG,DEFAULT_PRODUCERS,casesProducer,catalogXml,makeWorld,mindMap,startPostgres} from './test-support.ts';
let postgres:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{postgres=await startPostgres();});after(async()=>{await postgres?.stop();});
const name='Rel_ACME_10_6_1_71',flagged='store:mindmap:flagged',good='store:mindmap:good';
const build={name,family:'ACME',line:'10.6.1',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:'site:tree:synthetic',cases:[flagged,good]}};
async function setup(t:any,allowed:boolean,echo=false,connectorFailure=false,override?:{systemPack:string;slot:string}[]){
 let clock=new Date('2026-10-24T00:00:00.000Z');
 const w=await makeWorld(postgres,{now:()=>clock,pack:{declaration:{producers:[...DEFAULT_PRODUCERS,casesProducer({batch:2})]}},knowledge:{credentialAcceptance:{autoAcceptSources:override??(allowed?[{systemPack:'synthetic-documents',slot:'cases'}]:[])}} as any});t.after(()=>w.close());
 w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 w.external.set(flagged,{bytes:mindMap({id:'flagged'},[{id:'case',text:'[cmd: system show] password = SyntheticLab72#value'}]),mediaType:'application/json'});
 w.external.set(good,{bytes:mindMap({id:'good'},[{id:'case',text:'[cmd: system show] synthetic clean case'}]),mediaType:'application/json'});
 const previous=w.external.read.bind(w.external);
 w.external.read=async(id,context)=>{
  const read=await previous(id,context);if(!read.ok)return read;
  let artifact=read.artifacts[0].artifact;
  if(id===flagged&&echo)artifact=await w.kit.artifacts.ingest({bytes:Buffer.from(String((w.external.objects.get(id) as any).bytes)),mediaType:'application/json',origin:{read:{object:id}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.admin.id],admins:true,packs:[],shareable:false},readTier:'retain_only'});
  const withheld=connectorFailure&&artifact.body.read_tier==='retain_only',at=clock.toISOString();
  const body=ReadManifest.parse({action:'read',run:null,item:null,inputs:[],component:'connectors@1',lease:null,started_at:at,ended_at:at,result:withheld?'error':'completed',error_code:withheld?'SOURCE_CREDENTIAL':null,external:id,revision:null,resource:newId('res'),environment:'test',system_pack:{id:'synthetic-documents',version:'1.0.0',digest:'b'.repeat(64)},read:'document',principal:context.principal.id,purpose:'synthetic credential policy',requests:[{key:'page',round:1,route:'page',method:'GET',path:'/synthetic',query:{},started_at:at,ended_at:at,status:200,ok:!withheld,error:withheld?'SOURCE_CREDENTIAL':null,sha256:artifact.body.sha256,size:artifact.body.size,media_type:artifact.body.media_type,etag:null,artifact:artifact.digest,after_login:false}],reads:[],original:'page',artifacts:withheld?[]:[{name:'original',record:artifact.digest,sha256:artifact.body.sha256,size:artifact.body.size,media_type:artifact.body.media_type}],coverage:{complete:!withheld,examined:1,total:1},reason:withheld?'synthetic credential hold':null,warnings:[]});
  const manifest=await w.kit.store.put({kind:'action',schema:'read-manifest@1',provenance:'observed',body});
  return withheld?{ok:false,id,reason:'synthetic credential hold',manifest:manifest.digest}:{...read,artifacts:[{name:'original',artifact}],manifest:manifest.digest};
 };
 return {...w,advance:()=>{clock=new Date(clock.getTime()+73*3600000);}};
}
for(const connectorFailure of [false,true])test(`explicit system-pack and slot policy accepts ordinary examples (${connectorFailure})`,async t=>{
 const w=await setup(t,true,false,connectorFailure);
 const result=await w.knowledge.produceTree({product:w.product,build});assert.equal(result.ok,true,result.reason??'');assert.equal(result.skippedCount,0);
});
test('explicit retention never enters automatic acceptance',async t=>{
 const w=await setup(t,true,true,true);const result=await w.knowledge.produceTree({product:w.product,build});
 assert.equal(result.ok,true,result.reason??'');assert.equal(result.skippedCount,1);
 const rows=await w.kit.store.find<any>({key:'action.kind',value:'read',kind:'action',limit:100});assert.ok(rows.items.some(row=>row.body.detail?.credential?.external===flagged));
});
test('unlisted examples create a named 72-hour request and expiry creates a verification request without acceptance',async t=>{
 const w=await setup(t,false);const result=await w.knowledge.produceTree({product:w.product,build});assert.equal(result.ok,true,result.reason??'');assert.equal(result.skippedCount,1);
 const list=async()=>w.kit.store.find<any>({key:'action.kind',value:'read',kind:'action',limit:100});
 const first=(await list()).items.find(row=>row.body.detail?.credential?.external===flagged);assert.ok(first);assert.equal(first.body.detail.audience_user,w.admin.id);
 assert.equal(Date.parse(first.body.detail.deadline)-Date.parse(first.body.started_at),72*3600000);
 w.advance();await w.knowledge.syncProduct(w.product);
 const expired=(await list()).items.find(row=>row.body.detail?.expired_from===first.digest);assert.ok(expired);assert.equal(expired.body.detail.audience_user,w.admin.id);assert.equal(expired.body.detail.request_kind,'clarification');
 assert.equal((await w.kit.artifacts.source(w.admin,first.body.detail.credential.sha256))?.bytes,null);
});

for(const source of [{systemPack:'another-system',slot:'cases'},{systemPack:'synthetic-documents',slot:'another_slot'}])test('both the actual system pack and producer slot must match deployment policy',async t=>{
 const w=await setup(t,true,false,true,[source]);const result=await w.knowledge.produceTree({product:w.product,build});assert.equal(result.ok,true,result.reason??'');assert.equal(result.skippedCount,1);
});
test('automatic policy never reverses an administrator withdrawal',async t=>{
 const w=await setup(t,true,false,true);const first=await w.knowledge.produceTree({product:w.product,build});assert.equal(first.skippedCount,0);
 const sha=first.sources.find(row=>row.external===flagged)?.sha256??(await w.kit.store.find<any>({key:'artifact.object',value:flagged,kind:'source_artifact',limit:100})).items[0].body.sha256;
 await w.kit.artifacts.revokeFindings(w.admin,sha,'合成管理员撤回');
 const second=await w.knowledge.produceTree({product:w.product,build});assert.equal(second.ok,true,second.reason??'');assert.equal(second.skippedCount,1);
 assert.equal((await w.kit.artifacts.source(w.admin,sha))?.bytes,null);
});

test('a final view hold lists excluded references and the named administrator action without values',async t=>{
 const w=await makeWorld(postgres);t.after(()=>w.close());
 const name='Rel_ACME_10_6_1_81 password=FtpSyntheticBuild72';
 w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
 const result=await w.knowledge.produceTree({product:w.product,build:{name,family:'ACME',line:'10.6.1',base:name,platform:null,built_at:null,released_at:null,root:null,sources:{tree:'site:tree:synthetic'}}});assert.equal(result.ok,true,result.reason??'');
 const {createKnowledgeReader}=await import('./api.ts');
 const rejected=await createKnowledgeReader(w.knowledge).read(`knowledge:index:acme:${encodeURIComponent(name)}?kind=definition&key=words`,{principal:w.user,run:null,purpose:'synthetic final hold'});
 assert.equal(rejected.ok,false);if(rejected.ok)return;
 assert.match(rejected.reason,/被排除引用.*tree:/);assert.ok(rejected.reason.includes(w.admin.id));assert.match(rejected.reason,/核对请求 rec:[0-9a-f]{64}/);assert.match(rejected.reason,/完整清单/);assert.ok(!rejected.reason.includes('FtpSyntheticBuild72'));
});

test('the declared source policy handles more than one hundred ordinary findings without dropping entries',async t=>{
 const w=await setup(t,true,false,true);
 w.external.set(flagged,{bytes:mindMap({id:'flagged'},Array.from({length:143},(_,i)=>({id:`case-${i}`,text:`[cmd: system show] password = SyntheticLab72#value${i}`}))),mediaType:'application/json'});
 const result=await w.knowledge.produceTree({product:w.product,build});assert.equal(result.ok,true,result.reason??'');assert.equal(result.skippedCount,0);
 const {createKnowledgeReader}=await import('./api.ts');const read=await createKnowledgeReader(w.knowledge).read(`knowledge:index:acme:${name}?kind=case&key=document`,{principal:w.user,run:null,purpose:'synthetic large accepted view'});
 assert.equal(read.ok,true,JSON.stringify(read));if(!read.ok)return;
 assert.equal(read.artifacts[0].artifact.body.read_tier,'model_readable');assert.equal(read.artifacts[0].artifact.body.scan.truncated,false);
 const source=await w.kit.artifacts.source(w.user,read.artifacts[0].artifact.body.sha256);assert.ok(source?.bytes);assert.equal(Object.keys(JSON.parse(Buffer.from(source.bytes).toString()).entries).length,144);
});

for(const failure of [false,true])test(`configured acceptance uses the administrator and records a failed attempt (${failure})`,async t=>{
 const w=await setup(t,true);
 const ingest=w.kit.artifacts.ingest.bind(w.kit.artifacts);w.kit.artifacts.ingest=input=>ingest({...input,visibility:{...input.visibility,readers:[w.user.id]}});
 const {knowledgeSourceLoader}=await import('./credential-policy.ts');const {createDefaultRegistry}=await import('../refs/api.ts');
 if(failure)w.kit.artifacts.acceptFindings=async()=>{throw Error('synthetic acceptance failure');};
 const loader=knowledgeSourceLoader({records:w.kit,store:w.knowledge.store,parsers:createDefaultRegistry(),external:w.external,admin:w.admin,now:()=>new Date('2026-10-24T00:00:00.000Z'),credentialAcceptance:{autoAcceptSources:[{systemPack:'synthetic-documents',slot:'cases'}]}} as never,w.user,'synthetic nonadministrator source read');
 const load=await loader.read(flagged);assert.ok(load.ok);if(!load.ok)return;
 const result=await loader.readable(load,2*1024*1024,{slot:'cases'});
 assert.equal(result.ok,!failure);
 if(failure){const rows=await w.kit.store.find<any>({key:'knowledge.credential.acceptance-failed',value:load.artifact.body.sha256,kind:'action',limit:10});assert.equal(rows.items.length,1);assert.equal(rows.items[0].body.detail.administrator,w.admin.id);assert.ok(rows.items[0].body.detail.next_action);}
});


test('declared producer variables preserve automatic credential recovery during direct production',async t=>{
 const w=await setup(t,true,false,true);
 w.product.product.variables=[{name:'SYNTH_TRACE',description:'Synthetic trace flag',schema:{type:'boolean'},default:false}];
 w.product.product.producers=w.product.product.producers.map(producer=>producer.id==='cases'?{...producer,params:{...producer.params,trace:'${var:SYNTH_TRACE}'}}:producer);
 w.product.digest='e'.repeat(64);
 const variable=await w.kit.variables.setVariable(w.admin,'SYNTH_TRACE',true,'合成变量设置');
 const result=await w.knowledge.produceTree({product:w.product,build});assert.ok(result.ok,result.reason??'');assert.equal(result.skippedCount,0);
 const composition=(await w.knowledge.store.composition(result.composition!))!;
 assert.ok(composition.variables?.some(use=>use.name==='SYNTH_TRACE'&&use.decision===variable.value.decision.digest));
});
