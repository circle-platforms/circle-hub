// Synthetic injected responses; no external host is contacted.
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConnectorKit} from './testing/kit.ts';
import {writePack} from './testing/packs.ts';
import {ReadManifest} from '../../contracts/src/resources.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
async function world(t:{after:(fn:()=>Promise<void>)=>void},status=404,project?:unknown,body='{"data":[]}',envelope=false){
 let calls=0;
 const kit=await openConnectorKit(postgres,{fetch:async()=>{calls++;return new Response(body,{status,headers:{'content-type':'application/json'}});},...(project?{callFunction:async()=>project}:{})});t.after(()=>kit.close());
 const handle=await writePack(kit.packRoot,{id:'synthetic-absence',system:{schema:'system@1',title:'合成来源',roles:[{name:'source'}],auth:{kind:'none'},...(envelope?{envelope:{code:'/code',ok:[1000],expired:[],message:'/msg'}}:{}),routes:[{id:'one',role:'source',method:'GET',path:'/one',response:'json',max_bytes:1024,read:true,...(envelope?{envelope:true}:{})}],reads:[{name:'one',external:'fixture:item',request:{route:'one'},...(project?{project:{module:'functions/absent.ts'},absent_codes:['fixture.absent']}:{})}]}});if(project)await writeFile(join(handle.directory,'functions/absent.ts'),'export default function(){return {error:{code:"fixture.absent",message:"absent"}}}');kit.packs.set(handle);
 const resource=await kit.connectors.admin.addResource(kit.admin,{system_pack:handle.id,name:'合成来源',environment:'test',origins:{source:'http://192.0.2.1'}});
 return {kit,calls:()=>calls,read:()=>kit.connectors.executeRead(resource.id,'one',{id:'sample'},{principal:kit.user,purpose:'synthetic absence'}),external:()=>kit.connectors.reader.read('fixture:item:sample',{principal:kit.user,purpose:'synthetic absence'})};
}
for(const status of [404,410])test(`HTTP ${status} binds an absence observation with the original bytes and audited request`,async t=>{
 const w=await world(t,status);const result=await w.read();assert.ok(result.ok,JSON.stringify(result));if(!result.ok)return;
 assert.equal(result.absent?.code,'SOURCE_ABSENT');assert.equal(result.absent?.system,'fixture');assert.equal(result.absent?.object,'fixture:item:sample');assert.ok(result.absent?.observed_at);
 const original=result.artifacts.find(a=>a.name==='original')!,content=result.artifacts.find(a=>a.name==='content')!;
 assert.equal(Buffer.from((await w.kit.records.artifacts.source(w.kit.user,original.artifact.body.sha256))!.bytes!).toString(),'{"data":[]}');
 const observation=JSON.parse(Buffer.from((await w.kit.records.artifacts.source(w.kit.user,content.artifact.body.sha256))!.bytes!).toString());assert.equal(observation.code,'SOURCE_ABSENT');assert.deepEqual(observation.responses,['response']);
 const manifest=ReadManifest.parse((await w.kit.records.store.get(result.manifest))!.body);assert.equal(manifest.requests[0].status,status);assert.equal(manifest.requests.length,1);assert.equal(w.calls(),1);assert.equal(manifest.coverage.complete,true);
 const external=await w.external();assert.ok(external.ok && external.absent?.code==='SOURCE_ABSENT');
});
test('only explicitly declared projection absence errors are deterministic observations',async t=>{
 const w=await world(t,200,{error:{code:'fixture.absent',message:'没有这个编号'}});const result=await w.read();assert.ok(result.ok && result.absent?.code==='SOURCE_ABSENT',JSON.stringify(result));
 const other=await world(t,200,{error:{code:'fixture.invalid',message:'not absence'}});const rejected=await other.read();assert.ok(!rejected.ok && rejected.code==='PROJECTION_FAILED');
});
test('401 and 403 never become absence observations',async t=>{
 for(const status of [401,403]){const w=await world(t,status);assert.equal((await w.read()).ok,false);assert.equal(w.calls(),1);}
});

test('structured absence verifies its identity and response keys before binding',async t=>{
 const absent={code:'SOURCE_ABSENT',system:'fixture',object:'fixture:item:sample',observed_at:'2026-10-24T00:00:00.000Z'};
 const valid=await world(t,200,{artifacts:[],absent});const accepted=await valid.read();assert.ok(accepted.ok && accepted.absent);
 for(const changed of [{...absent,object:'fixture:item:other'},{...absent,system:'another'},{...absent,responses:['not-read']}]){
  const w=await world(t,200,{artifacts:[],absent:changed});const result=await w.read();assert.ok(!result.ok && result.code==='PROJECTION_FAILED',JSON.stringify(result));
 }
});
test('a known projection failure has a registered public correction, while an invalid reader gets no details',async t=>{
 const w=await world(t,200,{error:{code:'fixture.invalid',message:'合成格式错误'}});
 const answer=await w.external();assert.ok(!answer.ok && answer.inputError?.code==='SOURCE_READ_FAILED');if(!answer.ok){assert.match(answer.inputError!.message,/投影函数失败/);assert.doesNotMatch(answer.inputError!.message,/fixture.invalid|合成格式错误/);assert.match(answer.inputError!.fix,/系统包负责人/);}
 await w.kit.records.principals.setDisabled(w.kit.admin,w.kit.user.id,true);
 const hidden=await w.external();assert.ok(!hidden.ok && hidden.inputError===undefined);
});

test('a retained envelope never discloses its message through public or persisted failure diagnostics',async t=>{
 const secret='SyntheticEnvelopePassword42';
 const body=JSON.stringify({code:7,password:secret,msg:'password='+secret});
 const w=await world(t,200,undefined,body,true);
 const result=await w.external();assert.ok(!result.ok && result.inputError===undefined);assert.ok(!JSON.stringify(result).includes(secret));
 for(const record of (await w.kit.records.store.list({kind:'action',limit:100})).items)assert.ok(!JSON.stringify(record.body).includes(secret));
 assert.ok(!JSON.stringify(w.kit.log).includes(secret));
});
