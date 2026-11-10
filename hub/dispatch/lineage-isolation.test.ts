import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './testing/context.ts';
import {newId,sha256Hex} from '../records/api.ts';
import {readRunJobs} from './read-runs.ts';
import type {ActionBody} from '../records/api.ts';

type Fixture=Awaited<ReturnType<typeof setup>>;
async function independent(c:Fixture,ancestor?:string){
 const run=newId('run'),plan=newId('run'),detail=structuredClone(c.detail),original=c.runs.getRun.bind(c.runs);detail.run.run=run;detail.run.predecessor=plan;detail.latest!.result.run=run;detail.latest!.record=sha256Hex('synthetic independent validation '+run);detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data!.plan_run=plan;
 c.runs.getRun=async(by,id)=>id===run?detail:id===plan?{...detail,run:{...detail.run,run:plan,predecessor:ancestor}}:original(by,id);
 return {run,plan,detail};
}
async function transferLease(c:Fixture,run:string){
 assert.equal((await c.leases.release({keys:c.executor.definition.resources,holder:{user:c.owner.id,run:c.run}})).ok,true);
 assert.equal((await c.leases.acquire({keys:c.executor.definition.resources,prefix:'synthetic/',ttlSeconds:3600,maxTtlSeconds:3600,holder:{user:c.owner.id,run}})).ok,true);
}

test('a completed historical job cannot consume a new independent task with identical verified bytes',{timeout:30000},async t=>{
 const c=await setup();t.after(()=>c.close());const next=await independent(c),first=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(first.outcome,'effective');assert.equal(c.submitted.length,1);assert.deepEqual(await readRunJobs(c.kit,c.service,c.admin,next.run),[]);
 await transferLease(c,next.run);const second=await c.service.dispatch(c.admin,next.run,c.executor.id);assert.equal(second.outcome,'effective',JSON.stringify(second));assert.notEqual(second.job,first.job);assert.equal(c.submitted.length,2);assert.deepEqual(c.submitted[0],c.submitted[1]);
 const before=await c.service.journal.binding(first.job),after=await c.service.journal.binding(second.job);assert.equal(before.input!.run,c.run);assert.equal(after.input!.run,next.run);assert.notEqual(before.input!.lineage,after.input!.lineage);
 for(const [run,job] of [[c.run,first.job],[next.run,second.job],[next.plan,second.job]])assert.deepEqual((await readRunJobs(c.kit,c.service,c.admin,run)).map(row=>row.job),[job]);
 await assert.rejects(c.service.dispatch(c.admin,next.run,c.executor.id));assert.equal(c.submitted.length,2);
});

test('a new verification run inside the same lineage cannot reset the at-most-once history',{timeout:30000},async t=>{
 const c=await setup();t.after(()=>c.close());const next=await independent(c,c.detail.run.predecessor),first=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(first.outcome,'effective');await transferLease(c,next.run);await assert.rejects(c.service.dispatch(c.admin,next.run,c.executor.id),/已有派发意图/);assert.equal(c.submitted.length,1);assert.deepEqual(await readRunJobs(c.kit,c.service,c.admin,next.run),[]);
});

for(const form of ['unversioned','attempt'] as const)test(`legacy ${form} byte keys keep exact historical bindings without claiming an independent lineage`,{timeout:30000},async t=>{
 const c=await setup();t.after(()=>c.close());const next=await independent(c),put=c.kit.store.put.bind(c.kit.store);c.kit.store.put=async(input,tx)=>{if(input.kind==='action'&&(input.body as ActionBody).detail.phase==='intent'&&input.unique_key?.startsWith('dispatch.bytes:'))return put({...input,unique_key:'dispatch.bytes:'+c.payload.body.sha256+(form==='attempt'?':1':'')},tx);return put(input,tx);};
 const first=await c.service.dispatch(c.admin,c.run,c.executor.id);c.kit.store.put=put;assert.equal(first.outcome,'effective');const old=await c.kit.store.getByKey<ActionBody>('action','dispatch.bytes:'+c.payload.body.sha256+(form==='attempt'?':1':''));assert.ok(old);await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id));await transferLease(c,next.run);assert.equal((await c.service.dispatch(c.admin,next.run,c.executor.id)).outcome,'effective');assert.equal(c.submitted.length,2);assert.deepEqual((await c.kit.store.get(old.digest))!.body,old.body);
});

