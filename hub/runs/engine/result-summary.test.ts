// The summary record of a validation result (model 43, W08 R[6], decision 153): projected where the result is stored,
// read in place of the result by the statistics of a list, with the answers the results themselves give, to each reader.
import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {accepted,notAccepted,runRecord,RECOVERY,claim as fixtureClaim,sha} from '../../../contracts/src/fixtures.ts';
import {ResultSummaryBody} from '../../../contracts/src/result-summary.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import {newId,withReadScope,IntegrityError,type StoredRecord} from '../../records/api.ts';
import {runStatistics} from '../statistics.ts';
import {Database,createPool} from '../../records/db.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness} from './testing/harness.ts';
import {resultGrounds} from './ground-extraction.ts';
import {groundsWithSources} from './ground-extraction.ts';
import {resultSummaryOf,saveResult,summarize,summariesComplete,summarizeStoredResults} from './result-summary.ts';
import {INDEX,putResult,putRun} from './store.ts';
import {createRequestService} from '../../requests/api.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());

type Harness=Awaited<ReturnType<typeof openHarness>>;
const at=(run:RunRecord)=>new Date(run.started_at).toISOString();
/** How many result bodies the store handed out while `work` ran: the read a summary is there to spare. */
async function resultsRead<T>(h:Harness,work:()=>Promise<T>):Promise<{value:T;results:number}>{
 const store=h.kit.store as unknown as Record<string,(...args:unknown[])=>Promise<unknown>>,originals=new Map<string,(...args:unknown[])=>Promise<unknown>>();
 let results=0;
 const count=(value:unknown):void=>{
  const records=value==null?[]:value instanceof Map?[...value.values()]:Array.isArray(value)?value.flatMap(item=>item&&Array.isArray((item as {items?:unknown[]}).items)?(item as {items:unknown[]}).items:[item]):Array.isArray((value as {items?:unknown[]}).items)?(value as {items:unknown[]}).items:[value];
  for(const record of records)if((record as {kind?:string}|null)?.kind==='validation_result')results++;
 };
 for(const name of ['get','getMany','find','findBatch','findMany','list']){const original=store[name].bind(store);originals.set(name,store[name]);store[name]=async(...args:unknown[])=>{const value=await original(...args);count(value);return value;};}
 try{return {value:await work(),results};}finally{for(const [name,original] of originals)store[name]=original;}
}

test('a result is stored with its summary, which says what the result says and names the grounds it names',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const input=await h.kit.artifacts.ingest({bytes:Buffer.from('合成摘要原件'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:summary'}},author:{user:null},provenanceType:'observed',visibility:{readers:[h.alice.id],admins:true,packs:[],shareable:false}});
 const run=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[{reference:'src:'+input.body.sha256,artifact:input.digest,role:'subject'}],items:[],target_basis:[],client_key:'synthetic-summary-shape'});
 const stored=await putRun(h.kit.store,run,at(run));
 // A claim whose validity binds the run's source by its digest: the source becomes a ground of the result within this run.
 const bound=ValidationResult.parse({...accepted,run:run.run,submission:stored.digest,cross_item:[{...fixtureClaim,validity:{status:'valid',bound:[input.body.sha256],premises:[]}}]});
 const saved=await saveResult(h.kit.store,bound,at(run));
 const again=await saveResult(h.kit.store,bound,at(run));
 assert.equal(again.digest,saved.digest,'the same result again is the same record');
 const summaries=await h.kit.store.findMany<ResultSummaryBody>({kind:'result_summary',key:INDEX.summaryResult,values:[saved.digest]});
 assert.equal(summaries.length,1,'and has one summary');
 const summary=summaries[0];
 assert.equal(summary.schema,'result-summary@1');assert.equal(summary.provenance,'projected');assert.equal(summary.created_at,saved.created_at);
 // The projection is of the record as stored: its canonical member order is the order every later read walks it in.
 const asStored=(await h.kit.store.get<ValidationResult>(saved.digest))!.body;
 assert.deepEqual(summary.body,ResultSummaryBody.parse(summarize(asStored,saved.digest)));
 assert.deepEqual(await resultSummaryOf(h.kit.store,run.run,saved.digest),summary.body);
 assert.equal(summary.body.run,run.run);assert.equal(summary.body.result,saved.digest);assert.equal(summary.body.submission,stored.digest);
 assert.equal(summary.body.acceptance,'accepted');assert.equal(summary.body.system_input,false);
 // What it comes to is what the statistics of a run say whose one result it is.
 assert.deepEqual(summary.body.statistics,runStatistics({run:{...run,requirements:[]},latest:{record:saved.digest,result:bound},production:null}));
 // The grounds within the run are those the result gives, in its order, the bound source among them.
 const read=(await h.kit.store.get<ValidationResult>(saved.digest))!;
 const fromResult=resultGrounds(read.body,run);
 assert.deepEqual(groundsWithSources(summary.body.grounds,summary.body.bound,run),fromResult);
 assert.ok(fromResult.includes('src:'+input.body.sha256)&&summary.body.bound.includes(input.body.sha256));
 // The result record is what putResult alone would have stored, plus the mark that it has a summary.
 assert.deepEqual(read.body,bound);
 assert.equal((await h.kit.store.find({kind:'validation_result',key:INDEX.resultSummarized,value:'1',limit:5})).items.length,1);
 // A refused result is summarized too: it awaits, with nothing counted.
 const refused=await saveResult(h.kit.store,ValidationResult.parse({...notAccepted,run:run.run,submission:sha('synthetic refused')}),at(run));
 assert.deepEqual((await resultSummaryOf(h.kit.store,run.run,refused.digest))!.statistics,{result:'awaiting',pending:0,checks:[],blockers:[]});
 // Not this run's result, and no result at all.
 assert.equal(await resultSummaryOf(h.kit.store,newId('run'),saved.digest),null);
 assert.equal(await resultSummaryOf(h.kit.store,run.run,sha('no such result')),null);
});

