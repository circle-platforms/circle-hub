import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
import {installReview,judgment,criterionRequests,revision} from './testing/criterion-review.ts';
import {runById} from './store.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
async function setup(t:any){const h=await criterionHarness(pg);t.after(()=>h.close());await installReview(h);const draft=await h.start();await h.submit(draft.run,[h.proposal]);const request=(await criterionRequests(h,draft.run))[0];return {h,draft,request};}
async function criterionOf(h:Awaited<ReturnType<typeof criterionHarness>>,run:string){await h.submit(run,[]);const result=(await h.service.getResult(h.alice,run))!.result;return Object.values(result.partitions).flat()[0].requirements[0].claims.find(claim=>claim.warrant.producer==='function')?.statement.data?.used_criterion;}
test('only accepted declarations at start freeze refs in the record and full text in check context',async t=>{
 const {h,draft,request}=await setup(t);const review=await judgment(h,draft.run,request),next=await revision(h,draft.run),stored=(await runById(h.kit.store,next.run))!.body;
 assert.deepEqual(stored.accepted_criteria,[{declaration:'rec:'+request.source+'#/criterion_changes/0',review:'rec:'+review.record,reviewer:h.admin.id}]);assert.ok(!JSON.stringify(stored.accepted_criteria).includes(h.proposal.new));assert.equal(await criterionOf(h,next.run),'新判据');const result=(await h.service.getResult(h.alice,next.run))!.result;const claim=Object.values(result.partitions).flat()[0].requirements[0].claims.find(claim=>claim.warrant.producer==='function')!;assert.ok(claim.validity.bound.includes(request.source));assert.ok(claim.validity.bound.includes(review.record));
});
test('pending, expired unanswered and rejected changes are excluded with concrete request status',async t=>{
 for(const state of ['pending','expired','reject']){const {h,draft,request}=await setup(t);if(state==='reject')await judgment(h,draft.run,request,'reject');if(state==='expired')h.advance(2*86400000);const next=await revision(h,draft.run);assert.equal((await runById(h.kit.store,next.run))!.body.accepted_criteria?.length??0,0);const notices=(next as any).criterion_changes;assert.equal(notices?.length,1);assert.equal(notices[0].request,'rec:'+request.record);assert.equal(notices[0].due,request.due);assert.equal(notices[0].audience,request.audience);assert.ok(notices[0].next_action);if(state==='reject'){assert.equal(notices[0].accepted,false);assert.equal(notices[0].reason,'合成复核理由');}assert.equal(await criterionOf(h,next.run),'旧判据');}
});
test('acceptance after start cannot enter that snapshot but late acceptance enters the following revision',async t=>{
 const {h,draft,request}=await setup(t);h.advance(2*86400000);const before=await revision(h,draft.run);await judgment(h,draft.run,request);assert.equal(await criterionOf(h,before.run),'旧判据');const after=await revision(h,before.run);assert.equal(await criterionOf(h,after.run),'新判据');const again=await revision(h,after.run);assert.equal((await runById(h.kit.store,again.run))!.body.accepted_criteria?.length,1);assert.equal(await criterionOf(h,again.run),'新判据');
});
test('distinct accepted submissions each need their own review before both freeze',async t=>{
 const {h,draft,request}=await setup(t);const second={...h.proposal,criterion:h.expected+'/text@1/l/2',old:'另一判据',assertion:'第二处合成判据'};assert.equal((await h.submit(draft.run,[second])).acceptance,'accepted');
 const requests=await criterionRequests(h,draft.run);assert.equal(requests.length,2);assert.notEqual(requests[0].source,requests[1].source);await judgment(h,draft.run,request);
 const first=await revision(h,draft.run);assert.equal((await runById(h.kit.store,first.run))!.body.accepted_criteria?.length,1);
 await judgment(h,draft.run,requests.find(row=>row.record!==request.record)!);const both=await revision(h,first.run);assert.equal((await runById(h.kit.store,both.run))!.body.accepted_criteria?.length,2);
});
