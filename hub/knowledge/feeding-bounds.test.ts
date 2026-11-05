import {osIsolationAvailable,type SandboxOptions} from '../rules/api.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import pgModule from 'pg';
import {startPostgres} from './test-support.ts';
import {FeedingLayer,FEEDING_BOUNDS} from './feeding.ts';
import {installTraceSink,startTrace,type SpanRow} from '../telemetry/api.ts';
import {createRunsService} from '../runs/api.ts';
import {FakeWorkflowStore} from '../runs/engine/testing/workflows.ts';
import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import {installedMindmapFixture,mapBytes,readCapture,workingPackage,world} from './testing/feeding-bounds-fixture.ts';

// Ordering, not wall-clock time: a document job is held on a gate before it projects, and the test opens the gate only
// after the call under test has returned. A call that waited for the projection could then never return, and the test's
// timeout fails it, however fast or slow the machine is.
function holdProjection(layer:FeedingLayer){
 let open!:()=>void,arrive!:()=>void;const gate=new Promise<void>(yes=>{open=yes;}),reached=new Promise<void>(yes=>{arrive=yes;});
 const worker=layer as unknown as {attempt:(...args:unknown[])=>Promise<unknown>};const project=worker.attempt.bind(layer);let entered=0;
 // The queue's worker calls this.attempt, so the instance property holds every job of this layer.
 worker.attempt=async(...args)=>{entered++;arrive();await gate;return project(...args);};
 return {reached,release:()=>open(),entered:()=>entered};
}