for(const withSummary of [true,false])test(`the statistics of a run ${withSummary?'read its summaries and no result':'without summaries read its results'}: the same answer to the runner, a shared reader and an administrator, through private grounds and revocation`,async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const write=(result:ValidationResult,when:string)=>withSummary?saveResult(h.kit.store,result,when):putResult(h.kit.store,result,when);
 const input=await h.kit.artifacts.ingest({bytes:Buffer.from('合成统计原件'),mediaType:'text/plain',origin:{read:{object:'synthetic:document:statistics-summary'}},author:{user:null},provenanceType:'observed',visibility:{readers:[h.alice.id,h.bob.id],admins:true,packs:[],shareable:false}});
 const run=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[{reference:'src:'+input.body.sha256,artifact:input.digest,role:'subject'}],items:[],target_basis:[],client_key:'synthetic-statistics-summary-'+withSummary});
 const stored=await putRun(h.kit.store,run,at(run));
 const result=ValidationResult.parse({...accepted,run:run.run,submission:stored.digest,cross_item:[],partitions:{delivered:[{item:'synthetic-item',label:'合成未知',location:'src:'+input.body.sha256,requirements:[{requirement:'synthetic',status:'pending',claims:[],layers:[{layer:'static',terminal:'unchecked',reason:'check_error',...RECOVERY,exit:{...RECOVERY.exit,audience:{user:h.alice.id}}}]}]}],rejected:[],incomplete:[],quarantined:[]}});
 await write(result,at(run));await h.kit.authorizations.share(h.admin,run.run,[h.bob.id]);
 const compare=async()=>{for(const by of [h.alice,h.bob,h.admin]){
  const full=await withReadScope(()=>h.service.getRunSummary!(by,run.run));
  const {value:small,results}=await resultsRead(h,()=>withReadScope(()=>h.service.getRunStatistics!(by,run.run)));
  assert.ok(full&&small);assert.deepEqual(small,runStatistics(full));assert.ok(!JSON.stringify(small).includes(input.body.sha256));
  if(withSummary)assert.equal(results,0,'no result is read for the statistics');else assert.ok(results>0);
 }};
 await compare();
 assert.equal((await h.service.getRunStatistics!(h.alice,run.run))!.pending,1);
 // A later result resting on a ground only the runner may read: the others have no current result, and are not told why.
 const secret=await h.kit.artifacts.ingest({bytes:Buffer.from('合成私人结论依据'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:h.alice.id},provenanceType:'declared',visibility:{readers:[h.alice.id],admins:false,packs:[],shareable:false}});
 const hidden=structuredClone(result);hidden.submission='a'.repeat(64);hidden.partitions.delivered[0].location='src:'+secret.body.sha256;
 await write(hidden,at(run));await compare();
 assert.equal((await h.service.getRunStatistics!(h.admin,run.run))!.result,'awaiting');
 assert.equal((await h.service.getRunStatistics!(h.alice,run.run))!.result,'delivered_pending');
 // A refused result after it changes nothing: the newest accepted one still counts.
 await write(ValidationResult.parse({...notAccepted,run:run.run,submission:'b'.repeat(64)}),at(run));await compare();
 assert.equal((await h.service.getRunStatistics!(h.alice,run.run))!.result,'delivered_pending');
 await h.kit.authorizations.unshare(h.admin,run.run,h.bob.id);
 assert.equal(await h.service.getRunStatistics!(h.bob,run.run),null);
 assert.equal(await h.service.getRunStatistics!(h.admin,newId('run')),null);
 await h.kit.principals.setDisabled(h.admin,h.alice.id,true);
 assert.equal(await h.service.getRunStatistics!(h.alice,run.run),null);
});

