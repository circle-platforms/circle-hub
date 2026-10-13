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
  const tree=await call(h,'command_tree',{build:approved.buildId});for(const response of [heads,params,checked,tree]){assert.equal(response.result.build,approved.buildId);assert.equal(response.result.buildId,approved.buildId);assert.equal(response.result.source.buildName,buildName);assert.equal(response.result.source.sourceArtifactId,approved.buildId);assert.equal(response.result.source.origin,'uploaded-artifact');assert.equal(response.result.source.live,false);assert.equal(response.result.source.commandTreeSha256,approved.commandTree.sha256);}
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

test('Source artifacts: existing assets registration binds uploaded originals and approved status supplies a stable command build id',async t=>{
  const {h,source,gateway,upload,submit}=await environment(t),xml=await upload(externalTree,'commands.xml'),functions=await upload(functionContract(),'functions.json');
  const input={scopeId:'scp_lab',kind:'knowledge-source',name:'Existing asset source registration',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{schema:'external-source-artifact/1',metadata:{packageId:'synthetic',buildName,platform:'synthetic-os',versionLine:'7.1'},files:[{path:'commands.xml',role:'command-tree',sourceRevisionId:xml.sourceRevisionId,sha256:xml.sha256},{path:'functions.json',role:'function-contract',sourceRevisionId:functions.sourceRevisionId,sha256:functions.sha256}]},readers:['prn_alice','prn_bob']};
  const draft=await h.request('/v1/assets',input);assert.equal(draft.sourceArtifactId,null);assert.equal(draft.lifecycle,'draft');assert.equal(draft.configuration.files[0].sourceRevisionId,xml.sourceRevisionId);assert.equal(draft.configuration.files[0].size,externalTree.length);assert.match(draft.configuration.files[0].sourceRecordId,/^knr_/);
  const replay=await h.request('/v1/assets',{...input,assetId:draft.assetId});assert.equal(replay.sha256,draft.sha256);assert.equal(replay.deduplicated,true);
  await h.reject(`/v1/assets/${draft.assetId}/lifecycle`,{version:draft.version,sha256:draft.sha256,state:'approved'},'SELF_APPROVAL');
  const approved=await h.request(`/v1/assets/${draft.assetId}/lifecycle`,{version:draft.version,sha256:draft.sha256,state:'approved'},'bob');assert.match(approved.sourceArtifactId,/^sar_/);assert.equal((await h.request(`/v1/assets/${draft.assetId}`)).sourceArtifactId,approved.sourceArtifactId);
  await h.startWorker();const listed=await h.request('/v1/tools/buildsite.versions/call',{args:{sourceArtifactId:approved.sourceArtifactId},idempotencyKey:'asset-source-versions'});assert.equal(listed.result.total,1);assert.deepEqual(listed.result.builds,[{name:buildName,buildId:approved.sourceArtifactId,formal:false,releasedOn:null,current:true,platform:'synthetic-os',commandTreeAvailable:true}]);assert.equal(listed.evidence[0].sha256,xml.sha256);
  const checked=await call(h,'command_check',{build:listed.result.builds[0].buildId,commands:['service create port 443']});assert.equal(checked.result.commands[0].status,'hit');assert.equal(checked.result.commands[0].violations.length,0);assert.equal(source.requests.length,0);
  const task=await submit({...approved,buildId:approved.sourceArtifactId});await h.phase(task.taskId,'waiting-review');const approval=(await h.request(`/v1/tasks/${task.taskId}/approvals`)).at(-1);assert.equal(approval.action.args.treeSha256,xml.sha256);assert.equal(approval.action.args.excelContractSha256,functions.sha256);await h.request(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'bob');await h.phase(task.taskId,'delivered');assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
  await h.stop();await h.startServer();assert.equal((await h.request(`/v1/assets/${draft.assetId}`)).sourceArtifactId,approved.sourceArtifactId);
});

test('Source artifacts: replaying an older asset version never rolls back current product source heads',async t=>{
  const {h,upload}=await environment(t),xml=await upload(externalTree,'commands.xml');
  const input={scopeId:'scp_lab',kind:'knowledge-source',name:'Versioned raw source',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{schema:'external-source-artifact/1',files:[{path:'commands.xml',role:'command-tree',sourceRevisionId:xml.sourceRevisionId}]},readers:['prn_alice','prn_bob']};
  const first=await h.request('/v1/assets',input),replacement=await upload(Buffer.from(externalTree.toString().replace('alpha','omega')),'commands.xml'),latest=await h.request('/v1/assets',{...input,assetId:first.assetId,version:'1.0.1',configuration:{...input.configuration,files:[{...input.configuration.files[0],sourceRevisionId:replacement.sourceRevisionId}]}});
  const replay=await h.request('/v1/assets',{...input,assetId:first.assetId});assert.equal(replay.deduplicated,true);assert.equal((await h.request(`/v1/assets/${first.assetId}`)).version,latest.version);
  const records=(await h.db.query("SELECT r.sha256 FROM knowledge_source_heads h JOIN knowledge_records r USING(record_id) WHERE r.payload->'asset'->>'assetId'=$1",[first.assetId])).rows;assert.deepEqual(records.map(row=>row.sha256),[replacement.sha256]);
});

