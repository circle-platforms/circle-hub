import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile,writeFile} from 'node:fs/promises';
import {sha256,canonicalHash} from '../../packages/contracts/src/index.ts';
import {setup,until} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';
import {scriptModel} from '../fixtures/script-model.ts';

test('Act R2.7: installed packages keep the compilation API and retire the old product health capability',async t=>{
  const h=await setup(t),packs=await h.request('/v1/packs');
  assert.ok(packs.some((pack:any)=>pack.capabilityPackId==='mindmap-compile'&&pack.version==='1.0.0'));
  assert.ok(!packs.some((pack:any)=>pack.capabilityPackId==='lbx-healthcheck'));
  assert.ok(packs.some((pack:any)=>pack.capabilityPackId==='synthetic-resource-check'));
  await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',title:'Retired capability',capabilityPackId:'lbx-healthcheck',idempotencyKey:'retired-pack-input',input:{}},'UNSUPPORTED_VERSION');
});

test('Act R2.7: a second fictional product line runs through the same scoped tools approvals RPC and artifact storage',{
  skip:(!process.env.CIRCLE_BIN||!process.env.CIRCLE_COMMIT)&&'Set CIRCLE_BIN and CIRCLE_COMMIT to verify the second product line with real Circle',
},async t=>{
  const stub=await readonlySources(t),model=await scriptModel(t),h=await setup(t);stub.state.manualText='# Meridian synthetic source\nMeridian amber is a literal source label.\n';
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"knowledge.read\",\"knowledge.submit\",\"skillpacks.read\",\"skillpacks.submit\",\"skillpacks.run\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\"]'::jsonb WHERE principal_id='prn_admin'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{meridian:{origin:stub.origin,root:'/dav/'}}}),{mode:0o600});h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;
  await writeFile(`${h.scratch}/runtime.json`,JSON.stringify({circleBin:process.env.CIRCLE_BIN,circleCommit:process.env.CIRCLE_COMMIT,circleVersion:'1.1.1',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}}),{mode:0o600});h.env.CIRCLE_RUNTIME_CONFIG=`${h.scratch}/runtime.json`;await h.stop();await h.startServer();
  await h.approveRuntimeProfiles('scp_second','admin','alice');
  const configuration=JSON.parse(await readFile(new URL('../../packs/meridian/product-line.json',import.meta.url),'utf8')),binding=configuration.connectorPackages[0];
  const asset=await h.request('/v1/assets',{scopeId:'scp_second',kind:'connector-instance',name:'Meridian document source',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:binding.packageId,productLineId:configuration.id,runtimeProfileRef:'meridian'},readers:['prn_alice','prn_admin']});
  await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'admin');await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});
  const folder=new URL('../../packs/meridian/skills/meridian-source-review/',import.meta.url),manifest=JSON.parse(await readFile(new URL('skillpack.json',folder),'utf8')),files=[];
  for(const path of ['SKILL.md','scripts/report.ts']){const bytes=await readFile(new URL(path,folder));files.push({path,base64:bytes.toString('base64'),sha256:sha256(bytes)});}
  const response=await fetch(`${h.url}/v1/skillpacks`,{method:'POST',headers:{authorization:`Bearer ${await h.login()}`,'content-type':'application/json','x-scope-id':'scp_second'},body:JSON.stringify({manifest,files,trial:{toolCalls:[{name:'meridian_docs.get',argsSha256:canonicalHash({file:'/dav/manual.txt'}),ok:true}],outputs:[{path:'out/findings.json',sha256:sha256('{}')}]}})});assert.equal(response.status,201,JSON.stringify(await response.clone().json()));const pack=(await response.json() as any).data;
  const approval=(await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals`))[0];await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'admin');
  const source=Buffer.from(stub.state.manualText),query='Meridian amber';model.state.sequence=[{name:'skill',args:{name:manifest.id}},{name:'srv_meridian_docs_get',args:{file:'/dav/manual.txt'}},{name:'write_file',args:{file_path:'source.json',content:JSON.stringify({base64:source.toString('base64'),sha256:sha256(source),query})}},{name:'execute',args:{command:'node .circle/skills/meridian-source-review/scripts/report.ts source.json out/findings.json'}}];
  await h.startWorker();const run=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{file:'/dav/manual.txt',query},idempotencyKey:'meridian-run'});const state=await until(async()=>{const task=await h.status(run.taskId);assert.notEqual(task.phase,'failed',JSON.stringify(await h.request(`/v1/tasks/${run.taskId}/result`)));return task.phase==='delivered'?task:false;},15_000);assert.equal(state.scopeId,'scp_second');
  const result=await h.request(`/v1/tasks/${run.taskId}/result`);assert.equal(result.artifacts.length,1);const downloaded=await fetch(`${h.url}${result.artifacts[0].downloadPath}`,{headers:{authorization:`Bearer ${await h.login()}`}}),bytes=Buffer.from(await downloaded.arrayBuffer()),report=JSON.parse(bytes.toString());assert.equal(sha256(bytes),result.artifacts[0].sha256);assert.equal(report.productLine,'meridian');assert.equal(report.sourceSha256,sha256(source));assert.equal(report.matches[0].line,2);assert.equal(report.semanticSupport,'not-asserted');
  await h.reject(`/v1/tasks/${run.taskId}/result`,undefined,'FORBIDDEN_SCOPE','bob');assert.ok(model.requests[0].tools.some((tool:any)=>tool.function.name==='srv_meridian_docs_get'));assert.ok(!model.requests[0].tools.some((tool:any)=>tool.function.name==='srv_buildsite_versions'));
  const page=await h.request(`/v1/tasks/${run.taskId}/events?after=0`);assert.ok(page.events.some((event:any)=>event.kind==='runtime.agent_settled'));
});
