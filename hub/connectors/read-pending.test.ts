// An answer held for scan hits says that the object exists and nothing else of it (D05 R[3]). Synthetic injected responses; no
// external host is contacted.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../testing/postgres.ts';
import {openConnectorKit} from './testing/kit.ts';
import {writePack} from './testing/packs.ts';
import {setSyntheticCredential} from './testing/credentials.ts';
import type {ConnectorsOptions} from './api.ts';
import {ReadManifest} from '../../contracts/src/resources.ts';
import {SOURCE_PENDING_REVIEW_GENERATOR,newId,sha256Hex,type SourceArtifact} from '../records/api.ts';

const VALUE='Synthetic-Held-Value-42';
const HIT=`{"data":"password=${VALUE}"}`;
const ORIGIN='http://192.0.2.1';
let postgres:TemporaryPostgres;
before(async()=>{postgres=await startPostgres();});after(()=>postgres?.stop());

interface Setting {status?:number;body?:string;type?:string;route?:Record<string,unknown>;declaration?:Record<string,unknown>;external?:string;auth?:Record<string,unknown>;resource?:Record<string,unknown>;options?:Partial<ConnectorsOptions>}
async function world(t:{after:(fn:()=>Promise<void>)=>void},{status=200,body=HIT,type='application/json',route={},declaration={},external='fixture:item',auth={kind:'none'},resource={},options={}}:Setting={}){
 const kit=await openConnectorKit(postgres,{fetch:async()=>new Response(body,{status,headers:{'content-type':type}}),...options});t.after(()=>kit.close());
 const handle=await writePack(kit.packRoot,{id:'synthetic-pending',system:{schema:'system@1',title:'合成来源',roles:[{name:'source'}],auth,routes:[{id:'one',role:'source',method:'GET',path:'/one',response:'json',max_bytes:1024,read:true,...route},{id:'two',role:'source',method:'GET',path:'/two',response:'json',max_bytes:1024,read:true}],reads:[{name:'one',external,object_route:'one',request:{route:'one'},...declaration}]}});kit.packs.set(handle);
 const added=await kit.connectors.admin.addResource(kit.admin,{system_pack:handle.id,name:'合成来源',environment:'test',origins:{source:ORIGIN},...resource});
 return {kit,resource:added,read:(context:{bindPending?:boolean;run?:string|null}={},id='fixture:item:sample')=>kit.connectors.reader.read(id,{principal:kit.user,purpose:'synthetic pending',...context})};
}
const digest=sha256Hex(new TextEncoder().encode(HIT));

test('a caller that does not bind it is told the object exists and that its content awaits review, nothing else',async t=>{
 const w=await world(t);const result=await w.read();assert.ok(!result.ok,JSON.stringify(result));if(result.ok)return;
 assert.equal(result.inputError?.code,'SOURCE_PENDING_REVIEW');
 assert.match(result.inputError!.message,/^系统 fixture 里有 fixture:item:sample，内容待核看（读于 /);
 assert.match(result.inputError!.fix,/来源系统看原文/);
 const told=JSON.stringify(result.inputError);
 for(const secret of [VALUE,'password',digest])assert.ok(!told.includes(secret),`${secret} stays out of what the reader is told`);
});

test('a run that only reads gets an observation holding no byte of the answer, marked partial',async t=>{
 const w=await world(t);const result=await w.read({bindPending:true});assert.ok(result.ok,JSON.stringify(result));if(!result.ok)return;
 assert.equal(result.pending?.code,'SOURCE_PENDING_REVIEW');
 assert.deepEqual(result.artifacts.map(a=>a.name),['content'],'the held answer is not offered as the original');
 const content=result.artifacts[0].artifact;
 assert.ok('generated'in content.body.origin&&content.body.origin.generated.generator===SOURCE_PENDING_REVIEW_GENERATOR,'the name the feeding layer stops at');
 const bytes=Buffer.from((await w.kit.records.artifacts.source(w.kit.user,content.body.sha256))!.bytes!).toString();
 const observation=JSON.parse(bytes) as {code:string;system:string;object:string;message:string};
 assert.equal(observation.code,'SOURCE_PENDING_REVIEW');assert.equal(observation.system,'fixture');assert.equal(observation.object,'fixture:item:sample');
 assert.match(observation.message,/内容待核看/);
 const stored=JSON.stringify(content.body);
 for(const secret of [VALUE,'password'])assert.ok(!bytes.includes(secret),`${secret} stays out of the observation`);
 assert.ok(!stored.includes(digest),'the digest of the held answer stays out of the observation record');
 assert.equal(result.coverage?.complete,false);assert.match(result.coverage?.note??'',/^部分：内容待核看/);
 const manifest=ReadManifest.parse((await w.kit.records.store.get(result.manifest))!.body);
 assert.equal(manifest.result,'completed');assert.deepEqual(manifest.artifacts.map(a=>a.name),['content']);
});

