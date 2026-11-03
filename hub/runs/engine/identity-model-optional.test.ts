import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Submission } from '../../../contracts/src/submission.ts';
import { startPostgres } from '../../testing/postgres.ts';
import { effectiveSubmission } from './independence.ts';
import { recheckEffectChecks } from './recheck-effect.ts';
import { actionsOf, submissionsOf } from './store.ts';
import { openHarness, sandboxSkip } from './testing/harness.ts';
import { ITEM, standardDocument, toyMap } from './testing/mindmap.ts';
import { locatePack, writePack } from './testing/packs.ts';
import { sha } from './testing/knowledge.ts';

const identity={model_id:'synthetic-model',model_family_id:'synthetic-family'};
test('only an explicitly declared identity or the same observed session can supply the omitted model', () => {
  const raw=Submission.parse({run:'run_01hzzzzzzzzzzzzzzzzzzzzzza',items:[]});
  const run={session:'start-session',model_identity:identity};
  assert.equal(effectiveSubmission(raw,run,'start-session')?.model,identity.model_id);
  assert.equal(effectiveSubmission(raw,run,'other-session'),null);
  assert.equal(effectiveSubmission(raw,run,null),null);
  assert.equal(effectiveSubmission({...raw,model_identity:{model_id:'synthetic-other',model_family_id:'synthetic-other-family'}},run,'other-session')?.model,'synthetic-other');
  assert.equal(effectiveSubmission({...raw,model:'synthetic-legacy'},run,'other-session')?.model,'synthetic-legacy');
  assert.equal(effectiveSubmission(raw,{},'start-session'),null);
  assert.equal(effectiveSubmission({...raw,model:'synthetic-legacy'},{},null)?.model,'synthetic-legacy');
  assert.equal(raw.model,undefined);
});

test('independent review carries the model family without a repeated model field', async t => {
  const skip=await sandboxSkip();if(skip)return t.skip(skip);
  const pg=await startPostgres();const h=await openHarness(pg);
  try {
    const source=await h.upload(h.alice,toyMap(standardDocument()));
    const draft=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',model_identity:identity,inputs:{map:{reference:source}}},h.call('draft-session'));
    assert.equal(draft.call_result,'ok',JSON.stringify(draft.errors));
    const submitted=await h.service.submitResult(h.alice,{run:draft.run!.run,items:draft.run!.items.map(item=>({item:item.id,handling:'handled',slots:{findings:[]}})),cross_item:[{nature:'judgment',statement:'合成初评',grounds:[],code:'draft_level',rank:'P4'}]},h.call('draft-session'));
    assert.equal(submitted.acceptance,'accepted',JSON.stringify(submitted.errors));
    const result=await h.service.getResult(h.alice,draft.run!.run);assert.ok(result);
    const verifier={model_id:'synthetic-verifier',model_family_id:'synthetic-verifier-family'};
    const started=await h.service.startRun(h.alice,{pack:'toy-verify',product:'Meadow',version:'3.2',predecessor:draft.run!.run,model_identity:verifier,inputs:{draft:{reference:`rec:${result.record}`},map:{reference:source}}},h.call('verify-session'));
    assert.equal(started.call_result,'ok',JSON.stringify(started.errors));const run=started.run!;
    const checked=await h.service.submitResult(h.alice,{run:run.run,items:run.items.map(item=>({item:item.id,handling:'handled',slots:{verification:[{text:'合成复核',code:'verified',rank:'minor',location:item.location,grounds:[item.location]}]}})),cross_item:[{nature:'judgment',statement:'合成结论',grounds:[],code:'verdict',rank:'PASS'}]},h.call('verify-session'));
    assert.equal(checked.acceptance,'accepted',JSON.stringify(checked.errors));
    const claims=Object.values(checked.result!.partitions).flat().flatMap(item=>item.requirements.flatMap(row=>row.claims));
    assert.ok(claims.some(claim=>claim.warrant.producer==='model'&&claim.warrant.id===verifier.model_id&&claim.warrant.independence==='model_family_declared'));
  } finally {await h.close();await pg.stop();}
});