test('a summary is verified when it is read, cannot be replaced by a later one, and is used only for the result and run it names',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const run=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'synthetic-summary-integrity'});
 const record=await putRun(h.kit.store,run,at(run));
 const result=ValidationResult.parse({...accepted,run:run.run,submission:record.digest,cross_item:[],partitions:{delivered:[{item:'synthetic',label:'合成',location:'src:'+'a'.repeat(64),requirements:[{requirement:'synthetic',status:'satisfied',claims:[fixtureClaim],layers:[{layer:'static',terminal:'pass'}]}]}],rejected:[],incomplete:[],quarantined:[]}});
 const written=await saveResult(h.kit.store,result,at(run));
 const summary=(await h.kit.store.find<ResultSummaryBody>({kind:'result_summary',key:INDEX.summaryResult,value:written.digest,limit:1})).items[0];
 const expected=runStatistics({run:{...run,requirements:[]},latest:{record:written.digest,result},production:null});
 assert.deepEqual(await h.service.getRunStatistics!(h.alice,run.run),expected);
 assert.equal(expected.result,'passed');

 // A record appended later that claims to summarize the same result with other figures is not the one that is read.
 const forged={...summary.body,statistics:{result:'rejected' as const,pending:0,checks:[],blockers:[]}};
 await h.kit.store.put({kind:'result_summary',schema:'result-summary@1',provenance:'projected',body:forged,index:[{key:INDEX.summaryResult,value:written.digest}]});
 assert.deepEqual(await h.service.getRunStatistics!(h.alice,run.run),expected);
 // A summary filed under a result it does not name, or naming another run, is not used: the result itself is read.
 const stray=RunRecord.parse({...run,run:newId('run'),client_key:'synthetic-summary-integrity-stray'});await putRun(h.kit.store,stray,at(stray));
 const bare=await putResult(h.kit.store,ValidationResult.parse({...result,run:stray.run,submission:sha('synthetic stray')}),at(stray));
 await h.kit.store.put({kind:'result_summary',schema:'result-summary@1',provenance:'projected',body:forged,index:[{key:INDEX.summaryResult,value:bare.digest}]});
 await h.kit.store.put({kind:'result_summary',schema:'result-summary@1',provenance:'projected',body:{...forged,result:bare.digest},index:[{key:INDEX.summaryResult,value:bare.digest}]});
 const {value:answered,results}=await resultsRead(h,()=>h.service.getRunStatistics!(h.alice,stray.run));
 assert.equal(answered!.result,'passed');assert.ok(results>0,'read from the result');

 const database=new Database(createPool(h.kit.database,1));t.after(()=>database.end());
 const corrupt=async(sql:string,digest:string)=>{await database.transaction(async tx=>{await database.query("SET LOCAL session_replication_role='replica'",[],tx);await database.query(sql,[digest],tx);});};
 // The result altered, its summary intact: the list still answers from the summary it verified; whatever reads the result refuses it.
 await corrupt("UPDATE records SET body=replace(body,'synthetic','synthetic altered') WHERE digest=$1",written.digest);
 assert.deepEqual(await h.service.getRunStatistics!(h.alice,run.run),expected);
 await assert.rejects(h.service.getRunSummary!(h.alice,run.run),IntegrityError);
 await assert.rejects(h.service.getRun(h.alice,run.run),IntegrityError);
 // The summary altered: the statistics refuse it, as they refuse an altered result that has no summary.
 await corrupt("UPDATE records SET body=replace(body,'\"passed\"','\"rejected\"') WHERE digest=$1",summary.digest);
 await assert.rejects(h.service.getRunStatistics!(h.alice,run.run),IntegrityError);
});