test('a failed exchange that holds a hit shows no object: it is not called one',async t=>{
 const w=await world(t,{status:500});const result=await w.read({bindPending:true});assert.ok(!result.ok,JSON.stringify(result));if(result.ok)return;
 assert.notEqual(result.inputError?.code,'SOURCE_PENDING_REVIEW');
 assert.ok(!(result.reason??'').includes(VALUE));
});

const manifestOf=async(w:Awaited<ReturnType<typeof world>>,digest:string|null|undefined)=>ReadManifest.parse((await w.kit.records.store.get(digest!))!.body);

test('the manifest a run can read says an answer came, and no digest in it leads to the answer or what the scanner found',async t=>{
 const w=await world(t);const result=await w.read({bindPending:true});assert.ok(result.ok,JSON.stringify(result));if(!result.ok)return;
 const manifest=await manifestOf(w,result.manifest),[entry]=manifest.requests;
 assert.deepEqual([entry.sha256,entry.size,entry.media_type,entry.etag,entry.artifact],[null,null,null,null,null]);
 assert.equal(entry.status,200,'that an answer came is what the observation rests on');
 const said=JSON.stringify(manifest);assert.ok(!said.includes(digest),'a reader could test a guess at the held bytes');
 for(const found of said.match(/[0-9a-f]{64}/g)??[]){
  const record=await w.kit.records.store.get<SourceArtifact['body']>(found);
  assert.ok(record?.kind!=='source_artifact'||record.body.scan.findings.length===0,'the record of the held answer lists what the scanner found');
 }
});

test('a read of a run keeps them out of its manifest even when it binds nothing',async t=>{
 const w=await world(t);const result=await w.read({run:newId('run')});assert.ok(!result.ok,JSON.stringify(result));if(result.ok)return;
 const [entry]=(await manifestOf(w,result.manifest)).requests;
 assert.deepEqual([entry.sha256,entry.size,entry.media_type,entry.etag,entry.artifact],[null,null,null,null,null]);
});

test('a sync read keeps them: the administrator\'s review checks that the held answer belongs to the read',async t=>{
 const w=await world(t);const result=await w.read({run:null});assert.ok(!result.ok,JSON.stringify(result));if(result.ok)return;
 const manifest=await manifestOf(w,result.manifest),[entry]=manifest.requests;
 assert.equal(entry.sha256,digest);assert.ok(entry.artifact);assert.equal(entry.error,'SOURCE_CREDENTIAL');assert.equal(manifest.error_code,'SOURCE_CREDENTIAL');
});

test('the manifest of a run names no cause: a hold reads like any other answer not available to its reader',async t=>{
 const w=await world(t);
 for(const context of [{bindPending:true},{run:newId('run')}]){
  const result=await w.read(context),manifest=await manifestOf(w,result.manifest);
  assert.equal(manifest.requests[0].error,'SOURCE_UNAVAILABLE');
  assert.ok(!JSON.stringify(manifest).includes('SOURCE_CREDENTIAL'),JSON.stringify(manifest));
 }
});

