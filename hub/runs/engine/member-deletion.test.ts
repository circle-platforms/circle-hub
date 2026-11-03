// An active runner keeps the exact already-frozen private workflow while its deleted owner has no new eligibility.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {startPostgres} from '../../testing/postgres.ts';
import {openHarness,sandboxSkip} from './testing/harness.ts';
import {toyMap,standardDocument} from './testing/mindmap.ts';
const skip=await sandboxSkip();
test('deleting a private workflow owner preserves frozen evaluation but refuses every new run',{skip},async t=>{
 const pg=await startPostgres();t.after(()=>pg.stop());const h=await openHarness(pg);t.after(()=>h.close());h.review.pack.space=h.bob.id;for(const slot of h.review.workflow.inputs)slot.accepts=['application/json'];delete h.review.workflow.expected_sources;
 const map=await h.upload(h.alice,toyMap(standardDocument())),input={pack:'toy-review',pack_space:h.bob.id,product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},answer=await h.service.startRun(h.alice,input,h.call());assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));const run=answer.run!,stored=(await h.kit.store.find({kind:'run',key:'runs.id',value:run.run,limit:1})).items[0];
 const preview=await h.kit.memberDeletions!.preview(h.admin,h.bob.id),intent=await h.kit.memberDeletions!.prepare(h.admin,{...preview,operation_id:randomUUID()});await h.kit.memberDeletions!.finish(h.admin,h.bob.id,intent.operation_id);
 const result=await h.service.submitResult(h.alice,{run:run.run,model:'Scripted',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[]}})),cross_item:[{nature:'judgment',statement:'合成成员删除后冻结评估',grounds:[],code:'draft_level',rank:'P4'}]},h.call());assert.equal(result.call_result,'ok',JSON.stringify(result.errors));assert.equal(result.acceptance,'accepted');assert.deepEqual(await h.kit.store.get(stored.digest),stored);
 const next=await h.service.startRun(h.alice,input,h.call());assert.equal(next.call_result,'error');assert.equal(next.errors[0]?.code,'SOURCE_UNAVAILABLE');assert.equal((await h.kit.store.list({kind:'run'})).items.length,1);
});
