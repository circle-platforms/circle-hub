// All controls are read-only confirmations; the console never executes permanent member deletion.
import {deletionCheck,deletionRetryCommand,DELETION_EFFECT} from '../member-deletion.ts';
import {RecordsError} from '../../records/api.ts';
import type {MemberDeletionBody} from '../../../contracts/src/spaces.ts';
import type {PageContext} from './pages.ts';
import {html,definitions,code,type Html} from './html.ts';
import {dialog,technical,actionLink,tooltip} from './presentation.ts';
export const deletionDialogId='delete-member-confirm';
function manifestSummary(manifest:string,c:MemberDeletionBody['counts']):Html{
 return technical(html`${definitions([['记录',c.records],['载荷',c.payloads],['原件',c.objects],['来源署名',c.attributions],['归档登记',c.archives],['私人版本',c.private_versions]])}${code(manifest)}`,'查看清除清单摘要');
}
export async function memberDeletionDialog(ctx:PageContext,member:string):Promise<Html>{
 try{
  const check=await deletionCheck(ctx.deps.records,ctx.principal,member),c=check.preview.scope_counts;
  const categories=[['知识',c.knowledge],['记忆',c.memory],['原文',c.originals],['来源署名',c.attributions],['归档的原文',c.archived_originals],['私人工作流与技能',c.private_versions]];
  return dialog(deletionDialogId,'确认永久删除成员',html`<p>${DELETION_EFFECT}</p><p>${tooltip('清除范围','数量包括此前保存的版本；原文按采集次数计数，私人工作流与技能按版本计数。团队和已有任务独立持有的副本保留。')}</p><dl class="ch-section ch-list" data-deletion-scope>${categories.map(([label,count])=>html`<div class="ch-source-head"><dt>${label}</dt><dd>${count}</dd></div>`)}</dl><p>在 Hub 所在主机上的 Circle 中执行下列命令完成删除；内容变化后须重新检查。</p>${manifestSummary(check.preview.purge_manifest,check.preview.counts)}<pre class="ch-quote">${check.command}</pre>`);
 }catch(error){if(!(error instanceof RecordsError))throw error;return dialog(deletionDialogId,'删除检查未通过',html`<p role="alert">${error.message}</p><p>尚未删除成员；修正后重新检查。</p>`,actionLink('/console/team/'+member+'?deletion=preview#'+deletionDialogId,'重新检查'));}
}
export async function memberDeletionProgress(ctx:PageContext,member:string):Promise<Html>{
 const progress=await ctx.deps.records.memberDeletions?.status(ctx.principal,member);if(!progress)return html`<p>删除进度暂不可读</p>`;
 return html`<p>${progress.result?'私人内容已清除；团队内容及合法冻结副本保留。':'等待清除中。账户已永久停用；存储清理尚未完成，不能报告删除完成。'}</p>${manifestSummary(progress.intent.purge_manifest,progress.intent.counts)}${progress.result?technical(code(progress.result.record),'查看删除记录摘要'):html`<p>修复存储后，由仍启用的管理员重试同一操作。</p><pre class="ch-quote">${deletionRetryCommand(member,progress.intent.operation_id)}</pre>`}`;
}
