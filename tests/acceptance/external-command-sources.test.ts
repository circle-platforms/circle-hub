import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {sha256} from '../../packages/contracts/src/index.ts';
import {setup,until,type Harness} from './harness.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';
import {caseGateway} from '../fixtures/case-gateway.ts';
import {executionWorkbook} from '../fixtures/execution-workbook.ts';
import {externalTree,functionContract} from '../fixtures/command-source.ts';
import {scriptModel} from '../fixtures/script-model.ts';
import {privateRequest} from '../../packages/runtime/src/private-ipc.ts';
const circleBin=process.env.CIRCLE_BIN??'',circleCommit=process.env.CIRCLE_COMMIT??'';

const buildName='Beta_SYNTHETIC_7_1_9_42';
async function environment(t:any){
  const source=await readonlySources(t),gateway=await caseGateway(t),h=await setup(t);
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"credentials.register\",\"credentials.use\",\"builds.read\",\"cases.execute\",\"knowledge.read\",\"knowledge.submit\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\",\"knowledge.read\"]'::jsonb WHERE principal_id='prn_bob'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\"]'::jsonb WHERE principal_id='prn_outsider'");
  await writeFile(`${h.scratch}/profiles.json`,JSON.stringify({profiles:{source:{origin:source.origin,index:'/builds/'}}}));h.env.CIRCLE_SERVER_CONNECTOR_PROFILES=`${h.scratch}/profiles.json`;
  await writeFile(`${h.scratch}/gateways.json`,JSON.stringify({profiles:{lab:{endpoint:`${gateway.origin}/mcp`,issuer:gateway.origin,pollMs:25}}}));h.env.CIRCLE_SERVER_EXECUTION_GATEWAYS=`${h.scratch}/gateways.json`;await h.stop();await h.startServer();
  const activate=async(asset:any)=>{await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');return h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'running'});};
  const commands=await activate(await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic build tool surface',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'build-site',runtimeProfileRef:'source'},readers:['prn_alice','prn_bob']}));
  const upload=(bytes:Buffer,fileName:string)=>h.request('/v1/sources',{scopeId:'scp_lab',fileName,contentBase64:bytes.toString('base64')});
  const decorated=(asset:any)=>({...asset,buildId:asset.sourceArtifactId,commandTree:asset.files.find((file:any)=>file.role==='command-tree'),excelContract:asset.files.find((file:any)=>file.role==='function-contract')});
  const register=async(tree=externalTree,contract=functionContract(),version='1.0.0')=>{const xml=await upload(tree,'commands.xml'),functions=await upload(contract,'functions.json');return decorated(await h.request('/v1/source-artifacts',{scopeId:'scp_lab',name:'Synthetic external command authority',version,metadata:{buildName,platform:'synthetic-os'},files:[{path:'commands.xml',role:'command-tree',sourceRevisionId:xml.sourceRevisionId,sha256:xml.sha256},{path:'functions.json',role:'function-contract',sourceRevisionId:functions.sourceRevisionId,sha256:functions.sha256}],readers:['prn_alice','prn_bob']}));};
  const approveSource=async(asset:any)=>{await h.request(`/v1/assets/${asset.assetId}/lifecycle`,{version:asset.version,sha256:asset.sha256,state:'approved'},'bob');return decorated(await h.request(`/v1/source-artifacts/${asset.assetId}`));};
  const draft=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic execution bed',version:'1.0.0',declaration:{reads:['test-bed'],writes:['device-config'],credentials:[]},configuration:{packageId:'case-gateway',productLineId:'apv',runtimeProfileRef:'lab'},readers:['prn_alice','prn_bob']});
  const credential=await h.request(`/v1/assets/${draft.assetId}/credentials`,{version:'1.0.0',value:JSON.stringify({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+900,scope:'jumphost:run'})});
  const bed=await activate(await h.request('/v1/assets',{assetId:draft.assetId,scopeId:'scp_lab',kind:'connector-instance',name:draft.name,version:'2.0.0',declaration:{reads:['test-bed'],writes:['device-config'],credentials:[credential.assetId]},configuration:draft.configuration,readers:['prn_alice','prn_bob']}));
  const submit=async(binding:any,host='routera',command='service create port 443')=>{const original=await upload(await executionWorkbook({command,hostCommand:{host,command:'dig @192.0.2.1 example.test TXT'}}),'case.xlsx');return h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'apv-case-execute',idempotencyKey:`external-run-${Math.random()}`,input:{sourceRevisionId:original.sourceRevisionId,gatewayAssetId:bed.assetId,commandSourceAssetId:binding.assetId,build:binding.buildId}});};
  return {h,source,gateway,commands,upload,register,approveSource,submit};
}
const call=(h:Harness,name:string,args:any)=>h.request(`/v1/tools/buildsite.${name}/call`,{args,idempotencyKey:`external-${Math.random()}`});

