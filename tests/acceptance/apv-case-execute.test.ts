import {sandboxTest} from './harness.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFile} from 'node:fs/promises';
import {canonicalHash,sha256} from '../../packages/contracts/src/index.ts';
import {setup,until,type Harness} from './harness.ts';
import {executionWorkbook} from '../fixtures/execution-workbook.ts';
import {caseGateway} from '../fixtures/case-gateway.ts';
import {readonlySources} from '../fixtures/readonly-sources.ts';

async function environment(t:any){
  const source=await readonlySources(t);source.state.expandedCommands=true;const gateway=await caseGateway(t),h=await setup(t);
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.register\",\"assets.change\",\"credentials.register\",\"credentials.use\",\"builds.read\",\"cases.execute\"]'::jsonb WHERE principal_id='prn_alice'");
  await h.db.query("UPDATE policies SET grants=grants || '[\"assets.read\",\"assets.approve\"]'::jsonb WHERE principal_id='prn_bob'");
  await writeFile(`${h.scratch}/sources.json`,JSON.stringify({profiles:{source:{origin:source.origin,index:'/builds/'}}}));h.env.CIRCLE_HUB_CONNECTOR_PROFILES=`${h.scratch}/sources.json`;
  await writeFile(`${h.scratch}/gateways.json`,JSON.stringify({profiles:{lab:{endpoint:`${gateway.origin}/mcp`,issuer:gateway.origin,pollMs:25}}}));h.env.CIRCLE_HUB_EXECUTION_GATEWAYS=`${h.scratch}/gateways.json`;await h.stop();await h.startServer();
  const register=(name:string,configuration:any,declaration:any,assetId?:string,version='1.0.0')=>h.request('/v1/assets',{assetId,scopeId:'scp_lab',kind:'connector-instance',name,version,configuration,declaration,readers:['prn_alice','prn_bob']});
  const activate=async(item:any)=>{await h.request(`/v1/assets/${item.assetId}/lifecycle`,{version:item.version,sha256:item.sha256,state:'approved'},'bob');return h.request(`/v1/assets/${item.assetId}/lifecycle`,{version:item.version,sha256:item.sha256,state:'running'});};
  const build=await activate(await register('Synthetic command source',{packageId:'build-site',runtimeProfileRef:'source'},{reads:['registered-source'],writes:[],credentials:[]}));
  const draft=await register('Synthetic lab gateway',{packageId:'case-gateway',productLineId:'apv',runtimeProfileRef:'lab'},{reads:['test-bed'],writes:['device-config'],allowedTestHosts:['clientc','clientd','cliente','routera','routerb','server213','server231','server232'],executionIsChange:true,credentials:[]});
  const credential=await h.request(`/v1/assets/${draft.assetId}/credentials`,{version:'1.0.0',value:JSON.stringify({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_at:Date.now()/1000+900,scope:'jumphost:run'})});
  const bed=await activate(await register('Synthetic lab gateway',draft.configuration,{reads:['test-bed'],writes:['device-config'],allowedTestHosts:['clientc','clientd','cliente','routera','routerb','server213','server231','server232'],executionIsChange:true,credentials:[credential.assetId]},draft.assetId,'2.0.0'));
  const workbooks=new Map<string,Buffer>();const submit=async(command='service create port 443',key=`execute-${Math.random()}`)=>{let bytes=workbooks.get(command);if(!bytes){bytes=await executionWorkbook({command});workbooks.set(command,bytes);}const original=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'case.xlsx',contentBase64:bytes.toString('base64')});return h.request('/v1/tasks/submit',{scopeId:'scp_lab',title:'Run synthetic workbook',capabilityPackId:'apv-case-execute',idempotencyKey:key,input:{sourceRevisionId:original.sourceRevisionId,sourceSha256:original.sha256,gatewayAssetId:bed.assetId,commandSourceAssetId:build.assetId,build:'Rel_PHOTON_10_5_0_101'}});};
  const approve=async(task:any)=>{await h.phase(task.taskId,'waiting-review');const approval=(await h.request(`/v1/tasks/${task.taskId}/approvals`)).at(-1);const answer={inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true};await h.reject(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,answer,'SELF_APPROVAL');await h.request(`/v1/tasks/${task.taskId}/approvals/${approval.approvalId}`,answer,'bob');return approval;};
  return {h,source,gateway,build,bed,credential,submit,approve};
}