test('results stored before summaries get theirs in one background pass, which then does not run again',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const run=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'synthetic-summary-backfill'});
 const record=await putRun(h.kit.store,run,at(run));
 const old:StoredRecord<ValidationResult>[]=[];
 for(let n=0;n<5;n++)old.push(await putResult(h.kit.store,ValidationResult.parse({...(n%2?notAccepted:accepted),run:run.run,submission:n===0?record.digest:sha('synthetic old '+n)}),at(run)));
 const before=await h.service.getRunStatistics!(h.alice,run.run);
 assert.equal(await summariesComplete(h.kit.store),false);
 const have=async()=>(await h.kit.store.findMany({kind:'result_summary',key:INDEX.summaryResult,values:old.map(r=>r.digest)})).length;
 assert.equal(await have(),0);

 // Interrupted before it starts: nothing is marked.
 const stopped=new AbortController();stopped.abort();
 await assert.rejects(summarizeStoredResults(h.kit.store,{signal:stopped.signal}));
 assert.equal(await summariesComplete(h.kit.store),false);

 // From here on results are stored with their summary: the pass stops at the first of them.
 const fresh=await saveResult(h.kit.store,ValidationResult.parse({...accepted,run:run.run,submission:sha('synthetic fresh')}),at(run));
 assert.deepEqual(await summarizeStoredResults(h.kit.store,{batch:2}),{examined:5,written:5,complete:true});
 assert.equal(await have(),5);
 assert.equal(await summariesComplete(h.kit.store),true);
 assert.deepEqual(await summarizeStoredResults(h.kit.store),{examined:0,written:0,complete:true});
 for(const result of old){
  const summary=(await h.kit.store.find<ResultSummaryBody>({kind:'result_summary',key:INDEX.summaryResult,value:result.digest,limit:1})).items[0];
  assert.deepEqual(summary.body,ResultSummaryBody.parse(summarize(result.body,result.digest)),'what storing it with a summary would have written');
  assert.equal(summary.created_at,result.created_at);
 }
 // The statistics read summaries now, and say for the older results what they said from the results.
 const read=await resultsRead(h,()=>h.service.getRunStatistics!(h.alice,run.run));
 assert.equal(read.results,0);
 assert.deepEqual(read.value,runStatistics((await h.service.getRunSummary!(h.alice,run.run))!));
 assert.equal((await resultSummaryOf(h.kit.store,run.run,fresh.digest))!.result,fresh.digest);
 assert.ok(before);
});

test('a request is shown to a reader by the summary of the result that issued it, as by the result',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const secret=await h.kit.artifacts.ingest({bytes:Buffer.from('合成私人依据'),mediaType:'text/plain',origin:{upload:{session:null}},author:{user:h.alice.id},provenanceType:'declared',visibility:{readers:[h.alice.id],admins:false,packs:[],shareable:false}});
 const run=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'synthetic-summary-requests'});
 await putRun(h.kit.store,run,at(run));await h.kit.authorizations.share(h.admin,run.run,[h.bob.id]);
 const requests=createRequestService(h.kit);
 const issue=async(label:string,location:string,summarized:boolean)=>{
  const result=ValidationResult.parse({...accepted,run:run.run,submission:sha('synthetic issuing '+label),cross_item:[],partitions:{delivered:[{item:'synthetic',label:'合成',location,requirements:[{requirement:'synthetic',status:'satisfied',claims:[],layers:[{layer:'static',terminal:'pass'}]}]}],rejected:[],incomplete:[],quarantined:[]}});
  if(summarized)await saveResult(h.kit.store,result,at(run));else await putResult(h.kit.store,result,at(run));
  return (await requests.write({run:run.run,source:result.submission,kind:'repair',audience:h.alice.id,due:'2026-10-21T00:00:00.000Z',missing:'合成缺口 '+label,next_action:'原样重交',code:'not_covered'})).digest;
 };
 const open='src:'+'c'.repeat(64),closed='src:'+secret.body.sha256;
 const made={openSummary:await issue('open summary',open,true),openResult:await issue('open result',open,false),closedSummary:await issue('closed summary',closed,true),closedResult:await issue('closed result',closed,false)};
 const seen=async(by:typeof h.alice)=>new Set((await h.service.listRequests!(by,run.run,{waiting:true})).map(request=>request.record));
 assert.deepEqual(await seen(h.alice),new Set(Object.values(made)),'the runner sees all four');
 // A reader who may not read the private ground sees neither request issued by a result resting on it, summarized or not.
 for(const by of [h.bob,h.admin]){
  const visible=await seen(by);
  assert.equal(visible.has(made.closedSummary),visible.has(made.closedResult));
  assert.equal(visible.has(made.openSummary),visible.has(made.openResult));
  assert.equal(visible.has(made.closedSummary),false);
 }
});
