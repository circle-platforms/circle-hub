import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {setup,until,type Harness} from './harness.ts';
import {scriptModel} from '../fixtures/script-model.ts';
import {sha256} from '../../packages/contracts/src/index.ts';

async function prepare(t:any,real=false){
  const h=await setup(t),model=await scriptModel(t);model.state.hold=true;
  const runtime={circleBin:real?process.env.CIRCLE_BIN!:'synthetic-not-run',circleCommit:real?process.env.CIRCLE_COMMIT!:'a'.repeat(40),circleVersion:'1.1.1',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}};
  await writeFile(`${h.scratch}/runtime.json`,JSON.stringify(runtime));h.env.CIRCLE_RUNTIME_CONFIG=`${h.scratch}/runtime.json`;await h.stop();await h.startServer();
  const bytes=Buffer.from('---\nname: revision-fixture\ndescription: Synthetic revision binding\n---\nWait for the scripted model.'),response=await h.raw('/v1/skillpacks',{token:await h.login(),headers:{'x-scope-id':'scp_lab'},body:{manifest:{id:'revision-fixture',version:'1.0.0',title:'Revision binding',owner:'fixture',tools:[],triggers:['manual'],inputs:{},outputs:['out.txt'],model:'scripted'},files:[{path:'SKILL.md',base64:bytes.toString('base64'),sha256:sha256(bytes)}],trial:{toolCalls:[],outputs:[{path:'out.txt',sha256:sha256('fixture')}]}}});assert.equal(response.status,201,JSON.stringify(response.body));
  const pack=response.body.data;await h.request(`/v1/assets/${pack.assetId}/lifecycle`,{version:pack.assetVersion,sha256:(await h.request(`/v1/assets/${pack.assetId}`)).sha256,state:'approved'},'bob');
  const profile=(await h.db.query("SELECT a.*,v.* FROM assets a JOIN asset_versions v ON v.asset_id=a.asset_id AND v.version=a.current_version WHERE a.kind='runtime-profile' AND v.configuration->>'profileType'='runtime'")).rows[0];
  const run=(key:string)=>h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{},idempotencyKey:key});
  const draft=(version:string,configuration=profile.configuration)=>h.request('/v1/assets',{assetId:profile.asset_id,scopeId:'scp_lab',kind:'runtime-profile',name:profile.name,version,declaration:profile.declaration,configuration,readers:['*']},'admin');
  return {h,model,profile,run,draft};
}
async function claim(h:Harness){await h.request('/v1/workers/register',{},'lab-east-01');const operation=await h.request('/v1/workers/claim',{},'lab-east-01');return {operation,check:()=>h.request(`/v1/workers/operations/${operation.operationId}/preflight`,{fencingToken:operation.fencingToken},'lab-east-01')};}

test('Runtime revisions: draft registration leaves accepted and new runs on the latest approved revision and later approval binds only new runs',async t=>{
  const {h,profile,run,draft}=await prepare(t),first=await run('before-draft'),leased=await claim(h);await leased.check();
  const next=await draft('2.0.0');assert.equal((await leased.check()).authorization.runtimeProfile.version,profile.version);
  const during=await run('during-draft');assert.equal((await h.status(during.taskId)).input.runtimeProfile.version,profile.version);
  await h.request(`/v1/assets/${next.assetId}/lifecycle`,{version:next.version,sha256:next.sha256,state:'approved'},'bob');
  assert.equal((await leased.check()).authorization.runtimeProfile.version,profile.version);
  const after=await run('after-approval');assert.equal((await h.status(after.taskId)).input.runtimeProfile.version,'2.0.0');assert.equal((await h.status(first.taskId)).input.runtimeProfile.sha256,profile.sha256);
  const mismatch=await draft('3.0.0',{...profile.configuration,profileSha256:'0'.repeat(64)});await h.reject(`/v1/assets/${mismatch.assetId}/lifecycle`,{version:mismatch.version,sha256:mismatch.sha256,state:'approved'},'DEPENDENCY_NOT_APPROVED','bob');assert.equal((await h.status((await run('blocked-draft')).taskId)).input.runtimeProfile.version,'2.0.0');
  await h.reject(`/v1/assets/${profile.asset_id}/lifecycle`,{version:profile.version,sha256:profile.sha256,state:'disabled'},'FORBIDDEN_ACTION','alice');
  await h.request(`/v1/assets/${profile.asset_id}/lifecycle`,{version:profile.version,sha256:profile.sha256,state:'disabled'},'admin');await h.reject(`/v1/workers/operations/${leased.operation.operationId}/preflight`,{fencingToken:leased.operation.fencingToken},'SOURCE_NOT_APPROVED','lab-east-01');
});

