import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {fileURLToPath} from 'node:url';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
import {createRequestService} from '../../requests/api.ts';
import {artifactShareKey} from '../../records/api.ts';
import {runById} from './store.ts';

let pg:Awaited<ReturnType<typeof startPostgres>>;
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
async function setup(t:any){const h=await criterionHarness(pg);t.after(()=>h.close());const loaded=await h.workflows.add(fileURLToPath(new URL('../../../packs/workflow/criterion-review/',import.meta.url)));for(const user of [h.admin,h.alice,h.bob])h.workflows.assign(user.id,loaded.pack.id);const draft=await h.start();await h.submit(draft.run,[h.proposal]);const request=(await createRequestService(h.kit).all(draft.run)).find(row=>row.declaration)!;return{h,draft,request};}
async function review(f:Awaited<ReturnType<typeof setup>>,by:any=f.h.admin){const answer=await f.h.service.startRun(by,{pack:'criterion-review',predecessor:f.draft.run,inputs:{declaration:{reference:'rec:'+f.request.source},evidence:[{reference:f.h.expected}]}},f.h.call('criterion-author'));assert.equal(answer.call_result,'ok',JSON.stringify(answer));return answer.run!;}
async function decision(f:Awaited<ReturnType<typeof setup>>,run:any,by:any,code='accept',quote='依据'){
 return f.h.service.submitResult(by,{run:run.run,model:'Scripted',items:run.items.map((item:any)=>({item:item.id,handling:'handled',slots:{review:[{text:'账号确认',code,location:item.location,data:{reason:'合成复核理由'},quotes:[{reference:f.h.expected,text:quote}]}]}}))},f.h.call('criterion-author'));
}
test('a non-author account using the same session and model accepts or rejects and closes the request',async t=>{
 for(const code of ['accept','reject']){
  const f=await setup(t),r=await review(f),answer=await decision(f,r,f.h.admin,code);assert.equal(answer.acceptance,'accepted',JSON.stringify(answer));
  const stored=await f.h.service.getResult(f.h.admin,r.run);assert.ok(stored);assert.ok(Object.values(stored.result.partitions).flat().every(row=>row.requirements.every(requirement=>requirement.status==='satisfied')),JSON.stringify(stored.result));
  assert.ok(JSON.stringify(stored.result).includes('human_non_author'));
  const request=(await createRequestService(f.h.kit).all(f.draft.run)).find(row=>row.record===f.request.record)!;assert.equal(request.answered_by,stored.record);
  const answers=await f.h.kit.store.find<any>({kind:'action',key:'runs.request.answer',value:request.record,limit:1,newestFirst:true});assert.equal(answers.items[0].body.detail.criterion_answer.accepted,code==='accept');
 }
});
test('an author account never closes its own judgment request',async t=>{
 const f=await setup(t),r=await review(f,f.h.alice);const answer=await decision(f,r,f.h.alice);assert.equal(answer.acceptance,'accepted',JSON.stringify(answer));const stored=await f.h.service.getResult(f.h.alice,r.run);assert.ok(JSON.stringify(stored!.result).includes('not_independent'));assert.equal((await createRequestService(f.h.kit).all(f.draft.run)).find(row=>row.record===f.request.record)!.answered_by,null);
});
test('a shared non-author can start read-only review without inheriting mutation rights and loses read admission on unshare',async t=>{
 const f=await setup(t);await f.h.kit.authorizations.share(f.h.admin,f.draft.run,[f.h.bob.id]);
 const sources=await f.h.kit.store.list<any>({kind:'source_artifact',limit:100});const expected=sources.items.find(record=>record.body.sha256===f.h.expected.slice(4))!;assert.ok(expected);await f.h.kit.authorizations.share(f.h.admin,artifactShareKey(expected),[f.h.bob.id]);
 const r=await review(f,f.h.bob),record=await runById(f.h.kit.store,r.run);assert.equal(record!.body.predecessor_access,'view');assert.equal(record!.body.client_key,undefined);assert.equal(record!.body.leases,undefined);assert.ok(r.items.every(item=>item.reuse===undefined));
 const forbidden=await f.h.submit(f.draft.run,[],f.h.bob);assert.notEqual(forbidden.acceptance,'accepted');
 const answer=await decision(f,r,f.h.bob);assert.equal(answer.acceptance,'accepted',JSON.stringify(answer));const before=await f.h.service.getResult(f.h.bob,r.run);assert.ok(before);assert.equal((await createRequestService(f.h.kit).all(f.draft.run)).find(row=>row.record===f.request.record)!.answered_by,before.record);const bytes=JSON.stringify(before.result);
 await f.h.kit.authorizations.unshare(f.h.admin,f.draft.run,f.h.bob.id);
 const after=await decision(f,r,f.h.bob,'reject');assert.notEqual(after.acceptance,'accepted');assert.equal(JSON.stringify((await f.h.kit.store.get(before.record))!.body),bytes);
});
test('wrong quotations refuse review and cannot answer a pending request',async t=>{
 const f=await setup(t),r=await review(f);const answer=await decision(f,r,f.h.admin,'accept','伪造引文');assert.equal(answer.acceptance,'not_accepted');assert.ok(answer.errors.some(error=>error.code==='QUOTE_MISMATCH'));assert.equal((await createRequestService(f.h.kit).all(f.draft.run)).find(row=>row.record===f.request.record)!.answered_by,null);
});
test('an accepted review submission whose requirement is unsatisfied leaves the request unanswered',async t=>{
 const f=await setup(t),unrelated=await f.h.upload(f.h.admin,Buffer.from('无关期望'),'text/plain');
 const started=await f.h.service.startRun(f.h.admin,{pack:'criterion-review',predecessor:f.draft.run,inputs:{declaration:{reference:'rec:'+f.request.source},evidence:[{reference:unrelated}]}},f.h.call());assert.equal(started.call_result,'ok');
 const r=started.run!,answer=await f.h.service.submitResult(f.h.admin,{run:r.run,model:'Scripted',items:r.items.map(item=>({item:item.id,handling:'handled',slots:{review:[{text:'确认',code:'accept',location:item.location,data:{reason:'合成理由'},quotes:[{reference:unrelated,text:'无关期望'}]}]}}))},f.h.call());assert.equal(answer.acceptance,'accepted');
 const stored=await f.h.service.getResult(f.h.admin,r.run);assert.ok(Object.values(stored!.result.partitions).flat().some(row=>row.requirements.some(requirement=>requirement.status==='unsatisfied')));assert.equal((await createRequestService(f.h.kit).all(f.draft.run)).find(row=>row.record===f.request.record)!.answered_by,null);
});
test('incomplete author lineage reports the missing account fact and a named recovery step',async t=>{
 const f=await setup(t);const {putRun,runById}=await import('./store.ts'),{newId}=await import('../../records/api.ts');const original=(await runById(f.h.kit.store,f.draft.run))!;const id=newId('run');await putRun(f.h.kit.store,{...original.body,run:id,predecessor:newId('run')},original.created_at);await f.h.submit(id,[f.h.proposal]);const request=(await createRequestService(f.h.kit).all(id)).find(row=>row.declaration)!;
 const r=await review({...f,draft:{...f.draft,run:id},request}),answer=await decision(f,r,f.h.admin);assert.equal(answer.acceptance,'accepted');const result=(await f.h.service.getResult(f.h.admin,r.run))!.result;
 assert.ok(result.errors.some(error=>error.message.includes('作者账号')&&error.fix?.includes(f.h.admin.id)),JSON.stringify(result.errors));assert.equal((await createRequestService(f.h.kit).all(id)).find(row=>row.record===request.record)!.answered_by,null);
});
