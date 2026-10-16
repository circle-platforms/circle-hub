import {sandboxTest} from './harness.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFile,readFile,readdir} from 'node:fs/promises';
import {canonicalHash,sha256} from '../../packages/contracts/src/index.ts';
import {setup,type Harness,until} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';
import {scriptModel} from '../fixtures/script-model.ts';
import {privateRequest} from '../../packages/runtime/src/private-ipc.ts';

const circleCommit=process.env.CIRCLE_COMMIT??'';
const circleBin=process.env.CIRCLE_BIN??'';
const runtimeTest={skip:(!circleBin||!circleCommit)&&'Set CIRCLE_BIN and CIRCLE_COMMIT to verify a real pinned Circle build'};
const manifest={id:'rpc-fixture',version:'1.0.0',title:'Synthetic RPC fixture',owner:'synthetic-team',tools:['docs.search'],triggers:['manual'],inputs:{},outputs:['result.json'],model:'scripted'};
const bytes=Buffer.from('---\nname: rpc-fixture\ndescription: Run the synthetic RPC acceptance.\n---\nSYNTHETIC_SKILL_LOADED\nUse docs.search and write result.json in this workspace.');
const submission={manifest,files:[{path:'SKILL.md',base64:bytes.toString('base64'),sha256:sha256(bytes)}],trial:{toolCalls:[{name:'docs.search',argsSha256:canonicalHash({query:'service'}),ok:true}],outputs:[{path:'result.json',sha256:sha256('{"synthetic":true}')}]}};
async function post(h:Harness,path:string,body:any,username='alice',scope:string|null='scp_lab'){
  const response=await fetch(`${h.url}${path}`,{method:'POST',headers:{authorization:`Bearer ${await h.login(username)}`,'content-type':'application/json',...(scope?{'x-scope-id':scope}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as any};
}
async function prepare(h:Harness,origin:string,runtime?:any){
  const grants=['assets.read','assets.register','assets.change','credentials.use','knowledge.read','knowledge.submit','skillpacks.read','skillpacks.submit','skillpacks.run'];
  await h.db.query('UPDATE policies SET grants=grants || $1::jsonb WHERE principal_id=ANY($2::text[])',[JSON.stringify(grants),['prn_alice','prn_bob']]);
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.approve\"]'::jsonb WHERE principal_id='prn_bob'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{fixture:{origin,root:'/dav/'}}}),{mode:0o600});h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;
  if(runtime){await writeFile(`${h.scratch}/runtime.json`,JSON.stringify(runtime),{mode:0o600});h.env.CIRCLE_RUNTIME_CONFIG=`${h.scratch}/runtime.json`;}
  await h.stop();await h.startServer();
  const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic documents',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'documents',runtimeProfileRef:'fixture'},readers:['prn_alice','prn_bob']});
  await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});return asset;
}
async function submit(h:Harness,body=submission){const response=await post(h,'/v1/skillpacks',body);assert.equal(response.status,201,JSON.stringify(response.body));return response.body.data;}
async function approve(h:Harness,pack:any){
  const list=await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals`);assert.equal(list.length,1);const approval=list[0];
  const result=await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'bob');assert.equal(result.status,'approved');
  return approval;
}

test('Act R2.5: sealed skill submissions enforce scope hashes safe files and trial tool declarations',async t=>{
  const stub=await readonlySources(t),h=await setup(t);await prepare(h,stub.origin);
  assert.equal((await post(h,'/v1/skillpacks',submission,'alice',null)).body.error.code,'INVALID_PAYLOAD');
  assert.equal((await post(h,'/v1/skillpacks',submission,'alice','scp_hidden')).body.error.code,'FORBIDDEN_SCOPE');
  const undeclared=await post(h,'/v1/skillpacks',{...submission,trial:{...submission.trial,toolCalls:[...submission.trial.toolCalls,{name:'admin.secret',argsSha256:sha256('{}'),ok:true}]}});
  assert.equal(undeclared.body.error.code,'SKILLPACK_CHECK_FAILED');assert.deepEqual(undeclared.body.error.details.check.undeclaredTools,['admin.secret']);
  const absent=await post(h,'/v1/skillpacks',{...submission,manifest:{...manifest,id:'missing-fixture',tools:['hidden.read']},trial:{...submission.trial,toolCalls:[]}});assert.equal(absent.status,422);assert.equal(absent.body.error.code,'SKILLPACK_CHECK_FAILED');assert.deepEqual(absent.body.error.details.check.missingTools,['hidden.read']);
  const corrupt=await post(h,'/v1/skillpacks',{...submission,files:[{...submission.files[0],sha256:'0'.repeat(64)}]});assert.equal(corrupt.body.error.code,'SOURCE_HASH_MISMATCH');
  const escaped=await post(h,'/v1/skillpacks',{...submission,files:[{...submission.files[0],path:'../SKILL.md'}]});assert.equal(escaped.body.error.code,'INVALID_PAYLOAD');
  const pack=await submit(h),same=await submit(h);assert.equal(pack.skillPackId,same.skillPackId);assert.equal(pack.digest,same.digest);assert.equal(pack.approvalTaskId,same.approvalTaskId);assert.equal(pack.status,'candidate');
  assert.deepEqual(pack.check,{undeclaredTools:[],missingTools:[]});assert.equal((await h.request('/v1/skillpacks')).length,1);
});

test('Act R2.5: existing approvals bind the package digest prohibit self approval and recheck tools',async t=>{
  const stub=await readonlySources(t),h=await setup(t);const asset=await prepare(h,stub.origin),pack=await submit(h);
  const approval=(await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals`))[0],answer={inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true};
  await h.reject(`/v1/tasks/${pack.approvalTaskId}/approvals/${approval.approvalId}`,answer,'SELF_APPROVAL');
  await h.reject(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:'before-approval'},'APPROVAL_REQUIRED');
  await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'disabled'});
  const error=await h.reject(`/v1/tasks/${pack.approvalTaskId}/approvals/${approval.approvalId}`,answer,'DEPENDENCY_NOT_APPROVED','bob');assert.deepEqual(error.details.check.missingTools,['docs.search']);
  assert.equal((await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals`))[0].status,'open');
});

sandboxTest('Act R2.5: real pinned Circle RPC loads the skill discovers scoped tools and delivers SHA checked artifacts',runtimeTest,async t=>{
  const stub=await readonlySources(t),model=await scriptModel(t),h=await setup(t);
  await prepare(h,stub.origin,{circleBin,circleCommit,circleVersion:'1.7.0',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}});
  const pack=await submit(h);await approve(h,pack);await h.startWorker();
  const inputs={text:'Synthetic source'},accepted=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs,idempotencyKey:'rpc-run-key'}),same=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs,idempotencyKey:'rpc-run-key'});assert.equal(same.taskId,accepted.taskId);
  const result=await until(async()=>{const result=await h.request(`/v1/tasks/${accepted.taskId}/result`);return ['delivered','failed','unknown'].includes(result.phase)?result:false;},15_000).catch(async error=>{t.diagnostic(JSON.stringify({phase:(await h.status(accepted.taskId)).phase,modelRequests:model.requests.length,operations:(await h.db.query('SELECT name,status FROM operations')).rows,events:(await h.request(`/v1/tasks/${accepted.taskId}/events?after=0`)).events.map((e:any)=>({kind:e.kind,event:e.payload.event?.type,tool:e.payload.event?.name,status:e.payload.event?.status,message:e.payload.event?.message}))}));throw error;});assert.equal(result.status,'succeeded',JSON.stringify(result));assert.equal(result.artifacts.length,1);
  assert.equal(result.runtime.circleCommit,circleCommit);assert.equal(result.runtime.circleVersion,'1.7.0');assert.equal(result.runtime.agentSettled,true);
  const download=await fetch(`${h.url}${result.artifacts[0].downloadPath}`,{headers:{authorization:`Bearer ${await h.login()}`}});const artifact=Buffer.from(await download.arrayBuffer());assert.equal(sha256(artifact),result.artifacts[0].sha256);assert.deepEqual(JSON.parse(artifact.toString()),{synthetic:true,source:'scripted-rpc'});
  const hiddenArtifact=await fetch(`${h.url}${result.artifacts[0].downloadPath}`,{headers:{authorization:`Bearer ${await h.login('bob')}`}});assert.equal(hiddenArtifact.status,403);
  const events=await h.request(`/v1/tasks/${accepted.taskId}/events?after=0`);assert.ok(events.events.some((event:any)=>event.kind==='runtime.agent_settled'));const loaded=events.events.find((event:any)=>event.kind==='runtime.tool_result'&&event.payload.event.name==='skill');assert.ok(loaded);assert.equal(loaded.payload.event.output,undefined);const original=await fetch(h.url+loaded.content.downloadPath,{headers:{authorization:'Bearer '+await h.login()}}),originalBytes=Buffer.from(await original.arrayBuffer());assert.equal(sha256(originalBytes),loaded.content.sha256);assert.ok(JSON.stringify(JSON.parse(originalBytes.toString()).event.output).includes('SYNTHETIC_SKILL_LOADED'));
  assert.ok(model.requests[0].tools.some((tool:any)=>tool.function.name==='hub_tool_docs_search'));assert.ok(!model.requests[0].tools.some((tool:any)=>tool.function.name==='hub_tool_docs_get'));
  await h.reject(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{changed:true},idempotencyKey:'rpc-run-key'},'IDEMPOTENCY_MISMATCH');
  await h.reject(`/v1/tasks/${accepted.taskId}/result`,undefined,'FORBIDDEN_SCOPE','bob');
});

test('Act R2.5: a mismatched Circle Git commit fails before any model request',runtimeTest,async t=>{
  const stub=await readonlySources(t),model=await scriptModel(t),h=await setup(t);await prepare(h,stub.origin,{circleBin,circleCommit:'0'.repeat(40),circleVersion:'1.7.0',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}});
  const pack=await submit(h);await approve(h,pack);await h.startWorker();const run=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:'bad-runtime-commit'});await h.phase(run.taskId,'failed');
  assert.equal((await h.request(`/v1/tasks/${run.taskId}/result`)).error.code,'RUNTIME_VERSION_MISMATCH');assert.equal(model.requests.length,0);
});

sandboxTest('Act R2.5: run delegation stays off disk and cancellation observes local exit while freezing an unknown remote outcome',runtimeTest,async t=>{
  const stub=await readonlySources(t),model=await scriptModel(t),h=await setup(t);model.state.hold=true;
  await prepare(h,stub.origin,{circleBin,circleCommit,circleVersion:'1.7.0',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}});
  const pack=await submit(h);await approve(h,pack);await h.startWorker();const run=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:'cancel-runtime'});
  await until(async()=>model.requests.length>0);const operation=(await h.db.query("SELECT * FROM operations WHERE task_id=$1 AND name='assets.execute'",[run.taskId])).rows[0],workerToken=await h.login('lab-east-01');
  const checked=await h.raw(`/v1/workers/operations/${operation.operation_id}/preflight`,{token:workerToken,body:{fencingToken:Number(operation.fencing_token)}});assert.equal(checked.status,200);
  const secret=await privateRequest(checked.body.data.authorization.privateSocketPath,{authorization:`Bearer ${workerToken}`,operationId:operation.operation_id,fencingToken:Number(operation.fencing_token)});
  assert.ok(!JSON.stringify(checked.body).includes(secret.serverToken));
  const directory=await h.raw('/v1/tools',{token:secret.serverToken});assert.deepEqual(directory.body.data.map((tool:any)=>tool.name),['docs.search']);
  const forbidden=await h.raw('/v1/assets',{token:secret.serverToken});assert.equal(forbidden.body.error.code,'FORBIDDEN_ACTION');
  async function files(path:string):Promise<Buffer[]>{const parts:Buffer[]=[];for(const entry of await readdir(path,{withFileTypes:true})){const name=`${path}/${entry.name}`;if(entry.isDirectory())parts.push(...await files(name));else if(entry.isFile())parts.push(await readFile(name));}return parts;}
  const written=await files(`${h.scratch}/objects/runs/${operation.operation_id}`);assert.ok(written.length>0);assert.ok(written.every(bytes=>!bytes.includes(Buffer.from(secret.serverToken))));
  await h.request(`/v1/tasks/${run.taskId}/cancel`,{});await h.phase(run.taskId,'unknown');
  const observed=(await h.db.query('SELECT status,result FROM operations WHERE operation_id=$1',[operation.operation_id])).rows[0];assert.equal(observed.status,'unknown');assert.equal(observed.result.localExitObserved,true);assert.equal(observed.result.remoteStoppingVerified,false);
  assert.equal((await h.raw('/v1/tools',{token:secret.serverToken})).status,401);
  await h.reject(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:'after-local-cancel'},'RESOURCE_BUSY');
});

sandboxTest('Run sessions: slow pinned RPC keeps its short token alive through fenced preflight and never upgrades it to a login session',runtimeTest,async t=>{
  const stub=await readonlySources(t),model=await scriptModel(t),h=await setup(t,{CIRCLE_HUB_RUN_TOKEN_TTL_MS:'1000'});model.state.delayMs=1600;
  await prepare(h,stub.origin,{circleBin,circleCommit,circleVersion:'1.7.0',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}});
  const pack=await submit(h);await approve(h,pack);await h.startWorker();const run=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:'slow-renewing-runtime'});await until(async()=>model.requests.length>0);
  const operation=(await h.db.query("SELECT * FROM operations WHERE task_id=$1 AND name='assets.execute'",[run.taskId])).rows[0],workerToken=await h.login('lab-east-01'),checked=await h.raw(`/v1/workers/operations/${operation.operation_id}/preflight`,{token:workerToken,body:{fencingToken:Number(operation.fencing_token)}}),secret=await privateRequest(checked.body.data.authorization.privateSocketPath,{authorization:`Bearer ${workerToken}`,operationId:operation.operation_id,fencingToken:Number(operation.fencing_token)});
  const upgrade=await h.raw('/v1/auth/refresh',{token:secret.serverToken,body:{}});assert.equal(upgrade.status,403);assert.equal(upgrade.body.error.code,'FORBIDDEN_ACTION');
  await new Promise(resolve=>setTimeout(resolve,1300));assert.equal((await h.raw('/v1/tools',{token:secret.serverToken})).status,200,'The token survives past its initial one-second expiry while its fenced worker remains live');
  const row=(await h.db.query('SELECT expires_at,constraints FROM auth_tokens WHERE digest=$1',[sha256(secret.serverToken)])).rows[0];assert.equal(row.constraints.operationId,operation.operation_id);assert.equal(row.constraints.fencingToken,Number(operation.fencing_token));assert.ok(row.expires_at<=operation.deadline_at);
  const result=await until(async()=>{const result=await h.request(`/v1/tasks/${run.taskId}/result`);assert.notEqual(result.phase,'failed',JSON.stringify(result));return result.phase==='delivered'?result:false;},15_000);assert.equal(result.status,'succeeded');assert.equal((await h.raw('/v1/tools',{token:secret.serverToken})).status,401);
});

test('Hub RPC operations require an advertised worker capability at claim and again at preflight',async t=>{
  const stub=await readonlySources(t),model=await scriptModel(t),h=await setup(t);await prepare(h,stub.origin,{circleBin:'synthetic-not-run',circleCommit:'a'.repeat(40),circleVersion:'1.7.0',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}});
  const pack=await submit(h);await approve(h,pack);
  const run=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:'hub-capability'});
  await h.request('/v1/workers/register',{capabilities:['flow.invoke']},'lab-east-01');
  assert.equal(await h.request('/v1/workers/claim',{},'lab-east-01'),null);
  await h.request('/v1/workers/register',{capabilities:['assets.execute']},'lab-east-01');
  const work=await h.request('/v1/workers/claim',{},'lab-east-01');assert.equal(work.taskId,run.taskId);
  assert.equal((await h.db.query('SELECT required_worker_capability FROM operations WHERE operation_id=$1',[work.operationId])).rows[0].required_worker_capability,'assets.execute');
  await h.request('/v1/workers/register',{capabilities:[]},'lab-east-01');
  await h.reject(`/v1/workers/operations/${work.operationId}/preflight`,{fencingToken:work.fencingToken},'FORBIDDEN_ACTION','lab-east-01');
  await h.request('/v1/workers/register',{capabilities:['assets.execute']},'lab-east-01');
  const checked=await h.request(`/v1/workers/operations/${work.operationId}/preflight`,{fencingToken:work.fencingToken},'lab-east-01');assert.equal(checked.authorization.skillPackId,pack.skillPackId);assert.equal(model.requests.length,0);
});
