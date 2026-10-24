import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {makeWorld,startPostgres,STATIC_PLAN_SOURCE,DEFAULT_SYNC,COMMANDS_SOURCE,catalogXml} from './test-support.ts';
import {SeedlingBody} from '../../contracts/src/knowledge.ts';
import {seedlingName} from './seedling.ts';
import {FeedingLayer,FEEDING_BOUNDS} from './feeding.ts';
import {createRunsService} from '../runs/api.ts';
import {FakeWorkflowStore} from '../runs/engine/testing/workflows.ts';
import {createDefaultRegistry} from '../refs/api.ts';
const apv=new URL('../../packs/product/apv/',import.meta.url);
const mapBytes=Buffer.from(JSON.stringify({agile:{id:'SYN-DOC'},root:{data:{id:'root',text:'Synthetic zx-u 10.8'},children:Array.from({length:40},(_,i)=>({data:{id:'case-'+i,autoid:'SYN-'+i,text:'Synthetic case '+i,priority:2,resource:['functional']},children:[{data:{id:'step-'+i,text:'system show'},children:[{data:{id:'expect-'+i,text:'Synthetic expected '+i}}]}]}))}}));
async function world(pg:Awaited<ReturnType<typeof startPostgres>>,slow=false){
 const manifest=JSON.parse(readFileSync(new URL('pack.json',apv),'utf8'));
 const functions:Record<string,string>=Object.fromEntries(manifest.files.filter((file:{path:string})=>file.path.startsWith('functions/')).map((file:{path:string})=>[file.path.slice(10),readFileSync(new URL(file.path,apv),'utf8')]));
 functions['synthetic-tree.ts']=COMMANDS_SOURCE;functions['synthetic-plan.ts']=STATIC_PLAN_SOURCE;
 if(slow)functions['slow.ts']=`import project from './feeding.ts';export default input=>{const until=Date.now()+800;while(Date.now()<until){}return project(input);};`;
 const name='Rel_APV-zx-u_10_8_1_1';
 const w=await makeWorld(pg,{pack:{id:'apv',names:['APV','NSAE'],functions,declaration:{sync:{...DEFAULT_SYNC,plan:{module:'functions/synthetic-plan.ts'},options:{builds:[{name,base:name,family:'APV',line:'10.8.0',platform:'zx-u',built_at:'2026-10-01T00:00:00.000Z',released_at:'2026-10-02T00:00:00.000Z',sources:{tree:'site:tree:synthetic'}}]}},catalogs:[],producers:[{id:'tree',title:'Synthetic tree',function:{module:'functions/synthetic-tree.ts'},inputs:{tree:{source:'tree'}}}],feeding:{project:{module:slow?'functions/slow.ts':'functions/feeding.ts'},normalize_line:{module:'functions/feeding.ts',export:'normalizeLine'}}}}});
 w.external.set('site:tree:synthetic',{bytes:catalogXml({system:[{name:'show',params:[]}]}),mediaType:'application/xml'});await w.knowledge.syncProduct(w.product,{by:w.admin});
 const root=await w.knowledge.rootOfBuild('apv',name);assert.ok(root);const comp=await w.knowledge.store.composition(root.composition);assert.ok(comp);const original=comp.sources[0];
 for(let i=8;i<28;i++){const line='10.'+i+'.0',body=SeedlingBody.parse({product:'apv',line,root:root.root,composition:root.composition,build:name,origin:[{role:'command-tree',producer:original.producer,slot:original.slot,external:original.external,sha256:original.sha256,revision:null}],parent:null,basis:'Synthetic seed'});const rec=await w.knowledge.store.putClaim('seedling@1','projected',body,[{key:'knowledge.seedling',value:'apv/'+line},{key:'knowledge.seedling.root',value:'apv/'+root.root}]);await w.kit.pointers.move({name:seedlingName('apv',line),expected:null,next:rec.digest,by:w.admin,run:null,component:'synthetic.feeding@1'});}
 const ingest=async(bytes:Uint8Array)=>w.kit.artifacts.ingest({bytes,mediaType:'application/json',origin:{read:{object:'agile:mindmap:SYN-DOC'}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});
 const document=await ingest(mapBytes),meta=await ingest(Buffer.from(JSON.stringify({id:'SYN-DOC',title:'Synthetic doc',ancestors:['rel_apv_10_8'],root:{id:'synthetic-root',title:'APV'}})));
 let calls=0;Object.assign(w.knowledge.__context.sandbox,{onAttempt:()=>{calls++;}});
 return {...w,name,root,document,meta,calls:()=>calls,scope:{product:'apv',root:root.root,composition:root.composition,sourceRecord:document.digest,metaSource:meta.body.sha256}};
}
test('40 APV cases and 20 seed lines take three sandbox processes per document; repeat and restart reuse the content-addressed projection',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 const started=performance.now();const [first,second]=await Promise.all([layer.observeSource(w.user,w.document.body.sha256,w.scope),layer.observeSource(w.user,w.document.body.sha256,w.scope)]);
 assert.equal(first.objects.length,40);assert.deepEqual(second.objects,first.objects);assert.equal(w.calls(),3,'two whole-document passes plus one normalization batch, independent of case and seed counts');assert.ok(performance.now()-started<10000,'synthetic cold 40-case document completes within 10 seconds');
 await layer.observeSource(w.user,w.document.body.sha256,w.scope);assert.equal(w.calls(),3,'same digest does not reproject');
 const restarted=new FeedingLayer(w.knowledge.__context,layer.reading);await restarted.observeSource(w.user,w.document.body.sha256,w.scope);assert.equal(w.calls(),4,'restart reads the persisted document projection; only a fresh seed normalization batch runs');
 // Metadata and the frozen composition remain part of identity; the cache must never cross their boundary.
 const changed=await w.kit.artifacts.ingest({bytes:Buffer.from(JSON.stringify({id:'SYN-DOC',ancestors:['rel_apv_10_9']})),mediaType:'application/json',origin:{read:{object:'agile:mindmap:SYN-DOC'}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});
 await layer.observeSource(w.user,w.document.body.sha256,{...w.scope,metaSource:changed.body.sha256});assert.equal(w.calls(),7,'changed metadata gets its own document projection and normalization');
});
test('slow document projection returns a pending receipt in a bounded slice and shares one in-flight job',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg,true);const layer=w.knowledge.feeding!;t.after(async()=>{await layer.drain();await w.close();});
 const started=performance.now();const receipts=await Promise.all(Array.from({length:40},()=>layer.observeSourceBounded(w.user,w.document.body.sha256,w.scope)));assert.ok(performance.now()-started<1500,'40 duplicate readers do not wait for the deliberately slow projection');assert.ok(receipts.every(row=>row.pending.some(p=>p.missing.includes('进行中'))));assert.ok(w.calls()<=1,'duplicates share the same queued/running document');await layer.drain();assert.equal(w.calls(),3);assert.equal((await layer.entries(w.user,'apv')).length,40);
 assert.deepEqual(FEEDING_BOUNDS,{waitMs:250,concurrency:2,queued:32,callMs:5000,rows:1000});
});
test('actual case-location start_run with granularity=case returns 40 items without waiting for a slow APV feeding projection',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg,true);const layer=w.knowledge.feeding!;t.after(async()=>{await layer.drain();await w.close();});
 const workflows=new FakeWorkflowStore(w.admin.id);await workflows.add(fileURLToPath(new URL('../../packs/workflow/case-location/',import.meta.url)));workflows.assign(w.user.id,'case-location');
 const previous=w.external.read.bind(w.external);w.external.accepts=async id=>id==='agile:mindmap:SYN-DOC'||id==='agile:tree:roots'||id==='site:tree:synthetic';w.external.read=async(id,context)=>{
  if(id==='agile:mindmap:SYN-DOC')return {ok:true,id,revision:null,manifest:'synthetic',artifacts:[{name:'content',artifact:w.document},{name:'meta',artifact:w.meta}]};
  if(id==='agile:tree:roots'){const artifact=await w.kit.artifacts.ingest({bytes:Buffer.from(JSON.stringify({roots:[{id:'synthetic-root',title:'APV'}],documents:[{id:'SYN-DOC',title:'Synthetic doc',ancestors:['rel_apv_10_8'],root:'synthetic-root',listed:true}],complete:true,repeated:0})),mediaType:'application/json',origin:{read:{object:id}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});return {ok:true,id,revision:null,manifest:'synthetic',artifacts:[{name:'original',artifact}]};}
  return previous(id,context);
 };
 const service=createRunsService({records:w.kit,packs:w.packs,knowledge:w.knowledge,external:w.external,workflows,parsers:createDefaultRegistry()});const started=performance.now();const answer=await service.startRun(w.user,{pack:'case-location',product:'APV',build:w.name,parameters:{granularity:'case'},inputs:{documents:{external:'agile:mindmap:SYN-DOC'}}},{traceId:'4bf92f3577b34da6a3ce929d0e0e4736',sessionId:'synthetic'});assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));assert.equal(answer.run!.items.length,40);assert.ok(performance.now()-started<10000,'case-location start returns within 10 seconds');await layer.drain();assert.ok(w.calls()<=5,'feeding process count is per distinct source document, not per case/check');assert.equal((await layer.entries(w.user,'apv')).length,40);assert.ok((await layer.usages(w.user,answer.run!.run)).includes(w.document.body.sha256));
});
test('queue admission has a hard capacity and rejects excess work without starting another sandbox',async t=>{
 const {newId}=await import('../records/api.ts');const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);const layer=w.knowledge.feeding!;t.after(async()=>{await layer.drain();await w.close();});
 const original=w.kit.artifacts.source.bind(w.kit.artifacts);let release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;});w.kit.artifacts.source=async(...args)=>{if(args[1]===w.document.body.sha256)await gate;return original(...args);};
 const count=FEEDING_BOUNDS.concurrency+FEEDING_BOUNDS.queued+1;const responses=await Promise.all(Array.from({length:count},()=>layer.observeSourceBounded(w.user,w.document.body.sha256,{run:newId('run')})));const callsBefore=w.calls();release();assert.equal(responses.filter(row=>row.pending.some(p=>p.missing.includes('队列已达上限'))).length,1);assert.equal(callsBefore,0);await layer.drain();assert.equal(w.calls(),0,'unscoped sources cannot start product projection callbacks');
});
test('a sandbox timeout ends the document job as unknown, with no wall-time retries or per-case retry loop',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg,true);const layer=w.knowledge.feeding!;t.after(async()=>{await layer.drain();await w.close();});w.knowledge.__context.sandbox.producer.timeoutMs=100;
 const started=performance.now();const response=await layer.observeSourceBounded(w.user,w.document.body.sha256,w.scope);assert.ok(performance.now()-started<1500);assert.ok(response.pending.length);await layer.drain();assert.equal(w.calls(),1,'the single document attempt times out once; no calls per case');assert.equal((await layer.entries(w.user,'apv')).length,0);const states=await w.knowledge.store.all<any>({key:'knowledge.feeding.job',value:w.user.id,kind:'action'});assert.equal(states.at(-1)!.body.detail.feeding_job.state,'unknown');
});
