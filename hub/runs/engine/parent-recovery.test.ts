// Parent observations, never pack-authored data, drive bounded accepted-result recovery.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {after,before,test} from 'node:test';
import {startPostgres,type TemporaryPostgres} from '../../testing/postgres.ts';
import {createEngineContext} from './deps.ts';
import {roundsUsedOf} from './submit.ts';
import {actionsOf} from './store.ts';
import {openRetryHarness} from './testing/retry-harness.ts';
import {sandboxSkip} from './testing/harness.ts';
import {standardDocument,toyMap} from './testing/mindmap.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewPack,writePack} from './testing/packs.ts';
import {digestOf} from '../../records/api.ts';
let pg:TemporaryPostgres;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();});after(async()=>{await pg?.stop();});
async function setup(){
  const h=await openRetryHarness(pg),map=await h.upload(h.alice,toyMap(standardDocument()));
  const started=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call('observed-start'));
  assert.equal(started.call_result,'ok',JSON.stringify(started.errors));const run=started.run!;
  const args={run:run.run,model:'synthetic',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[]}})),cross_item:[{nature:'judgment',statement:'合成等级',grounds:[],code:'draft_level',rank:'P4'}]};
  return{h,run,args,map};
}
function unavailable(){
  const original=childProcess.spawn;let launches=0;
  childProcess.spawn=((...args:Parameters<typeof original>)=>{if(args[1]?.some(value=>String(value).endsWith('/bootstrap.ts'))){launches++;throw Object.assign(new Error('SyntheticParentUnavailable'),{code:'EAGAIN'});}return original(...args);}) as typeof original;
  syncBuiltinESMExports();return{restore(){childProcess.spawn=original;syncBuiltinESMExports();},count:()=>launches};
}
test('maintenance rechecks accepted transient parent failures using the originally observed session',{skip},async()=>{
  const {h,run,args}=await setup(),failure=unavailable();
  try{
    const first=await h.service.submitResult(h.alice,args,h.call('observed-submit'));assert.equal(first.acceptance,'accepted');assert.ok(first.counts!.unknown>0);
    const original=(await h.service.getRun(h.alice,run.run))!.latest!;failure.restore();
    await h.service.maintain();const recovered=(await h.service.getRun(h.alice,run.run))!.latest!;
    assert.notEqual(recovered.record,original.record);assert.equal(recovered.result.submission,first.result!.submission);
    assert.equal(Object.values(recovered.result.partitions).flat().flatMap(item=>item.requirements).flatMap(r=>r.layers).filter(layer=>layer.reason==='check_error').length,0);
    const action=(await actionsOf(h.kit.store,run.run)).find(a=>a.body.detail.result===recovered.record&&a.body.detail.session==='observed-submit');assert.ok(action);
    assert.deepEqual((await h.kit.store.get(original.record))!.body,original.result);
  }finally{failure.restore();await h.close();}
});
test('three failed automatic rounds escalate to a real administrator request and never add a model repair round',{skip},async()=>{
  const {h,run,args}=await setup(),failure=unavailable();
  try{
    await h.service.submitResult(h.alice,args,h.call('observed-submit'));
    const ctx=createEngineContext({records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external});
    const before=await roundsUsedOf(ctx,run.run);
    for(let n=0;n<3;n++)await h.service.maintain();const launches=failure.count();await h.service.maintain();assert.equal(failure.count(),launches);
    const detail=(await h.service.getRun(h.alice,run.run))!,question=detail.requests!.find(q=>q.kind==='repair'&&q.audience===h.admin.id&&q.missing.includes('三次自动重评'));
    assert.ok(question);assert.ok(detail.latest!.result.system_input);
    const source=await h.kit.store.get<{detail:{input:unknown}}>(detail.latest!.result.system_input!.slice(4));assert.ok(source);
    assert.equal(detail.latest!.result.submission,digestOf(source.body.detail.input));assert.deepEqual(await roundsUsedOf(ctx,run.run),before);
    failure.restore();await h.service.submitResult(h.alice,args,h.call('observed-submit'));await h.service.maintain();
    assert.ok((await h.service.listRequests!(h.alice,run.run)).find(q=>q.record===question.record)!.answered_by,'actual parent success answers host repair');
  }finally{failure.restore();await h.close();}
});

