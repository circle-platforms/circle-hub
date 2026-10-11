import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setup,root,until} from './harness.ts';

async function command(env:NodeJS.ProcessEnv,args:string[]):Promise<any>{
  const child=spawn(process.execPath,['apps/server/src/cli.ts','admin',...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout!.on('data',data=>{stdout+=data.toString();});child.stderr!.on('data',data=>{stderr+=data.toString();});const [code]=await once(child,'exit');return {code,stdout,stderr};
}
test('admin tasks drain approvals tail audit and connector control use the same authenticated API',async t=>{
  const h=await setup(t);await h.startWorker();const task=await h.submit({target:'LBX-LAB-01'});
  const env={...h.env,CIRCLE_SERVER_URL:h.url,CIRCLE_SERVER_TOKEN:await h.login('admin'),CIRCLE_SERVER_SCOPE:'scp_lab'};
  const tasks=await command(env,['tasks']);assert.equal(tasks.code,0,tasks.stderr);assert.ok(JSON.parse(tasks.stdout).some((item:any)=>item.taskId===task.taskId));
  const denied=await command({...env,CIRCLE_SERVER_TOKEN:await h.login('alice')},['tasks']);assert.notEqual(denied.code,0);assert.match(denied.stderr,/FORBIDDEN_ACTION/);
  const approval=await h.request(`/v1/tasks/${task.taskId}/approvals`,{inputRevisionId:task.inputRevisionId,name:'product.config.write',target:'LBX-LAB-01',targetIdentity:'synthetic-host-key:lbx-01',args:{key:'backend.timeout',value:10}});
  const approvals=await command(env,['approvals']);assert.equal(approvals.code,0,approvals.stderr);assert.ok(JSON.parse(approvals.stdout).some((item:any)=>item.approvalId===approval.approvalId));
  const events=await command(env,['events','--tail','--once']);assert.equal(events.code,0,events.stderr);assert.ok(JSON.parse(events.stdout).events.some((event:any)=>event.taskId===task.taskId));
  const audit=await command(env,['audit']);assert.equal(audit.code,0,audit.stderr);assert.ok(JSON.parse(audit.stdout).some((item:any)=>item.action==='tasks.submit'));
  const disabled=await command(env,['connectors','disable','bugzilla-synthetic']);assert.equal(disabled.code,0,disabled.stderr);
  await h.reject(`/v1/tasks/${task.taskId}/operations`,{inputRevisionId:task.inputRevisionId,name:'defects.search',target:'bugzilla-synthetic',targetIdentity:'synthetic-connector:bugzilla-synthetic',args:{defectId:'LAB-42'},idempotencyKey:'disabled-connector-call'},'CONNECTOR_DISABLED');
  const enabled=await command(env,['connectors','enable','bugzilla-synthetic']);assert.equal(enabled.code,0,enabled.stderr);
  const observing=await h.request(`/v1/tasks/${task.taskId}/operations`,{inputRevisionId:task.inputRevisionId,name:'product.config.read',target:'LBX-LAB-01',targetIdentity:'synthetic-host-key:lbx-01',args:{holdAfterEffectMs:1000},idempotencyKey:'drain-existing-operation'});
  await until(async()=>(await h.request(`/v1/tasks/${task.taskId}/operations`)).some((item:any)=>item.operationId===observing.operationId&&item.status==='running'));
  const drain=await command(env,['workers','drain','lab-east-01']);assert.equal(drain.code,0,drain.stderr);assert.equal(JSON.parse(drain.stdout).draining,true);assert.equal(JSON.parse(drain.stdout).inFlight,0);
  assert.equal((await h.request(`/v1/tasks/${task.taskId}/operations`)).find((item:any)=>item.operationId===observing.operationId).status,'succeeded');
  assert.equal(await h.request('/v1/workers/claim',{},'lab-east-01'),null);
});

test('admin graceful restart actually changes the server process and keeps tasks cursor token and worker state',async t=>{
  const child=spawn('npm',['run','dev:stack'],{cwd:root,env:{...process.env,CIRCLE_SERVER_PORT:'0'},stdio:['ignore','pipe','pipe']});let output='',errors='',pid:number|undefined;
  child.stdout!.on('data',data=>{output+=data.toString();});child.stderr!.on('data',data=>{errors+=data.toString();});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');if(pid)process.kill(pid,'SIGTERM');else child.kill('SIGTERM');await exited;}});
  const ready=await until(async()=>{if(child.exitCode!==null)throw new Error(errors);for(const line of output.split('\n'))try{const data=JSON.parse(line);if(data.type==='dev-stack-ready')return data;}catch{}return false;},20_000);pid=ready.pid;
  const login=await fetch(`${ready.url}/v1/auth/dev-login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ready.login)}),token=(await login.json() as any).data.token,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const before=(await(await fetch(`${ready.url}/v1/status`,{headers})).json() as any).data;
  const admitted=(await(await fetch(`${ready.url}/v1/tasks/submit`,{method:'POST',headers,body:JSON.stringify({scopeId:ready.scopeId,title:'Wait across graceful restart',input:{requiredFields:['target']},idempotencyKey:'admin-restart-admission'})})).json() as any).data;
  await until(async()=>((await(await fetch(`${ready.url}/v1/tasks/${admitted.taskId}/status`,{headers})).json() as any).data.phase==='waiting-input'));
  const first=(await(await fetch(`${ready.url}/v1/tasks/${admitted.taskId}/events?after=0`,{headers})).json() as any).data;
  const restarted=await command({...process.env,CIRCLE_SERVER_URL:ready.url,CIRCLE_SERVER_TOKEN:token},['restart','--graceful']);assert.equal(restarted.code,0,restarted.stderr);
  const after=(await(await fetch(`${ready.url}/v1/status`,{headers})).json() as any).data;assert.notEqual(after.bootId,before.bootId);assert.notEqual(after.processId,before.processId);
  const task=(await(await fetch(`${ready.url}/v1/tasks/${admitted.taskId}/status`,{headers})).json() as any).data;assert.equal(task.phase,'waiting-input');assert.equal(task.inputRevisionId,admitted.inputRevisionId);
  const replay=(await(await fetch(`${ready.url}/v1/tasks/${admitted.taskId}/events?after=${first.after}`,{headers})).json() as any).data;assert.deepEqual(replay.events,[]);
  const workers=(await(await fetch(`${ready.url}/v1/admin/workers`,{headers})).json() as any).data;assert.ok(workers.some((worker:any)=>worker.workerId==='lab-east-01'));
});
