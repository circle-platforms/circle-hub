import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {accepted,runRecord,RECOVERY} from '../../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {newId,withReadScope} from '../../records/api.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness} from './testing/harness.ts';
import {putRun,putResult} from './store.ts';
import {taskResultOf,pendingCount} from '../../server/console/status.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
test('summary reads only the current head and production candidate rather than large unrelated history',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'bounded-summary'});
 const stored=await putRun(h.kit.store,body,new Date(body.started_at).toISOString());
 const result=ValidationResult.parse({...accepted,run:body.run,submission:stored.digest,cross_item:[],partitions:{delivered:[],rejected:[],incomplete:[],quarantined:[]}});
 const production=await putResult(h.kit.store,result,new Date(body.started_at).toISOString());
 for(let n=0;n<24;n++)await putResult(h.kit.store,{...result,submission:n.toString(16).padStart(64,'0'),acceptance:'not_accepted',errors:[{code:'CHECK_ERROR',message:'synthetic historical body '+String(n)+'x'.repeat(64*1024),fix:'synthetic recovery'}]},new Date(body.started_at).toISOString());
 const head=await putResult(h.kit.store,{...result,submission:'b'.repeat(64)},new Date(body.started_at).toISOString());
 const findBatch=h.kit.store.findBatch!.bind(h.kit.store);let reads=0,bytes=0;
 h.kit.store.findBatch=(async(...args:Parameters<typeof findBatch>)=>{
  const pages=await findBatch(...args);args[0].forEach((query,index)=>{if(query.kind==='validation_result'&&(query.key==='runs.result.run'||query.key==='runs.result.submission'))for(const record of pages[index].items){reads++;bytes+=Buffer.byteLength(JSON.stringify(record.body));}});return pages;
 }) as typeof findBatch;
 try{
  const summary=await h.service.getRunSummary!(h.alice,body.run);
  assert.equal(summary?.latest?.record,head.digest);assert.equal(summary?.production?.record,production.digest);
  assert.equal(reads,2,'history volume must not increase the loaded result bodies for a visible current head and production');
  assert.equal(bytes,Buffer.byteLength(JSON.stringify(head.body))+Buffer.byteLength(JSON.stringify(production.body)),'only the two exact current bodies contribute bytes');
 }finally{h.kit.store.findBatch=findBatch;}
 const rejected=await putResult(h.kit.store,{...result,submission:'c'.repeat(64),acceptance:'not_accepted',errors:[{code:'CHECK_ERROR',message:'synthetic refused head',fix:'synthetic retry'}]},new Date(body.started_at).toISOString());
 assert.notEqual(rejected.digest,head.digest);
 assert.equal((await h.service.getRunSummary!(h.alice,body.run))?.latest?.record,head.digest,'a rejected receipt is not an accepted technical head');
});

test('summary heads equal full detail for owners, administrators and partial readers, including unknown and hidden latest results',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const input=await h.kit.artifacts.ingest({bytes:Buffer.from('合成公开采集'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:summary'}},author:{user:null},provenanceType:'observed',visibility:{readers:[h.alice.id,h.bob.id],admins:true,packs:[],shareable:false}});
 const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[{reference:'src:'+input.body.sha256,artifact:input.digest,role:'subject'}],items:[],target_basis:[],client_key:'synthetic-summary'});
 const stored=await putRun(h.kit.store,body,new Date(body.started_at).toISOString());
 const result=ValidationResult.parse({...accepted,run:body.run,submission:stored.digest,cross_item:[],partitions:{delivered:[{item:'synthetic-item',label:'合成未知',location:'src:'+input.body.sha256,requirements:[{requirement:'synthetic',status:'pending',claims:[],layers:[{layer:'static',terminal:'unchecked',reason:'check_error',...RECOVERY,exit:{...RECOVERY.exit,audience:{user:h.alice.id}}}]}]}],rejected:[],incomplete:[],quarantined:[]}});
 await putResult(h.kit.store,result,new Date(body.started_at).toISOString());await h.kit.authorizations.share(h.admin,body.run,[h.bob.id]);
 const compare=async()=>{
  for(const by of [h.alice,h.bob,h.admin])await withReadScope(async()=>{
   const detail=await h.service.getRun(by,body.run),summary=await h.service.getRunSummary!(by,body.run);
   assert.ok(detail&&summary);assert.deepEqual(summary.latest,detail.latest);assert.deepEqual(summary.production,detail.production);assert.deepEqual(summary.management,detail.management);assert.deepEqual(summary.run.requirements,detail.run.requirements);
   assert.equal(taskResultOf(summary),taskResultOf(detail));assert.equal(pendingCount(summary),pendingCount(detail));
  });
 };
 await compare();assert.equal(taskResultOf((await h.service.getRunSummary!(h.admin,body.run))!),'delivered_pending');
 const findBatch=h.kit.store.findBatch!.bind(h.kit.store);let resultReads=0;
 h.kit.store.findBatch=((queries:Parameters<typeof findBatch>[0],tx?:Parameters<typeof findBatch>[1])=>{resultReads+=queries.filter(query=>query.key==='runs.result.run').length;return findBatch(queries,tx);}) as typeof findBatch;
 await h.service.getRunSummary!(h.admin,body.run);h.kit.store.findBatch=findBatch;
 assert.equal(resultReads,1,'only the newest accepted candidate is read from the full-history index');
 const secret=await h.kit.artifacts.ingest({bytes:Buffer.from('合成私人结论依据'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:h.alice.id},provenanceType:'declared',visibility:{readers:[h.alice.id],admins:false,packs:[],shareable:false}});
 const hidden=structuredClone(result);hidden.submission='a'.repeat(64);hidden.partitions.delivered[0].location='src:'+secret.body.sha256;
 await putResult(h.kit.store,hidden,new Date(body.started_at).toISOString());await compare();
 assert.equal((await h.service.getRunSummary!(h.admin,body.run))!.latest,null,'a hidden current result never falls back to an older visible success');
 const hiddenProduction={...hidden,submission:stored.digest};
 await putResult(h.kit.store,hiddenProduction,new Date(body.started_at).toISOString());await compare();
 assert.equal((await h.service.getRunSummary!(h.admin,body.run))!.production?.result.partitions.delivered[0].location,'src:'+input.body.sha256,'production keeps its existing last-readable policy even when its newest candidate is private');
 await h.kit.authorizations.unshare(h.admin,body.run,h.bob.id);assert.equal(await h.service.getRunSummary!(h.bob,body.run),null);
 assert.equal(await h.service.getRunSummary!(h.admin,newId('run')),null);
});
