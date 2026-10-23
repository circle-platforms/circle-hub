import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpJev } from '../tools/jev/lib/http.ts';
import { fakeJev, MODEL, JEV_KEY } from './servers.ts';
const request={model:MODEL,state:{p:'synthetic manual'},questions:{q:{type:'noul' as const,instructions:'Judge `p`'}}};
for(const status of [429,529,408,500,503])test(`transport retries HTTP ${status} twice with bounded backoff and per-attempt key reads`,async t=>{
 const server=await fakeJev(()=>({status,body:{error:{code:'synthetic_unavailable'}}}));t.after(()=>server.close());let keys=0;const waits:number[]=[];const client=new HttpJev({model:MODEL,apiKey:()=>{keys++;return JEV_KEY;},baseUrl:server.url,random:()=>0,sleep:async ms=>{waits.push(ms);}});await assert.rejects(client.ask(request));assert.equal(keys,3);assert.equal(server.requests.length,3);assert.deepEqual(waits,[500,1000]);
});
test('401 and long Retry-After stop without retry and redirects never leave loopback',async t=>{
 for(const spec of [{status:401},{status:429,headers:{'retry-after':'61'}},{status:302,headers:{location:'https://192.0.2.20/never-contact'}}]){const server=await fakeJev(()=>({...spec,headers:spec.headers as Record<string,string>|undefined,body:{error:'synthetic'}}));t.after(()=>server.close());const client=new HttpJev({model:MODEL,apiKey:()=>JEV_KEY,baseUrl:server.url,sleep:async()=>{assert.fail('must not wait');}});await assert.rejects(client.ask(request));assert.equal(server.requests.length,1);}
});
test('timeout retries twice and aliases or scripted versions at remote endpoints refuse before networking',async t=>{
 const server=await fakeJev(()=>({delay:200}));t.after(()=>server.close());const waits:number[]=[];const client=new HttpJev({model:MODEL,apiKey:()=>JEV_KEY,baseUrl:server.url,timeoutMs:30,random:()=>0,sleep:async ms=>{waits.push(ms);}});await assert.rejects(client.ask(request));assert.deepEqual(waits,[500,1000]);assert.ok(server.requests.length<=3);
 for(const options of [{model:'jev-latest',baseUrl:server.url},{model:MODEL,baseUrl:'https://192.0.2.10'},{model:'jev-fixture-10.6.0',baseUrl:'http://192.0.2.10'}])assert.throws(()=>new HttpJev({...options,apiKey:()=>JEV_KEY}));
});

test('echoes in headers or escaped unknown response members discard the whole reply',async t=>{
 for(const mode of ['header','escaped']){const body=JSON.stringify({model:MODEL,answers:{q:{type:'noul',noul:0.9}},usage:{input_tokens:1,output_tokens:1},extra:JEV_KEY}).replace(JEV_KEY,[...JEV_KEY].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''));const server=await fakeJev(()=>mode==='header'?{headers:{'x-typesafe-request-id':JEV_KEY}}:{body});t.after(()=>server.close());const client=new HttpJev({model:MODEL,apiKey:()=>JEV_KEY,baseUrl:server.url});await assert.rejects(client.ask(request),error=>(error as {code:string}).code==='JEV_BAD_RESPONSE');assert.equal(server.requests.length,1);}
});