test('an unbound legacy byte intent remains a conservative refusal rather than being assigned to a new task',{timeout:30000},async t=>{
 const c=await setup();t.after(()=>c.close());const time=c.now().toISOString();await c.kit.store.put<ActionBody>({kind:'action',schema:'action@1',provenance:'observed',created_at:time,unique_key:'dispatch.bytes:'+c.payload.body.sha256,body:{action:'dispatch',run:null,item:null,inputs:[],component:'synthetic-legacy@1',lease:null,started_at:time,ended_at:time,result:'completed',error_code:null,acceptance:'accepted',codes:[],detail:{phase:'intent'}},index:[{key:'dispatch.bytes',value:c.payload.body.sha256}]});await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id),/历史派发意图缺少可核验的作业绑定.*不得重交/);assert.equal(c.submitted.length,0);
});

test('inconsistent historical lineage metadata is refused without modifying original journal records',{timeout:30000},async t=>{
 const c=await setup();t.after(()=>c.close());const next=await independent(c),first=await c.service.dispatch(c.admin,c.run,c.executor.id),original=await c.service.journal.binding(first.job),events=await c.service.journal.events(first.job),intent=events.find(row=>row.body.detail.phase==='intent')!;
 const binding={...original,job:sha256Hex('synthetic inconsistent historical lineage'),input:{...original.input!,lineage:newId('run')}};await c.service.journal.append(binding,'reservation','validate','completed',{binding});await c.service.journal.append(binding,'intent','dispatch','completed',{...intent.body.detail,job:binding.job},intent.body.inputs);await transferLease(c,next.run);await assert.rejects(c.service.dispatch(c.admin,next.run,c.executor.id),/历史派发意图的血缘绑定不完整或不一致.*不得重交/);assert.equal(c.submitted.length,1);assert.deepEqual((await c.kit.store.get(intent.digest))!.body,intent.body);
});

test('independent repetition starts with its own rounds and window instead of inheriting old byte history',{timeout:30000},async t=>{
 const c=await setup();t.after(()=>c.close());c.detail.run.requirements=[{key:'workbook_verified',name:'合成核验',description:'合成',layers:['dynamic'],done_rule:'gating',accepted_producer:'fact',repair_rounds:0,rules:[],run_interpreters:[],repetition:{count:2,aggregation:'all',basis:'explicit',declared:{count:true,aggregation:true,k:false},window_seconds:2}}];
 const next=await independent(c),first=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(first.outcome,'effective');assert.equal(c.submitted.length,2);await transferLease(c,next.run);c.clock.ms+=5000;const second=await c.service.dispatch(c.admin,next.run,c.executor.id);assert.equal(second.outcome,'effective');assert.equal(c.submitted.length,4);assert.deepEqual(second.rounds?.map(row=>row.round),[1,2]);assert.ok(second.rounds?.every(row=>row.reason!=='budget_exhausted'));
 const original=await c.service.journal.events(first.job),current=await c.service.journal.events(second.job);assert.deepEqual(current.filter(row=>row.body.detail.phase==='intent').map(row=>[row.body.detail.round,row.body.detail.attempt]),[[1,1],[2,1]]);assert.equal(new Set([...original,...current].filter(row=>row.body.detail.phase==='intent').map(row=>row.body.detail.intent_key)).size,4);assert.deepEqual((await readRunJobs(c.kit,c.service,c.admin,next.run)).map(row=>row.job),[second.job]);
});

test('risk disposition frees physical occupancy without erasing the original unknown or permitting its retry',{timeout:30000},async t=>{
 const c=await setup({mode:'reject'});t.after(()=>c.close());const next=await independent(c),first=await c.service.dispatch(c.admin,c.run,c.executor.id),released=await c.service.dispose(c.admin,first.job,{choice:'mark_failed',reason:'合成独立任务风险确认',acceptPossibleDuplicateEffects:true});assert.equal(released.outcome,'unknown');assert.equal(released.frozen,false);await assert.rejects(c.service.dispatch(c.admin,c.run,c.executor.id));await transferLease(c,next.run);const second=await c.service.dispatch(c.admin,next.run,c.executor.id);assert.equal(second.outcome,'unknown');assert.notEqual(second.job,first.job);assert.equal(c.submitted.length,2);assert.equal((await c.service.status(c.admin,first.job)).outcome,'unknown');
});

test('an unresolved historical write continues to own its physical target across a new independent task',{timeout:30000},async t=>{
 const c=await setup({mode:'reject'});t.after(()=>c.close());const next=await independent(c),first=await c.service.dispatch(c.admin,c.run,c.executor.id);assert.equal(first.outcome,'unknown');assert.equal(first.frozen,true);await transferLease(c,next.run);
 await assert.rejects(c.service.dispatch(c.admin,next.run,c.executor.id),/物理目标被作业.*占用/);assert.equal(c.submitted.length,1);assert.deepEqual(await readRunJobs(c.kit,c.service,c.admin,next.run),[]);assert.equal((await c.service.status(c.admin,first.job)).frozen,true);
});
