import assert from 'node:assert/strict';
import {sandboxTest,until} from './harness.ts';
import {sha256} from '../../packages/contracts/src/index.ts';
import {meridianFlow,meridianModule} from '../fixtures/meridian-flow.ts';

async function installDeadline(h:any,deadlineMs:number){
 const fixture=await meridianModule('2.0.0'),file=fixture.files.find((entry:any)=>entry.path==='flows/execution.json')!;
 const flow=JSON.parse(Buffer.from(file.base64,'base64').toString());flow.deadlineMs=deadlineMs;const bytes=Buffer.from(JSON.stringify(flow));file.base64=bytes.toString('base64');file.sha256=sha256(bytes);fixture.module.files=fixture.files.map(({path,sha256}:any)=>({path,sha256}));fixture.module.digest=sha256(fixture.files.map((entry:any)=>`${entry.sha256}  ${entry.path}\n`).join(''));
 const response=await h.raw('/v1/modules/install',{token:await h.login(),headers:{'x-scope-id':'scp_lab'},body:fixture});assert.equal(response.status,201,JSON.stringify(response.body));const method=response.body.data;await h.request(`/v1/assets/${method.assetId}/lifecycle`,{version:method.assetVersion,sha256:method.assetSha256,state:'approved'},'bob');return method;
}

sandboxTest('A3 deadline: independent approval after the former five minute window refreshes the frozen one hour dispatch deadline',async t=>{
 const {h,provider,submit}=await meridianFlow(t,{executionIsChange:true});await h.startWorker();const task=await submit('deadline-review-age');await h.phase(task.taskId,'waiting-review',30_000);
 const write=(await h.db.query("SELECT o.* FROM operations o WHERE o.task_id=$1 AND source_effect='write'",[task.taskId])).rows[0];
 await h.db.query("UPDATE operations SET created_at=created_at-interval '6 minutes',deadline_at=clock_timestamp()-interval '1 minute' WHERE operation_id=$1",[write.operation_id]);
 const approval=(await h.request(`/v1/tasks/${task.taskId}/approvals`))[0];await h.request(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'bob');
 const refreshed=(await h.db.query('SELECT extract(epoch FROM deadline_at-clock_timestamp())*1000 AS remaining FROM operations WHERE operation_id=$1',[write.operation_id])).rows[0];assert.ok(Number(refreshed.remaining)>3_590_000,'Approved dispatch must receive the same frozen one hour budget after review');
 const run=(await h.db.query('SELECT definition FROM flow_runs WHERE task_id=$1',[task.taskId])).rows[0];assert.equal(run.definition.deadlineMs,3_600_000);await h.phase(task.taskId,'delivered',30_000);assert.equal(provider.state.submissions,1);
});

sandboxTest('A3 deadline: approved flow and explicit submission durations are selected once and frozen before any worker claim',async t=>{
 const f=await meridianFlow(t),{h}=f,method=await installDeadline(h,9000),input=f.input('normal',method);
 const first=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',idempotencyKey:'deadline-from-flow',input});await until(async()=>(await h.db.query('SELECT definition FROM flow_runs WHERE task_id=$1',[first.taskId])).rows[0],5000);assert.equal((await h.db.query('SELECT definition FROM flow_runs WHERE task_id=$1',[first.taskId])).rows[0].definition.deadlineMs,9000);
 const second=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'module-execute',idempotencyKey:'deadline-from-submission',input:{...input,deadlineMs:6000}});await until(async()=>(await h.db.query('SELECT definition FROM flow_runs WHERE task_id=$1',[second.taskId])).rows[0],5000);assert.equal((await h.db.query('SELECT definition FROM flow_runs WHERE task_id=$1',[second.taskId])).rows[0].definition.deadlineMs,6000);
 for(const [id,duration] of [[first.taskId,9000],[second.taskId,6000]]){const row=(await h.db.query('SELECT extract(epoch FROM deadline_at-created_at)*1000 AS duration FROM operations WHERE task_id=$1',[id])).rows[0];assert.ok(Math.abs(Number(row.duration)-Number(duration))<100,'Every step is derived from its frozen duration');}
});

sandboxTest('A3 deadline: an active write outlives the former five minute budget without cancellation or a second submission',async t=>{
 const {h,provider,submit}=await meridianFlow(t);provider.state.hold=true;await h.startWorker();const task=await submit('deadline-long-write');const write=await until(async()=>(await h.db.query("SELECT o.* FROM operations o JOIN flow_steps s USING(operation_id) WHERE o.task_id=$1 AND s.intent AND s.remote_identity IS NOT NULL",[task.taskId])).rows[0],30_000);
 // Age the operation by the old duration in the synthetic database; no timer or
 // deadline implementation is mocked, and the worker remains genuinely active.
 await h.db.query("UPDATE operations SET created_at=created_at-interval '5 minutes',deadline_at=deadline_at-interval '5 minutes' WHERE operation_id=$1",[write.operation_id]);await new Promise(resolve=>setTimeout(resolve,600));
 assert.equal((await h.db.query('SELECT status FROM operations WHERE operation_id=$1',[write.operation_id])).rows[0].status,'running');assert.ok(!(await h.db.query('SELECT 1 FROM resources WHERE frozen')).rowCount);provider.state.hold=false;await h.phase(task.taskId,'delivered',30_000);assert.equal(provider.state.submissions,1);
});

sandboxTest('A3 deadline: expired accepted work fails explicitly before claim and cannot leave a permanently pending task',async t=>{
 const {h,provider,submit}=await meridianFlow(t),task=await submit('deadline-accepted-expiry'),step=await until(async()=>(await h.db.query("SELECT * FROM operations WHERE task_id=$1 AND status='accepted'",[task.taskId])).rows[0],5000);
 await h.db.query("UPDATE operations SET deadline_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[step.operation_id]);await h.phase(task.taskId,'failed',3000);
 const row=(await h.db.query('SELECT status,result FROM operations WHERE operation_id=$1',[step.operation_id])).rows[0];assert.equal(row.status,'failed');assert.equal(row.result.error.code,'UPSTREAM_TIMEOUT');assert.equal(row.result.error.details.sideEffects,'none');assert.ok(!(await h.db.query('SELECT 1 FROM leases WHERE operation_id=$1',[step.operation_id])).rowCount);assert.ok(!(await h.db.query('SELECT 1 FROM resources WHERE frozen')).rowCount);assert.equal(provider.state.submissions,0);
});

sandboxTest('A3 deadline: a write past its real compressed deadline becomes unknown even while its local lease remains live',async t=>{
 const {h,provider,submit}=await meridianFlow(t);provider.state.hold=true;await h.startWorker();const task=await submit('deadline-real-intent'),write=await until(async()=>(await h.db.query("SELECT o.* FROM operations o JOIN flow_steps s USING(operation_id) WHERE o.task_id=$1 AND s.intent AND s.remote_identity IS NOT NULL",[task.taskId])).rows[0],30_000);
 await h.db.query("UPDATE operations SET deadline_at=clock_timestamp()+interval '3 seconds' WHERE operation_id=$1",[write.operation_id]);await h.phase(task.taskId,'unknown',6000);assert.equal((await h.db.query('SELECT status FROM operations WHERE operation_id=$1',[write.operation_id])).rows[0].status,'unknown');assert.ok((await h.db.query('SELECT 1 FROM resources WHERE frozen')).rowCount);assert.equal(provider.state.submissions,1);assert.equal(provider.state.releases,0);assert.ok(!(await h.db.query('SELECT 1 FROM leases WHERE operation_id=$1',[write.operation_id])).rowCount);
});
