import {canonicalHash,requireCondition,sha256} from '../../contracts/src/index.ts';

// This symbol is internal to C. It is never accepted from a worker request or
// serialized into the worker authorization envelope.
export const DISPATCH_HOOK_WORK=Symbol('dispatch-hook-work');
export const DISPATCH_HOOK_BLOCKED=Symbol('dispatch-hook-blocked');
export const DISPATCH_HOOK_PENDING=Symbol('dispatch-hook-pending');
export function dispatchHookMetadata(task:any,row:any,run:any,step:any){return canonicalHash({operationId:row.operation_id,workerId:row.worker_id,inputRevisionId:task.inputRevisionId,inputSha256:run.binding.inputSha256,fencingToken:Number(row.fencing_token),requestHash:step.request_hash,method:run.binding.method,resource:run.binding.resources[step.action.resource],sources:run.binding.sources,runtime:run.definition.profiles[step.action.resource],preparationDigest:step.prepare_ref?.complete?step.prepare_ref.digest:null});}

export function dispatchHookAuthority(work:any){
 return canonicalHash({metadataDigest:work.metadataDigest,operationId:work.operationId,workerId:work.workerId,inputRevisionId:work.inputRevisionId,fencingToken:work.fencingToken,requestHash:work.requestHash,method:work.method,resource:work.resource,sources:work.sources,runtime:work.runtime,preparationDigest:work.preparationDigest??null,input:work.input,handlers:work.handlers.map((handler:any)=>({id:handler.id,version:handler.version,event:handler.event,order:handler.order,sha256:sha256(handler.code)}))});
}
export function freezeDispatchHookWork(value:any){return {...value,authorityDigest:dispatchHookAuthority(value)};}
export function requireFreshDispatchHookWork(previous:any,current:any){
 requireCondition(previous&&current&&previous.authorityDigest===dispatchHookAuthority(previous)&&current.authorityDigest===dispatchHookAuthority(current)&&previous.authorityDigest===current.authorityDigest,'APPROVAL_STALE','Dispatch Hook inputs changed during evaluation');
}

// A worker error is not proof of a mandatory exit refusal. Only C's retained,
// currently bound block decision can stop the flow after a failed report.
export async function verifiedDispatchHookBlock(tx:any,objects:any,task:any,row:any,run:any,step:any,report:any){
 const proof=step.before_dispatch_ref;
 if(report.status!=='failed'||row.source_effect!=='write'||row.kind==='reconcile'||step.kind!=='provider.call'||step.intent||step.terminal||step.remote_identity||proof?.status!=='failed')return undefined;
 if(row.task_id!==task.taskId||row.input_revision_id!==task.inputRevisionId||row.tenant_id!==task.tenantId||row.scope_id!==task.scopeId||step.operation_id!==row.operation_id||step.task_id!==task.taskId||step.input_revision_id!==task.inputRevisionId||proof.fencingToken!==Number(row.fencing_token)||proof.metadataDigest!==dispatchHookMetadata(task,row,run,step))return undefined;
 const kind='flow-before-dispatch-'+proof.authorityDigest,evidence=(await tx.query('SELECT * FROM evidence WHERE evidence_id=$1 AND tenant_id=$2 AND scope_id=$3 AND task_id=$4 AND input_revision_id=$5 AND operation_id=$6 AND kind=$7',[proof.evidenceId,task.tenantId,task.scopeId,task.taskId,task.inputRevisionId,row.operation_id,kind])).rows[0];
 if(!evidence||evidence.evidence_id!==proof.evidenceId||evidence.tenant_id!==task.tenantId||evidence.scope_id!==task.scopeId||evidence.task_id!==task.taskId||evidence.input_revision_id!==task.inputRevisionId||evidence.operation_id!==row.operation_id||evidence.kind!==kind||evidence.sha256!==proof.sha256||Number(evidence.size)!==proof.size)return undefined;
 const bytes=await objects.getObject({Bucket:'evidence',Key:evidence.object_key});if(bytes.length!==proof.size||sha256(bytes)!==proof.sha256)return undefined;
 let content:any;try{content=JSON.parse(bytes.toString('utf8'));}catch{return undefined;}
 if(!content||!content.method||!content.resource||canonicalHash(content.method)!==canonicalHash(run.binding.method)||canonicalHash(content.resource)!==canonicalHash(run.binding.resources[step.action.resource])||content.inputRevisionId!==task.inputRevisionId||content.requestHash!==step.request_hash||content.preparationDigest!==(step.prepare_ref?.complete?step.prepare_ref.digest:null)||!Array.isArray(content.decisions))return undefined;
 const blocked=content.decisions.filter((decision:any)=>decision.event==='beforeDispatch'&&decision.result?.decision==='block');if(!blocked.length)return undefined;
 return {evidenceId:proof.evidenceId,sha256:proof.sha256,operationId:row.operation_id,ruleIds:blocked.map((decision:any)=>decision.ruleId)};
}
