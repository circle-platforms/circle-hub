import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {setup,until} from './harness.ts';
import {sha256} from '../../packages/contracts/src/index.ts';

for(const tracker of ['record-feed-a','record-feed-b'])test(`Act 8: ${tracker} cursor trigger owner-scoped service dedupe docs conversion and marker read-back`,async t=>{
  const h=await setup(t);await h.startWorker('lab-east-01');await h.startWorker('lab-east-02');
  const packs=await h.request('/v1/packs'),pack=packs.find((item:any)=>item.capabilityPackId==='defect-review');
  assert.deepEqual(pack.requiredOperations,['defects.search','defects.comment','docs.fetch','docs.convert','product.version']);
  const rule=await h.request('/v1/rules',{scopeId:'scp_lab',capabilityPackId:'defect-review',servicePrincipalId:'prn_defectbot',
    bindings:{defects:tracker,documents:'document-store',product:'RESOURCE-LAB-01'},intervalMs:100,simulateCommentTimeout:true,ownerId:'prn_admin'});
  assert.equal(rule.ownerId,'prn_alice');
  const event=await until(async()=> (await h.db.query('SELECT * FROM connector_events WHERE rule_id=$1',[rule.ruleId])).rows[0],15_000);
  assert.equal(event.external_event_id,'defect-42-updated');assert.equal(event.payload.defectId,'LAB-42');
  const task=await h.phase(event.task_id,'unknown');assert.equal(task.principalId,'prn_defectbot');assert.equal(task.capabilityPackId,'defect-review');
  const unknown=(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((row:any)=>row.name==='defects.comment'&&row.kind==='execute');
  assert.equal(unknown.status,'unknown');
  const state=JSON.parse(await readFile(`${h.scratch}/resources/${tracker}.json`,'utf8'));
  assert.equal(state.defects['LAB-42'].comments.length,1);assert.ok(state.defects['LAB-42'].comments[0].text.includes(`[circle ${unknown.operationId}]`));
  await h.request(`/v1/tasks/${task.taskId}/reconcile`,{operationId:unknown.operationId});await h.phase(task.taskId,'delivered');
  const result=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(result.status,'succeeded');
  const reconciled=(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((row:any)=>row.operationId===unknown.operationId);
  assert.equal(reconciled.status,'reconciled');assert.notEqual(reconciled.result.observedBy,unknown.workerId);
  const all=(await h.request(`/v1/tasks/${task.taskId}/operations`)).filter((row:any)=>row.kind==='execute');
  assert.ok(pack.requiredOperations.every((name:string)=>all.some((row:any)=>row.name===name)));
  const converted=result.artifacts.find((artifact:any)=>artifact.mediaType==='text/plain');assert.ok(converted);
  const bytes=Buffer.from(await(await fetch(`${h.url}${converted.downloadPath}`,{headers:{authorization:`Bearer ${await h.login()}`}})).arrayBuffer());
  assert.equal(sha256(bytes),converted.sha256);assert.match(bytes.toString(),/backend\.timeout.*10/);
  await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'defect-review',input:{ruleId:rule.ruleId,defectId:'SECRET-99'},idempotencyKey:'cannot-read-hidden-defect'},'FORBIDDEN_TARGET','defect-bot');
  assert.equal((await h.db.query("SELECT 1 FROM connector_events WHERE payload->>'defectId'='SECRET-99'")).rowCount,0);
  const replay=JSON.parse(await readFile(`${h.scratch}/resources/${tracker}.json`,'utf8'));
  replay.events.push({cursor:3,externalId:'defect-42-updated',defectId:'LAB-42'});await writeFile(`${h.scratch}/resources/${tracker}.json`,JSON.stringify(replay));
  await until(async()=> (await h.request(`/v1/rules/${rule.ruleId}`)).cursor===3,10_000);
  assert.equal((await h.db.query('SELECT 1 FROM connector_events WHERE rule_id=$1',[rule.ruleId])).rowCount,1);
  assert.equal((await h.db.query("SELECT 1 FROM tasks WHERE capability_pack_id='defect-review' AND input->>'externalEventId'='defect-42-updated' AND input->>'ruleId'=$1",[rule.ruleId])).rowCount,1);
  const actual=JSON.parse(await readFile(`${h.scratch}/resources/${tracker}.json`,'utf8'));assert.equal(actual.defects['LAB-42'].comments.length,1);
});
