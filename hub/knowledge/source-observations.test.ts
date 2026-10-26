import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReadManifest} from '../../contracts/src/resources.ts';
import {newId,type Artifacts} from '../records/api.ts';

import {SourceLoader,type SourceDeps} from './sources.ts';
for(const status of [403,404])test(`source loading retains determined HTTP ${status} facts from the failure manifest`,async()=>{
 const by={id:newId('usr'),name:'synthetic administrator',role:'admin' as const},id='site:document:synthetic',at='2026-10-24T00:00:00.000Z';
 const body=ReadManifest.parse({action:'read',run:null,item:null,inputs:[],component:'connectors@1',lease:null,started_at:at,ended_at:at,result:'error',error_code:status===404?'SOURCE_ABSENT':'SOURCE_FORBIDDEN',external:id,revision:null,resource:newId('res'),environment:'test',system_pack:{id:'synthetic-site',version:'1.0.0',digest:'b'.repeat(64)},read:'document',principal:by.id,purpose:'synthetic observation',requests:[{key:'page',round:1,route:'page',method:'GET',path:'/synthetic',query:{},started_at:at,ended_at:at,status,ok:false,error:status===404?'SOURCE_ABSENT':'SOURCE_FORBIDDEN',sha256:null,size:null,media_type:null,etag:null,artifact:null,after_login:false}],reads:[],original:null,artifacts:[],coverage:{complete:false,examined:0,total:1},reason:'synthetic failure',warnings:[]});
 const manifest='a'.repeat(64);
 const deps={parsers:createDefaultRegistry(),artifacts:{} as Artifacts,records:{get:async()=>({kind:'action',schema:'read-manifest@1',digest:manifest,body})},external:{accepts:async()=>true,read:async()=>({ok:false as const,id,reason:'free text intentionally says something else',manifest})}} as unknown as SourceDeps;
 const load=await new SourceLoader(deps,by,'synthetic observation').read(id);assert.equal(load.ok,false);if(load.ok)return;
 const observation=(load as any).observation;assert.ok(observation);assert.equal(observation.status,status);assert.equal(observation.code,body.error_code);assert.equal(observation.manifest,manifest);assert.equal(observation.at,at);
});

for(const status of [200,404,410])test(`source loading recognizes a successful determined absence backed by HTTP ${status}`,async()=>{
 const by={id:newId('usr'),name:'synthetic administrator',role:'admin' as const},id='site:document:synthetic',at='2026-10-24T00:00:00.000Z',manifest='a'.repeat(64);
 const body=ReadManifest.parse({action:'read',run:null,item:null,inputs:[],component:'connectors@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,external:id,revision:null,resource:newId('res'),environment:'test',system_pack:{id:'synthetic-site',version:'1.0.0',digest:'b'.repeat(64)},read:'document',principal:by.id,purpose:'synthetic absence',requests:[{key:'page',round:1,route:'page',method:'GET',path:'/synthetic',query:{},started_at:at,ended_at:at,status,ok:status===200,error:status===200?null:'SOURCE_ABSENT',sha256:'c'.repeat(64),size:2,media_type:'application/json',etag:null,artifact:'d'.repeat(64),after_login:false}],reads:[],original:'page',artifacts:[],coverage:{complete:true,examined:1,total:1},reason:null,warnings:[]});
 const result={ok:true as const,id,revision:null,manifest,absent:{code:'SOURCE_ABSENT' as const,system:'site',object:id,observed_at:at,responses:['page']},artifacts:[{name:'content',artifact:{body:{sha256:'e'.repeat(64)}}}]};
 const deps={parsers:createDefaultRegistry(),artifacts:{} as Artifacts,records:{get:async()=>({kind:'action',schema:'read-manifest@1',digest:manifest,body})},external:{accepts:async()=>true,read:async()=>result}} as unknown as SourceDeps;
 const load=await new SourceLoader(deps,by,'synthetic absence').read(id);assert.equal(load.ok,false,'an absence observation is never parsed as an ordinary source document');if(load.ok)return;
 assert.equal(load.observation?.code,'SOURCE_ABSENT');assert.equal(load.observation?.status,status);assert.equal(load.observation?.manifest,manifest);assert.equal(load.observation?.at,at);
 for(const invalid of ['principal','external','response','forbidden','manifest'] as const){
  const changed=structuredClone(body);if(invalid==='principal')changed.principal=newId('usr');if(invalid==='external')changed.external='site:document:different';if(invalid==='response')changed.requests[0].key='different';if(invalid==='forbidden'){changed.requests[0].ok=false;changed.requests[0].status=403;changed.requests[0].error='SOURCE_FORBIDDEN';}
  const rejected=await new SourceLoader({...deps,records:{get:async()=>invalid==='manifest'?null:({kind:'action',schema:'read-manifest@1',digest:manifest,body:changed})} as SourceDeps['records']},by,'synthetic invalid absence').read(id);
  assert.equal(rejected.ok,false);if(!rejected.ok){assert.equal(rejected.observation,undefined);assert.match(rejected.reason,/缺席.*清单|清单.*缺席/);}
 }
});
