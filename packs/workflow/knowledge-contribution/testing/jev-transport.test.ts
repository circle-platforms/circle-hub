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

test('a cause comes only from a structured code, never from the words of an error body',async t=>{
 // Reproduces the retired rule: the context-limit marker inside a sentence, or inside a body that is no longer JSON,
 // named the cause. Only a structured code member of the body, taken by exact equality, does.
 const rows=[
  {name:'structured code',spec:{status:422,body:{error:{code:'max_tokens_exceeded'}}},code:'JEV_TOO_LARGE',reasons:['max_tokens_exceeded'],observed:true},
  {name:'structured type',spec:{status:400,body:{detail:[{type:'max_tokens_exceeded',msg:'synthetic'}]}},code:'JEV_TOO_LARGE',reasons:['max_tokens_exceeded'],observed:true},
  {name:'marker in a message only',spec:{status:422,body:{detail:[{type:'synthetic_type',msg:'max_tokens_exceeded while reading the request'}]}},code:'JEV_BAD_REQUEST',reasons:['synthetic_type'],observed:true},
  {name:'marker in a plain text body',spec:{status:400,body:'max_tokens_exceeded'},code:'JEV_BAD_REQUEST',reasons:[],observed:false},
  {name:'marker in an echoed request member',spec:{status:422,body:{error:{message:'max_tokens_exceeded',code:'synthetic_code'}}},code:'JEV_BAD_REQUEST',reasons:['synthetic_code'],observed:true},
 ];
 for(const row of rows){
  const server=await fakeJev(()=>row.spec);t.after(()=>server.close());
  const client=new HttpJev({model:MODEL,apiKey:()=>JEV_KEY,baseUrl:server.url,retries:0});
  await assert.rejects(client.ask(request),(error)=>{
   const typed=error as {code:string;reasons:readonly string[];message:string};
   assert.equal(typed.code,row.code,row.name);
   assert.deepEqual([...typed.reasons],row.reasons,row.name);
   // No observable cause: the message says so instead of naming one, and gives the next step.
   assert.equal(typed.message.includes('不推断原因'),!row.observed,row.name+' '+typed.message);
   return true;
  });
  assert.equal(server.requests.length,1,row.name);
 }
});
