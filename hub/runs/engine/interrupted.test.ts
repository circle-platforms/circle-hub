import {createTestParserRegistry} from '../../testing/parsers.ts';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip, type Harness } from './testing/harness.ts';
import { openRetryHarness as openHarness } from './testing/retry-harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { actionsOf, putRun, putAction, submissionsOf } from './store.ts';
let pg:TemporaryPostgres;let h:Harness;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();if(!skip)h=await openHarness(pg);});
after(async()=>{await h?.close();await pg?.stop();});
test('an internal failure leaves an interrupted action and startup maintenance revalidates the original session', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call('initial'))).run!;
  const body={run:run.run,model:'synthetic',items:run.items.map(i=>({item:i.id,handling:'handled',slots:{findings:[]}})),cross_item:[{nature:'judgment',statement:'合成等级',grounds:[],code:'draft_level',rank:'P4'}]};
  const original=h.workflows.byDigest.bind(h.workflows);
  h.workflows.byDigest=async()=>{throw new Error('synthetic internal interruption detail');};
  let response;
  try{response=await h.service.submitResult(h.alice,body,h.call('judge-observed'));}finally{h.workflows.byDigest=original;}
  assert.equal(response.acceptance,'not_accepted');
  assert.ok(response.errors.some(e=>e.code==='check_error'&&e.fix?.includes('自动重验')));
  assert.ok(!JSON.stringify(response).includes('synthetic internal interruption detail'));
  const detail=(await h.service.getRun(h.alice,run.run))!;
  assert.equal(detail.submissions[0].acceptance,null);
  assert.equal(detail.submissions[0].errors[0].message,'未校验（中断）');
  await h.kit.authorizations.share(h.admin,run.run,[h.bob.id]);
  const shared=(await h.service.getRun(h.bob,run.run))!;
  assert.equal(shared.submissions[0].acceptance,null);
  assert.ok(shared.submissions[0].errors.length>0);
  for(const error of shared.submissions[0].errors)assert.deepEqual(Object.keys(error).sort(),['code','message']);
  assert.ok(!JSON.stringify(shared.submissions[0]).includes('synthetic internal interruption detail'));
  assert.ok(!JSON.stringify(shared.submissions[0].errors).includes('自动重验'),'the runner-only repair hint is not a shared diagnostic');
  await h.kit.authorizations.unshare(h.admin,run.run,h.bob.id);
  let reservedBeforeWork=false;
  h.workflows.byDigest=async digest=>{reservedBeforeWork ||= (await actionsOf(h.kit.store,run.run)).some(action=>typeof action.body.detail.recovery_submission==='string');return original(digest);};
  try{await h.service.maintain();}finally{h.workflows.byDigest=original;}
  assert.equal(reservedBeforeWork,true,'automatic work must see its durable reservation already committed');
  assert.equal((await h.service.getRun(h.alice,run.run))!.latest?.result.acceptance,'accepted');
  const actions=await actionsOf(h.kit.store,run.run);
  assert.ok(actions.some(a=>a.body.detail.hub_error===true&&a.body.acceptance===null));
  assert.ok(actions.some(a=>a.body.acceptance==='accepted'&&a.body.detail.session==='judge-observed'));
});

test('startup recovery recomputes a fact-only run left without its production result', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const first=(await h.service.startRun(h.alice,{pack:'toy-locate',inputs:{map:{reference:map}}},h.call())).run!;
  const original=(await h.service.getRun(h.alice,first.run))!.run;
  const orphan={...structuredClone(original),run:'run_00000000000000000000000044'};
  await putRun(h.kit.store,orphan,orphan.started_at);
  assert.equal((await h.service.getRun(h.alice,orphan.run))!.latest,null);
  await h.service.maintain();
  const recovered=(await h.service.getRun(h.alice,orphan.run))!;
  assert.equal(recovered.production?.result.acceptance,'accepted');
  assert.equal(recovered.latest?.record,recovered.production?.record);
});

test('durable recovery reservations survive service restarts and stop a repeatedly killed validation', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const build=(await h.knowledge.builds('meadow'))[0];
  const started=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:build.line,build:build.name,inputs:{map:{reference:map}}},h.call('synthetic-restart'));assert.ok(started.run,JSON.stringify(started.errors));
  const run=started.run;
  const body={run:run.run,model:'synthetic',items:run.items.map(i=>({item:i.id,handling:'handled',slots:{findings:[]}}))};
  const original=h.workflows.byDigest.bind(h.workflows);
  h.workflows.byDigest=async()=>{throw new Error('synthetic pre-validation interruption');};
  try{await h.service.submitResult(h.alice,body,h.call('synthetic-restart'));}finally{h.workflows.byDigest=original;}
  const submission=(await submissionsOf(h.kit.store,run.run))[0];assert.ok(submission);
  // Each record is what is committed immediately before work; no completion exists, as after SIGKILL/OOM.
  for(let attempt=1;attempt<=3;attempt++)await putAction(h.kit.store,{action:'validate',run:run.run,inputs:['rec:'+submission.digest],startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),acceptance:null,result:'unknown',codes:[],detail:{recovery_submission:submission.digest,retry_attempt:attempt,result:null}});
  const frozen=(await h.service.getRun(h.alice,run.run))!.run;
  const {createRunsService}=await import('./service.ts');
  for(let restart=0;restart<2;restart++){
    const service=createRunsService({parsers:createTestParserRegistry(),records:h.kit,workflows:h.workflows,knowledge:h.knowledge,packs:h.packs,external:h.external,now:()=>new Date(frozen.started_at)});
    await service.maintain();
  }
  const actions=await actionsOf(h.kit.store,run.run);
  assert.equal(actions.filter(action=>action.body.detail.recovery_submission===submission.digest).length,3);
  assert.equal(actions.filter(action=>action.body.detail.submission&&action.body.detail.result).length,0,'no fourth evaluation after a restart');
  const requests=await h.service.listRequests!(h.admin,run.run);
  assert.ok(JSON.stringify(requests).includes('自动恢复至多三次'),JSON.stringify(requests));
});

test('fact production also stops after three durable reservations without completion', {skip},async()=>{
 const map=await h.upload(h.alice,toyMap(standardDocument()));
 const first=(await h.service.startRun(h.alice,{pack:'toy-locate',inputs:{map:{reference:map}}},h.call())).run!;
 const original=(await h.service.getRun(h.alice,first.run))!.run;
 const orphan={...structuredClone(original),run:'run_00000000000000000000000046'};
 const stored=await putRun(h.kit.store,orphan,orphan.started_at);
 for(let attempt=1;attempt<=3;attempt++)await putAction(h.kit.store,{action:'validate',run:orphan.run,inputs:['rec:'+stored.digest],startedAt:orphan.started_at,endedAt:orphan.started_at,acceptance:null,result:'unknown',codes:[],detail:{production_recovery_started:stored.digest,retry_attempt:attempt,result:null}});
 await h.service.maintain();await h.service.maintain();
 assert.equal((await h.service.getRun(h.alice,orphan.run))!.latest,null);
 assert.equal((await actionsOf(h.kit.store,orphan.run)).filter(action=>action.body.detail.production_recovery_started===stored.digest).length,3);
 assert.ok(JSON.stringify(await h.service.listRequests!(h.admin,orphan.run)).includes('三次有限重验'));
});
