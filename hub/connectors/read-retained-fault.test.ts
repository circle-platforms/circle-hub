import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
// Isolate disclosure policy without a database; ingest explicitly reports the scanner's retain_only decision.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ReadEngine,type ReadEngineOptions,type ResourceRuntime} from './read.ts';
import {HttpSource} from './http.ts';
import {Redactor} from './redact.ts';
import {compileRoutes} from './routes.ts';

import {SystemProfile} from '../../contracts/src/resources.ts';
import {sha256Hex,type SourceArtifact} from '../records/api.ts';
for(const echoed of [false,true])test(`a retained ${echoed?'echoed':'ordinary'} response fault keeps its protected diagnostics private`,async()=>{
 const secret='SyntheticRetainedPassword42',body=JSON.stringify({code:7,msg:'password='+secret});
 const bytes=Buffer.from(body),now=()=>new Date('2026-10-24T00:00:00.000Z');
 const profile=SystemProfile.parse({schema:'system@1',title:'合成来源',roles:[{name:'source'}],auth:{kind:'none'},envelope:{code:'/code',ok:[1000],expired:[],message:'/msg'},routes:[{id:'read',role:'source',method:'GET',path:'/one',response:'json',envelope:true,max_bytes:1024,read:true}],reads:[{name:'one',external:'fixture:item',plan:{module:'functions/plan.ts'}}]});
 let manifest:unknown;
 const reader={id:'usr_0'+'a'.repeat(25),name:'synthetic',role:'user' as const,disabled:false};
 const redactor=new Redactor();if(echoed)redactor.addSent(secret);const inputs:unknown[]=[];
 const options={now,parsers:createDefaultRegistry(),resolve:async()=>[],redactor,callFunction:async(_target:any,input:any)=>{inputs.push(input);return input.round===1?{requests:[{key:'response',route:'read'}],done:false}:{requests:[],done:true};},principals:{get:async()=>reader},store:{put:async(input:any)=>{manifest=input.body;return {digest:'d'.repeat(64)};}},artifacts:{ingest:async()=>({digest:'e'.repeat(64),body:{sha256:sha256Hex(bytes),media_type:'application/json',size:bytes.length,read_tier:'retain_only'}} as SourceArtifact)}} as unknown as ReadEngineOptions;
 const engine=new ReadEngine(options);
 const runtime={resource:{id:'res_0'+'a'.repeat(25),environment:'test',settings:{}},decision:'b'.repeat(64),pack:{id:'fixture-pack',version:'1.0.0',digest:'c'.repeat(64),directory:'.'},profile,routes:compileRoutes(profile.routes),http:new HttpSource({resource:'res_0'+'a'.repeat(25),origins:{source:'http://192.0.2.1'},allowPlaintext:[],routes:profile.routes,envelope:profile.envelope,fetch:async()=>new Response(body,{headers:{'content-type':'application/json',etag:'"'+sha256Hex(bytes)+'"'}})}),login:null,credential:null} as unknown as ResourceRuntime;
 const result=await engine.execute(runtime,profile.reads[0],{id:'sample'},{principal:reader,purpose:'synthetic disclosure'});
 assert.ok(!result.ok);assert.ok(!JSON.stringify(result).includes(secret));assert.ok(!JSON.stringify(manifest).includes(secret));
 assert.equal((result as {disclosable?:boolean}).disclosable,false);
 if(echoed){assert.ok(!JSON.stringify(inputs).includes(sha256Hex(bytes)));assert.ok(!JSON.stringify(manifest).includes(sha256Hex(bytes)));assert.ok(!JSON.stringify(result).includes(sha256Hex(bytes)));}
});
