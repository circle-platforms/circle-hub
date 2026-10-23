import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { actionsOf } from './store.ts';
let pg:TemporaryPostgres;let h:Harness;const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();if(!skip)h=await openHarness(pg);});
after(async()=>{await h?.close();await pg?.stop();});
test('an internal failure leaves an interrupted action and startup maintenance revalidates the original session', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call('initial'))).run!;
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
  await h.service.maintain();
  assert.equal((await h.service.getRun(h.alice,run.run))!.latest?.result.acceptance,'accepted');
  const actions=await actionsOf(h.kit.store,run.run);
  assert.ok(actions.some(a=>a.body.detail.hub_error===true&&a.body.acceptance===null));
  assert.ok(actions.some(a=>a.body.acceptance==='accepted'&&a.body.detail.session==='judge-observed'));
});