test('External commands: uploaded originals and independent asset approval produce one stable build id and scoped queries without listing HTTP',async t=>{
  const {h,source,register,approveSource}=await environment(t),draft=await register();assert.equal(draft.buildId,null);assert.equal(draft.lifecycle,'draft');assert.equal((await register()).assetId,draft.assetId);
  await h.reject(`/v1/assets/${draft.assetId}/lifecycle`,{version:draft.version,sha256:draft.sha256,state:'approved'},'SELF_APPROVAL');
  const approved=await approveSource(draft);assert.match(approved.buildId,/^sar_/);assert.equal(approved.commandTree.sha256,sha256(externalTree));assert.equal(approved.excelContract.sha256,sha256(functionContract()));
  await h.startWorker();const readsBefore=source.requests.length;
  const heads=await call(h,'command_heads',{build:approved.buildId,prefix:'service'});assert.deepEqual(heads.result.heads,['service create port','service inspect alpha']);assert.ok(heads.evidence.length);
  const params=await call(h,'command_param',{build:approved.buildId,head:'service create port'});assert.equal(params.result.parameters[0].type,'U16');
  const checked=await call(h,'command_check',{build:approved.buildId,commands:['service create port 443','invented command']});assert.equal(checked.result.commands[0].status,'hit');assert.equal(checked.result.commands[1].status,'missing');assert.equal(checked.result.source.commandTreeSha256,approved.commandTree.sha256);assert.equal(source.requests.length,readsBefore);
  await h.stop();await h.startServer();assert.equal((await h.request(`/v1/source-artifacts/${draft.assetId}`)).sourceArtifactId,approved.buildId);
  await h.reject(`/v1/source-artifacts/${draft.assetId}`,undefined,'ASSET_NOT_VISIBLE','outsider');
});

test('Source artifacts: registration checks bytes and hashes while semantic validation belongs to consumers',async t=>{
  const {h,upload,approveSource}=await environment(t),xml=await upload(externalTree,'commands.xml');
  const body={scopeId:'scp_lab',name:'Synthetic external source',version:'1.0.0',metadata:{buildName},readers:['prn_alice','prn_bob'],files:[{path:'commands.xml',role:'command-tree',sourceRevisionId:xml.sourceRevisionId,sha256:'0'.repeat(64)}]};
  await h.reject('/v1/source-artifacts',body,'SOURCE_HASH_MISMATCH');await h.reject('/v1/source-artifacts',{...body,files:[{path:'commands.xml',role:'command-tree'}]},'INVALID_PAYLOAD');
  const broken=await upload(Buffer.from('<commands><item>'),'broken.xml'),opaque=await h.request('/v1/source-artifacts',{...body,files:[{path:'commands.xml',role:'command-tree',sourceRevisionId:broken.sourceRevisionId}]});assert.equal(opaque.lifecycle,'draft');
  const approved=await approveSource(opaque);await h.startWorker();await h.reject('/v1/tools/buildsite.command_heads/call',{args:{build:approved.sourceArtifactId,prefix:''},idempotencyKey:'bad-external-xml'},'INVALID_PAYLOAD');
});

test('External commands: execution uses the imported XML and function contract and keeps source proof in the approved action',async t=>{
  const {h,gateway,register,approveSource,submit}=await environment(t),binding=await approveSource(await register());await h.startWorker();gateway.state.hostLog='routera executes command: dig @192.0.2.1 example.test TXT\nhealthy\n';
  const task=await submit(binding);await h.phase(task.taskId,'waiting-review');const approval=(await h.request(`/v1/tasks/${task.taskId}/approvals`)).at(-1);assert.equal(approval.action.args.treeSha256,binding.commandTree.sha256);assert.equal(approval.action.args.excelContractSha256,binding.excelContract.sha256);
  await h.request(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'bob');await h.phase(task.taskId,'delivered');assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
  const invalid=await submit(binding,'routera','unknown command');await h.phase(invalid.taskId,'failed');assert.equal((await h.request(`/v1/tasks/${invalid.taskId}/result`)).error.code,'COMMAND_VALIDATION_FAILED');assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
  const replacement=await approveSource(await register(externalTree,functionContract([{e:'test_env',f:'routera'}]),'1.0.1'));const rejected=await assert.rejects(submit(replacement),(error:any)=>/INVALID_EXECUTION_WORKBOOK/.test(error.message));assert.equal(rejected,undefined);assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
});

