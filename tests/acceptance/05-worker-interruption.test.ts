import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, until } from './harness.ts';

test('Act 5: SIGKILL, actual 60-second expiry, frozen writes, independent read-back and stale fence', async t => {
  const h = await setup(t);
  const worker = await h.startWorker('lab-east-01');
  const task = await h.submit({ product:'LBX',version:'8.4.2',target:'LBX-LAB-01' });
  const operation = await h.request(`/v1/tasks/${task.taskId}/operations`,{
    inputRevisionId:task.inputRevisionId,name:'product.config.read',target:'LBX-LAB-01',targetIdentity:'synthetic-host-key:lbx-01',
    args:{ holdAfterEffectMs:120_000 },idempotencyKey:'kill-worker-observation',deadlineMs:180_000,
  });
  await until(async () => {
    const rows = await h.request(`/v1/tasks/${task.taskId}/operations`);
    return rows.find((row: any) => row.operationId === operation.operationId && row.status === 'running');
  });
  const { readFile } = await import('node:fs/promises');
  await until(async () => {
    try { const state=JSON.parse(await readFile(`${h.scratch}/resources/LBX-LAB-01.json`,'utf8'));
      return state.receipts[operation.operationId] ? true : false; } catch { return false; }
  });
  const running = (await h.request(`/v1/tasks/${task.taskId}/operations`)).find((row: any) => row.operationId === operation.operationId);
  await h.stop(worker,'SIGKILL');
  const start = Date.now();
  await until(async () => (await h.request(`/v1/tasks/${task.taskId}/operations`)).some((row: any) => row.operationId === operation.operationId && row.status === 'unknown'),70_000);
  assert.ok(Date.now()-start >= 50_000,'This acceptance must observe the real default lease, not edit its timestamp');
  const writes = await h.submit({ target:'LBX-LAB-01' });
  await h.reject(`/v1/tasks/${writes.taskId}/operations`,{
    inputRevisionId:writes.inputRevisionId,name:'product.config.write',target:'LBX-LAB-01',targetIdentity:'synthetic-host-key:lbx-01',
    args:{ key:'backend.timeout',value:10 },idempotencyKey:'frozen-resource-write',
  },'RESOURCE_BUSY');
  await h.startWorker('lab-east-02');
  assert.equal((await h.db.query('SELECT count(*)::integer AS count FROM operations WHERE operation_id=$1',[operation.operationId])).rows[0].count,1);
  await h.request(`/v1/tasks/${task.taskId}/reconcile`,{ operationId:operation.operationId });
  const reconciled = await until(async () => {
    const row=(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((item: any) => item.operationId === operation.operationId);
    return row.status === 'reconciled' ? row : false;
  });
  assert.equal(reconciled.result.observedBy,'lab-east-02'); assert.equal(reconciled.result.observedOutcome,'succeeded');
  assert.ok(reconciled.result.evidence[0].sha256);
  await h.reject(`/v1/workers/operations/${operation.operationId}/report`,{
    fencingToken:running.fencingToken,inputRevisionId:task.inputRevisionId,status:'succeeded',output:{ config:{'backend.timeout':5} },
  },'FENCING_STALE','lab-east-01');
  const next = await h.request(`/v1/tasks/${writes.taskId}/operations`,{
    inputRevisionId:writes.inputRevisionId,name:'product.config.read',target:'LBX-LAB-01',targetIdentity:'synthetic-host-key:lbx-01',args:{},idempotencyKey:'after-reconcile-read',
  });
  const completed = await until(async () => (await h.request(`/v1/tasks/${writes.taskId}/operations`)).find((row: any) => row.operationId === next.operationId && row.status === 'succeeded'));
  assert.ok(completed.fencingToken > running.fencingToken);
  assert.equal((await h.db.query('SELECT count(*)::integer AS count FROM operations WHERE task_id=$1 AND parent_operation_id IS NULL',[task.taskId])).rows[0].count,1);
});
