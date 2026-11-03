// New personal runs recheck both the runner and the workflow owner at the run commit boundary.
import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {startPostgres} from '../../testing/postgres.ts';
import {barrier,reaches} from '../../testing/member-freeze.ts';
import {openHarness,sandboxSkip} from './testing/harness.ts';
import {toyMap,standardDocument} from './testing/mindmap.ts';
let pg:Awaited<ReturnType<typeof startPostgres>>;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();});after(()=>pg?.stop());
for(const disabled of ['runner','owner'])test(`a ${disabled} deactivated after projection cannot commit a new personal run`,{skip},async t=>{
 const h=await openHarness(pg);t.after(()=>h.close());h.review.pack.space=h.bob.id;for(const slot of h.review.workflow.inputs)slot.accepts=['application/json'];delete h.review.workflow.expected_sources;
 const map=await h.upload(h.alice,toyMap(standardDocument())),entered=barrier(),release=barrier(),active=h.kit.principals.lockActive.bind(h.kit.principals);let once=false;
 h.kit.principals.lockActive=async(...args)=>{if(args[0].id===h.alice.id&&!once){once=true;assert.ok(args[2]?.includes(h.bob.id));entered.release();await release.promise;}return active(...args);};
 const starting=h.service.startRun(h.alice,{pack:'toy-review',pack_space:h.bob.id,product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call());
 try{await reaches(entered,starting);await h.kit.principals.setDisabled(h.admin,disabled==='owner'?h.bob.id:h.alice.id,true);}finally{release.release();}
 const result=await starting;assert.equal(result.call_result,'error',JSON.stringify(result));assert.equal(result.errors[0]?.code,'SOURCE_UNAVAILABLE');assert.equal((await h.kit.store.list({kind:'run'})).items.length,0);
});
test('disabling a personal workflow owner does not reinterpret an already frozen run evaluation', {skip},async t=>{
 const h=await openHarness(pg);t.after(()=>h.close());h.review.pack.space=h.bob.id;for(const slot of h.review.workflow.inputs)slot.accepts=['application/json'];delete h.review.workflow.expected_sources;
 const map=await h.upload(h.alice,toyMap(standardDocument())),answer=await h.service.startRun(h.alice,{pack:'toy-review',pack_space:h.bob.id,product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call());assert.equal(answer.call_result,'ok',JSON.stringify(answer.errors));
 const run=answer.run!,stored=(await h.kit.store.find({kind:'run',key:'runs.id',value:run.run,limit:1})).items[0];
 await h.kit.principals.setDisabled(h.admin,h.bob.id,true);
 const result=await h.service.submitResult(h.alice,{run:run.run,model:'Scripted',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[]}})),cross_item:[{nature:'judgment',statement:'合成冻结评估声明',grounds:[],code:'draft_level',rank:'P4'}]},h.call());
 assert.equal(result.call_result,'ok',JSON.stringify(result.errors));assert.equal(result.acceptance,'accepted');assert.deepEqual(await h.kit.store.get(stored.digest),stored);
});
