import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './harness.ts';

test('Approval lifetime: approvals default to a day independently of short clarification deadlines and remain revision bound',async t=>{
  const h=await setup(t),task=await h.submit(),before=Date.now();
  const approval=await h.request(`/v1/tasks/${task.taskId}/approvals`,{inputRevisionId:task.inputRevisionId,name:'product.config.write',target:'RESOURCE-LAB-01',targetIdentity:'synthetic-host-key-v1',args:{}});
  const ttl=Date.parse(approval.expiresAt)-before;assert.ok(ttl>=23.9*60*60*1000&&ttl<=24.1*60*60*1000);
  const pending=(await h.status(task.taskId)).pendingInputs.find((item:any)=>item.requestId===approval.approvalId);assert.equal(pending.expiresAt,approval.expiresAt);
  const clarification=await h.submit({requiredFields:['purpose']});await h.phase(clarification.taskId,'waiting-input');const prompt=(await h.status(clarification.taskId)).pendingInputs[0];assert.ok(Date.parse(prompt.expiresAt)-Date.now()<301000);
  await h.request(`/v1/tasks/${task.taskId}/input`,{inputRevisionId:task.inputRevisionId,replacement:{purpose:'revision changed'}});await h.reject(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'APPROVAL_STALE','bob');
});

test('Approval lifetime: runtime approval TTL is configurable and schema failures expose safe repair hints',async t=>{
  const h=await setup(t,{CIRCLE_SERVER_APPROVAL_TTL_MS:'7200000'}),task=await h.submit(),before=Date.now();
  const approval=await h.request(`/v1/tasks/${task.taskId}/approvals`,{inputRevisionId:task.inputRevisionId,name:'product.config.write',target:'RESOURCE-LAB-01',targetIdentity:'synthetic-host-key-v1',args:{}});assert.ok(Date.parse(approval.expiresAt)-before>=7199000&&Date.parse(approval.expiresAt)-before<=7201000);
  const error=await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',idempotencyKey:'bad',input:{}},'INVALID_PAYLOAD');assert.ok(error.details.issues.some((issue:any)=>issue.path.join('.')==='idempotencyKey'));assert.ok(!JSON.stringify(error.details).includes('synthetic-only-password'));
});
