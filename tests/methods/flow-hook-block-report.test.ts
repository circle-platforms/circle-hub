import assert from 'node:assert/strict';
import test from 'node:test';
import {ApiError,ExecutionReport,canonicalJson,sha256} from '../../packages/contracts/src/index.ts';
import {executeFlowStep} from '../../packages/execution/src/flow-worker.ts';
import {dispatchHookMetadata,verifiedDispatchHookBlock} from '../../packages/execution/src/flow-hooks.ts';

test('A first Flow check refusal returns a fenced failed report without any dispatch or stopping claim',async()=>{
 const claim={operationId:'op_fixture',fencingToken:7,inputRevisionId:'inrev_fixture'};let events=0,checks=0;
 const report=ExecutionReport.parse(await executeFlowStep(claim,{directory:'unused',signal:new AbortController().signal,check:async()=>{checks++;throw new ApiError('HOOK_FAILED','Approved Hook blocked dispatch');},event:async()=>{events++;throw new Error('No event may run');}}));
 assert.equal(checks,1);assert.equal(events,0);assert.equal(report.status,'failed');assert.equal(report.fencingToken,7);assert.equal(report.inputRevisionId,claim.inputRevisionId);assert.equal(report.error?.code,'HOOK_FAILED');assert.equal(report.error?.details?.sideEffects,'none');assert.equal(report.output.remoteStoppingVerified,false);assert.ok(!Object.hasOwn(report.output,'remoteLeaseReleased'));
});

function fixture(){
 const task={taskId:'task_fixture',inputRevisionId:'inrev_fixture',tenantId:'tnt_fixture',scopeId:'scp_fixture'},pin={assetId:'ast_fixture',version:'1.0.0',sha256:'a'.repeat(64)},run={binding:{inputSha256:'b'.repeat(64),method:pin,resources:{gateway:pin},sources:{input:pin}},definition:{profiles:{gateway:pin}}},row={operation_id:'op_fixture',worker_id:'worker_fixture',task_id:task.taskId,input_revision_id:task.inputRevisionId,tenant_id:task.tenantId,scope_id:task.scopeId,fencing_token:7,source_effect:'write',kind:'provider.call'},step:any={operation_id:row.operation_id,task_id:task.taskId,input_revision_id:task.inputRevisionId,kind:'provider.call',action:{resource:'gateway'},intent:false,terminal:false,remote_identity:null,request_hash:'c'.repeat(64)};
 const content={method:pin,resource:pin,inputRevisionId:task.inputRevisionId,requestHash:step.request_hash,preparationDigest:null,subjectSha256:'d'.repeat(64),decisions:[{ruleId:'synthetic-rule',event:'beforeDispatch',result:{decision:'block',code:'HOOK_FAILED'}}]},bytes=Buffer.from(canonicalJson(content)),authorityDigest='e'.repeat(64),evidence:any={evidence_id:'evd_fixture',tenant_id:task.tenantId,scope_id:task.scopeId,task_id:task.taskId,input_revision_id:task.inputRevisionId,operation_id:row.operation_id,kind:'flow-before-dispatch-'+authorityDigest,sha256:sha256(bytes),size:bytes.length,object_key:sha256(bytes)};
 step.before_dispatch_ref={evidenceId:evidence.evidence_id,sha256:evidence.sha256,size:evidence.size,status:'failed',authorityDigest,fencingToken:7,metadataDigest:dispatchHookMetadata(task,row,run,step)};
 const report={status:'failed',error:{code:'HOOK_FAILED'}},check=(data:any={})=>verifiedDispatchHookBlock({query:async()=>({rows:[data.evidence??evidence]})},{getObject:async()=>data.bytes??bytes},data.task??task,data.row??row,data.run??run,data.step??step,data.report??report);
 return {task,run,row,step,content,bytes,evidence,report,check};
}

test('Only the current C block decision and its exact B original prove a mandatory pre-intent refusal',async()=>{
 const f=fixture();assert.deepEqual(await f.check(),{evidenceId:f.evidence.evidence_id,sha256:f.evidence.sha256,operationId:f.row.operation_id,ruleIds:['synthetic-rule']});
 for(const patch of [{intent:true},{terminal:true},{remote_identity:{remoteId:'remote_fixture'}},{kind:'tool.call'},{before_dispatch_ref:null},{before_dispatch_ref:{...f.step.before_dispatch_ref,status:'succeeded'}},{before_dispatch_ref:{...f.step.before_dispatch_ref,fencingToken:8}},{before_dispatch_ref:{...f.step.before_dispatch_ref,metadataDigest:'0'.repeat(64)}},{input_revision_id:'inrev_other'}])assert.equal(await f.check({step:{...f.step,...patch}}),undefined);
 for(const patch of [{source_effect:'read'},{kind:'reconcile'},{tenant_id:'tnt_other'},{scope_id:'scp_other'},{worker_id:'worker_other'},{operation_id:'op_other'},{fencing_token:8}])assert.equal(await f.check({row:{...f.row,...patch}}),undefined);
 for(const key of ['evidence_id','tenant_id','scope_id','task_id','input_revision_id','operation_id','kind','sha256'])assert.equal(await f.check({evidence:{...f.evidence,[key]:'other'}}),undefined);
 assert.equal(await f.check({bytes:Buffer.from('{}')}),undefined);assert.equal(await f.check({report:{status:'succeeded'}}),undefined);
 // Even a worker's registered refusal code cannot substitute for C's proof.
 assert.equal(await f.check({step:{...f.step,before_dispatch_ref:null},report:f.report}),undefined);
 for(const patch of [{method:{...f.content.method,version:'2.0.0'}},{resource:{...f.content.resource,sha256:'0'.repeat(64)}},{inputRevisionId:'inrev_other'},{requestHash:'0'.repeat(64)},{preparationDigest:'0'.repeat(64)},{decisions:[{event:'afterResult',result:{decision:'block'}}]},{decisions:[{event:'beforeDispatch',result:{decision:'pass'}}]}]){
  const bytes=Buffer.from(canonicalJson({...f.content,...patch})),evidence={...f.evidence,sha256:sha256(bytes),size:bytes.length},step={...f.step,before_dispatch_ref:{...f.step.before_dispatch_ref,sha256:evidence.sha256,size:evidence.size}};assert.equal(await f.check({bytes,evidence,step}),undefined);
 }
});
