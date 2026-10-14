import {canonicalJson,sha256} from '../../contracts/src/index.ts';

const ids=['inputRevisionId','requestId','approvalId','operationId','changeSetId','botAssetId','triggerAssetId','occurrenceKey','supersededBy','assigneeId','remoteTaskId','artifactId','assetId','sourceRevisionId','sourceArtifactId','workerId','methodAssetId','hookAssetId','parentOperationId'];
export const notificationKinds=['approval.requested','approval.decision','approval.superseded','change-set.decided','change-set.superseded','change-set.blocked','change-set.ready','task.waiting-input','task.waiting-review','task.delivered','task.failed','task.cancelled','operation.unknown','runtime.local-stopped','bot.started','bot.output','bot.admission-failed','task.accepted','task.assignment-changed'];
const pick=(source:any,keys:string[])=>Object.fromEntries(keys.filter(key=>typeof source?.[key]==='string'||typeof source?.[key]==='boolean'||typeof source?.[key]==='number'&&Number.isFinite(source[key])).map(key=>[key,source[key]]));

// These references point to already retained B content. They do not claim that
// the event's canonical payload itself was stored in B or shares their SHA.
export function retainedEventContent(value:any){
 const candidates=[value?.artifact,value?.evidence,value?.artifacts,value?.result?.evidence,value?.result?.artifacts].flatMap(value=>Array.isArray(value)?value:value?[value]:[]),references=new Map<string,any>();
 for(const item of candidates){if(typeof item?.artifactId!=='string'&&typeof item?.evidenceId!=='string')continue;const artifact=typeof item.artifactId==='string',id=artifact?item.artifactId:item.evidenceId;
  const reference={...(artifact?{artifactId:id}:{evidenceId:id}),...pick(item,['sha256','fileName']),downloadPath:artifact?`/v1/artifacts/${id}/content`:id.startsWith('knr_')?`/v1/knowledge/records/${id}/content`:`/v1/evidence/${id}/content`};references.set((artifact?'artifact/':'evidence/')+id,reference);
 }
 return [...references.values()];
}

export function notificationPayload(value:any){
 const result:any={};for(const id of ids)if(typeof value?.[id]==='string')result[id]=value[id];
 for(const key of ['phase','to','status','message','question','reason','outcome','waitingReason'])if(typeof value?.[key]==='string')result[key]=value[key];
 if(typeof value?.error?.code==='string'){if(result.reason===undefined)result.reason={code:value.error.code};result.error={code:value.error.code};}
 const references=retainedEventContent(value),evidence=references.filter(item=>item.evidenceId),artifacts=references.filter(item=>item.artifactId);
 if(evidence.length)result.evidence=evidence.map(item=>pick(item,['evidenceId','sha256']));
 if(Array.isArray(value?.artifacts)||artifacts.length)result.artifacts=artifacts.map(item=>pick(item,['artifactId','fileName','sha256']));
 if(Array.isArray(value?.unknowns))result.unknowns=value.unknowns.filter((item:any)=>typeof item==='string');
 Object.assign(result,pick(value,['ruleId','ruleVersion','methodId','flowVersion','capabilityPackId','channel','stage','name','decision','code','hookPoint','point','contractVersion','packVersion','fencingToken','passed','localExitObserved','remoteStoppingVerified','remoteLeaseReleased','count']));
 if(value?.trigger)result.trigger=pick(value.trigger,['kind','eventId','sourceAssetId','scheduledFor','skippedOccurrences']);
 if(value?.event){result.event=pick(value.event,['type','id','name','status','statusCode','requestBytes','responseBytes','durationMs','requestNumber']);if(value.event.runtimeProfile)result.event.runtimeProfile=pick(value.event.runtimeProfile,['assetId','version','sha256','profileSha256']);}
 return result;
}

export function projectedEvent(row:any){
 const event={seq:Number(row.seq),taskId:row.task_id,kind:row.kind,payload:notificationPayload(row.payload),createdAt:row.created_at.toISOString()};
 if(!row.task_id)return event;
 const bytes=Buffer.from(canonicalJson(row.payload)),retained=retainedEventContent(row.payload);
 return {...event,content:{sha256:sha256(bytes),size:bytes.length,downloadPath:`/v1/tasks/${row.task_id}/events/${row.seq}/content`,...(retained.length?{retained}:{})}};
}
