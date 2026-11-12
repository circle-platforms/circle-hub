import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {accepted,runRecord} from '../../../contracts/src/fixtures.ts';
import {ValidationResult} from '../../../contracts/src/validation.ts';
import {RunRecord} from '../../../contracts/src/run.ts';
import type {RunDetail} from '../../ports.ts';
import {newId} from '../../records/api.ts';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness,type Harness} from './testing/harness.ts';
import {putAction,putResult,putRun,putSubmission} from './store.ts';

let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());

/** A run with `count` submissions, each answered by its own result; by default the second one is the accepted one, so the current result is old. */
async function history(h:Harness,count:number,filler=2048,acceptedAt=1){
 const body=RunRecord.parse({...runRecord,run:newId('run'),runner:h.alice.id,pack:`${h.review.pack.id}@${h.review.pack.version}`,pack_digest:h.review.pack.digest,requirements:[],sources:[],items:[],target_basis:[],client_key:'history-'+count});
 const at=new Date(body.started_at).toISOString(),stored=await putRun(h.kit.store,body,at);
 const base=ValidationResult.parse({...accepted,run:body.run,submission:stored.digest,cross_item:[],partitions:{delivered:[],rejected:[],incomplete:[],quarantined:[]}});
 const production=await putResult(h.kit.store,base,at);
 const records:string[]=[];
 for(let n=0;n<count;n++){
  const digest=(n+1).toString(16).padStart(64,'0');
  const submission=await putSubmission(h.kit.store,{run:body.run,digest,body:{received:{object:'synthetic',size:n+1,non_canonical_path:'/',run:body.run}},parses:false,createdAt:at});
  const ok=n===acceptedAt;
  const result=await putResult(h.kit.store,{...base,submission:digest,acceptance:ok?'accepted':'not_accepted',...(ok?{}:{errors:[{code:'CHECK_ERROR',message:'synthetic history '+n+'x'.repeat(filler),fix:'synthetic recovery'}]})},at);
  await putAction(h.kit.store,{action:'validate',run:body.run,inputs:[submission.digest],startedAt:at,endedAt:at,result:'completed',acceptance:ok?'accepted':'not_accepted',codes:[],detail:{submission:digest,result:result.digest},submissionRecord:submission.digest});
  records.push(submission.digest);
 }
 return {body,stored,production,records};
}

const countBodies=async<T>(h:Harness,read:()=>Promise<T>):Promise<{value:T;bodies:number}>=>{
 const find=h.kit.store.find.bind(h.kit.store),findBatch=h.kit.store.findBatch!.bind(h.kit.store);let bodies=0;
 h.kit.store.find=(async(...args:Parameters<typeof find>)=>{const page=await find(...args);for(const record of page.items)if(record.kind==='validation_result')bodies++;return page;}) as typeof find;
 h.kit.store.findBatch=(async(...args:Parameters<typeof findBatch>)=>{const pages=await findBatch(...args);for(const page of pages)for(const record of page.items)if(record.kind==='validation_result')bodies++;return pages;}) as typeof findBatch;
 try{return {value:await read(),bodies};}finally{h.kit.store.find=find;h.kit.store.findBatch=findBatch;}
};