test('40 FAMX cases and 20 seed lines take three sandbox processes per document; repeat and restart reuse the content-addressed projection',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);t.after(()=>w.close());const layer=w.knowledge.feeding!;
 const [first,second]=await Promise.all([layer.observeSource(w.user,w.document.body.sha256,w.scope),layer.observeSource(w.user,w.document.body.sha256,w.scope)]);
 assert.equal(first.objects.length,40);assert.deepEqual(second.objects,first.objects);assert.equal(w.calls(),3,'two whole-document passes plus one normalization batch, independent of case and seed counts');
 await layer.observeSource(w.user,w.document.body.sha256,w.scope);assert.equal(w.calls(),3,'same digest does not reproject');
 const restarted=new FeedingLayer(w.knowledge.__context,layer.reading);await restarted.observeSource(w.user,w.document.body.sha256,w.scope);assert.equal(w.calls(),4,'restart reads the persisted document projection; only a fresh seed normalization batch runs');
 // Metadata and the frozen composition remain part of identity; the cache must never cross their boundary.
 const changed=await w.kit.artifacts.ingest({bytes:Buffer.from(JSON.stringify({id:'SYN-DOC',root:{id:'synthetic-root',title:w.product.product.names[0]},ancestors:['rel_famx_10_9']})),mediaType:'application/json',origin:{read:{object:'agile:mindmap:SYN-DOC'}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});
 await layer.observeSource(w.user,w.document.body.sha256,{...w.scope,metaSource:changed.body.sha256});assert.equal(w.calls(),7,'changed metadata gets its own document projection and normalization');
 // Database round trips grow at most linearly with the cases of a document. A query count has no noise, and an affine
 // count (a fixed part plus a part per case) never grows faster than its input: eight times the cases may take at most
 // eight times the queries. Work per case over all cases (quadratic) exceeds that.
 let queries=0;const rawQuery=pgModule.Client.prototype.query;
 t.mock.method(pgModule.Client.prototype,'query',function(this:pgModule.Client,...args:unknown[]){queries++;return Reflect.apply(rawQuery,this,args);});
 const queriesFor=async(cases:number)=>{
  const input=JSON.parse(mapBytes.toString().replaceAll('Synthetic case ',`Sized ${cases} case `).replaceAll('Synthetic expected ',`Sized ${cases} expected `));input.root.children=input.root.children.slice(0,cases);
  const capture=await readCapture(w,'agile:mindmap:SYN-SIZED-'+cases,Buffer.from(JSON.stringify(input)));
  queries=0;const receipt=await layer.observeSource(w.user,capture.content.body.sha256,capture.scope);const used=queries;assert.equal(receipt.objects.length,cases);return used;
 };
 const small=await queriesFor(5),large=await queriesFor(40);t.diagnostic(`queries per document: 5 cases ${small}, 40 cases ${large}`);
 assert.ok(large<=8*small,`5 → 40 cases took ${small} → ${large} queries; database work per case must not grow with the document`);
});
test('slow document projection returns a pending receipt in a bounded slice and shares one in-flight job',{timeout:120_000},async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg,true);const layer=w.knowledge.feeding!;const held=holdProjection(layer);t.after(async()=>{held.release();await layer.drain();await w.close();});
 const receipts=await Promise.all(Array.from({length:40},()=>layer.observeSourceBounded(w.user,w.document.body.sha256,w.scope)));
 // Every reader has returned while the projection is still held: none of them waited for it.
 assert.ok(receipts.every(row=>row.pending.some(p=>p.missing.includes('进行中'))));
 await held.reached;assert.equal(held.entered(),1,'duplicates share the same queued/running document');assert.equal(w.calls(),0,'no sandbox process ran before the readers returned');
 held.release();await layer.drain();assert.equal(held.entered(),1);assert.equal(w.calls(),3);assert.equal((await layer.entries(w.user,'famx')).length,40);
 assert.deepEqual(FEEDING_BOUNDS,{waitMs:250,concurrency:2,queued:32,callMs:5000,rows:1000});
});
test('a queued projection is a background trace of its own: what it reads is not usage of the request that queued it',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);const layer=w.knowledge.feeding!;t.after(async()=>{await layer.drain();await w.close();});
 const rows:SpanRow[]=[];t.after(installTraceSink({push:row=>rows.push(row)}));
 await startTrace({name:'get_nodes',origin:'mcp'},()=>layer.observeSourceBounded(w.user,w.document.body.sha256,w.scope));await layer.drain();
 const job=rows.find(row=>row.name==='project-document'),call=rows.find(row=>row.name==='get_nodes');
 assert.ok(job&&call);assert.notEqual(job.trace_id,call.trace_id);assert.equal(job.origin,'background');assert.equal(job.is_root,true);assert.ok((job.usage['sandbox.runs']??0)>0,'the projection ran in the job');
});
test('actual case-location start_run with granularity=case returns 40 items without waiting for a slow FAMX feeding projection',{timeout:120_000},async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg,3000);const layer=w.knowledge.feeding!;const held=holdProjection(layer);t.after(async()=>{held.release();await layer.drain();await w.close();});
 const workflows=new FakeWorkflowStore(w.admin.id);await workflows.add(fileURLToPath(new URL('../../packs/workflow/case-location/',import.meta.url)));workflows.assign(w.user.id,'case-location');
 const previous=w.external.read.bind(w.external);w.external.accepts=async id=>id==='agile:mindmap:SYN-DOC'||id==='agile:tree:roots'||id==='site:tree:synthetic';w.external.read=async(id,context)=>{
  if(id==='agile:mindmap:SYN-DOC')return {ok:true,id,revision:null,manifest:'synthetic',artifacts:[{name:'content',artifact:w.document},{name:'meta',artifact:w.meta}]};
  if(id==='agile:tree:roots'){const artifact=await w.kit.artifacts.ingest({bytes:Buffer.from(JSON.stringify({roots:[{id:'synthetic-root',title:'FAMX'}],documents:[{id:'SYN-DOC',title:'Synthetic doc',ancestors:['rel_famx_10_8'],root:'synthetic-root',listed:true}],complete:true,repeated:0})),mediaType:'application/json',origin:{read:{object:id}},author:{user:null},provenanceType:'observed',visibility:{readers:[w.user.id],admins:true,packs:[],shareable:false},readTier:'model_readable'});return {ok:true,id,revision:null,manifest:'synthetic',artifacts:[{name:'original',artifact}]};}
  return previous(id,context);
 };
 const service=createRunsService({sandbox:{requireOsIsolation:await osIsolationAvailable()},records:w.kit,packs:w.packs,knowledge:w.knowledge,external:w.external,workflows,parsers:installedMindmapFixture()});const answer=await service.startRun(w.user,{pack:'case-location',product:'FAMX',build:w.name,parameters:{granularity:'case'},inputs:{documents:{external:'agile:mindmap:SYN-DOC'}}},{traceId:'4bf92f3577b34da6a3ce929d0e0e4736',sessionId:'synthetic'});assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));assert.equal(answer.run!.items.length,40);
 // The run has started while its document projection is still held: start_run did not wait for it.
 await held.reached;assert.ok((await layer.pending(w.user,answer.run!.run)).some(row=>row.missing.includes('进行中')));
 held.release();await layer.drain();assert.ok(w.calls()<=5,'feeding process count is per distinct source document, not per case/check');assert.equal((await layer.entries(w.user,'famx')).length,40);assert.ok((await layer.usages(w.user,answer.run!.run)).includes(w.document.body.sha256));
});
test('queue admission has a hard capacity and rejects excess work without starting another sandbox',async t=>{
 const {newId}=await import('../records/api.ts');const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg);const layer=w.knowledge.feeding!;t.after(async()=>{await layer.drain();await w.close();});
 const original=w.kit.artifacts.source.bind(w.kit.artifacts);let release!:()=>void;const gate=new Promise<void>(yes=>{release=yes;});w.kit.artifacts.source=async(...args)=>{if(args[1]===w.document.body.sha256)await gate;return original(...args);};
 const count=FEEDING_BOUNDS.concurrency+FEEDING_BOUNDS.queued+1;const responses=await Promise.all(Array.from({length:count},()=>layer.observeSourceBounded(w.user,w.document.body.sha256,{run:newId('run')})));const callsBefore=w.calls();release();assert.equal(responses.filter(row=>row.pending.some(p=>p.missing.includes('队列已达上限'))).length,1);assert.equal(callsBefore,0);await layer.drain();assert.equal(w.calls(),0,'unscoped sources cannot start product projection callbacks');
});
test('a sandbox timeout ends the document job as unknown, with no wall-time retries or per-case retry loop',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const w=await world(pg,true);const layer=w.knowledge.feeding!;t.after(async()=>{await layer.drain();await w.close();});w.knowledge.__context.sandbox.producer.timeoutMs=100;
 // The outcome of each sandbox attempt, not the time taken: the deliberately slow projection (800 ms) is stopped at the
 // injected 100 ms limit, and that wall-time timeout is not retried.
 const sandbox=w.knowledge.__context.sandbox as typeof w.knowledge.__context.sandbox&SandboxOptions;const counted=sandbox.onAttempt;const attempts:Parameters<NonNullable<SandboxOptions['onAttempt']>>[0][]=[];sandbox.onAttempt=attempt=>{attempts.push(attempt);counted?.(attempt);};
 const response=await layer.observeSourceBounded(w.user,w.document.body.sha256,w.scope);assert.ok(response.pending.length);await layer.drain();assert.equal(w.calls(),1,'the single document attempt times out once; no calls per case');
 assert.deepEqual(attempts.map(row=>[row.code,row.timeoutMs,row.retry]),[['SANDBOX_TIMEOUT',100,false]],'the one attempt stops at its injected time limit and is not retried');assert.equal((await layer.entries(w.user,'famx')).length,0);const states=await w.knowledge.store.all<any>({key:'knowledge.feeding.job',value:w.user.id,kind:'action'});assert.equal(states.at(-1)!.body.detail.feeding_job.state,'unknown');
});
