import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReadManifest} from '../../contracts/src/resources.ts';
import {newId,type Artifacts} from '../records/api.ts';
import {createDefaultRegistry} from '../refs/api.ts';
import {SourceLoader,type SourceDeps} from './sources.ts';
for(const status of [403,404])test(`source loading retains determined HTTP ${status} facts from the failure manifest`,async()=>{
 const by={id:newId('usr'),name:'synthetic administrator',role:'admin' as const},id='site:document:synthetic',at='2026-10-24T00:00:00.000Z';
 const body=ReadManifest.parse({action:'read',run:null,item:null,inputs:[],component:'connectors@1',lease:null,started_at:at,ended_at:at,result:'error',error_code:status===404?'SOURCE_ABSENT':'SOURCE_FORBIDDEN',external:id,revision:null,resource:newId('res'),environment:'test',system_pack:{id:'synthetic-site',version:'1.0.0',digest:'b'.repeat(64)},read:'document',principal:by.id,purpose:'synthetic observation',requests:[{key:'page',round:1,route:'page',method:'GET',path:'/synthetic',query:{},started_at:at,ended_at:at,status,ok:false,error:status===404?'SOURCE_ABSENT':'SOURCE_FORBIDDEN',sha256:null,size:null,media_type:null,etag:null,artifact:null,after_login:false}],reads:[],original:null,artifacts:[],coverage:{complete:false,examined:0,total:1},reason:'synthetic failure',warnings:[]});
 const manifest='a'.repeat(64);
 const deps={parsers:createDefaultRegistry(),artifacts:{} as Artifacts,records:{get:async()=>({kind:'action',schema:'read-manifest@1',digest:manifest,body})},external:{accepts:async()=>true,read:async()=>({ok:false as const,id,reason:'free text intentionally says something else',manifest})}} as unknown as SourceDeps;
 const load=await new SourceLoader(deps,by,'synthetic observation').read(id);assert.equal(load.ok,false);if(load.ok)return;
 const observation=(load as any).observation;assert.ok(observation);assert.equal(observation.status,status);assert.equal(observation.code,body.error_code);assert.equal(observation.manifest,manifest);assert.equal(observation.at,at);
});
