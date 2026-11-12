import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {accepted,runRecord} from '../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../contracts/src/validation.ts';
import {RunRecord} from '../../contracts/src/run.ts';
import type {RunsService} from '../ports.ts';
import {newId} from '../records/api.ts';
import {startPostgres} from '../testing/postgres.ts';
import {openHarness} from '../runs/engine/testing/harness.ts';
import {putAction,putResult,putRun,putSubmission} from '../runs/engine/store.ts';
import {recordReaderFor} from './readers.ts';

let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());

test('reading a run-scoped record decides on the run header, never on the run history, with the same verdicts',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'reader-header'});
 const at=new Date(body.started_at).toISOString();
 const stored=await putRun(h.kit.store,body,at);
 const result=ValidationResult.parse({...accepted,run:body.run,submission:stored.digest,cross_item:[],partitions:{delivered:[],rejected:[],incomplete:[],quarantined:[]}});
 const production=await putResult(h.kit.store,result,at);
 const HISTORY=24;
 let refused=production;
 for(let n=0;n<HISTORY;n++)refused=await putResult(h.kit.store,{...result,submission:n.toString(16).padStart(64,'0'),acceptance:'not_accepted',errors:[{code:'CHECK_ERROR',message:'synthetic historical body '+String(n)+'x'.repeat(64*1024),fix:'synthetic recovery'}]},at);
 // One submission whose accepted result a non-runner may therefore read, and one whose result is not accepted.
 const SUBMITTED='a'.repeat(64);
 const submission=await putSubmission(h.kit.store,{run:body.run,digest:SUBMITTED,body:{received:{object:'synthetic',size:1,non_canonical_path:'/',run:body.run}},parses:false,createdAt:at});
 const answered=await putResult(h.kit.store,{...result,submission:SUBMITTED},at);
 const action=await putAction(h.kit.store,{action:'validate',run:body.run,inputs:[submission.digest],startedAt:at,endedAt:at,result:'completed',acceptance:'accepted',codes:[],detail:{submission:SUBMITTED,result:answered.digest},submissionRecord:submission.digest});
 const unanswered=await putSubmission(h.kit.store,{run:body.run,digest:'b'.repeat(64),body:{received:{object:'synthetic',size:2,non_canonical_path:'/',run:body.run}},parses:false,createdAt:at});

 const records=[['run',stored.digest],['production result',production.digest],['rejected result',refused.digest],['answered submission',submission.digest],['unanswered submission',unanswered.digest],['validate action',action.digest]] as const;
 const legacy={...h.service,runHeader:undefined} as unknown as RunsService;
 const readers=(by:typeof h.alice,service:RunsService)=>recordReaderFor(h.kit,service,by);
 const verdicts=async(by:typeof h.alice,service:RunsService)=>Promise.all(records.map(async([,digest])=>(await readers(by,service).read(digest,{user:by.id,role:by.role}))!==null));

 // Every account × record pair gets the verdict the full detail read gave before the header read existed.
 const seen=new Set<boolean>();
 const compare=async(label:string)=>{
  for(const by of [h.alice,h.bob,h.admin]){
   const [fast,slow]=[await verdicts(by,h.service),await verdicts(by,legacy)];
   assert.deepEqual(fast,slow,`${label}: ${by.id}`);fast.forEach(v=>seen.add(v));
  }
 };
 await compare('before any share');
 await h.kit.authorizations.share(h.admin,body.run,[h.bob.id]);
 await compare('shared with bob');
 assert.deepEqual(await verdicts(h.alice,h.service),[true,true,true,true,true,true],'the runner reads every record of the run');
 assert.equal((await verdicts(h.bob,h.service)).filter(Boolean).length>0,true,'the share is visible to the reader');
 await h.kit.authorizations.unshare(h.admin,body.run,h.bob.id);
 await compare('share revoked');
 assert.deepEqual(await verdicts(h.bob,h.service),[false,false,false,false,false,false],'a revoked share reads nothing at once');
 assert.deepEqual([...seen].sort(),[false,true],'the matrix covers both verdicts');

 // The cost: reading one record of a run with a long history loads none of its result bodies.
 await h.kit.authorizations.share(h.admin,body.run,[h.bob.id]);
 const find=h.kit.store.find.bind(h.kit.store),findBatch=h.kit.store.findBatch!.bind(h.kit.store);
 const loaded=async(read:()=>unknown):Promise<number>=>{
  let bodies=0;
  h.kit.store.find=(async(...args:Parameters<typeof find>)=>{const page=await find(...args);for(const record of page.items)if(record.kind==='validation_result')bodies++;return page;}) as typeof find;
  h.kit.store.findBatch=(async(...args:Parameters<typeof findBatch>)=>{const pages=await findBatch(...args);for(const page of pages)for(const record of page.items)if(record.kind==='validation_result')bodies++;return pages;}) as typeof findBatch;
  try{await read();return bodies;}finally{h.kit.store.find=find;h.kit.store.findBatch=findBatch;}
 };
 const control=await loaded(()=>readers(h.bob,legacy).read(stored.digest,{user:h.bob.id,role:h.bob.role}));
 assert.ok(control>=HISTORY,'control: the full detail read loads the history ('+control+' bodies)');
 const header=await loaded(()=>readers(h.bob,h.service).read(stored.digest,{user:h.bob.id,role:h.bob.role}));
 assert.equal(header,0,'a run record read must not load result bodies');
 const result_=await loaded(()=>readers(h.bob,h.service).read(production.digest,{user:h.bob.id,role:h.bob.role}));
 assert.equal(result_,0,'a result record read checks its own readability, not the run history');
});