test('model-less same-session submissions retain raw bytes, replay identity and carry over; other sessions must declare', async t => {
  const skip=await sandboxSkip(); if(skip)return t.skip(skip);
  const postgres=await startPostgres();const h=await openHarness(postgres);
  try {
    const doc=standardDocument(),source=await h.upload(h.alice,toyMap(doc));
    const start=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',model_identity:identity,inputs:{map:{reference:source}}},h.call('start-session'));
    assert.equal(start.call_result,'ok',JSON.stringify(start.errors));const run=start.run!;
    const title=doc.groups[0].cases[0].title;
    const input={run:run.run,items:run.items.map(item=>({item:item.id,handling:'handled' as const,context:sha('synthetic context '+item.id),slots:{findings:item.id===ITEM.c1?[{text:'合成判断',code:'edge_case_gap',rank:'major',location:item.location,quotes:[{reference:item.location,text:title}]}]:[]}})),cross_item:[{nature:'judgment',statement:'合成结论',grounds:[],code:'draft_level',rank:'P4'}]};
    const same=await h.service.submitResult(h.alice,input,h.call('start-session'));
    assert.equal(same.acceptance,'accepted',JSON.stringify(same.errors));
    const claims=Object.values(same.result!.partitions).flat().flatMap(item=>item.requirements.flatMap(row=>row.claims));
    assert.ok(claims.some(claim=>claim.warrant.producer==='model'&&claim.warrant.id===identity.model_id));
    const stored=await submissionsOf(h.kit.store,run.run);assert.equal(stored.length,1);assert.deepEqual(stored[0].body,input);
    const actions=(await actionsOf(h.kit.store,run.run)).filter(row=>row.body.action==='validate'&&row.body.detail.session==='start-session');
    assert.equal(actions.at(-1)?.body.detail.model,identity.model_id);
    const again=await h.service.submitResult(h.alice,input,h.call('start-session'));assert.equal(again.acceptance,'accepted');
    const other=await h.service.submitResult(h.alice,input,h.call('other-session'));
    assert.equal(other.acceptance,'not_accepted');assert.ok(other.errors.some(error=>error.path==='/model_identity'&&/声明/.test(error.fix??'')));
    const absent=await h.service.submitResult(h.alice,input,h.call(null));assert.equal(absent.acceptance,'not_accepted');
    const override=await h.service.submitResult(h.alice,{...input,model_identity:{model_id:'synthetic-override',model_family_id:'synthetic-family-b'}},h.call('other-session'));
    assert.equal(override.acceptance,'accepted',JSON.stringify(override.errors));
    assert.ok(Object.values(override.result!.partitions).flat().flatMap(item=>item.requirements.flatMap(row=>row.claims)).some(claim=>claim.warrant.producer==='model'&&claim.warrant.id==='synthetic-override'));
    assert.deepEqual((await h.kit.store.get(stored[0].digest))!.body,input);

    // Make the inherited declaration the latest accepted result before testing carry-over.
    const latest=await h.service.submitResult(h.alice,{...input,notes:'synthetic latest same-session submission'},h.call('start-session'));
    assert.equal(latest.acceptance,'accepted',JSON.stringify(latest.errors));

    const revision=await h.service.startRun(h.alice,{pack:'toy-review',product:'Meadow',version:'3.2',predecessor:run.run,model_identity:identity,inputs:{map:{reference:source}}},h.call('start-session'));
    assert.equal(revision.call_result,'ok',JSON.stringify(revision.errors));
    const reused=revision.run!.items.find(item=>item.id===ITEM.c1)?.reuse;assert.ok(reused,'the original model-less record offers an unchanged item');
    const next=await h.service.submitResult(h.alice,{run:revision.run!.run,items:revision.run!.items.map(item=>item.id===ITEM.c1?{item:item.id,handling:'handled',reuse:reused}:{item:item.id,handling:'handled',slots:{findings:[]}}),cross_item:[{nature:'judgment',statement:'合成结论',grounds:[],code:'draft_level',rank:'P4'}]},h.call('start-session'));
    assert.equal(next.acceptance,'accepted',JSON.stringify(next.errors));
    const carried=next.result!.partitions.delivered.find(item=>item.item===ITEM.c1);assert.equal(carried?.carried_over,reused);
    assert.ok(carried?.requirements.flatMap(row=>row.claims).some(claim=>claim.warrant.producer==='model'&&claim.warrant.id===identity.model_id));
  } finally {await h.close();await postgres.stop();}
});

test('effect replay reconstructs an omitted model from the result action session', async t => {
  const skip=await sandboxSkip();if(skip)return t.skip(skip);
  const pg=await startPostgres();t.after(()=>pg.stop());const h=await openHarness(pg);t.after(()=>h.close());const dir=await mkdtemp(join(tmpdir(),'synthetic-model-replay-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const spec=locatePack();spec.id='synthetic-model-replay';
  const requirements=spec.files['requirements.json'] as {json:{requirements:Array<Record<string,unknown>>}};requirements.json.requirements=requirements.json.requirements.filter(r=>r.key==='overview');requirements.json.requirements[0].checks=['policy'];
  const checks=spec.files['checks.json'] as {json:{checks:unknown[]}};checks.json.checks=[{id:'policy',function:{module:'functions/policy.ts'},table:'policies/checked.json',applies:'run',judges:'subject',tier:'advisory'}];
  spec.files['policies/checked.json']={json:{tag:'synthetic-frozen'}};
  spec.files['functions/policy.ts']="export default function(input){return [{verdict:'support',tier:'advisory',statement:'synthetic',grounds:[],data:{tag:input.table.tag}}]}";
  await h.workflows.add(await writePack(dir,spec));h.workflows.assign(h.alice.id,spec.id);const map=await h.upload(h.alice,toyMap(standardDocument()));
  const started=await h.service.startRun(h.alice,{pack:spec.id,model_identity:identity,inputs:{map:{reference:map}}},h.call('replay-session'));assert.equal(started.call_result,'ok',JSON.stringify(started.errors));
  const input={run:started.run!.run,items:started.run!.items.map(item=>({item:item.id,handling:'handled'}))};
  const answer=await h.service.submitResult(h.alice,input,h.call('replay-session'));assert.equal(answer.acceptance,'accepted',JSON.stringify(answer.errors));
  const selected=(await h.service.getRun(h.alice,started.run!.run))!.latest!.record;
  const other=await h.service.submitResult(h.alice,input,h.call('other-session'));assert.equal(other.acceptance,'not_accepted');
  const deps={records:h.kit,workflows:h.workflows,packs:h.packs,knowledge:h.knowledge,external:h.external,sandbox:{requireOsIsolation:false}};
  const replay=await recheckEffectChecks(deps,{run:started.run!.run,submission:answer.result!.submission,result:selected,checks:['policy']});
  assert.ok(replay.policy.length);assert.ok(replay.policy.every(row=>row.verdict==='support'&&row.data?.tag==='synthetic-frozen'));
  await assert.rejects(recheckEffectChecks(deps,{run:started.run!.run,submission:answer.result!.submission,result:'f'.repeat(64),checks:['policy']}),/已受理/);
  await assert.rejects(recheckEffectChecks(deps,{run:started.run!.run,submission:answer.result!.submission,result:'',checks:['policy']}));
  const stored=await submissionsOf(h.kit.store,started.run!.run);assert.deepEqual(stored[0].body,input);
});