sandboxTest('Device execution: server rejects unknown workbook commands and forged client receipts before any gateway call',async t=>{
  const {h,gateway,submit,bed,build}=await environment(t);await h.startWorker();const invalid=await submit('invented command 123');await h.phase(invalid.taskId,'failed');assert.equal((await h.request(`/v1/tasks/${invalid.taskId}/result`)).error.code,'COMMAND_NOT_IN_TREE');assert.equal(gateway.state.calls.length,0);
  const bytes=await executionWorkbook(),source=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'case.xlsx',contentBase64:bytes.toString('base64')});
  await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'apv-case-execute',idempotencyKey:'forged-client-receipt',input:{sourceRevisionId:source.sourceRevisionId,gatewayAssetId:bed.assetId,commandSourceAssetId:build.assetId,build:'Rel_PHOTON_10_5_0_101',commandReceipt:{status:'hit'}}},'INVALID_PAYLOAD');
  const absent=await h.request('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'apv-case-execute',idempotencyKey:'absent-build-hidden',input:{sourceRevisionId:source.sourceRevisionId,gatewayAssetId:bed.assetId,commandSourceAssetId:build.assetId,build:'unlisted-build'}});await h.phase(absent.taskId,'failed');assert.equal((await h.request(`/v1/tasks/${absent.taskId}/result`)).error.code,'SOURCE_FORBIDDEN');
});

sandboxTest('Device execution: approved fenced gateway run returns bound per-case step checkpoint evidence and same-key submission never runs twice',async t=>{
  const {h,gateway,submit,approve}=await environment(t);await h.startWorker();const task=await submit('service create port 443','stable-device-run');await approve(task);await h.phase(task.taskId,'delivered');
  const result=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(result.result.cases[0].verdict,'pass');assert.equal(result.result.cases[0].steps[0].status,'observed');assert.ok(result.result.cases[0].checkPoints.every((point:any)=>point.status==='passed'));assert.equal(result.result.sourceSha256,gateway.state.sha);assert.ok(result.artifacts.length>=2);assert.ok(result.evidence.length);
  const events=(await h.request(`/v1/tasks/${task.taskId}/events?after=0`)).events,environmentEvent=events.find((event:any)=>event.kind==='execution.environment.observed'),deliveredEvent=events.find((event:any)=>event.kind==='task.delivered');assert.ok(environmentEvent.content.retained.some((ref:any)=>ref.artifactId&&ref.fileName==='environment-observation.json'));assert.ok(deliveredEvent.content.retained.some((ref:any)=>result.artifacts.some((artifact:any)=>artifact.artifactId===ref.artifactId)));
  for(const ref of result.artifacts){const response=await fetch(`${h.url}${ref.downloadPath}`,{headers:{authorization:`Bearer ${await h.login()}`}});assert.equal(sha256(Buffer.from(await response.arrayBuffer())),ref.sha256);}
  await h.stop();await h.startServer();const again=await submit('service create port 443','stable-device-run');assert.equal(again.taskId,task.taskId);assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
  await h.reject(`/v1/tasks/${task.taskId}/result`,undefined,'FORBIDDEN_SCOPE','outsider');assert.equal((await h.request(`/v1/tasks/${task.taskId}/events?after=0`)).events.filter((event:any)=>event.kind==='execution.gateway.submitted').length,1);
});

