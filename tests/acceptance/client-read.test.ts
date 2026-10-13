import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CLIENT_ROUTES,TaskView} from '../../packages/contracts/src/index.ts';
import {setup} from './harness.ts';

test('client task list filters before limiting and returns newest TaskViews with current input and pending requests',async t=>{
  const h=await setup(t),visible:any[]=[];
  for(let index=0;index<102;index++){
    visible.push(await h.request('/v1/tasks/submit',{scopeId:index%3===0?'scp_second':'scp_lab',title:`Visible task ${index}`,
      input:{requiredFields:['target']},idempotencyKey:`client-list-visible-${index}`}));
  }
  const packed=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',title:'SYNTH clarification for the desktop',capabilityPackId:'synthetic-resource-check',
    input:{requiredFields:['target']},idempotencyKey:'client-list-packed-task'});visible.push(packed);
  await h.phase(packed.taskId,'waiting-input');
  const peer=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',title:'Another person in the same scope',input:{requiredFields:['target']},
    idempotencyKey:'client-list-peer-task'},'bob');visible.push(peer);
  // These newer tasks must be excluded before applying even limit=1.
  await h.request('/v1/tasks/submit',{scopeId:'scp_lab',title:'Another tenant',input:{},idempotencyKey:'client-list-other-tenant'},'outsider');
  await h.request('/v1/tasks/submit',{scopeId:'scp_hidden',title:'Hidden scope',input:{},idempotencyKey:'client-list-hidden-scope'},'limited');
  const revised=await h.request(`/v1/tasks/${visible[4].taskId}/input`,{inputRevisionId:visible[4].inputRevisionId,
    replacement:{requiredFields:['target'],note:'Updated after the newest task was created'}});
  const token=await h.login();
  const read=async(path:string)=>{
    const response=await h.raw(path,{token});assert.equal(response.status,200,JSON.stringify(response.body));
    return TaskView.array().parse(response.body.data);
  };
  const latest=[...visible].reverse();
  const defaults=await read('/v1/tasks');assert.deepEqual(defaults.map(task=>task.taskId),latest.slice(0,20).map(task=>task.taskId));
  assert.deepEqual((await read('/v1/tasks?limit=1')).map(task=>task.taskId),[peer.taskId]);
  const maximum=await read('/v1/tasks?limit=100');assert.equal(maximum.length,100);
  assert.deepEqual(maximum.map(task=>task.taskId),latest.slice(0,100).map(task=>task.taskId));
  assert.equal(maximum.find(task=>task.taskId===revised.taskId)!.inputRevisionId,revised.inputRevisionId);
  const packedView=defaults.find(task=>task.taskId===packed.taskId)!;
  assert.equal(packedView.title,packed.title);assert.equal(packedView.phase,'waiting-input');
  assert.equal(packedView.inputRevisionId,packed.inputRevisionId);assert.equal(packedView.capabilityPackId,'synthetic-resource-check');
  assert.ok(packedView.pendingInputs!.some(input=>input.status==='open'&&input.inputRevisionId===packedView.inputRevisionId));
  for(const value of ['0','-1','101','1.5','NaN','Infinity','abc','']){
    const rejected=await h.raw(`/v1/tasks?limit=${value}`,{token});assert.equal(rejected.status,400,`limit=${value}`);
    assert.equal(rejected.body.error.code,'INVALID_PAYLOAD');
  }
  assert.equal(CLIENT_ROUTES.tasks.method,'GET');assert.equal(CLIENT_ROUTES.tasks.path,'/v1/tasks');
  assert.equal(CLIENT_ROUTES.tasks.query.parse({}).limit,20);
  assert.deepEqual(CLIENT_ROUTES.tasks.response.parse(defaults),defaults);
});

test('client task reads require live tasks.read and cannot expand the authenticated tenant or scopes',async t=>{
  const h=await setup(t),lab=await h.submit({requiredFields:['target']}),second=await h.submit({},'scp_second');
  const token=await h.login('bob');
  await h.setRole('prn_bob','viewer');
  const allowed=await h.raw('/v1/tasks?limit=100&scopeId=scp_second&tenantId=tnt_other&principalId=prn_admin&role=admin',{token});
  assert.equal(allowed.status,200,JSON.stringify(allowed.body));assert.deepEqual(allowed.body.data.map((task:any)=>task.taskId),[lab.taskId]);
  assert.equal((await h.raw('/v1/admin/tasks',{token})).body.error.code,'FORBIDDEN_ACTION');
  assert.deepEqual(await h.request('/v1/tasks',undefined,'limited'),[]);
  assert.deepEqual(await h.request('/v1/tasks',undefined,'outsider'),[]);
  assert.equal((await h.raw('/v1/tasks')).body.error.code,'UNAUTHENTICATED');
  await h.reject('/v1/tasks',undefined,'FORBIDDEN_ACTION','lab-east-01');
  await h.reject(`/v1/tasks/${second.taskId}/status`,undefined,'FORBIDDEN_SCOPE','bob');
  await h.setRole('prn_bob',null);
  const revoked=await h.raw('/v1/tasks',{token});assert.equal(revoked.status,403);assert.equal(revoked.body.error.code,'FORBIDDEN_ACTION');
});