test('a read whose held answer it kept parts of lists no held answer in a run\'s manifest',async t=>{
 const body=`{"data":"password=${VALUE}","name":"kept"}`,held=sha256Hex(new TextEncoder().encode(body));
 const w=await world(t,{body,route:{keep:['/name']}});
 const result=await w.read({run:newId('run')});assert.ok(result.ok,JSON.stringify(result));if(!result.ok)return;
 const manifest=await manifestOf(w,result.manifest);assert.ok(!JSON.stringify(manifest).includes(held));
 assert.deepEqual([manifest.requests[0].ok,manifest.requests[0].error],[true,null],'a request that gave its kept parts did not fail');
 const sync=await w.read({run:null});assert.ok(sync.ok,JSON.stringify(sync));if(!sync.ok)return;
 assert.ok(JSON.stringify(await manifestOf(w,sync.manifest)).includes(held),'the administrator\'s view keeps it');
});

test('nothing a function makes from a read tells of an answer held from it, nor does the manifest of the run',async t=>{
 const side=`{"secret":"password=${VALUE}","side":true}`,other=`{"secret":"password=${VALUE}","nested":true}`;
 const digests=[side,other].map(body=>sha256Hex(new TextEncoder().encode(body)));
 const kit=await openConnectorKit(postgres,{fetch:async url=>new Response(url.endsWith('/one')?'{"plain":true}':url.endsWith('/two')?side:other,{headers:{'content-type':'application/json'}})});t.after(()=>kit.close());
 const route=(id:string)=>({id,role:'source',method:'GET',path:`/${id}`,response:'json',max_bytes:1024,read:true});
 const handle=await writePack(kit.packRoot,{id:'synthetic-held-side',functions:['held-side.ts'],system:{schema:'system@1',title:'合成来源',roles:[{name:'source'}],auth:{kind:'none'},routes:[route('one'),route('two'),route('three')],reads:[
  {name:'main',external:'fixture:item',plan:{module:'functions/held-side.ts',export:'sidePlan'},project:{module:'functions/held-side.ts',export:'sideProject'}},
  {name:'other',external:'fixture:other',request:{route:'three'}},
 ]}});kit.packs.set(handle);
 await kit.connectors.admin.addResource(kit.admin,{system_pack:handle.id,name:'合成来源',environment:'test',origins:{source:ORIGIN}});
 const result=await kit.connectors.reader.read('fixture:item:sample',{principal:kit.user,purpose:'synthetic side',run:newId('run')});
 assert.ok(result.ok,JSON.stringify(result));if(!result.ok)return;
 const content=result.artifacts.find(a=>a.name==='content')!.artifact;
 const bytes=Buffer.from((await kit.records.artifacts.source(kit.user,content.body.sha256))!.bytes!).toString();
 const told=JSON.parse(bytes) as {responses:{side:Record<string,unknown>};reads:Record<string,{reason:string}>};
 assert.deepEqual([told.responses.side.sha256,told.responses.side.size,told.responses.side.media_type,told.responses.side.etag],[null,null,null,null]);
 assert.equal(told.responses.side.status,200,'a function may know an answer came');
 assert.match(told.reads['fixture:other:held'].reason,/对你不可用/);
 const manifest=ReadManifest.parse((await kit.records.store.get(result.manifest))!.body);
 const nested=ReadManifest.parse((await kit.records.store.get(manifest.reads[0].manifest!))!.body);
 assert.equal(nested.error_code,'SOURCE_UNAVAILABLE');
 // A pack function keeps the code: the file packs use it to name a held file as the original. Whoever reads the run does not get it.
 for(const said of [bytes,JSON.stringify(content.body)])for(const secret of [...digests,VALUE,'凭据'])assert.ok(!said.includes(secret),`${secret} in ${said}`);
 for(const said of [JSON.stringify(manifest),JSON.stringify(nested)])for(const secret of [...digests,VALUE,'凭据','SOURCE_CREDENTIAL'])assert.ok(!said.includes(secret),`${secret} in ${said}`);
});

