import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Agent,get,request as httpRequest,type IncomingHttpHeaders} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {setup,root,until} from './harness.ts';

async function command(env:NodeJS.ProcessEnv,args:string[]):Promise<any>{
  const child=spawn(process.execPath,['apps/server/src/cli.ts','admin',...args],{cwd:root,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout!.on('data',data=>{stdout+=data.toString();});child.stderr!.on('data',data=>{stderr+=data.toString();});const [code]=await once(child,'exit');return {code,stdout,stderr};
}

async function developmentStack(t:TestContext):Promise<any>{
  const child=spawn('npm',['run','dev:stack'],{cwd:root,env:{...process.env,CIRCLE_SERVER_PORT:'0'},stdio:['ignore','pipe','pipe']});let output='',errors='',pid:number|undefined;
  child.stdout!.on('data',data=>{output+=data.toString();});child.stderr!.on('data',data=>{errors+=data.toString();});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');if(pid)process.kill(pid,'SIGTERM');else child.kill('SIGTERM');await exited;}});
  const ready=await until(async()=>{if(child.exitCode!==null)throw new Error(errors);for(const line of output.split('\n'))try{const data=JSON.parse(line);if(data.type==='dev-stack-ready')return data;}catch{}return false;},20_000);pid=ready.pid;
  const login=await fetch(`${ready.url}/v1/auth/dev-login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ready.login)});
  const token=(await login.json() as any).data.token;
  return {...ready,token,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}};
}

function keepAliveGet(url:string,headers:Record<string,string>,agent:Agent){
  const sent=Promise.withResolvers<void>();
  let reusedSocket=false;
  const result=new Promise<{status:number;headers:IncomingHttpHeaders;data:any;reusedSocket:boolean}>((resolve,reject)=>{
    const request=get(url,{headers,agent},response=>{
      let body='';response.on('data',data=>{body+=data.toString();});response.once('error',reject);
      response.once('end',()=>{try{resolve({status:response.statusCode!,headers:response.headers,data:JSON.parse(body).data,reusedSocket});}catch(error){reject(error);}});
    });
    request.once('finish',()=>{reusedSocket=request.reusedSocket;sent.resolve();});
    request.once('error',error=>{sent.resolve();reject(error);});
  });
  return {sent:sent.promise,result};
}
test('admin tasks drain approvals tail audit and connector control use the same authenticated API',async t=>{
  const h=await setup(t);await h.startWorker();const task=await h.submit({target:'RESOURCE-LAB-01'});
  const env={...h.env,CIRCLE_SERVER_URL:h.url,CIRCLE_SERVER_TOKEN:await h.login('admin'),CIRCLE_SERVER_SCOPE:'scp_lab'};
  const tasks=await command(env,['tasks']);assert.equal(tasks.code,0,tasks.stderr);assert.ok(JSON.parse(tasks.stdout).some((item:any)=>item.taskId===task.taskId));
  const denied=await command({...env,CIRCLE_SERVER_TOKEN:await h.login('limited')},['tasks']);assert.notEqual(denied.code,0);assert.match(denied.stderr,/FORBIDDEN_ACTION/);
  const approval=await h.request(`/v1/tasks/${task.taskId}/approvals`,{inputRevisionId:task.inputRevisionId,name:'product.config.write',target:'RESOURCE-LAB-01',targetIdentity:'synthetic-host-key:resource-01',args:{key:'backend.timeout',value:10}});
  const approvals=await command(env,['approvals']);assert.equal(approvals.code,0,approvals.stderr);assert.ok(JSON.parse(approvals.stdout).some((item:any)=>item.approvalId===approval.approvalId));
  const events=await command(env,['events','--tail','--once']);assert.equal(events.code,0,events.stderr);assert.ok(JSON.parse(events.stdout).events.some((event:any)=>event.taskId===task.taskId));
  const audit=await command(env,['audit']);assert.equal(audit.code,0,audit.stderr);assert.ok(JSON.parse(audit.stdout).some((item:any)=>item.action==='tasks.submit'));
  const disabled=await command(env,['connectors','disable','record-feed-a']);assert.equal(disabled.code,0,disabled.stderr);
  await h.reject(`/v1/tasks/${task.taskId}/operations`,{inputRevisionId:task.inputRevisionId,name:'defects.search',target:'record-feed-a',targetIdentity:'synthetic-connector:record-feed-a',args:{defectId:'LAB-42'},idempotencyKey:'disabled-connector-call'},'CONNECTOR_DISABLED');
  const enabled=await command(env,['connectors','enable','record-feed-a']);assert.equal(enabled.code,0,enabled.stderr);
  const observing=await h.request(`/v1/tasks/${task.taskId}/operations`,{inputRevisionId:task.inputRevisionId,name:'product.config.read',target:'RESOURCE-LAB-01',targetIdentity:'synthetic-host-key:resource-01',args:{holdAfterEffectMs:1000},idempotencyKey:'drain-existing-operation'});
  await until(async()=>(await h.request(`/v1/tasks/${task.taskId}/operations`)).some((item:any)=>item.operationId===observing.operationId&&item.status==='running'));
  const drain=await command(env,['workers','drain','lab-east-01']);assert.equal(drain.code,0,drain.stderr);assert.equal(JSON.parse(drain.stdout).draining,true);assert.equal(JSON.parse(drain.stdout).inFlight,0);
  assert.equal((await h.request(`/v1/tasks/${task.taskId}/operations`)).find((item:any)=>item.operationId===observing.operationId).status,'succeeded');
  assert.equal(await h.request('/v1/workers/claim',{},'lab-east-01'),null);
});

test('admin graceful restart actually changes the server process and keeps tasks cursor token and worker state',async t=>{
  const ready=await developmentStack(t),{token,headers}=ready;
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

test('admin graceful restart drains sustained keep-alive polling and pending task and admin event long polls',async t=>{
  const ready=await developmentStack(t),{headers,token}=ready;
  const before=(await(await fetch(`${ready.url}/v1/status`,{headers})).json() as any).data;
  const admitted=(await(await fetch(`${ready.url}/v1/tasks/submit`,{method:'POST',headers,body:JSON.stringify({scopeId:ready.scopeId,title:'Keep event streams pending across restart',input:{requiredFields:['target']},idempotencyKey:'restart-long-polls'})})).json() as any).data;
  await until(async()=>((await(await fetch(`${ready.url}/v1/tasks/${admitted.taskId}/status`,{headers})).json() as any).data.phase==='waiting-input'));
  const taskCursor=(await(await fetch(`${ready.url}/v1/tasks/${admitted.taskId}/events`,{headers})).json() as any).data.after;
  const adminCursor=(await(await fetch(`${ready.url}/v1/admin/events`,{headers})).json() as any).data.after;
  const agents=Array.from({length:3},()=>new Agent({keepAlive:true,maxSockets:1}));
  let stopped=false,reused=0,successful=0;const seenBoots=new Set<string>(),failures:unknown[]=[];
  t.after(()=>{stopped=true;for(const agent of agents)agent.destroy();});
  async function poll(agent:Agent){
    while(!stopped){
      try{
        const response=await keepAliveGet(`${ready.url}/v1/status`,headers,agent).result;
        assert.equal(response.status,200);seenBoots.add(response.data.bootId);successful++;if(response.reusedSocket)reused++;
      }catch(error){if(!stopped&&!['ECONNREFUSED','ECONNRESET','EPIPE'].includes((error as NodeJS.ErrnoException).code??''))failures.push(error);}
      if(!stopped)await delay(10);
    }
  }
  const polling=poll(agents[0]);
  let taskReply:Awaited<ReturnType<typeof keepAliveGet>['result']>|undefined,adminReply:typeof taskReply;
  let taskFinishedAt=0,adminFinishedAt=0;
  const taskPoll=keepAliveGet(`${ready.url}/v1/tasks/${admitted.taskId}/events?after=${taskCursor}&waitMs=30000`,headers,agents[1]);
  const adminPoll=keepAliveGet(`${ready.url}/v1/admin/events?after=${adminCursor}&waitMs=30000`,headers,agents[2]);
  // Continue polling on each long poll's own socket as soon as its response ends.
  const taskPolling=taskPoll.result.then(response=>{taskReply=response;taskFinishedAt=Date.now();return poll(agents[1]);},error=>{failures.push(error);});
  const adminPolling=adminPoll.result.then(response=>{adminReply=response;adminFinishedAt=Date.now();return poll(agents[2]);},error=>{failures.push(error);});
  await Promise.all([taskPoll.sent,adminPoll.sent]);
  await until(async()=>successful>=10&&reused>=5);
  assert.deepEqual([taskReply,adminReply],[undefined,undefined],'Both event requests must still be pending when restart begins');
  const started=Date.now();
  const restarted=await command({...process.env,CIRCLE_SERVER_URL:ready.url,CIRCLE_SERVER_TOKEN:token},['restart','--graceful']);
  assert.equal(restarted.code,0,restarted.stderr);
  assert.ok(Date.now()-started<8000,'Keep-alive clients must not hold the old process open');
  assert.ok(taskReply);assert.ok(adminReply);
  for(const [reply,cursor,finishedAt] of [[taskReply,taskCursor,taskFinishedAt],[adminReply,adminCursor,adminFinishedAt]] as const){
    assert.equal(reply.status,200);assert.equal(reply.headers.connection,'close');
    assert.deepEqual(reply.data,{events:[],after:cursor});
    assert.ok(finishedAt-started<2000,'Shutdown must wake pending event requests before their 30 second deadlines');
  }
  const after=(await(await fetch(`${ready.url}/v1/status`,{headers})).json() as any).data;
  assert.notEqual(after.bootId,before.bootId);assert.notEqual(after.processId,before.processId);
  await until(async()=>seenBoots.has(after.bootId));
  assert.ok(seenBoots.has(before.bootId));assert.deepEqual(failures,[]);
  stopped=true;for(const agent of agents)agent.destroy();await Promise.all([polling,taskPolling,adminPolling]);
  const replay=(await(await fetch(`${ready.url}/v1/tasks/${admitted.taskId}/events?after=${taskCursor}`,{headers})).json() as any).data;
  assert.deepEqual(replay,{events:[],after:taskCursor});
});

test('admin graceful restart bounds a stalled request body and preserves only admitted tasks',async t=>{
  const ready=await developmentStack(t),{headers,token}=ready;
  const before=(await(await fetch(`${ready.url}/v1/status`,{headers})).json() as any).data;
  const admitted=(await(await fetch(`${ready.url}/v1/admin/tasks`,{headers})).json() as any).data;
  const stalled=httpRequest(`${ready.url}/v1/tasks/submit`,{method:'POST',agent:false,headers:{...headers,'content-length':'1024',expect:'100-continue',connection:'keep-alive'}});
  let closedAt=0;stalled.on('error',()=>{});stalled.once('close',()=>{closedAt=Date.now();});t.after(()=>stalled.destroy());
  const accepted=once(stalled,'continue');stalled.flushHeaders();await accepted;
  stalled.write('{"scopeId":"scp_lab",'); // Deliberately leave the body incomplete.
  const started=Date.now();
  const restarted=await command({...process.env,CIRCLE_SERVER_URL:ready.url,CIRCLE_SERVER_TOKEN:token},['restart','--graceful']);
  assert.equal(restarted.code,0,restarted.stderr);
  assert.ok(closedAt-started>=4500,'Allow the five second HTTP grace period before closing an active request');
  assert.ok(closedAt-started<8000,'Force-close a request that never completes its body');
  const after=(await(await fetch(`${ready.url}/v1/status`,{headers})).json() as any).data;
  assert.notEqual(after.bootId,before.bootId);assert.notEqual(after.processId,before.processId);
  assert.deepEqual((await(await fetch(`${ready.url}/v1/admin/tasks`,{headers})).json() as any).data,admitted);
});