test('client approval reads need only tasks.read and preserve bound approval history without decisions or cross-scope access',async t=>{
  const h=await setup(t),task=await h.submit({target:'RESOURCE-LAB-01'});
  const proposal=(revision:string,value:number)=>({inputRevisionId:revision,name:'product.config.write',target:'RESOURCE-LAB-01',
    targetIdentity:'synthetic-host-key:resource-01',args:{key:'backend.timeout',value}});
  const decision=(approval:any,approve:boolean)=>({inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve});
  const first=await h.request(`/v1/tasks/${task.taskId}/approvals`,proposal(task.inputRevisionId,10));
  const approved=await h.request(`/v1/tasks/${task.taskId}/approvals/${first.approvalId}`,decision(first,true),'bob');
  const revised=await h.request(`/v1/tasks/${task.taskId}/input`,{inputRevisionId:task.inputRevisionId,replacement:{target:'RESOURCE-LAB-01',note:'New revision'}});
  const second=await h.request(`/v1/tasks/${task.taskId}/approvals`,proposal(revised.inputRevisionId,11));
  const declined=await h.request(`/v1/tasks/${task.taskId}/approvals/${second.approvalId}`,decision(second,false),'bob');
  const open=await h.request(`/v1/tasks/${task.taskId}/approvals`,proposal(revised.inputRevisionId,12));
  const empty=await h.submit({}),otherScope=await h.submit({},'scp_second');
  const token=await h.login('bob');
  await h.setRole('prn_bob','viewer');
  const counts=async()=> (await h.db.query(`SELECT (SELECT count(*) FROM approvals WHERE task_id=$1)::integer AS approvals,
    (SELECT count(*) FROM decisions WHERE task_id=$1)::integer AS decisions,
    (SELECT count(*) FROM outbox WHERE task_id=$1)::integer AS events`,[task.taskId])).rows[0];
  const before=await counts(),path=`/v1/tasks/${task.taskId}/approvals`;
  const read=await h.raw(path,{token});assert.equal(read.status,200,JSON.stringify(read.body));
  assert.deepEqual(read.body.data,[approved,declined,open]);
  assert.equal(read.body.data[0].inputRevisionId,task.inputRevisionId);assert.equal(read.body.data[2].inputRevisionId,revised.inputRevisionId);
  assert.equal(CLIENT_ROUTES.approvals.method,'GET');assert.equal(CLIENT_ROUTES.approvals.path,'/v1/tasks/{taskId}/approvals');
  assert.deepEqual(CLIENT_ROUTES.approvals.response.parse(read.body.data),read.body.data);
  assert.deepEqual((await h.raw(`/v1/tasks/${empty.taskId}/approvals`,{token})).body.data,[]);
  assert.equal((await h.raw(path)).body.error.code,'UNAUTHENTICATED');
  await h.reject(path,undefined,'FORBIDDEN_SCOPE','limited');await h.reject(path,undefined,'FORBIDDEN_SCOPE','outsider');
  const scoped=await h.raw(`/v1/tasks/${otherScope.taskId}/approvals`,{token});assert.equal(scoped.status,403);assert.equal(scoped.body.error.code,'FORBIDDEN_SCOPE');
  await h.reject(path,undefined,'FORBIDDEN_ACTION','lab-east-01');
  const missing=await h.raw('/v1/tasks/task_missing/approvals',{token});assert.equal(missing.status,404);assert.equal(missing.body.error.code,'TARGET_NOT_FOUND');
  const invalid=await h.raw('/v1/tasks/invalid/approvals',{token});assert.equal(invalid.status,400);assert.equal(invalid.body.error.code,'INVALID_PAYLOAD');
  const writeDenied=await h.raw(`${path}/${open.approvalId}`,{token,body:decision(open,true)});assert.equal(writeDenied.status,403);assert.equal(writeDenied.body.error.code,'FORBIDDEN_ACTION');
  await h.setRole('prn_bob',null);
  const revoked=await h.raw(path,{token});assert.equal(revoked.status,403);assert.equal(revoked.body.error.code,'FORBIDDEN_SCOPE');
  assert.deepEqual(await counts(),before);
});
