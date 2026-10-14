import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup,type Harness} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

const skill=Buffer.from('---\nname: diagnostic-fixture\ndescription: Synthetic declaration check.\n---\nUse the declared server tools.');
const manifest={id:'diagnostic-fixture',version:'1.0.0',title:'Synthetic diagnostics',owner:'synthetic-team',tools:['docs.search'],triggers:['manual'],inputs:{},outputs:['out.json'],model:'scripted'};
function submission(tools:string[],calls:string[],id=manifest.id){return {manifest:{...manifest,id,tools},files:[{path:'SKILL.md',base64:skill.toString('base64'),sha256:sha256(skill)}],trial:{toolCalls:calls.map(name=>({name,argsSha256:sha256('{}'),ok:true})),outputs:[]}};}
async function post(h:Harness,value:any){const response=await fetch(`${h.url}/v1/skillpacks`,{method:'POST',headers:{authorization:`Bearer ${await h.login()}`,'content-type':'application/json','x-scope-id':'scp_lab'},body:JSON.stringify(value)});return {status:response.status,body:await response.json() as any};}
async function prepare(t:Parameters<typeof setup>[0]){
  const source=await readonlySources(t),h=await setup(t);
  const grants=['assets.read','assets.register','assets.change','credentials.use','knowledge.read','knowledge.submit','skillpacks.read','skillpacks.submit','skillpacks.run'];
  await h.db.query('UPDATE policies SET grants=grants || $1::jsonb WHERE principal_id=ANY($2::text[])',[JSON.stringify(grants),['prn_alice','prn_bob']]);
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.approve\"]'::jsonb WHERE principal_id='prn_bob'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{fixture:{origin:source.origin,root:'/dav/'}}}));h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;await h.stop();await h.startServer();
  const asset=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic diagnostic documents',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'documents',runtimeProfileRef:'fixture'},readers:['prn_alice','prn_bob']});
  await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});
  return {h,asset,source};
}
function mismatch(error:any,missingTools:string[],undeclaredTools:string[]=[]){
  assert.equal(error.code,'SKILLPACK_CHECK_FAILED');assert.deepEqual(error.details.check,{missingTools,undeclaredTools});
  if(missingTools.length){assert.match(error.message,/unavailable in caller catalog/i);assert.ok(error.message.includes(missingTools[0]));}
  if(undeclaredTools.length){assert.match(error.message,/undeclared trial tools/i);assert.ok(error.message.includes(undeclaredTools[0]));}
}
async function approval(h:Harness,pack:any){const record=(await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals`))[0];return {path:`/v1/tasks/${pack.approvalTaskId}/approvals/${record.approvalId}`,body:{inputRevisionId:record.inputRevisionId,targetIdentity:record.targetIdentity,actionDigest:record.actionDigest,approve:true}};}

test('Skill diagnostics: submit names undeclared trial calls and unavailable declarations while retaining complete safe lists',async t=>{
  const {h,source}=await prepare(t);assert.ok((await h.request('/v1/tools')).some((tool:any)=>tool.name==='docs.list'));
  const response=await post(h,submission(['docs.list','docs.search','zentao.products','future.read'],['docs.list','docs.get','oldsvc.read']));assert.equal(response.status,422);
  const error=response.body.error;mismatch(error,['future.read','zentao.products'],['docs.get','oldsvc.read']);
  assert.ok(error.message.includes('zentao.products'));assert.ok(error.message.includes('oldsvc.read'));assert.ok(!JSON.stringify(error).includes(source.origin));
  assert.equal((await h.db.query('SELECT 1 FROM skill_packages')).rowCount,0);
});

test('Skill diagnostics: a bounded message keeps whole tool names while details preserve every mismatch',async t=>{
  const {h}=await prepare(t),missing=Array.from({length:100},(_,i)=>`missing_${String(i).padStart(3,'0')}.${'m'.repeat(130)}`),undeclared=Array.from({length:120},(_,i)=>`trial_${String(i).padStart(3,'0')}.${'t'.repeat(130)}`);
  const response=await post(h,submission(missing,undeclared));assert.equal(response.status,422);const error=response.body.error;mismatch(error,missing,undeclared);
  assert.ok(error.message.length<=1000);assert.match(error.message,/more/);assert.match(error.message,/details\.check/);assert.ok(error.details.check.missingTools.includes(missing.at(-1)));assert.ok(error.details.check.undeclaredTools.includes(undeclared.at(-1)));
});

test('Skill diagnostics: approval and run rechecks report the same catalog mismatch after a connector is disabled',async t=>{
  const {h,asset}=await prepare(t),candidate=await post(h,submission(['docs.search'],['docs.search'],'diagnostic-approval')),registered=await post(h,submission(['docs.search'],['docs.search'],'diagnostic-run'));
  assert.equal(candidate.status,201);assert.equal(registered.status,201);const accepted=await approval(h,registered.body.data);await h.request(accepted.path,accepted.body,'bob');
  await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'disabled'});
  const pending=await approval(h,candidate.body.data),approvalError=await h.reject(pending.path,pending.body,'DEPENDENCY_NOT_APPROVED','bob');assert.deepEqual(approvalError.details.check,{undeclaredTools:[],missingTools:['docs.search']});assert.equal((await h.request(`/v1/change-sets/${candidate.body.data.changeSetId}`)).status,'blocked');
  const runError=await h.reject(`/v1/skillpacks/${registered.body.data.skillPackId}/runs`,{inputs:{},idempotencyKey:'diagnostic-tool-disabled'},'SKILLPACK_CHECK_FAILED');mismatch(runError,['docs.search']);
  assert.equal((await h.db.query("SELECT 1 FROM tasks WHERE capability_pack_id='skill-run'")).rowCount,0);
});

test('Skill diagnostics: a post-admission catalog denial retains complete lists in the failed task result',async t=>{
  const {h,asset,source}=await prepare(t);
  await writeFile(`${h.scratch}/unstarted-runtime.json`,JSON.stringify({circleBin:'unstarted-circle.ts',circleCommit:'0'.repeat(40),circleVersion:'1.1.1',model:{kind:'scripted',base_url:source.origin,model:'synthetic-unstarted',protocol:'openai',api_key:'synthetic-only-key'}}));
  h.env.CIRCLE_RUNTIME_CONFIG=`${h.scratch}/unstarted-runtime.json`;await h.stop();await h.startServer();
  const submitted=await post(h,submission(['docs.search'],['docs.search'],'diagnostic-claim'));assert.equal(submitted.status,201);const record=await approval(h,submitted.body.data);await h.request(record.path,record.body,'bob');
  const accepted=await h.request(`/v1/skillpacks/${submitted.body.data.skillPackId}/runs`,{inputs:{},idempotencyKey:'diagnostic-post-admission'});
  await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'disabled'});await h.request('/v1/workers/register',{},'lab-east-01');
  mismatch(await h.reject('/v1/workers/claim',{},'SKILLPACK_CHECK_FAILED','lab-east-01'),['docs.search']);await h.phase(accepted.taskId,'failed');
  mismatch((await h.request(`/v1/tasks/${accepted.taskId}/result`)).error,['docs.search']);
});
