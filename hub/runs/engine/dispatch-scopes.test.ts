import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunJob } from '../../dispatch/api.ts';
import type { ActionBody, StoredRecord } from '../../records/api.ts';
import { dispatchNotExecuted, dispatchUncertain, dispatchFinalized, publicDispatchFacts, legacyJobState, exportedScopedJobs } from './dispatch-results.ts';
import { withDispatch, type SubmitAnswer } from './submit.ts';
import { accepted, runRecord } from '../../../contracts/src/fixtures.ts';
import type { EngineContext } from './deps.ts';

const job='a'.repeat(64),run='run_'+'0'.repeat(26);
const attempt=(round:number,outcome:'effective'|'not_dispatched'|'unknown'|'issued')=>({scope:{operation:'dispatch' as const,job,round},outcome,...(outcome==='not_dispatched'?{not_sent:true as const}:{})});
function observed():RunJob {
  return {job,verification_run:run,plan_run:run,verification_item:'case-a',items:['case-a'],sha256:'b'.repeat(64),ended:'done',boundary_refused:false,status:{job,events:4,job_facts:{scope:{job},frozen:false,rounds:[{round:1,terminal:'pass',dispatch_attempt:attempt(1,'effective')},{round:2,terminal:'not_run',dispatch_attempt:attempt(2,'not_dispatched')}]},dispatch_attempt:attempt(2,'not_dispatched')}};
}

test('round two not sent does not erase round one execution or prove a whole job unexecuted',()=>{
  const value=observed();
  assert.equal(dispatchNotExecuted(value),false);
  assert.equal(dispatchUncertain(value),false);
  value.status.job_facts.rounds![0].dispatch_attempt=undefined;
  assert.equal(dispatchNotExecuted(value),false,'missing scope is not converted to a not-sent observation');
});

test('whole-job no-execution requires all recorded contiguous rounds, a settled job and no report',()=>{
  const value=observed();
  value.status.job_facts.rounds![0].dispatch_attempt=attempt(1,'not_dispatched');
  assert.equal(dispatchNotExecuted(value),true);
  value.status.job_facts.result=`src:${'c'.repeat(64)}`;
  assert.equal(dispatchNotExecuted(value),false);
  delete value.status.job_facts.result;
  value.status.job_facts.rounds=[];
  assert.equal(dispatchNotExecuted(value),false,'a selected round two alone does not cover the job');
  value.status.dispatch_attempt=attempt(1,'not_dispatched');
  value.ended=null;
  assert.equal(dispatchNotExecuted(value),false,'an active job can still perform work');
});

test('unknown or issued history remains actionable independently of the last not-sent attempt',()=>{
  const value=observed();
  value.status.job_facts.rounds![0].dispatch_attempt=attempt(1,'unknown');
  assert.equal(dispatchUncertain(value),true);
  value.status.job_facts.rounds![0].dispatch_attempt=attempt(1,'issued');
  assert.equal(dispatchUncertain(value),false);
  assert.equal(dispatchUncertain(value,true),true,'maintenance still reconciles an accepted unresolved attempt');
});

test('named management disposition preserves the safety freeze without remaining an open technical verdict',()=>{
  const value=observed();
  value.status.job_facts.frozen=true;
  assert.equal(dispatchUncertain(value),true);
  Object.assign(value.status.job_facts,{disposition:'mark_failed',decided_by:'u_admin',decided_at:'2026-11-15T00:00:00.000Z'});
  assert.equal(dispatchFinalized(value),true);
  assert.equal(dispatchUncertain(value),false);
  assert.equal(value.status.job_facts.frozen,true);
});

test('public scoped export strips internal diagnostics and administrative grounds without manufacturing a scope',()=>{
  const value=observed();
  Object.assign(value.status.job_facts,{grounds:[`rec:${'d'.repeat(64)}`],admin_release:[{private:'not-for-wire'}]});
  Object.assign(value.status.dispatch_attempt!,{grounds:[`rec:${'e'.repeat(64)}`],booking:{private:'not-for-wire'}});
  const exported=publicDispatchFacts(value);
  assert.equal(exported.job_facts.grounds,undefined);
  assert.equal(exported.dispatch_attempt?.grounds,undefined);
  assert.doesNotMatch(JSON.stringify(exported),/not-for-wire|admin_release|booking/);
  delete value.status.dispatch_attempt;
  assert.equal(publicDispatchFacts(value).dispatch_attempt,undefined);
});

