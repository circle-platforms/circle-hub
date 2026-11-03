// Read-only confirmation facts; execution remains an explicit administrator command on the Hub host.
import {randomUUID} from 'node:crypto';
import type {RecordsKit,Principal} from '../records/api.ts';
import {ConflictError,RecordsError} from '../records/api.ts';
export const DELETION_EFFECT='永久清除该成员在 Hub 的私人知识、原文、记忆和工作流。团队已取得的独立内容及已有任务合法持有的副本保留。旧密码、令牌、会话和同步请求均不能恢复该账户。此操作不可撤销。';
export const deletionRetryCommand=(member:string,operation:string)=>`circle-hub user delete ${member} --operation-id=${operation} --confirm`;
export async function deletionCheck(records:RecordsKit,by:Principal,member:string){
 if(!records.memberDeletions)throw new RecordsError('成员删除暂不可用');
 const preview=await records.memberDeletions.preview(by,member),operation_id=randomUUID();
 return {preview,operation_id,command:deletionRetryCommand(member,operation_id)+` --expected-state=${preview.state} --epoch=${preview.epoch}`};
}
export async function deleteMember(records:RecordsKit,by:Principal,member:string,operation_id:string,state?:string,epoch?:string){
 const api=records.memberDeletions;if(!api)throw new RecordsError('成员删除暂不可用');
 const progress=await api.status(by,member);
 if(progress){if(progress.intent.operation_id!==operation_id)throw new ConflictError('删除操作与已记录的操作不符');return api.finish(by,member,operation_id);}
 if(!state||!epoch)throw new ConflictError('确认前须重新检查成员及清除范围');
 const preview=await api.preview(by,member);await api.prepare(by,{...preview,state,epoch,operation_id});
 return api.finish(by,member,operation_id);
}
