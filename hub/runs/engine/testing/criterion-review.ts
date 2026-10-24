import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createRequestService,type RequestView} from '../../../requests/api.ts';
import type {Principal} from '../../../records/api.ts';
import type {criterionHarness} from './criterion.ts';
export async function installReview(h:Awaited<ReturnType<typeof criterionHarness>>){const workflow=await h.workflows.add(fileURLToPath(new URL('../../../../packs/workflow/criterion-review/',import.meta.url)));for(const user of [h.admin,h.alice,h.bob])h.workflows.assign(user.id,workflow.pack.id);}
export async function judgment(h:Awaited<ReturnType<typeof criterionHarness>>,draft:string,request:RequestView,code='accept',by:Principal=h.admin){
 const started=await h.service.startRun(by,{pack:'criterion-review',predecessor:draft,inputs:{declaration:{reference:'rec:'+request.source},evidence:[{reference:h.expected}]}},h.call('criterion-author'));assert.equal(started.call_result,'ok',JSON.stringify(started));const run=started.run!;
 const answer=await h.service.submitResult(by,{run:run.run,model:'Scripted',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{review:[{text:'确认',code,location:item.location,data:{reason:'合成复核理由'},quotes:[{reference:h.expected,text:'依据'}]}]}}))},h.call('criterion-author'));assert.equal(answer.acceptance,'accepted',JSON.stringify(answer));return (await h.service.getResult(by,run.run))!;
}
export async function criterionRequests(h:Awaited<ReturnType<typeof criterionHarness>>,run:string){return (await createRequestService(h.kit).all(run)).filter(row=>row.declaration);}
export async function revision(h:Awaited<ReturnType<typeof criterionHarness>>,run:string){const answer=await h.service.startRun(h.alice,{pack:'criterion-draft',predecessor:run,inputs:{subject:{reference:h.subject},expected:{reference:h.expected}}},h.call('criterion-author'));assert.equal(answer.call_result,'ok',JSON.stringify(answer));return answer.run!;}