test('version one outcome reads original journal rules, not a version two last-attempt alias',()=>{
  const event=(detail:Record<string,unknown>)=>({digest:'f'.repeat(64),body:{detail}} as unknown as StoredRecord<ActionBody>);
  assert.equal(legacyJobState([event({phase:'complete',done:true,outcome:'effective'})]).outcome,'effective');
  assert.equal(legacyJobState([event({phase:'complete',done:true,outcome:'target_rejected'})]).outcome,'target_rejected');
  assert.equal(legacyJobState([event({phase:'intent'}),event({phase:'receipt'}),event({phase:'complete',done:true,outcome:'effective'})]).outcome,'effective');
  assert.equal(legacyJobState([event({phase:'intent'}),event({phase:'complete',done:true,outcome:'not_dispatched'})]).outcome,'unknown');
});

test('canonical export reads the job report even when the last attempt names a different report',async()=>{
  const value=observed(),reference=`src:${'c'.repeat(64)}`,attemptReference=`src:${'d'.repeat(64)}`;
  value.status.job_facts.result=reference;
  value.status.dispatch_attempt!.result=attemptReference;
  const seen:string[]=[];
  const ctx={deps:{dispatch:{jobs:async()=>[value]},records:{principals:{list:async()=>[{id:'u_admin',name:'合成管理员',role:'admin'}]},artifacts:{source:async(_by:unknown,sha:string)=>{seen.push(sha);return {bytes:new TextEncoder().encode(JSON.stringify({job,sha256:value.sha256,rows:[{item:'case-a',dynamic_terminal:'pass',qualifier:{nature:'judgment',marks:['target_reported']},accepted_as_fact:false}]})),artifact:{body:{origin:{generated:{generator:'dispatch@1'}},author:{user:null},provenance_type:'projected'}}};}}}}} as unknown as EngineContext;
  const [exported]=await exportedScopedJobs(ctx,run);
  assert.deepEqual(seen,['c'.repeat(64)]);
  assert.equal(exported.job_facts.result,reference);
  assert.equal(exported.dispatch_attempt?.result,attemptReference);
  assert.equal(exported.rows?.[0].dynamic_terminal,'pass');
  for(const field of ['outcome','frozen','result','device_return','record'])assert.equal(Object.hasOwn(exported,field),false,field);
});


test('a dispatch exception reports only the run scope, without inventing job or physical outcome',async()=>{
  let calls=0;
  const ctx={deps:{workflows:{byDigest:async()=>({effects:[{trigger:'hub_template',release:{requirements:[]}}]})},dispatch:{accepted:async()=>{calls++;throw new Error('private executor diagnostic');}},records:{principals:{get:async()=>({id:'u_member',name:'合成成员',role:'user',disabled:false})}}},log:()=>{}} as unknown as EngineContext;
  const answer={call_result:'ok',errors:[],acceptance:'accepted',result:accepted} as SubmitAnswer;
  const reply=await withDispatch(ctx,runRecord,answer,null,{id:'u_member',name:'合成成员',role:'user'});
  assert.equal(calls,1);
  const note=reply.dispatch![0];
  assert.deepEqual(note.run_facts?.scope,{run:runRecord.run});
  assert.equal(note.run_facts?.worker_settled,undefined);
  assert.match(note.run_facts?.missing_facts?.[0].fact??'',/未能取得/);
  assert.match(note.run_facts?.next_action??'',/不要重新发送/);
  for(const key of ['outcome','job','job_facts','dispatch_attempt','not_sent','missing_facts','next_action'])assert.equal(Object.hasOwn(note,key),false,key);
  assert.doesNotMatch(JSON.stringify(note),/private executor diagnostic/);
});
