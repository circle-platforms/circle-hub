// Every response and credential in this file is synthetic. Fetch is injected; no network is contacted.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConnectorKit} from './testing/kit.ts';
import {writePack} from './testing/packs.ts';
import {ReadManifest} from '../../contracts/src/resources.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
async function world(t:{after:(fn:()=>Promise<void>)=>void},reply:(n:number)=>Response|Promise<Response>,method='GET',maxBytes?:number) {
  let calls=0,now=Date.parse('2026-10-24T00:00:00Z');const sleeps:number[]=[];
  const kit=await openConnectorKit(postgres,{fetch:async()=>reply(++calls),now:()=>new Date(now),readRetrySleep:async(ms:number)=>{sleeps.push(ms);now+=ms;}});t.after(()=>kit.close());
  const handle=await writePack(kit.packRoot,{id:'synthetic-retry',system:{schema:'system@1',title:'合成读取',roles:[{name:'source'}],auth:{kind:'none'},routes:[{id:'one',role:'source',method,path:'/one',response:'json',max_bytes:1024,read:true}],reads:[{name:'one',external:'fixture:item',request:{route:'one'},...(maxBytes===undefined?{}:{max_bytes:maxBytes})}]}});kit.packs.set(handle);
  const resource=await kit.connectors.admin.addResource(kit.admin,{system_pack:handle.id,name:'合成来源',environment:'test',origins:{source:'http://192.0.2.1'}});
  return {external:()=>kit.connectors.reader.read('fixture:item:sample',{principal:kit.user,purpose:'synthetic retry'}),kit,sleeps,now:()=>now,calls:()=>calls,read:()=>kit.connectors.executeRead(resource.id,'one',{id:'sample'},{principal:kit.user,purpose:'synthetic retry'})};
}
for(const status of [429,503])test(`a read retries HTTP ${status}, honors Retry-After and journals every attempt`,async t=>{
  const w=await world(t,n=>new Response(n===1?'{}':'{"ok":true}',{status:n===1?status:200,headers:{'content-type':'application/json','retry-after':'2'}}));
  const result=await w.read();assert.equal(result.ok,true);assert.equal(w.calls(),2);assert.deepEqual(w.sleeps,[2000]);
  const record=await w.kit.records.store.get(result.manifest!);const manifest=ReadManifest.parse(record!.body);
  assert.deepEqual(manifest.requests.map(r=>r.status),[status,200]);assert.deepEqual(manifest.requests.map(r=>r.attempt),[1,2]);
  assert.ok(manifest.requests.every(r=>r.artifact));assert.equal(Date.parse(manifest.requests[0].retry_at!),Date.parse(manifest.requests[1].started_at));
  assert.deepEqual(manifest.coverage,{complete:true,examined:1,total:1});
});
test('an allowed POST read retries transport failures with bounded exponential backoff',async t=>{
  const w=await world(t,n=>{if(n<3)throw new Error('synthetic connection failure');return new Response('{}',{headers:{'content-type':'application/json'}});},'POST');
  const result=await w.read();assert.equal(result.ok,true);assert.equal(w.calls(),3);assert.deepEqual(w.sleeps,[100,200]);
});
test('exhaustion returns a future retry time and never exceeds three transport attempts',async t=>{
  const w=await world(t,()=>new Response('{}',{status:502,headers:{'content-type':'application/json'}}));
  const result=await w.read();assert.equal(result.ok,false);if(result.ok)return;
  assert.equal(w.calls(),3);assert.equal(result.code,'SOURCE_HTTP_STATUS');assert.equal(result.retry?.attempts,3);assert.ok(Date.parse(result.retry!.at)>w.now());
});
test('a Retry-After beyond the bounded wait budget is returned without an early retry',async t=>{
  const w=await world(t,()=>new Response('{}',{status:429,headers:{'retry-after':'60'}}));const result=await w.read();
  assert.equal(result.ok,false);if(result.ok)return;assert.equal(w.calls(),1);assert.deepEqual(w.sleeps,[]);assert.equal(Date.parse(result.retry!.at)-w.now(),60000);
});
for(const status of [401,403])test(`HTTP ${status} is not a transient read retry`,async t=>{
  const w=await world(t,()=>new Response('{}',{status}));const result=await w.read();assert.equal(result.ok,false);assert.equal(w.calls(),1);assert.deepEqual(w.sleeps,[]);
});

