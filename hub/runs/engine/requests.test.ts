import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { createEngineContext } from './deps.ts';
import { putRequest, requestsOf, answerRequest } from './requests.ts';
let pg:TemporaryPostgres;let h:Harness;
const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();if(!skip)h=await openHarness(pg);});
after(async()=>{await h?.close();await pg?.stop();});
test('requests are append-only, idempotent, explicitly answered and gated by run visibility', {skip}, async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call())).run!;
  const ctx=createEngineContext({records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external});
  const input={run:run.run,kind:'repair' as const,audience:h.alice.id,due:'2026-10-25T00:00:00.000Z',missing:'条目 A 的完整提交',next_action:'用 submit_result 对同一运行重交完整提交',source:'a'.repeat(64),code:'not_covered',item:run.items[0].id,requirement:'findings'};
  const first=await putRequest(ctx,input);
  assert.equal((await putRequest(ctx,input)).digest,first.digest);
  assert.equal((await requestsOf(ctx,h.alice,run.run)).length,1);
  assert.deepEqual(await requestsOf(ctx,h.bob,run.run),[]);
  const response=await h.kit.store.put({kind:'claim',schema:'synthetic-answer@1',provenance:'declared',body:{statement:'合成修复已重交'}});
  await answerRequest(ctx,first.digest,response.digest);
  const records=await requestsOf(ctx,h.alice,run.run);
  assert.equal(records[0].answered_by,response.digest);
  assert.equal(records[0].record,first.digest);
});

test('exhausted missing submissions persist named requests and keep full replacement available', {skip}, async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',inputs:{map:{reference:map}}},h.call())).run!;
  let last;
  for(let n=0;n<3;n++)last=await h.service.submitResult(h.alice,{run:run.run,model:`synthetic-${n}`,items:[],cross_item:[{nature:'judgment',statement:'合成等级',grounds:[],code:'draft_level',rank:'P4'}]},h.call());
  assert.ok(last!.result!.partitions.incomplete.every(i=>i.requirements.find(r=>r.requirement==='findings')?.layers[0].reason==='repair_exhausted'));
  assert.ok(last!.errors.some(e=>e.fix?.includes('请求 rec:')&&e.fix.includes('完整的新提交')));
  const view=(await h.service.getRun(h.alice,run.run))!;
  assert.ok(view.requests!.some(r=>r.kind==='repair'&&r.audience===h.alice.id&&r.code==='repair_exhausted'&&r.answered_by===null));
});
