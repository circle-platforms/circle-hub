import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConnectorKit} from './testing/kit.ts';
import {writePack} from './testing/packs.ts';
import {ReadManifest} from '../../contracts/src/resources.ts';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());
async function world(t:{after:(fn:()=>Promise<void>)=>void},route:Record<string,unknown>,reply:(path:string)=>Response,plan:(input:any)=>unknown){
 const paths:string[]=[];
 const kit=await openConnectorKit(postgres,{fetch:async(url,options)=>{assert.equal(options?.redirect,'manual');paths.push(new URL(String(url)).pathname);return reply(paths.at(-1)!);},callFunction:async(_target,input)=>plan(input)});t.after(()=>kit.close());
 const pack=await writePack(kit.packRoot,{id:'synthetic-routing',system:{schema:'system@1',title:'合成路由',roles:[{name:'source'}],auth:{kind:'none'},routes:[{id:'read',role:'source',method:'GET',path:'/{key}',params:{key:{type:'string',maxLength:100}},response:'json',max_bytes:4096,read:true,...route}],reads:[{name:'object',external:'fixture:item',plan:{module:'functions/plan.ts'},max_requests:10}]}});
 await writeFile(join(pack.directory,'functions/plan.ts'),'export default function(){return {requests:[],done:true}}');kit.packs.set(pack);
 const resource=await kit.connectors.admin.addResource(kit.admin,{system_pack:pack.id,name:'合成路由',environment:'test',origins:{source:'http://192.0.2.1'}});
 return {kit,paths,read:()=>kit.connectors.executeRead(resource.id,'object',{id:'sample'},{principal:kit.user,purpose:'synthetic routing'}),external:()=>kit.connectors.reader.read('fixture:item:sample',{principal:kit.user,purpose:'synthetic routing'})};
}
const redirectPlan=(i:any)=>i.round===1?{requests:[{key:'one',route:'read',params:{key:'one'}}],done:false}:i.round===2?{requests:[{key:'two',route:'read',href:i.responses.one.location,against:'one'}],original:'two',done:true}:{requests:[],done:true};
test('a declared same-origin redirect is a separate planned and recorded request',async t=>{
 const w=await world(t,{redirects:{same_origin:true,max_hops:1}},p=>p==='/one'?new Response('',{status:302,headers:{location:'/two'}}):new Response('{"found":true}'),redirectPlan);
 const result=await w.read();assert.ok(result.ok,JSON.stringify(result));if(!result.ok)return;assert.deepEqual(w.paths,['/one','/two']);assert.equal(result.coverage.complete,true);
 const manifest=ReadManifest.parse((await w.kit.records.store.get(result.manifest))!.body);assert.deepEqual(manifest.requests.map(r=>r.status),[302,200]);assert.equal(manifest.requests[0].location,'/two');assert.ok(manifest.requests.every(r=>r.artifact));
});
for(const declared of [false,true])test(`a ${declared?'cross-origin':'undeclared'} redirect is a determined refusal with Location and a repair action`,async t=>{
 const location=declared?'http://192.0.2.2/else':'/else';
 const w=await world(t,declared?{redirects:{same_origin:true,max_hops:1}}:{},()=>new Response('',{status:302,headers:{location}}),i=>({requests:i.round===1?[{key:'one',route:'read',params:{key:'one'}}]:[],done:true}));
 const result=await w.external();assert.ok(!result.ok && result.inputError?.code==='SOURCE_REDIRECT_REFUSED',JSON.stringify(result));if(result.ok)return;
 assert.match(result.manifest??'',/^[0-9a-f]{64}$/);
 const manifest=ReadManifest.parse((await w.kit.records.store.get(result.manifest!))!.body);assert.equal(manifest.requests[0].status,302);assert.equal(manifest.result,'error');
 assert.equal(result.redirect?.location,location);assert.match(result.inputError!.message,/302/);assert.match(result.inputError!.fix,/资源管理员/);assert.equal(w.paths.length,1);
});
test('declared pagination cannot silently complete beyond its page bound',async t=>{
 const w=await world(t,{pagination:{max_pages:2}},()=>new Response('{}'),i=>({requests:[{key:'p'+i.round,route:'read',params:{key:'p'+i.round}}],done:i.round===3}));
 const result=await w.read();assert.ok(!result.ok && result.code==='READ_LIMIT',JSON.stringify(result));assert.equal(w.paths.length,2);
 const external=await w.external();assert.ok(!external.ok && external.inputError?.code==='SOURCE_READ_LIMIT');
 assert.match(external.manifest??'',/^[0-9a-f]{64}$/);const manifest=ReadManifest.parse((await w.kit.records.store.get(external.manifest!))!.body);assert.equal(manifest.error_code,'READ_LIMIT');assert.equal(manifest.requests.length,2);
});
test('redirect hop bounds and the allow list prevent another fetch',async t=>{
 const w=await world(t,{redirects:{same_origin:true,max_hops:1}},()=>new Response('',{status:302,headers:{location:'/two'}}),i=>i.round===1?{requests:[{key:'one',route:'read',params:{key:'one'}}],done:false}:{requests:[{key:i.round===2?'two':'three',route:'read',href:'/two',against:i.round===2?'one':'two'}],original:'three',done:i.round===3});
 const result=await w.read();assert.ok(!result.ok);assert.equal(w.paths.length,2);
});
test('a credential-bearing Location is observed without disclosing or following its value',async t=>{
 const location=["http:/","/synth","etic:F","akeSec","retFor","Redire","ct@192",".0.2.1","/two"].join('');
 const w=await world(t,{},()=>new Response('',{status:302,headers:{location}}),()=>({requests:[{key:'one',route:'read',params:{key:'one'}}],done:true}));
 const result=await w.external();assert.ok(!result.ok && result.redirect?.location===null && result.redirect.location_redacted===true);assert.ok(!JSON.stringify(result).includes('FakeSecretForRedirect'));assert.equal(w.paths.length,1);
 for(const bytes of await w.kit.allObjects())assert.ok(!bytes.includes(Buffer.from('FakeSecretForRedirect')));
});

test('an unauthorized reader gets neither budget nor redirect diagnostics',async t=>{
 const w=await world(t,{pagination:{max_pages:1}},()=>new Response('',{status:302,headers:{location:'/two'}}),()=>({requests:[{key:'one',route:'read',params:{key:'one'}}],done:true}));
 await w.kit.records.principals.setDisabled(w.kit.admin,w.kit.user.id,true);
 const result=await w.external();assert.ok(!result.ok && result.inputError===undefined && result.redirect===undefined);assert.equal(w.paths.length,0);
});
test('an attempted cross-origin redirect stays a structured refusal before the second fetch',async t=>{
 const w=await world(t,{redirects:{same_origin:true,max_hops:1}},()=>new Response('',{status:302,headers:{location:'http://192.0.2.2/two'}}),redirectPlan);
 const result=await w.external();assert.ok(!result.ok && result.inputError?.code==='SOURCE_REDIRECT_REFUSED');assert.equal(w.paths.length,1);
});

test('a same-origin Location outside the target allow list is disclosed without fetching it',async t=>{
 for(const undeclared of [false,true]){
 const plan=(i:any)=>{const value=redirectPlan(i) as any;if(i.round===2 && undeclared)value.requests[0].route='absent';return value;};
 const w=await world(t,{redirects:{same_origin:true,max_hops:1}},()=>new Response('',{status:302,headers:{location:'/two/deep'}}),plan);
 const result=await w.external();assert.ok(!result.ok && result.inputError?.code==='SOURCE_REDIRECT_REFUSED');assert.equal(w.paths.length,1);
 }
});