test('External commands: a changed source version invalidates pending execution approval and old ids never select new bytes',async t=>{
  const {h,gateway,register,approveSource,submit}=await environment(t),binding=await approveSource(await register()),worker=await h.startWorker();
  const task=await submit(binding);await h.phase(task.taskId,'waiting-review');await h.stop(worker);const approval=(await h.request(`/v1/tasks/${task.taskId}/approvals`)).at(-1);
  await register(Buffer.from(externalTree.toString('latin1').replace('max="65535"','max="80"'),'latin1'),functionContract(),'1.0.1');
  await h.reject(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'APPROVAL_STALE','bob');assert.equal(gateway.state.calls.length,0);
});

test('Source artifacts: the same generic binding supplies a document connector with scoped immutable originals',async t=>{
  const {h,source,upload,approveSource}=await environment(t),doc=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Synthetic document reader',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'documents',runtimeProfileRef:'source'},readers:['prn_alice','prn_bob']});
  await h.request(`/v1/assets/${doc.assetId}/lifecycle`,{version:doc.version,sha256:doc.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${doc.assetId}/lifecycle`,{version:doc.version,sha256:doc.sha256,state:'running'});
  const original=await upload(Buffer.from('Synthetic source manual: service create port.'),'manual.md'),draft=await h.request('/v1/source-artifacts',{scopeId:'scp_lab',name:'Synthetic manual artifact',version:'1.0.0',files:[{path:'manual.md',role:'document',mediaType:'text/plain',sourceRevisionId:original.sourceRevisionId}],metadata:{classification:'synthetic documentation'},readers:['prn_alice','prn_bob']}),approved=await approveSource(draft);
  const schema=(await h.request('/v1/tools')).find((tool:any)=>tool.name==='docs.get').inputSchema;assert.ok(schema.properties.sourceArtifactId);await h.startWorker();const count=source.requests.length;
  const result=await h.request('/v1/tools/docs.get/call',{args:{file:'/manual.md',sourceArtifactId:approved.sourceArtifactId},idempotencyKey:'generic-source-document'});assert.equal(Buffer.from(result.result.contentBase64,'base64').toString(),'Synthetic source manual: service create port.');assert.equal(result.evidence[0].sha256,original.sha256);assert.equal(source.requests.length,count);
  await h.db.query("UPDATE policies SET grants=grants || '[\"docs.fetch\"]'::jsonb WHERE principal_id='prn_bob'");
  const shared=await h.request('/v1/tools/docs.get/call',{args:{file:'/manual.md',sourceArtifactId:approved.sourceArtifactId},idempotencyKey:'generic-shared-reader'},'bob');assert.equal(shared.evidence[0].sha256,original.sha256);
  await until(async()=>{const jobs=(await h.db.query("SELECT status,error FROM knowledge_projection_jobs WHERE owner_id='prn_bob'")).rows;assert.ok(!jobs.some(row=>row.status==='failed'),JSON.stringify(jobs));return jobs.length&&jobs.every(row=>row.status==='succeeded');},10_000);
});

test('Source artifacts: real pinned RPC can use a declared tool with the approved artifact while the run token cannot list assets', {skip:(!circleBin||!circleCommit)&&'Set CIRCLE_BIN and CIRCLE_COMMIT for the real RPC source binding'},async t=>{
  const {h}=await environment(t),model=await scriptModel(t);
  await h.db.query("UPDATE policies SET grants=grants || '[\"skillpacks.read\",\"skillpacks.submit\",\"skillpacks.run\",\"knowledge.submit\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"skillpacks.read\",\"skillpacks.submit\"]'::jsonb WHERE principal_id='prn_bob'");
  await writeFile(`${h.scratch}/runtime.json`,JSON.stringify({circleBin,circleCommit,circleVersion:'1.1.1',model:{kind:'scripted',base_url:model.url,model:'scripted-fixture',protocol:'openai',api_key:model.key}}));h.env.CIRCLE_RUNTIME_CONFIG=`${h.scratch}/runtime.json`;await h.stop();await h.startServer();
  const doc=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'RPC source reader',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{packageId:'documents',runtimeProfileRef:'source'},readers:['prn_alice','prn_bob']});await h.request(`/v1/assets/${doc.assetId}/lifecycle`,{version:doc.version,sha256:doc.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${doc.assetId}/lifecycle`,{version:doc.version,sha256:doc.sha256,state:'running'});
  const bytes=Buffer.from('RPC external source original'),original=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'manual.md',contentBase64:bytes.toString('base64')}),source=await h.request('/v1/source-artifacts',{scopeId:'scp_lab',name:'RPC original artifact',version:'1.0.0',files:[{path:'manual.md',role:'document',sourceRevisionId:original.sourceRevisionId}],readers:['prn_alice','prn_bob']});await h.request(`/v1/assets/${source.assetId}/lifecycle`,{version:source.version,sha256:source.sha256,state:'approved'},'bob');const artifact=await h.request(`/v1/source-artifacts/${source.assetId}`);
  const skill=Buffer.from('---\nname: artifact-rpc\ndescription: Read the approved source.\n---\nUse docs.get with the input sourceArtifactId and write result.json.');
  const response=await fetch(`${h.url}/v1/skillpacks`,{method:'POST',headers:{authorization:`Bearer ${await h.login()}`,'x-scope-id':'scp_lab','content-type':'application/json'},body:JSON.stringify({manifest:{id:'artifact-rpc',version:'1.0.0',title:'Artifact RPC',owner:'synthetic',tools:['docs.get'],triggers:['manual'],inputs:{},outputs:['result.json'],model:'scripted'},files:[{path:'SKILL.md',base64:skill.toString('base64'),sha256:sha256(skill)}],trial:{toolCalls:[{name:'docs.get',argsSha256:sha256('{}'),ok:true}],outputs:[]}})});assert.equal(response.status,201);const pack=(await response.json() as any).data,approval=(await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals`))[0];await h.request(`/v1/tasks/${pack.approvalTaskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'bob');
  model.state.delayMs=1000;model.state.sequence=[{name:'skill',args:{name:'artifact-rpc'}},{name:'srv_docs_get',args:{file:'/manual.md',sourceArtifactId:artifact.sourceArtifactId}},{name:'write_file',args:{file_path:'result.json',content:'{"received":true}'}}];await h.startWorker();const run=await h.request(`/v1/skillpacks/${pack.skillPackId}/runs`,{inputs:{sourceArtifactId:artifact.sourceArtifactId},idempotencyKey:'rpc-approved-source'});
  await until(async()=>model.requests.length>0);const operation=(await h.db.query("SELECT * FROM operations WHERE task_id=$1 AND name='assets.execute'",[run.taskId])).rows[0],workerToken=await h.login('lab-east-01'),checked=await h.raw(`/v1/workers/operations/${operation.operation_id}/preflight`,{token:workerToken,body:{fencingToken:Number(operation.fencing_token)}}),secret=await privateRequest(checked.body.data.authorization.privateSocketPath,{authorization:`Bearer ${workerToken}`,operationId:operation.operation_id,fencingToken:Number(operation.fencing_token)});assert.equal((await h.raw('/v1/assets',{token:secret.serverToken})).body.error.code,'FORBIDDEN_ACTION');
  await h.phase(run.taskId,'delivered',20_000);
  const children=(await h.db.query("SELECT phase,result FROM tasks WHERE context->>'parentRunTaskId'=$1 AND capability_pack_id='asset-tool'",[run.taskId])).rows;assert.equal(children.length,1);assert.equal(children[0].phase,'delivered',JSON.stringify(children[0]));assert.equal(Buffer.from(children[0].result.result.contentBase64,'base64').toString(),bytes.toString());
  assert.ok(model.requests[0].tools.find((tool:any)=>tool.function.name==='srv_docs_get').function.parameters.properties.sourceArtifactId);
});