test('pack-authored sandbox data cannot schedule a parent recovery round',{skip},async()=>{
  const h=await openRetryHarness(pg),directory=await mkdtemp(join(tmpdir(),'hub-parent-forgery-'));
  try{
    const spec=reviewPack();spec.version='1.0.1';
    spec.files['requirements.json']={json:{schema:'requirements@1',requirements:[{...h.review.requirements[0],checks:['probe']},h.review.requirements[3]]}};
    spec.files['checks.json']={json:{schema:'checks@1',checks:[{id:'probe',applies:'item',judges:'subject',tier:'advisory',function:{module:'functions/probe.ts'}}]}};
    spec.files['functions/probe.ts']="export default () => [{verdict:'unknown',reason:'check_error',missing:'合成包未给出结论',statement:'缺结论',grounds:[],tier:'advisory',data:{sandbox:'SANDBOX_UNAVAILABLE',retry_attempts:[{parent_unavailable:true}]}}];";
    await h.workflows.add(await writePack(directory,spec));
    const map=await h.upload(h.alice,toyMap(standardDocument()));
    const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call('forged-start'))).run!;
    const args={run:run.run,model:'synthetic',items:run.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[]}})),cross_item:[{nature:'judgment',statement:'合成等级',grounds:[],code:'draft_level',rank:'P4'}]};
    assert.equal((await h.service.submitResult(h.alice,args,h.call('forged-submit'))).acceptance,'accepted');
    const original=(await h.service.getRun(h.alice,run.run))!.latest!.record;await h.service.maintain();
    assert.equal((await h.service.getRun(h.alice,run.run))!.latest!.record,original);
    assert.ok(!(await actionsOf(h.kit.store,run.run)).some(action=>typeof action.body.detail.parent_recheck==='string'));
  }finally{await h.close();await rm(directory,{recursive:true,force:true});}
});

test('a same-pack successor hands trusted parent failure to an administrator without replaying the old run',{skip},async()=>{
  const {h,run,args,map}=await setup();let failure=unavailable();
  try{
    await h.service.submitResult(h.alice,args,h.call('observed-submit'));
    const original=(await h.service.getRun(h.alice,run.run))!.latest!;
    failure.restore();
    const next=await h.service.startRun(h.alice,{pack:'toy-review',predecessor:run.run,product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call('successor'));
    assert.equal(next.call_result,'ok',JSON.stringify(next.errors));
    failure=unavailable();await h.service.maintain();assert.equal(failure.count(),0,'old superseded work must not be replayed');
    const detail=(await h.service.getRun(h.alice,run.run))!;
    const question=detail.requests!.find(q=>q.kind==='repair'&&q.audience===h.admin.id&&q.missing.includes('后继'));
    assert.ok(question);assert.equal(question.answered_by,null);
    assert.ok(detail.latest!.result.system_input);
    for(const layer of Object.values(detail.latest!.result.partitions).flat().flatMap(i=>i.requirements).flatMap(r=>r.layers)){
      if(layer.reason==='check_error'){assert.deepEqual(layer.exit!.audience,{user:h.admin.id});assert.equal(layer.exit!.due,question.due);}
    }
    assert.deepEqual((await h.kit.store.get(original.record))!.body,original.result);
    await h.service.maintain();assert.equal((await h.service.getRun(h.alice,run.run))!.latest!.record,detail.latest!.record);
    assert.ok((await h.service.listRuns(h.admin)).open_runs?.includes(run.run),'an unanswered host repair stays open despite a successor');
    failure.restore();h.advance(1000);
    await h.service.submitResult(h.alice,{...args,run:next.run!.run},h.call('successor-submit'));
    await h.service.maintain();
    assert.ok((await h.service.listRequests!(h.admin,run.run)).find(q=>q.record===question.record)!.answered_by,'a later trusted parent success closes the host repair, without rewriting the old terminal');
  }finally{failure.restore();await h.close();}
});