sandboxTest('Device execution: tree change after approval is rejected by a second server check and an upstream introspection outage never masquerades as login expiry',async t=>{
  const {h,source,gateway,submit,approve}=await environment(t);const worker=await h.startWorker(),task=await submit();await h.phase(task.taskId,'waiting-review');await h.stop(worker);await approve(task);source.state.expandedCommands=false;await h.startWorker();await h.phase(task.taskId,'failed');assert.ok(['COMMAND_NOT_IN_TREE','APPROVAL_STALE'].includes((await h.request(`/v1/tasks/${task.taskId}/result`)).error.code));assert.equal(gateway.state.calls.length,0);
  source.state.expandedCommands=true;const unavailable=await submit();gateway.state.unavailable=true;await approve(unavailable);await h.phase(unavailable.taskId,'waiting-input');assert.equal((await h.request(`/v1/tasks/${unavailable.taskId}/result`)).error.code,'GATEWAY_UNREACHABLE');assert.ok(!gateway.state.calls.includes('case_submit'));
});

sandboxTest('Device execution: lost submission and local cancellation freeze the bed without automatic replay; independent read-back reconciles an observed terminal run',async t=>{
  const {h,gateway,credential,submit,approve}=await environment(t);gateway.state.hold=true;await h.startWorker();const task=await submit();await approve(task);await until(async()=>gateway.state.calls.includes('case_status'));await h.request(`/v1/tasks/${task.taskId}/cancel`,{});await h.phase(task.taskId,'unknown');const operation=(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((op:any)=>op.name==='cases.execute');assert.equal(operation.status,'unknown');assert.equal((await h.request(`/v1/tasks/${task.taskId}/result`)).runtime?.remoteStoppingVerified??false,false);
  await assert.rejects(submit(),/RESOURCE_BUSY/);assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
  const replacement=await h.request(`/v1/assets/${credential.assetId}/credentials`,{version:credential.version,value:JSON.stringify({access_token:'replacement-access',refresh_token:'replacement-refresh',expires_at:Date.now()/1000+900,scope:'jumphost:run'})});assert.equal(replacement.assetId,credential.assetId);assert.ok(!JSON.stringify(replacement).includes('replacement-access'));await h.reject(`/v1/assets/${credential.assetId}/credentials`,{version:'9.0.0',value:'secret'},'APPROVAL_STALE');
  await h.startWorker('lab-east-02');const pending=await h.request(`/v1/tasks/${task.taskId}/reconcile`,{operationId:operation.operationId});await until(async()=>(await h.request(`/v1/tasks/${task.taskId}/operations`)).some((op:any)=>op.operationId===pending.operationId&&op.status==='failed'));assert.equal((await h.status(task.taskId)).phase,'unknown');
  gateway.state.hold=false;await h.request(`/v1/tasks/${task.taskId}/reconcile`,{operationId:operation.operationId});await until(async()=>(await h.request(`/v1/tasks/${task.taskId}/operations`)).some((op:any)=>op.operationId===operation.operationId&&op.status==='reconciled'));assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
});

sandboxTest('Device execution: worker lease expiry refuses late fences and server restart never resubmits a received gateway task',async t=>{
  const {h,gateway,submit,approve}=await environment(t);gateway.state.hold=true;const worker=await h.startWorker(),task=await submit();await approve(task);await until(async()=>gateway.state.calls.includes('case_status'));
  const operation=(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((op:any)=>op.name==='cases.execute');await h.stop(worker,'SIGKILL');await h.db.query("UPDATE leases SET expires_at=clock_timestamp()-interval '1 second' WHERE operation_id=$1",[operation.operationId]);await h.phase(task.taskId,'unknown');
  await h.reject(`/v1/workers/operations/${operation.operationId}/report`,{inputRevisionId:task.inputRevisionId,fencingToken:operation.fencingToken,status:'succeeded',output:{}},'FENCING_STALE','lab-east-01');
  await h.stop();await h.startServer();await h.startWorker('lab-east-02');assert.equal((await h.status(task.taskId)).phase,'unknown');assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
  gateway.state.hold=false;await h.request(`/v1/tasks/${task.taskId}/reconcile`,{operationId:operation.operationId});await h.phase(task.taskId,'delivered');assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
});

sandboxTest('Device execution: an interrupted submit persists its intent without replay',async t=>{
  const {h,gateway,submit,approve}=await environment(t);gateway.state.dropSubmit=true;await h.startWorker();const task=await submit('service create port 443','lost-submit-key');await approve(task);await h.phase(task.taskId,'unknown');
  const operation=(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((op:any)=>op.name==='cases.execute'),receipt=(await h.db.query('SELECT * FROM case_gateway_receipts WHERE operation_id=$1',[operation.operationId])).rows[0];assert.equal(receipt.submit_intent,true);assert.equal(receipt.gateway_task_id,null);
  await h.reject(`/v1/tasks/${task.taskId}/reconcile`,{operationId:operation.operationId},'EVIDENCE_INSUFFICIENT');await h.stop();await h.startServer();const repeated=await submit('service create port 443','lost-submit-key');assert.equal(repeated.taskId,task.taskId);assert.equal(repeated.deduplicated,true);assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
});

sandboxTest('Device execution: cancellation before approval closes the pending input without starting a device run',async t=>{
  const {h,gateway,submit}=await environment(t);await h.startWorker();const task=await submit();await h.phase(task.taskId,'waiting-review');await h.request(`/v1/tasks/${task.taskId}/cancel`,{});await h.phase(task.taskId,'cancelled');assert.equal(gateway.state.calls.length,0);assert.equal((await h.request(`/v1/tasks/${task.taskId}/result`)).status,'cancelled');assert.ok((await h.status(task.taskId)).pendingInputs.every((item:any)=>item.status!=='open'));
});

sandboxTest('Device execution: server refuses submit intent without its own fresh command proof and approvals bind the runtime target identity',async t=>{
  const {h,gateway,submit,approve}=await environment(t);const worker=await h.startWorker(),task=await submit();await h.phase(task.taskId,'waiting-review');await h.stop(worker);await approve(task);
  const claim=await h.request('/v1/workers/claim',{},'lab-east-01');assert.equal(claim.name,'cases.execute');
  await h.reject(`/v1/workers/operations/${claim.operationId}/events`,{fencingToken:claim.fencingToken,inputRevisionId:task.inputRevisionId,event:{stage:'submit-intent'}},'DECISION_CONFLICT','lab-east-01');assert.equal(gateway.state.calls.length,0);
  await writeFile(`${h.scratch}/gateways.json`,JSON.stringify({profiles:{lab:{endpoint:`${gateway.origin}/different-mcp`,issuer:gateway.origin,pollMs:25}}}));
  await h.reject(`/v1/workers/operations/${claim.operationId}/preflight`,{fencingToken:claim.fencingToken},'APPROVAL_STALE','lab-east-01');assert.equal(gateway.state.calls.length,0);
});

sandboxTest('Device execution: input replacement invalidates approval and failed checkpoints remain separate from successful delivery',async t=>{
  const {h,gateway,submit,approve}=await environment(t);await h.startWorker();const task=await submit();await h.phase(task.taskId,'waiting-review');const old=(await h.request(`/v1/tasks/${task.taskId}/approvals`)).at(-1);
  const revised=await h.request(`/v1/tasks/${task.taskId}/input`,{inputRevisionId:task.inputRevisionId,replacement:{...task.input,module:'revision_two'}});assert.notEqual(revised.inputRevisionId,task.inputRevisionId);
  await h.reject(`/v1/tasks/${task.taskId}/approvals/${old.approvalId}`,{inputRevisionId:old.inputRevisionId,targetIdentity:old.targetIdentity,actionDigest:old.actionDigest,approve:true},'APPROVAL_STALE','bob');assert.equal(gateway.state.calls.length,0);
  gateway.state.failCase=true;await approve(revised);await h.phase(task.taskId,'delivered');const result=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(result.status,'succeeded');assert.equal(result.result.cases[0].verdict,'fail');assert.equal(result.result.cases[0].checkPoints[0].status,'failed');
});

sandboxTest('Device execution: approved host traffic dispatch is not a device head and unregistered hosts cannot be submitted',async t=>{
  const {h,gateway,bed,build,approve}=await environment(t),hostCommand={host:'routera',command:'curl --http1.1 http://service.example.test/'};
  await writeFile(`${h.scratch}/gateways.json`,JSON.stringify({profiles:{lab:{endpoint:`${gateway.origin}/mcp`,issuer:gateway.origin,pollMs:25}}}));
  const bytes=await executionWorkbook({command:'service create port 443',hostCommand}),original=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'case.xlsx',contentBase64:bytes.toString('base64')});
  const payload={scopeId:'scp_lab',capabilityPackId:'apv-case-execute',idempotencyKey:'host-dispatch-run',input:{sourceRevisionId:original.sourceRevisionId,gatewayAssetId:bed.assetId,commandSourceAssetId:build.assetId,build:'Rel_PHOTON_10_5_0_101'}};
  gateway.state.hostLog=`routera executes command: ${hostCommand.command}\nHTTP/1.1 200 OK\n`;await h.startWorker();const task=await h.request('/v1/tasks/submit',payload),approval=await approve(task);assert.equal(approval.action.args.hostDispatch.count,1);assert.deepEqual(approval.action.args.hostDispatch.hosts,['routera']);await h.phase(task.taskId,'delivered');const result=await h.request(`/v1/tasks/${task.taskId}/result`);assert.equal(result.result.cases[0].steps[1].status,'observed');assert.ok(!result.unmapped.length);
  const proof=(await h.request(`/v1/tasks/${task.taskId}/operations`)).find((op:any)=>op.name==='cases.verify').result.artifact,response=await fetch(`${h.url}${proof.downloadPath}`,{headers:{authorization:`Bearer ${await h.login()}`}}),checked=await response.json() as any;assert.equal(checked.checked.commands.length,1);assert.deepEqual(checked.hostCommands.map((row:any)=>[row.host,row.command]),[['routera',hostCommand.command]]);
  const narrowed=await h.request('/v1/assets',{assetId:bed.assetId,scopeId:'scp_lab',kind:bed.kind,name:bed.name,version:'3.0.0',configuration:bed.configuration,declaration:{...bed.declaration,allowedTestHosts:['clientc']},readers:['*']});await h.request(`/v1/assets/${narrowed.assetId}/lifecycle`,{version:narrowed.version,sha256:narrowed.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${narrowed.assetId}/lifecycle`,{version:narrowed.version,sha256:narrowed.sha256,state:'running'});await h.reject('/v1/tasks/submit',{...payload,idempotencyKey:'unregistered-host-rejected'},'COMMAND_VALIDATION_FAILED');assert.equal(gateway.state.calls.filter(name=>name==='case_submit').length,1);
});

sandboxTest('Device execution: workbook errors expose authorized row locations through HTTP without command text',async t=>{
  const {h,gateway,bed,build}=await environment(t);
  for(const method of ['reboot','routera']){
    const bytes=await executionWorkbook({hostCommand:{host:method,command:method==='reboot'?'private-command-text':'private-command-text,unsafe=1'}}),source=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'case.xlsx',contentBase64:bytes.toString('base64')});
    const error=await h.reject('/v1/tasks/submit',{scopeId:'scp_lab',capabilityPackId:'apv-case-execute',idempotencyKey:`locate-${method}`,input:{sourceRevisionId:source.sourceRevisionId,gatewayAssetId:bed.assetId,commandSourceAssetId:build.assetId,build:'Rel_PHOTON_10_5_0_101'}},method==='reboot'?'COMMAND_VALIDATION_FAILED':'INVALID_EXECUTION_WORKBOOK');
    assert.deepEqual(Object.fromEntries(['row','autoid','object','method'].map(key=>[key,error.details[key]])),{row:4,autoid:'301',object:'test_env',method});assert.ok(!JSON.stringify(error).includes('private-command-text'));
  }
  assert.equal(gateway.state.calls.length,0);
});

sandboxTest('Device execution: optional host command policies only narrow runtime dispatch and policy changes invalidate approval',async t=>{
  const {h,gateway,bed,build}=await environment(t);
  const payload=async(command:string,key:string)=>{const bytes=await executionWorkbook({command:'service create port 443',hostCommand:{host:'routera',command}}),source=await h.request('/v1/sources',{scopeId:'scp_lab',fileName:'case.xlsx',contentBase64:bytes.toString('base64')});return {scopeId:'scp_lab',capabilityPackId:'apv-case-execute',idempotencyKey:key,input:{sourceRevisionId:source.sourceRevisionId,gatewayAssetId:bed.assetId,commandSourceAssetId:build.assetId,build:'Rel_PHOTON_10_5_0_101'}};};
  const worker=await h.startWorker(),original=await h.request('/v1/tasks/submit',await payload('curl http://service.example.test/','policy-default'));
  await h.phase(original.taskId,'waiting-review');await h.stop(worker);const approval=(await h.request(`/v1/tasks/${original.taskId}/approvals`)).at(-1);
  let policyVersion=2;const setPolicy=async(policy:Record<string,unknown>|null)=>{const current=await h.request(`/v1/assets/${bed.assetId}`),draft=await h.request('/v1/assets',{assetId:bed.assetId,scopeId:'scp_lab',kind:current.kind,name:current.name,version:`${++policyVersion}.0.0`,configuration:current.configuration,declaration:{...current.declaration,hostCommandPolicies:policy?{routera:policy}:{}},readers:['*']});await h.request(`/v1/assets/${draft.assetId}/lifecycle`,{version:draft.version,sha256:draft.sha256,state:'approved'},'bob');await h.request(`/v1/assets/${draft.assetId}/lifecycle`,{version:draft.version,sha256:draft.sha256,state:'running'});};
  await setPolicy({allowedCommands:['dig example.test'],maxTimeoutSeconds:15,allowMultiline:false,maxCommandBytes:200});
  await h.reject(`/v1/tasks/${original.taskId}/approvals/${approval.approvalId}`,{inputRevisionId:approval.inputRevisionId,targetIdentity:approval.targetIdentity,actionDigest:approval.actionDigest,approve:true},'APPROVAL_STALE','bob');
  for(const [rule,policy,command] of [
    ['allowedCommands',{allowedCommands:['dig example.test']},'curl http://service.example.test/'],
    ['maxTimeoutSeconds',{maxTimeoutSeconds:15},'dig example.test,timeout=30'],
    ['allowMultiline',{allowMultiline:false},'dig example.test\necho second'],
    ['maxCommandBytes',{maxCommandBytes:5},'dig example.test'],
  ] as const){
    await setPolicy(policy);const error=await h.reject('/v1/tasks/submit',await payload(command,`restricted-${rule}`),'INVALID_EXECUTION_WORKBOOK');assert.deepEqual(Object.fromEntries(['row','autoid','object','method','policy'].map(key=>[key,error.details[key]])),{row:4,autoid:'301',object:'test_env',method:'routera',policy:rule});
  }
  await setPolicy({allowedCommands:['dig example.test'],maxTimeoutSeconds:15,allowMultiline:false,maxCommandBytes:200});
  assert.equal((await h.request('/v1/tasks/submit',await payload('dig example.test,timeout=5','policy-allowed'))).phase,'admitted');
  await setPolicy(null);const accepted=await h.request('/v1/tasks/submit',await payload('curl http://service.example.test/','policy-tightened-after-admission'));
  await setPolicy({allowedCommands:['dig example.test']});await h.startWorker();await h.phase(accepted.taskId,'failed',30_000);
  const failure=(await h.request(`/v1/tasks/${accepted.taskId}/result`)).error;assert.equal(failure.code,'INVALID_EXECUTION_WORKBOOK');assert.deepEqual(Object.fromEntries(['row','autoid','object','method','policy'].map(key=>[key,failure.details[key]])),{row:4,autoid:'301',object:'test_env',method:'routera',policy:'allowedCommands'});assert.ok(failure.details.evidenceId);assert.equal(gateway.state.calls.length,0);
});
