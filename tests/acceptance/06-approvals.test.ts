import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { setup,until } from './harness.ts';

const write=(revision:string)=>({inputRevisionId:revision,name:'product.config.write',target:'LBX-LAB-01',targetIdentity:'synthetic-host-key:lbx-01',args:{key:'backend.timeout',value:10}});
const decision=(approval:any)=>({inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true});

test('Act 6: no self approval, exact binding, revision invalidation and no implied device grant',async t=>{
  const h=await setup(t),task=await h.submit({target:'LBX-LAB-01',version:'8.4.2'});
  const approval=await h.request(`/v1/tasks/${task.taskId}/approvals`,write(task.inputRevisionId));
  await h.reject(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,{...decision(approval),principalId:'prn_bob',role:'approver'},'SELF_APPROVAL');
  await h.reject(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,{...decision(approval),actionDigest:'0'.repeat(64)},'APPROVAL_STALE','bob');
  await h.request(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,decision(approval),'bob');
  await h.reject(`/v1/tasks/${task.taskId}/operations`,{...write(task.inputRevisionId),approvalId:approval.approvalId,idempotencyKey:'approver-is-not-operator'},'FORBIDDEN_ACTION','bob');
  await h.reject(`/v1/tasks/${task.taskId}/operations`,{...write(task.inputRevisionId),args:{key:'backend.timeout',value:11},approvalId:approval.approvalId,idempotencyKey:'different-approved-action'},'APPROVAL_STALE');
  const revised=await h.request(`/v1/tasks/${task.taskId}/input`,{inputRevisionId:task.inputRevisionId,replacement:{target:'LBX-LAB-01',version:'8.4.2',note:'revision two'}});
  await h.reject(`/v1/tasks/${task.taskId}/operations`,{...write(revised.inputRevisionId),approvalId:approval.approvalId,idempotencyKey:'superseded-approval'},'APPROVAL_STALE');
  const rows=(await h.db.query('SELECT principal_id,outcome FROM decisions WHERE task_id=$1 ORDER BY id',[task.taskId])).rows;
  assert.deepEqual(rows.map(row=>row.outcome),['self-approval','binding-mismatch','approved']);assert.deepEqual(rows.map(row=>row.principal_id),['prn_alice','prn_bob','prn_bob']);
});

test('Act 6: D rechecks before dispatch and the worker checks the observed host key before effect',async t=>{
  const h=await setup(t),task=await h.submit({target:'LBX-LAB-01'});
  const approval=await h.request(`/v1/tasks/${task.taskId}/approvals`,write(task.inputRevisionId));
  await h.request(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,decision(approval),'bob');
  const op=await h.request(`/v1/tasks/${task.taskId}/operations`,{...write(task.inputRevisionId),approvalId:approval.approvalId,idempotencyKey:'recheck-before-dispatch'});
  await h.request('/v1/workers/register',{},'lab-east-01');
  await h.db.query("UPDATE policies SET grants=grants-'product.config.write' WHERE principal_id='prn_alice'");
  await h.reject('/v1/workers/claim',{},'FORBIDDEN_ACTION','lab-east-01');
  const rejected=(await h.db.query('SELECT worker_id,status,result FROM operations WHERE operation_id=$1',[op.operationId])).rows[0];
  assert.equal(rejected.worker_id,null);assert.equal(rejected.status,'failed');assert.equal(rejected.result.executionStarted,false);
  await h.db.query(`UPDATE policies SET grants=grants||'"product.config.write"'::jsonb WHERE principal_id='prn_alice'`);
  await mkdir(`${h.scratch}/resources`,{recursive:true});
  await writeFile(`${h.scratch}/resources/LBX-LAB-01.json`,JSON.stringify({synthetic:true,identity:'rotated-synthetic-host-key',product:'LBX',version:'8.4.2',config:{'backend.timeout':5},fencing:0,receipts:{},writes:[]}));
  const keyed=await h.request(`/v1/tasks/${task.taskId}/operations`,{...write(task.inputRevisionId),approvalId:approval.approvalId,idempotencyKey:'observe-host-key-at-exit'});
  await h.startWorker('lab-east-01');
  const failed=await until(async()=> (await h.request(`/v1/tasks/${task.taskId}/operations`)).find((row:any)=>row.operationId===keyed.operationId&&row.status==='failed'));
  assert.equal(failed.result.error.code,'TARGET_IDENTITY_MISMATCH');
  const actual=JSON.parse(await readFile(`${h.scratch}/resources/LBX-LAB-01.json`,'utf8'));assert.equal(actual.config['backend.timeout'],5);assert.deepEqual(actual.writes,[]);
});
