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