// What each of these holds can come without the object: then the reader is not told the object exists.
const unproven:[string,Setting,string][]=[
 ['a read that does not declare its object route, such as a lookup or a list',{declaration:{object_route:undefined}},'fixture:item:sample'],
 ['the answer of another route than the one that is the object',{declaration:{object_route:'two'}},'fixture:item:sample'],
 ['a read of one revision, which no function could check',{},'fixture:item:sample@r1'],
 ['an id with a hit of its own, which an answer can repeat whether it found the object or not',{},'fixture:item:password=Abcdefgh1234'],
 ['a system name the observation cannot carry',{external:'a:item'},'a:item:sample'],
];
for(const [name,setting,id] of unproven)test(`a held answer stays neutral for ${name}`,async t=>{
 const asked:string[]=[];const w=await world(t,{...setting,options:{pendingReview:async(_artifact,external)=>void asked.push(external)}});
 for(const bindPending of [false,true]){
  const result=await w.read({bindPending,run:newId('run')},id);assert.ok(!result.ok,JSON.stringify(result));if(result.ok)return;
  assert.equal(result.inputError,undefined,JSON.stringify(result.inputError));
  assert.ok(result.manifest,'the read itself did not fail');
 }
 assert.deepEqual(asked,[],'nothing was told, so nothing is asked');
});

test('a credential of the Hub that only the kept parts spell out is an echo: neutral',async t=>{
 const token='Synthetic-Sent-Token-4242',escaped=[...token].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const w=await world(t,{body:`{"data":"password=${VALUE}","name":"${escaped}"}`,route:{keep:['/name']},auth:{kind:'static_header',header:{name:'X-Api-Key',scheme:'bearer'},roles:['source'],credential:'token'},resource:{credentials:{token:'SYNTHETIC_TOKEN'},allow_plaintext:[ORIGIN]}});
 await setSyntheticCredential(w.kit.records,w.kit.connectors,w.kit.admin,w.resource.id,'token',token);
 const result=await w.read({bindPending:true});assert.ok(!result.ok,JSON.stringify(result));if(result.ok)return;
 assert.equal(result.inputError,undefined,JSON.stringify(result.inputError));
 assert.ok(w.kit.log.some(event=>event.event==='secret_echoed'),'the administrator is told');
});

test('a read that kept no manifest says so instead of the observation, and asks nobody',async t=>{
 const w=await world(t),asked:string[]=[];
 const store=new Proxy(w.kit.records.store,{get(target,name){
  if(name==='put')return async(record:{schema?:string})=>{if(record.schema==='read-manifest@1')throw new Error('synthetic write failure');return target.put(record as never);};
  const value=Reflect.get(target,name);return typeof value==='function'?value.bind(target):value;
 }});
 const reader=w.kit.make({records:{...w.kit.records,store},pendingReview:async(_artifact,external)=>void asked.push(external)}).reader;
 for(const bindPending of [false,true]){
  const result=await reader.read('fixture:item:sample',{principal:w.kit.user,purpose:'synthetic pending',bindPending});
  assert.ok(!result.ok,JSON.stringify(result));if(result.ok)return;
  assert.equal(result.inputError,undefined,JSON.stringify(result.inputError));
 }
 assert.deepEqual(asked,[]);
});

test('what a run\'s reader is told awaits review is asked of an administrator, and the answer stands when asking fails',async t=>{
 const asked:[string,string][]=[];let failing=false;
 const w=await world(t,{options:{pendingReview:async(artifact,external)=>{asked.push([artifact.body.sha256,external]);if(failing)throw new Error('synthetic request failure');}}});
 assert.equal((await w.read({run:newId('run')})).ok,false);assert.deepEqual(asked,[[digest,'fixture:item:sample']]);
 failing=true;const result=await w.read({bindPending:true});assert.ok(result.ok,JSON.stringify(result));if(!result.ok)return;
 assert.equal(result.pending?.code,'SOURCE_PENDING_REVIEW');assert.equal(asked.length,2);
 const note=w.kit.log.find(event=>event.event==='pending_review_not_asked');
 assert.match(JSON.stringify(note),/synthetic request failure/,'the administrator log says why the request was not raised');
});

test('a sync read asks nobody here: the sync raises its own request',async t=>{
 const asked:string[]=[];const w=await world(t,{options:{pendingReview:async(_artifact,external)=>void asked.push(external)}});
 const result=await w.read({run:null});assert.ok(!result.ok,JSON.stringify(result));assert.deepEqual(asked,[]);
});
