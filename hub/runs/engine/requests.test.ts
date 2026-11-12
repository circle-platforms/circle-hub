import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { sandboxSkip, type Harness } from './testing/harness.ts';
import { openRetryHarness as openHarness } from './testing/retry-harness.ts';
import { standardDocument, toyMap } from './testing/mindmap.ts';
import { createEngineContext } from './deps.ts';
import { putSubmission } from './store.ts';
import { putRequest, requestsOf, answerRequest, answerSuccessorRequests, supersedeEarlierRequests } from './requests.ts';
let pg:TemporaryPostgres;let h:Harness;
const skip=await sandboxSkip();
before(async()=>{pg=await startPostgres();if(!skip)h=await openHarness(pg);});
after(async()=>{await h?.close();await pg?.stop();});
test('requests are append-only, idempotent, explicitly answered and gated by run visibility', {skip}, async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call())).run!;
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
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call())).run!;
  let last;
  for(let n=0;n<3;n++)last=await h.service.submitResult(h.alice,{run:run.run,model:`synthetic-${n}`,items:[],cross_item:[{nature:'judgment',statement:'合成等级',grounds:[],code:'draft_level',rank:'P4'}]},h.call());
  assert.ok(last!.result!.partitions.incomplete.every(i=>i.requirements.find(r=>r.requirement==='findings')?.layers[0].reason==='repair_exhausted'));
  assert.ok(last!.errors.some(e=>e.fix?.includes('请求 rec:')&&e.fix.includes('完整的新提交')));
  const view=(await h.service.getRun(h.alice,run.run))!;
  assert.ok(view.requests!.some(r=>r.kind==='repair'&&r.audience===h.alice.id&&r.code==='repair_exhausted'&&r.answered_by===null));
});

test('successor answers only explicit continuation requests and exactly the requested repaired version', {skip},async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call())).run!;
  const {runById}=await import('./store.ts');const before=(await runById(h.kit.store,run.run))!;
  const ctx=createEngineContext({records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external});
  const fixed='f'.repeat(64),other='e'.repeat(64);
  const version=await h.kit.store.put({kind:'pack_version',schema:'synthetic-version@1',provenance:'observed',body:{pack:'toy-review',digest:fixed}});
  const base={run:run.run,kind:'disposition' as const,audience:h.alice.id,due:'2026-10-25T00:00:00.000Z',next_action:'以原运行为 predecessor 开新修订',code:'awaiting_step'};
  const rerun=await putRequest(ctx,{...base,answer_action:'rerun',source:before.digest,missing:'根已变化，需要新修订'});
  const repair=await putRequest(ctx,{...base,answer_action:'rerun',source:version.digest,missing:'指定修复版本需要重跑'});
  const unrelated=await putRequest(ctx,{...base,source:before.digest,missing:'另一项管理选择，不能把续跑当回答'});
  const wrong=await h.kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body:{...before.body,pack_digest:other}});
  await answerSuccessorRequests(ctx,before.body,wrong);
  assert.ok((await requestsOf(ctx,h.alice,run.run)).find(q=>q.record===rerun.digest)!.answered_by);
  assert.equal((await requestsOf(ctx,h.alice,run.run)).find(q=>q.record===repair.digest)!.answered_by,null);
  const right=await h.kit.store.put({kind:'run',schema:'run@1',provenance:'observed',body:{...before.body,pack_digest:fixed}});
  await answerSuccessorRequests(ctx,before.body,right);
  const rows=await requestsOf(ctx,h.alice,run.run);
  assert.equal(rows.find(q=>q.record===repair.digest)!.answered_by,right.digest);
  assert.equal(rows.find(q=>q.record===unrelated.digest)!.answered_by,null);
});
test('an accepted result voids the earlier submissions\' waiting requests and their escalations, and nothing another step closes', {skip}, async()=>{
  const map=await h.upload(h.alice,toyMap(standardDocument()));
  const run=(await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'10.6.1',build:'Rel_MEADOW_10_6_1_7',inputs:{map:{reference:map}}},h.call())).run!;
  const ctx=createEngineContext({records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external});
  const record=async(label:string)=>(await h.kit.store.put({kind:'claim',schema:'synthetic-claim@1',provenance:'declared',body:{label}})).digest;
  // A request of a submission carries the digest of what was submitted, which the submission record is indexed under.
  const submitted=async(digest:string)=>{await putSubmission(h.kit.store,{run:run.run,digest,body:{label:digest.slice(0,4)},parses:false,createdAt:'2026-10-24T00:00:00.000Z'});return digest;};
  const earlier=await submitted('e'.repeat(64)),current=await submitted('c'.repeat(64)),other=await record('not a submission'),result=await record('later result');
  const base={run:run.run,kind:'clarification' as const,audience:h.alice.id,due:'2026-10-25T00:00:00.000Z',next_action:'合成的下一步',code:'missing_input',item:run.items[0].id,requirement:'findings'};
  const put=async(missing:string,extra:Record<string,unknown>={})=>(await putRequest(ctx,{...base,source:earlier,missing,...extra} as Parameters<typeof putRequest>[1])).digest;
  const plain=await put('合成缺口：等待作废');
  const escalation=await put('合成缺口：逾期升级',{source:plain});
  const answered=await put('合成缺口：已回答');await answerRequest(ctx,answered,other);
  const kept={
    declaration:await put('合成缺口：判据变更声明',{kind:'judgment',declaration:'/criterion_changes/0'}),
    job:await put('合成缺口：派发作业处置',{kind:'disposition',job:'b'.repeat(64)}),
    rerun:await put('合成缺口：要求重跑',{kind:'disposition',answer_action:'rerun'}),
    pack:await put('合成缺口：包作者修复',{kind:'repair',pack_digest:run.pack_digest}),
    notSubmission:await put('合成缺口：来源不是提交',{source:other}),
    current:await put('合成缺口：本次提交下发',{source:current}),
  };
  const closed=async()=>new Map((await requestsOf(ctx,h.alice,run.run)).map(view=>[view.record,view]));
  await supersedeEarlierRequests(ctx,run,{acceptance:'not_accepted',submission:current},result);
  assert.equal((await closed()).get(plain)!.answered_by,null,'a submission that was not accepted voids nothing');
  await supersedeEarlierRequests(ctx,run,{acceptance:'accepted',submission:current},result);
  const after=await closed();
  for(const id of [plain,escalation]){assert.equal(after.get(id)!.answered_by,result);assert.equal(after.get(id)!.superseded,true);}
  assert.equal(after.get(answered)!.answered_by,other);assert.equal(after.get(answered)!.superseded,undefined);
  for(const [name,id] of Object.entries(kept))assert.equal(after.get(id)!.answered_by,null,name+' stays waiting');
  // The earlier content is submitted again and accepted: its requests wait again and the other submission's are void.
  const again=await record('result of the earlier content again');
  await supersedeEarlierRequests(ctx,run,{acceptance:'accepted',submission:earlier},again);
  const back=await closed();
  for(const id of [plain,escalation]){assert.equal(back.get(id)!.answered_by,null);assert.equal(back.get(id)!.superseded,undefined);}
  assert.equal(back.get(answered)!.answered_by,other,'an answered request is not reopened');
  assert.equal(back.get(kept.current)!.answered_by,again);assert.equal(back.get(kept.current)!.superseded,true);
  for(const name of ['declaration','job','rerun','pack','notSubmission'] as const)assert.equal(back.get(kept[name])!.answered_by,null,name+' still waits');
});