test('a bounded detail read lists the newest submissions, pins the one behind the current result, and its pages together give the whole history in order',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const {body,records}=await history(h,12);
 const full=(await h.service.getRun(h.alice,body.run))!;
 assert.deepEqual(full.submissions.map(row=>row.record),records,'the unbounded read is unchanged: every submission, oldest first');
 assert.equal(full.history,undefined,'and says nothing about paging');
 const first=(await h.service.getRun(h.alice,body.run,{history:{limit:5}}))!;
 assert.ok(first.history);assert.equal(first.history.limit,5);assert.ok(first.history.next!==null,'older submissions remain');
 // The current (accepted) result belongs to the second submission, far outside the newest five: it stays visible, first.
 assert.equal(first.history.pinned,records[1]);assert.deepEqual(first.submissions.map(row=>row.record),[records[1],...records.slice(7)]);
 assert.deepEqual(first.latest,full.latest);assert.deepEqual(first.production,full.production);assert.deepEqual(first.run,full.run);
 // Every row is the row the unbounded read gives for the same submission.
 for(const row of first.submissions)assert.deepEqual(row,full.submissions.find(other=>other.record===row.record));
 // The older pages, followed by their cursors, add the rest without gaps or repeats.
 const seen:string[]=[...first.submissions.filter(row=>row.record!==first.history!.pinned).map(row=>row.record)];let cursor:string|null=first.history.next,pages=1;
 while(cursor!==null&&pages<10){
  const page:RunDetail=(await h.service.getRun(h.alice,body.run,{history:{limit:5,before:cursor}}))!;
  assert.equal(page.history!.pinned,undefined,'the pinned submission is shown with the newest page only');
  seen.unshift(...page.submissions.map(row=>row.record));cursor=page.history!.next;pages++;
 }
 assert.deepEqual(seen,records,'the pages cover the whole history exactly once, oldest first');
 assert.equal(pages,3,'12 submissions in pages of 5');
});

test('the result bodies a bounded read loads do not grow with the length of the history, while the unbounded read grows with it',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 // The accepted submission is the newest one here: finding the current result is a backward scan whose length is the distance to it,
 // which is independent of the listing this read replaces (it stays as long as the newest accepted result is old).
 const small=await history(h,110,1024,109),large=await history(h,220,1024,219);
 const bounded=async(run:string)=>(await countBodies(h,()=>h.service.getRun(h.alice,run,{history:{limit:5}}))).bodies;
 const unbounded=async(run:string)=>(await countBodies(h,()=>h.service.getRun(h.alice,run))).bodies;
 const [b1,b2,u1,u2]=[await bounded(small.body.run),await bounded(large.body.run),await unbounded(small.body.run),await unbounded(large.body.run)];
 assert.equal(b2,b1,`bounded: ${b1} bodies at 110 submissions and ${b2} at 220`);
 assert.ok(u2-u1>=110,`unbounded grows with the history (110 more results, at least 110 more bodies): ${u1} then ${u2}`);
 assert.ok(b2<u2/2,`and a bounded read loads far fewer: ${b2} against ${u2}`);
});

test('a bounded read gives every reader what the unbounded read gives: an unshared member sees nothing, a shared one sees the rows, a bad cursor is an empty page',async t=>{
 const h=await openHarness(pg);t.after(h.close);
 const {body,records}=await history(h,8);
 assert.equal(await h.service.getRun(h.bob,body.run,{history:{limit:3}}),null,'an unshared run answers the neutral null, as before');
 await h.kit.authorizations.share(h.admin,body.run,[h.bob.id]);
 for(const by of [h.alice,h.admin,h.bob]){
  const full=(await h.service.getRun(by,body.run))!,page=(await h.service.getRun(by,body.run,{history:{limit:3}}))!;
  assert.ok(full&&page,by.id);
  for(const row of page.submissions)assert.deepEqual(row,full.submissions.find(other=>other.record===row.record),`${by.id} ${row.record}`);
  assert.deepEqual(page.latest,full.latest);assert.deepEqual(page.production,full.production);assert.equal(page.requests?.length??0,full.requests?.length??0);
 }
 const bad=(await h.service.getRun(h.alice,body.run,{history:{limit:3,before:'not-a-cursor'}}))!;
 assert.deepEqual(bad.submissions.map(row=>row.record).filter(record=>!records.includes(record)),[],'nothing invented');
 assert.equal(bad.history!.next,null,'an unusable cursor ends the paging instead of failing the page');
 await h.kit.authorizations.unshare(h.admin,body.run,h.bob.id);
 assert.equal(await h.service.getRun(h.bob,body.run,{history:{limit:3}}),null,'a revoked share is seen at once');
 const refused=(await h.service.getRun(h.alice,body.run,{history:{limit:0}}));assert.equal(refused?.history?.limit,1,'a limit below one is raised to one, never an empty window');
});