test('Runtime revisions: dispatched pinned Circle continues across draft and approval then is stopped when its own bound revision is disabled',{skip:(!process.env.CIRCLE_BIN||!process.env.CIRCLE_COMMIT)&&'Set CIRCLE_BIN and CIRCLE_COMMIT for the pinned Circle revision test'},async t=>{
  const {h,model,profile,run,draft}=await prepare(t,true);await h.startWorker();const first=await run('live-first');await until(async()=>model.requests.length>0,15_000);
  const op=(await h.db.query("SELECT * FROM operations WHERE task_id=$1 AND name='assets.execute'",[first.taskId])).rows[0],workerToken=await h.login('lab-east-01');
  const check=()=>h.raw(`/v1/workers/operations/${op.operation_id}/preflight`,{token:workerToken,body:{fencingToken:Number(op.fencing_token)}});
  const next=await draft('2.0.0');await new Promise(resolve=>setTimeout(resolve,1100));assert.equal((await check()).status,200);assert.equal((await h.status(first.taskId)).phase,'running');
  await h.request(`/v1/assets/${next.assetId}/lifecycle`,{version:next.version,sha256:next.sha256,state:'approved'},'bob');await new Promise(resolve=>setTimeout(resolve,1100));assert.equal((await check()).status,200);assert.equal((await h.db.query('SELECT status FROM operations WHERE operation_id=$1',[op.operation_id])).rows[0].status,'running');
  const second=await run('live-second');assert.equal((await h.status(second.taskId)).input.runtimeProfile.version,'2.0.0');
  await h.request(`/v1/assets/${profile.asset_id}/lifecycle`,{version:profile.version,sha256:profile.sha256,state:'disabled'},'admin');await h.phase(first.taskId,'unknown',15_000);
  const stopped=(await h.db.query('SELECT result FROM operations WHERE operation_id=$1',[op.operation_id])).rows[0].result;assert.equal(stopped.localExitObserved,true);assert.equal(stopped.remoteStoppingVerified,false);assert.equal((await check()).status,409);
});

test('Runtime revisions: a newly approved revision is frozen by a new pinned Circle execution and the approved endpoint delivers its result',{skip:(!process.env.CIRCLE_BIN||!process.env.CIRCLE_COMMIT)&&'Set CIRCLE_BIN and CIRCLE_COMMIT for the pinned Circle revision test'},async t=>{
 const {h,model,profile,run,draft}=await prepare(t,true);model.state.hold=false;model.state.sequence=[{name:'write_file',args:{file_path:'out.txt',content:'Synthetic revision two'}}];const next=await draft('2.0.0');await h.request(`/v1/assets/${next.assetId}/lifecycle`,{version:next.version,sha256:next.sha256,state:'approved'},'bob');await h.startWorker();const accepted=await run('new-approved-execution');await h.phase(accepted.taskId,'delivered',15_000);const status=await h.status(accepted.taskId),result=await h.request(`/v1/tasks/${accepted.taskId}/result`);assert.equal(status.input.runtimeProfile.version,'2.0.0');assert.deepEqual(result.runtime.runtimeProfile,status.input.runtimeProfile);assert.equal(result.runtime.runtimeProfile.sha256,next.sha256);assert.equal(result.runtime.runtimeProfile.profileSha256,profile.configuration.profileSha256);assert.equal(result.artifacts[0].sha256,sha256('Synthetic revision two'));assert.ok(model.requests.length>0);assert.ok((await h.request(`/v1/tasks/${accepted.taskId}/events?after=0`)).events.some((event:any)=>event.kind==='runtime.model.proxy'&&event.payload.event.runtimeProfile.version==='2.0.0'));
});