test('Retry-After waits share one finite budget instead of restarting it at each attempt',async t=>{
  const w=await world(t,()=>new Response('{}',{status:503,headers:{'retry-after':'20'}}));const result=await w.read();
  assert.equal(result.ok,false);assert.equal(w.calls(),2);assert.deepEqual(w.sleeps,[20000]);
});
test('a declared HTTP-date is honored as a retry time',async t=>{
  const at=Date.parse('2026-10-24T00:00:02Z');const w=await world(t,n=>new Response('{}',{status:n===1?429:200,headers:{'content-type':'application/json','retry-after':new Date(at).toUTCString()}}));
  assert.equal((await w.read()).ok,true);assert.deepEqual(w.sleeps,[2000]);
});
test('a deterministic malformed answer is not retried',async t=>{
  const w=await world(t,()=>new Response('{ broken',{headers:{'content-type':'application/json'}}));const result=await w.read();
  assert.equal(result.ok,false);assert.equal(w.calls(),1);assert.deepEqual(w.sleeps,[]);
});

test('complete error responses consume the same byte budget as successful retry responses',async t=>{
  const w=await world(t,()=>new Response('{}',{status:503}),'GET',3);const result=await w.read();
  assert.equal(result.ok,false);if(result.ok)return;assert.equal(result.code,'READ_LIMIT');assert.equal(w.calls(),2);assert.deepEqual(w.sleeps,[100]);
});

test('an unrepresentable Retry-After is a definite malformed reply, not an immediate retry',async t=>{
  const w=await world(t,()=>new Response('{}',{status:429,headers:{'retry-after':'999999999999999999999999999999999999999999999999999999999999999999'}}));
  const result=await w.read();assert.equal(result.ok,false);if(result.ok)return;assert.equal(result.code,'SOURCE_MALFORMED');assert.equal(w.calls(),1);assert.ok(result.manifest);
});

test('the external reader preserves the retry code and next eligible time',async t=>{
  const w=await world(t,()=>new Response('{}',{status:503}));const result=await w.external();
  assert.equal(result.ok,false);if(result.ok)return;assert.equal(result.retry?.code,'SOURCE_HTTP_STATUS');assert.equal(result.retry?.attempts,3);assert.ok(Date.parse(result.retry!.at)>w.now());
});
test('a nontransient malformed response is a determined read failure with an administrator action',async t=>{
 const w=await world(t,()=>new Response('{bad',{headers:{'content-type':'application/json'}}));
 const result=await w.external();assert.ok(!result.ok && result.inputError?.code==='SOURCE_READ_FAILED');assert.equal(w.calls(),1);
 if(!result.ok)assert.match(result.inputError!.fix,/资源管理员/);
});

test('the reader port preserves retry metadata and the same stored failure manifest',async t=>{
 const w=await world(t,()=>new Response('{}',{status:503,headers:{'content-type':'application/json'}}));
 const result=await w.external();assert.equal(result.ok,false);if(result.ok)return;
 assert.equal(result.retry?.attempts,3);assert.equal(w.calls(),3);assert.ok(Date.parse(result.retry!.at)>w.now());
 assert.match(result.manifest??'',/^[0-9a-f]{64}$/);
 const manifest=ReadManifest.parse((await w.kit.records.store.get(result.manifest!))!.body);
 assert.equal(manifest.result,'error');assert.equal(manifest.error_code,'SOURCE_HTTP_STATUS');assert.equal(manifest.requests.length,3);
 assert.deepEqual(manifest.requests.map(request=>request.status),[503,503,503]);
});
test('the reader port preserves a determined read failure code together with its original manifest',async t=>{
 const w=await world(t,()=>new Response('{ broken',{headers:{'content-type':'application/json'}}));
 const result=await w.external();assert.equal(result.ok,false);if(result.ok)return;
 assert.equal(result.inputError?.code,'SOURCE_READ_FAILED');assert.ok(result.inputError.fix);assert.equal(result.retry,undefined);assert.equal(w.calls(),1);
 assert.match(result.manifest??'',/^[0-9a-f]{64}$/);
 const manifest=ReadManifest.parse((await w.kit.records.store.get(result.manifest!))!.body);
 assert.equal(manifest.result,'error');assert.equal(manifest.error_code,'SOURCE_MALFORMED');assert.equal(manifest.requests[0].status,200);assert.ok(manifest.requests[0].artifact);
});