test('Source artifacts: drafts disabled revisions and conflicting selector fields cannot reach a bound consumer',async t=>{
  const {h,register,approveSource,source}=await environment(t),draft=await register(),reserved=(await h.request(`/v1/assets/${draft.assetId}`)).configuration.sourceArtifactId;
  await h.reject('/v1/tools/buildsite.command_heads/call',{args:{build:reserved,prefix:''},idempotencyKey:'draft-source-blocked'},'APPROVAL_REQUIRED');const approved=await approveSource(draft),other=await h.request('/v1/source-artifacts',{scopeId:'scp_lab',name:'Another source selector',version:'1.0.0',files:approved.files.map((file:any)=>({path:file.path,role:file.role,sourceRevisionId:file.sourceRevisionId})),metadata:{buildName:'Beta_SYNTHETIC_OTHER'},readers:['prn_alice','prn_bob']}),second=await approveSource(other);
  await h.reject('/v1/tools/buildsite.command_heads/call',{args:{build:approved.sourceArtifactId,prefix:'',sourceArtifactId:second.sourceArtifactId},idempotencyKey:'conflicting-source-selectors'},'INVALID_PAYLOAD');
  await h.request(`/v1/assets/${approved.assetId}/lifecycle`,{version:approved.version,sha256:approved.sha256,state:'disabled'});await h.reject('/v1/tools/buildsite.command_heads/call',{args:{build:approved.sourceArtifactId,prefix:''},idempotencyKey:'disabled-source-blocked'},'APPROVAL_REQUIRED');assert.equal(source.requests.length,0);
});
