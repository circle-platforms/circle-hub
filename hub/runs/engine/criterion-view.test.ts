import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startPostgres} from '../../testing/postgres.ts';
import {criterionHarness} from './testing/criterion.ts';
import {writePack} from './testing/packs.ts';
import {createRequestService} from '../../requests/api.ts';
import {runById} from './store.ts';
async function copy(t:any,id:string,alter:(workflow:any,files:Record<string,string|{json:any}>)=>void){
 const root=fileURLToPath(new URL('../../../packs/workflow/criterion-review/',import.meta.url)),manifest=JSON.parse(await readFile(join(root,'pack.json'),'utf8')),files:Record<string,string|{json:any}>={};
 for(const file of manifest.files){const bytes=await readFile(join(root,file.path),'utf8');files[file.path]=file.path.endsWith('.json')?{json:JSON.parse(bytes)}:bytes;}
 alter((files['workflow.json'] as {json:any}).json,files);const temp=await mkdtemp(join(tmpdir(),'criterion-copy-'));t.after(()=>rm(temp,{recursive:true,force:true}));return writePack(temp,{...manifest,id,files});
}
test('a view predecessor cannot lend a held lease even to its own author reviewing from a new run',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg,{leases:true});t.after(()=>h.close());const draft=await h.start();await h.submit(draft.run,[h.proposal]);const request=(await createRequestService(h.kit).all(draft.run)).find(row=>row.declaration)!;
 assert.ok((await h.leases!.register({prefix:'criterion/bed/',declaredPrefix:'criterion/',owner:h.alice.id,by:h.alice.id,reason:'合成登记'})).ok);
 assert.ok((await h.leases!.acquire({keys:['criterion/bed/dut'],prefix:'criterion/',holder:{user:h.alice.id,run:draft.run}})).ok);
 const dir=await copy(t,'criterion-lease-view',workflow=>{workflow.context=['leases'];workflow.leases={prefix:'criterion/'};});const flow=await h.workflows.add(dir);h.workflows.assign(h.alice.id,flow.pack.id);
 const answer=await h.service.startRun(h.alice,{pack:flow.pack.id,predecessor:draft.run,inputs:{declaration:{reference:'rec:'+request.source},evidence:[{reference:h.expected}]}},h.call());assert.equal(answer.call_result,'ok',JSON.stringify(answer));
 const record=await runById(h.kit.store,answer.run!.run);assert.ok(record);assert.equal(record.body.lease_context?.find(row=>row.key==='criterion/bed/dut')?.mine,false);assert.equal(record.body.leases,undefined);assert.equal(record.body.client_key,undefined);assert.equal((await h.leases!.holders(['criterion/bed/dut']))[0].run,draft.run);
});
test('sharing never opens an ordinary predecessor start gate and a result cannot replace the declaration submission',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());const draft=await h.start();await h.submit(draft.run,[h.proposal]);await h.kit.authorizations.share(h.admin,draft.run,[h.bob.id]);
 const request=(await createRequestService(h.kit).all(draft.run)).find(row=>row.declaration)!;
 const dir=await copy(t,'criterion-owner-only',workflow=>{delete workflow.predecessor_access;delete workflow.criterion_review;});const flow=await h.workflows.add(dir);h.workflows.assign(h.bob.id,flow.pack.id);
 const denied=await h.service.startRun(h.bob,{pack:flow.pack.id,predecessor:draft.run,inputs:{declaration:{reference:'rec:'+request.source}}},h.call());assert.equal(denied.call_result,'error');assert.ok(denied.errors.some(error=>error.code==='SOURCE_UNAVAILABLE'));
 const source=fileURLToPath(new URL('../../../packs/workflow/criterion-review/',import.meta.url));const actual=await h.workflows.add(source);h.workflows.assign(h.admin.id,actual.pack.id);const result=await h.service.getResult(h.alice,draft.run);
 const wrong=await h.service.startRun(h.admin,{pack:actual.pack.id,predecessor:draft.run,inputs:{declaration:{reference:'rec:'+result!.record}}},h.call());assert.equal(wrong.call_result,'error');assert.ok(wrong.errors.some(error=>error.message.includes('提交记录')));
});
test('read-only review starts a fresh repair budget and never copies the predecessor client key',async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await criterionHarness(pg);t.after(()=>h.close());const answer=await h.service.startRun(h.alice,{pack:'criterion-draft',client_key:'synthetic-original-key',inputs:{subject:{reference:h.subject},expected:{reference:h.expected}}},h.call());assert.equal(answer.call_result,'ok');const draft=answer.run!;await h.submit(draft.run,[h.proposal]);const request=(await createRequestService(h.kit).all(draft.run)).find(row=>row.declaration)!;
 const {putAction}=await import('./store.ts');await putAction(h.kit.store,{action:'validate',run:draft.run,inputs:[],startedAt:draft.started_at,endedAt:draft.started_at,acceptance:'accepted',codes:[],detail:{submission:'synthetic-earlier-submission',repair:['review'],session:'synthetic-session',model:'Scripted',result:null}});
 const dir=await copy(t,'criterion-fresh-budget',(workflow,files)=>{const requirements=(files['requirements.json'] as {json:any}).json;requirements.requirements[0].error_handling=[{code:'criterion-review.form',action:'repair',max_rounds:2}];});const flow=await h.workflows.add(dir);h.workflows.assign(h.admin.id,flow.pack.id);
 const start=await h.service.startRun(h.admin,{pack:flow.pack.id,predecessor:draft.run,inputs:{declaration:{reference:'rec:'+request.source},evidence:[{reference:h.expected}]}},h.call());assert.equal(start.call_result,'ok',JSON.stringify(start));const run=start.run!;assert.equal((await runById(h.kit.store,run.run))!.body.client_key,undefined);
 const submitted=await h.service.submitResult(h.admin,{run:run.run,model:'Scripted',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{review:[{code:'accept',text:'确认',location:item.location,data:{reason:'合成确认'},quotes:[{reference:h.expected,text:'依据'}]}]}}))},h.call());assert.equal(submitted.acceptance,'accepted');assert.deepEqual((await h.service.getResult(h.admin,run.run))!.result.rounds,{used:0,max:2});
});
