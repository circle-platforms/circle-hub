import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup,until} from './harness.ts';
import {sha256} from '../../packages/contracts/src/index.ts';

test('Act 7: revision-bound checklist separates facts opinions and unknown and preserves originals',async t=>{
  const h=await setup(t);await h.startWorker();
  const manual=Buffer.from(JSON.stringify({product:'LBX',versionSeries:'8.4',section:'6.4',backendTimeoutMinimum:10}));
  const source=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'synthetic-manual-6.4.json',contentBase64:manual.toString('base64')});
  const task=await h.submit({product:'LBX',version:'8.4.2',target:'LBX-LAB-01',manualSourceRevisionId:source.sourceRevisionId});
  const checklist={inputRevisionId:task.inputRevisionId,items:[{itemId:'compare-config',requiresFact:true,required:true,predicate:'assessment-completed'}]};
  await h.request(`/v1/tasks/${task.taskId}/checklist`,checklist);
  const model=await h.request(`/v1/tasks/${task.taskId}/conclusions`,{inputRevisionId:task.inputRevisionId,kind:'model-judgment',judgment:'supports',rationale:'Synthetic opinion claims compliance'});
  const unknown=await h.request(`/v1/tasks/${task.taskId}/conclusions`,{inputRevisionId:task.inputRevisionId,kind:'unknown',rationale:'No field values yet'});
  assert.equal(model.kind,'model-judgment');assert.equal(unknown.kind,'unknown');
  await h.reject(`/v1/tasks/${task.taskId}/checklist/compare-config`,{inputRevisionId:task.inputRevisionId,conclusionId:model.conclusionId},'EVIDENCE_INSUFFICIENT');
  await h.reject(`/v1/tasks/${task.taskId}/delivery`,{inputRevisionId:task.inputRevisionId},'EVIDENCE_INSUFFICIENT');
  const read=await h.request(`/v1/tasks/${task.taskId}/operations`,{inputRevisionId:task.inputRevisionId,name:'product.config.read',target:'LBX-LAB-01',targetIdentity:'synthetic-host-key:lbx-01',args:{},idempotencyKey:'delivery-observation'});
  const observed=await until(async()=>(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((row:any)=>row.operationId===read.operationId&&row.status==='succeeded'));
  const fact=await h.request(`/v1/tasks/${task.taskId}/conclusions`,{inputRevisionId:task.inputRevisionId,kind:'script-conclusion',methodId:'lbx-healthcheck',evidenceIds:[observed.result.evidence[0].evidenceId]});
  assert.equal(fact.kind,'script-conclusion');assert.equal(fact.body.verdict,'refutes');assert.equal(fact.body.observedTimeout,5);assert.equal(fact.body.minimumTimeout,10);assert.ok(fact.body.snapshotId);
  await h.request(`/v1/tasks/${task.taskId}/checklist/compare-config`,{inputRevisionId:task.inputRevisionId,conclusionId:fact.conclusionId});
  const revised=await h.request(`/v1/tasks/${task.taskId}/input`,{inputRevisionId:task.inputRevisionId,replacement:{...task.input,note:'new revision'}});
  await h.reject(`/v1/tasks/${task.taskId}/checklist/compare-config`,{inputRevisionId:revised.inputRevisionId,conclusionId:fact.conclusionId},'INPUT_REVISION_STALE');
  await h.reject(`/v1/tasks/${task.taskId}/delivery`,{inputRevisionId:revised.inputRevisionId},'EVIDENCE_INSUFFICIENT');
  await h.request(`/v1/tasks/${task.taskId}/checklist`,{...checklist,inputRevisionId:revised.inputRevisionId});
  const second=await h.request(`/v1/tasks/${task.taskId}/operations`,{inputRevisionId:revised.inputRevisionId,name:'product.config.read',target:'LBX-LAB-01',targetIdentity:'synthetic-host-key:lbx-01',args:{},idempotencyKey:'revised-delivery-observation'});
  const next=await until(async()=>(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((row:any)=>row.operationId===second.operationId&&row.status==='succeeded'));
  const current=await h.request(`/v1/tasks/${task.taskId}/conclusions`,{inputRevisionId:revised.inputRevisionId,kind:'script-conclusion',methodId:'lbx-healthcheck',evidenceIds:[next.result.evidence[0].evidenceId]});
  await h.request(`/v1/tasks/${task.taskId}/checklist/compare-config`,{inputRevisionId:revised.inputRevisionId,conclusionId:current.conclusionId});
  await h.request(`/v1/tasks/${task.taskId}/delivery`,{inputRevisionId:revised.inputRevisionId});
  const delivered=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(delivered.phase,'delivered');assert.equal(delivered.status,'partial');
  const bytes=Buffer.from(await(await fetch(`${h.url}${current.evidence.downloadPath}`,{headers:{authorization:`Bearer ${await h.login()}`}})).arrayBuffer());
  assert.equal(sha256(bytes),current.evidence.sha256);assert.equal(JSON.parse(bytes.toString()).body.minimumTimeout,10);
  const kinds=(await h.db.query('SELECT DISTINCT kind FROM conclusions WHERE task_id=$1 ORDER BY kind',[task.taskId])).rows.map(row=>row.kind);
  assert.deepEqual(kinds,['model-judgment','script-conclusion','unknown']);
  const report=Buffer.from(await(await fetch(`${h.url}${delivered.artifacts[0].downloadPath}`,{headers:{authorization:`Bearer ${await h.login()}`}})).arrayBuffer());assert.equal(sha256(report),delivered.artifacts[0].sha256);
});

test('Act 7: citations without comparable values remain unknown rather than support',async t=>{
  const h=await setup(t);const raw=Buffer.from(JSON.stringify({product:'LBX',versionSeries:'8.4',section:'6.4',note:'citation without extracted minimum'}));
  const source=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'incomplete-manual.json',contentBase64:raw.toString('base64')});
  const task=await h.submit({product:'LBX',version:'8.4.2',manualSourceRevisionId:source.sourceRevisionId});
  const conclusion=await h.request(`/v1/tasks/${task.taskId}/conclusions`,{inputRevisionId:task.inputRevisionId,kind:'script-conclusion',methodId:'lbx-healthcheck',evidenceIds:[]});
  assert.equal(conclusion.kind,'unknown');assert.equal(conclusion.body.verdict,'undetermined');
});