test('Source artifacts: assets registration rejects forged hashes cross-scope originals and duplicate paths without storing partial knowledge',async t=>{
  const {h,upload}=await environment(t),xml=await upload(externalTree,'commands.xml');
  const input={scopeId:'scp_lab',kind:'knowledge-source',name:'Rejected source registration',version:'1.0.0',declaration:{reads:['registered-source'],writes:[],credentials:[]},configuration:{schema:'external-source-artifact/1',metadata:{},files:[{path:'commands.xml',role:'command-tree',sourceRevisionId:xml.sourceRevisionId,sha256:xml.sha256}]},readers:['prn_alice','prn_bob']};
  const counts=async()=>[Number((await h.db.query('SELECT count(*) AS n FROM assets')).rows[0].n),Number((await h.db.query('SELECT count(*) AS n FROM knowledge_records')).rows[0].n)];const before=await counts();
  await h.reject('/v1/assets',{...input,configuration:{...input.configuration,files:[{...input.configuration.files[0],sha256:'0'.repeat(64)}]}},'SOURCE_HASH_MISMATCH');
  await h.reject('/v1/assets',{...input,configuration:{...input.configuration,files:[...input.configuration.files,...input.configuration.files]}},'INVALID_PAYLOAD');
  const foreign=await h.request('/v1/sources',{scopeId:'scp_second',fileName:'foreign.xml',contentBase64:externalTree.toString('base64')});await h.reject('/v1/assets',{...input,configuration:{...input.configuration,files:[{...input.configuration.files[0],sourceRevisionId:foreign.sourceRevisionId}]}},'FORBIDDEN_SCOPE');
  await h.reject('/v1/assets',{...input,configuration:{...input.configuration,sourceArtifactId:`sar_${'0'.repeat(32)}`}},'INVALID_PAYLOAD');assert.deepEqual(await counts(),before);
});

test('Knowledge candidates: failed results locate caller-supplied evidence while missing and hidden records remain indistinguishable',async t=>{
  const {h}=await environment(t),files=[];for(const [path,role,bytes] of [['commands.xml','command-tree',externalTree],['functions.json','function-contract',functionContract()]] as const){const uploaded=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:path,contentBase64:bytes.toString('base64')},'bob');files.push({path,role,sourceRevisionId:uploaded.sourceRevisionId,sha256:uploaded.sha256});}
  const sourceDefinition={scopeId:'scp_lab',name:'Revocable source evidence',version:'1.0.0',metadata:{buildName},files,readers:['prn_alice','prn_bob']},draftSource=await h.request('/v1/source-artifacts',sourceDefinition,'bob');await h.request(`/v1/assets/${draftSource.assetId}/lifecycle`,{version:draftSource.version,sha256:draftSource.sha256,state:'approved'});const source=await h.request(`/v1/source-artifacts/${draftSource.assetId}`);
  const candidate=await h.request('/v1/assets',{scopeId:'scp_lab',kind:'connector-instance',name:'Candidate writer',version:'1.0.0',declaration:{reads:[],writes:['knowledge-candidates'],credentials:[]},configuration:{packageId:'knowledge'},readers:['prn_alice','prn_bob']});
  await h.request(`/v1/assets/${candidate.assetId}/lifecycle`,{version:candidate.version,sha256:candidate.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${candidate.assetId}/lifecycle`,{version:candidate.version,sha256:candidate.sha256,state:'running'});await h.startWorker();
  const checked=await call(h,'command_check',{build:source.sourceArtifactId,commands:['service create port 443']}),valid=checked.evidence[0];
  const good=await h.request('/v1/tools/knowledge.claim_submit/call',{args:{claim:{subject:'synthetic',predicate:'observed',value:true},evidence:[valid]},idempotencyKey:'candidate-evidence-valid'});await h.phase(good.taskId,'delivered');assert.equal((await h.request(`/v1/tasks/${good.taskId}/result`)).result.state,'candidate');
  await h.request('/v1/source-artifacts',{...sourceDefinition,version:'2.0.0',readers:['prn_bob']},'bob');
  const failures=[];for(const [index,evidenceId] of [valid.evidenceId,`knr_${'0'.repeat(32)}`].entries()){
    const accepted=await h.request('/v1/tools/knowledge.claim_submit/call',{args:{claim:{subject:'synthetic',predicate:'unverified',value:true},evidence:[{evidenceId,sha256:valid.sha256}]},idempotencyKey:`candidate-evidence-hidden-${index}`});await h.phase(accepted.taskId,'failed');
    const response=await h.raw(`/v1/tasks/${accepted.taskId}/result`,{token:await h.login()});assert.equal(response.status,200);assert.equal(response.body.status,'failed');assert.equal(response.body.data.result??null,null);const error=response.body.data.error;assert.equal(error.code,'SOURCE_FORBIDDEN');assert.deepEqual(error.details,{field:'evidence',index:0,evidenceId});failures.push(error);
  }
  assert.equal(failures[0].message,failures[1].message);
});
