import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setup} from './harness.ts';

test('Task filters run before limiting and creation-order cursors preserve the work list under internal task volume',async t=>{
  const h=await setup(t),work=[];
  for(let index=0;index<3;index++)work.push(await h.submit({note:index}));
  const tool=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',title:'Synthetic tool task',capabilityPackId:'asset-tool',input:{},idempotencyKey:'tool-list-fixture'}),index=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',title:'Synthetic index task',capabilityPackId:'asset-index',input:{},idempotencyKey:'index-list-fixture'});
  await h.db.query(`INSERT INTO tasks(task_id,tenant_id,scope_id,principal_id,title,phase,input_revision_id,input,flow_version,capability_pack_id,pack_version,context)
    SELECT 'task_volume_'||n,tenant_id,scope_id,principal_id,'Internal volume',phase,'inrev_volume_'||n,input,flow_version,capability_pack_id,pack_version,context FROM tasks CROSS JOIN generate_series(1,110) n WHERE task_id=$1`,[tool.taskId]);
  const first=await h.request('/v1/tasks?kind=work&limit=2');assert.deepEqual(first.map((task:any)=>task.taskId),[work[2].taskId,work[1].taskId]);
  const second=await h.request(`/v1/tasks?kind=work&limit=2&after=${first[1].taskId}`);assert.deepEqual(second.map((task:any)=>task.taskId),[work[0].taskId]);
  assert.equal((await h.request(`/v1/tasks?kind=work&after=${second[0].taskId}`)).length,0);assert.equal((await h.request('/v1/tasks?kind=tool&limit=100')).length,100);assert.deepEqual((await h.request('/v1/tasks?kind=index')).map((task:any)=>task.taskId),[index.taskId]);
  assert.equal((await h.request('/v1/tasks?capabilityPackId=asset-tool&limit=100')).length,100);assert.deepEqual(await h.request('/v1/tasks?kind=index',undefined,'bob'),[]);
  for(const query of ['kind=unknown','limit=0','limit=101','after=bad-id'])await h.reject(`/v1/tasks?${query}`,undefined,'INVALID_PAYLOAD');
  await h.reject(`/v1/tasks?after=${index.taskId}`,undefined,'FORBIDDEN_SCOPE','bob');
  const foreign=await h.submit({},'scp_second');await h.reject(`/v1/tasks?after=${foreign.taskId}`,undefined,'FORBIDDEN_SCOPE','bob');
  await h.stop();await h.startServer();assert.deepEqual((await h.request(`/v1/tasks?kind=work&limit=2&after=${first[1].taskId}`)).map((task:any)=>task.taskId),[work[0].taskId]);
});
