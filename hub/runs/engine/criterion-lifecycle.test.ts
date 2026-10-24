import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
import {createRequestService} from '../../requests/api.ts';
import {runById,putRun} from './store.ts';
import {newId} from '../../records/api.ts';
test('accepted declarations open named judgment requests at the source submission position and remain on the old criterion',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());const run=await h.start();
 const answer=await h.submit(run.run,[h.proposal]);assert.equal(answer.acceptance,'accepted',JSON.stringify(answer));
 const requests=await createRequestService(h.kit).all(run.run);const request=requests.find(row=>row.declaration)!;assert.ok(request);
 const stored=await runById(h.kit.store,run.run);assert.equal(request.due,stored!.body.submission_due);assert.equal(request.audience,h.admin.id);assert.equal(request.kind,'judgment');assert.equal(request.declaration,'/criterion_changes/0');
 assert.equal((await h.kit.store.get(request.source))?.kind,'submission');
 assert.ok(request.next_action.includes('criterion-review'));assert.ok(request.next_action.includes('evidence'));assert.ok(request.next_action.includes('rec:'+request.source));
 assert.ok(answer.errors.some(row=>row.fix?.includes(request.record)&&row.fix.includes(request.due)&&row.fix.includes(request.audience)));
 const result=await h.service.getResult(h.alice,run.run);assert.ok(Object.values(result!.result.partitions).flat().some(row=>row.requirements.some(requirement=>requirement.status!=='satisfied')));
 await h.submit(run.run,[h.proposal]);assert.equal((await createRequestService(h.kit).all(run.run)).filter(row=>row.declaration).length,1);
});
test('resubmitting the same item and criterion appends a replacement answer without modifying old request bytes',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());const run=await h.start();
 await h.submit(run.run,[h.proposal]);const service=createRequestService(h.kit);const before=(await service.all(run.run)).find(row=>row.declaration)!;const bytes=JSON.stringify((await h.kit.store.get(before.record))!.body);
 await h.submit(run.run,[{...h.proposal,new:'另一个判据'}]);const after=(await service.all(run.run)).filter(row=>row.declaration);assert.equal(after.length,2);
 const old=after.find(row=>row.record===before.record)!;assert.ok(old.answered_by);assert.equal(JSON.stringify((await h.kit.store.get(before.record))!.body),bytes);
 const event=await h.kit.store.find<any>({kind:'action',key:'runs.request.answer',value:old.record,limit:1,newestFirst:true});assert.equal(event.items[0].body.detail.criterion_answer.message,'由后一份提交的同名声明取代');
 const notices=(await h.service.getRun(h.alice,run.run))!.run.criterion_changes!;assert.equal(notices.length,2);assert.equal(notices.find(notice=>notice.request==='rec:'+old.record)!.superseded_by,'rec:'+old.answered_by);
});
test('legacy runs without a submission deadline reject declarations but do not invent a request deadline',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());const run=await h.start();const source=await runById(h.kit.store,run.run);assert.ok(source);
 const {submission_due,...record}=source.body;const id=newId('run');await putRun(h.kit.store,{...record,run:id},source.created_at);
 const answer=await h.submit(id,[h.proposal]);assert.equal(answer.acceptance,'not_accepted');assert.ok(answer.errors.some(row=>row.path==='/criterion_changes'&&row.message.includes('期限')));assert.equal((await createRequestService(h.kit).all(id)).filter(row=>row.declaration).length,0);
});
test('the request next action can be executed when criterion and grounds cite source fragments',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());const {installReview}=await import('./testing/criterion-review.ts');await installReview(h);const run=await h.start();const proposal={...h.proposal,criterion:h.expected+'/text@1/l/1',grounds:[{reference:h.expected+'/text@1/l/2',quote:'第二依据'}]};assert.equal((await h.submit(run.run,[proposal])).acceptance,'accepted');
 const request=(await createRequestService(h.kit).all(run.run)).find(row=>row.declaration)!;const action=JSON.parse(request.next_action.slice(request.next_action.indexOf('{'),request.next_action.lastIndexOf('}')+1));const started=await h.service.startRun(h.admin,action,h.call());assert.equal(started.call_result,'ok',JSON.stringify(started));assert.deepEqual(action.inputs.evidence,[{reference:h.expected}]);assert.equal(started.run!.items[0].fields.criterion,proposal.criterion);
});
