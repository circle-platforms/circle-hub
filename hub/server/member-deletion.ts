import {uiLabelOf} from '../../contracts/generated/vocabulary.ts';
// Read-only confirmation facts; execution remains an explicit administrator command on the Hub host.
import {randomUUID} from 'node:crypto';
import type {RecordsKit,Principal,MemberHandoverItem} from '../records/api.ts';
import {ConflictError,RecordsError} from '../records/api.ts';
// Owner rulings 3 and 4 on issue 141: private workflows and skills go to the deleting administrator; run-held copies of
// private knowledge originals are purged with them and those runs show their grounds as unavailable.
export const DELETION_EFFECT=`永久清除该成员在 Hub 的私人知识、原文和记忆，现有私人分享失效；该成员的私人${uiLabelOf('pack_kind','workflow')}和${uiLabelOf('pack_kind','skill')}转给执行删除的管理员，分享不随之转移。团队已取得的独立内容保留；运行引用过的私人知识原文一并清除，这些运行的根据标为“${uiLabelOf('validity_status','grounds_purged')}”。仅依赖被清除私人内容的知识条目转为${uiLabelOf('knowledge_entry_status','unverified')}。旧密码、令牌、会话和同步请求均不能恢复该账户；本机副本不受影响。此操作不可撤销。`;
/**
 * The same consequences as DELETION_EFFECT, grouped by who or what they touch, for the console preview (issue 236). The host
 * command keeps the paragraph; member-deletion-effect.test.ts fails when either form drops a consequence of the other.
 */
export const DELETION_EFFECT_GROUPS:ReadonlyArray<{title:string;items:readonly string[]}>=[
 {title:'将清除',items:['该成员在 Hub 的私人知识、原文和记忆（数量见下方）','运行引用过的私人知识原文一并清除']},
 {title:'将转移',items:[`该成员的私人${uiLabelOf('pack_kind','workflow')}和${uiLabelOf('pack_kind','skill')}转给执行删除的管理员`,'分享不随之转移']},
 {title:'将保留',items:['团队已取得的独立内容保留']},
 {title:'引用和分享的影响',items:['现有私人分享失效',`引用过被清除原文的运行，其根据标为“${uiLabelOf('validity_status','grounds_purged')}”`,`仅依赖被清除私人内容的知识条目转为${uiLabelOf('knowledge_entry_status','unverified')}`]},
 {title:'账户和登录',items:['旧密码、令牌、会话和同步请求均不能恢复该账户','该成员客户端设备上的本地副本不受影响']},
 {title:'不可撤销',items:['此操作不可撤销']},
];
/** One line per handed-over version, for the console dialog and the host command. */
export function handoverLines(preview:{handover?:{to:string|null;items:MemberHandoverItem[]}}):string[]{
 const items=preview.handover?.items??[];if(!preview.handover?.to)return items.length?['执行删除的是该成员本人，私人工作流和技能不转移，随账户清除']:[];
 return items.map(item=>`${uiLabelOf('pack_kind',item.kind)} ${item.title}（${item.pack}@${item.version}）：${uiLabelOf('member_handover_status',item.status)}`);
}
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
