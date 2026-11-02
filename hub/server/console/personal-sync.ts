// Console settings use password sessions and CSRF-protected console routes, never the Bearer-only sync API.
import {randomUUID} from 'node:crypto';
import {axisUiLabel,uiLabelOf,SyncModeSchema,SyncStatusSchema} from '../../../contracts/generated/vocabulary.ts';
import {RecordsError} from '../../records/api.ts';
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import type {PageContext} from './pages.ts';
import {html,link,type Html} from './html.ts';
import {card} from './ui.ts';
import {timestamp,size} from './knowledge-display.ts';
export async function personalLocal(ctx:PageContext):Promise<boolean>{return await ctx.deps.records.personalPayloads?.mode(ctx.principal.id)===SyncModeSchema.enum.local;}
export async function personalSyncNotice(ctx:PageContext):Promise<Html>{
 const sync=ctx.deps.knowledge.personalSync,api=ctx.deps.records.personalSync;if(!sync||!api)return html``;
 const state=await api.state(ctx.principal),local=state.mode===SyncModeSchema.enum.local;
 let control:Html;
 const hidden=html`<input type="hidden" name="csrf" value="${ctx.csrf??''}"><input type="hidden" name="epoch" value="${state.epoch}"><input type="hidden" name="operation_id" value="${randomUUID()}">`;
 if(local)control=html`<p>本机副本不受影响；同步到 Hub 的个人内容保存在 Hub 数据库和服务器备份中。</p><form method="post" action="/console/knowledge/do/sync-resume">${hidden}<input type="hidden" name="expected_state" value="${state.state_version}"><button class="btn primary" type="submit">${uiLabelOf('sync_mode','hub')}</button></form>`;
 else if(ctx.url.searchParams.get('sync')===SyncModeSchema.enum.local){
  const impact=await sync.modeCheck(ctx.principal,{mode:SyncModeSchema.enum.local});
  control=html`<p>将清除 Hub 上的个人知识、原文、记忆和历史内容，个人文件夹授权随之失效。未完成的提交共享检查将在确认时重新核验。团队副本保留，本机副本不受影响。恢复清除前的备份会带回旧内容。</p><p>个人内容 ${size(impact.personal_bytes)} · 文件夹授权 ${impact.directory_grants} · 已生成的团队副本 ${impact.team_copies_preserved}</p><form method="post" action="/console/knowledge/do/sync-mode">${hidden}<input type="hidden" name="expected_state" value="${impact.expected_state}"><input type="hidden" name="mode" value="${SyncModeSchema.enum.local}"><input type="hidden" name="check" value="${impact.check}"><label><input type="checkbox" name="confirm_purge" value="true" required>确认清除服务器上的个人内容</label><button class="btn danger" type="submit">${uiLabelOf('sync_mode','local')}</button></form>`;
 }else control=link('/console/knowledge','更改同步方式',{scope:'personal',sync:SyncModeSchema.enum.local});
 return card({title:axisUiLabel('sync_mode')},html`<p>${uiLabelOf('sync_mode',state.mode)} · ${uiLabelOf('sync_status',state.status)}</p><p>${uiLabelOf('sync_field','last_synced_at')}：${state.last_synced_at?timestamp(state.last_synced_at):'—'}</p>${state.status===SyncStatusSchema.enum.conflicted?html`<p>${uiLabelOf('sync_status','conflicted')} · ${await api.transact(ctx.principal,state.epoch,async(scope,tx)=>Number((await api.head(ctx.principal,scope.epoch,tx)).conflicts))}</p>`:''}${control}`);
}
/** A rendered form cannot restore content from an epoch that has since been purged. */
export async function checkPersonalFormEpoch(ctx:PageContext,expected:string|undefined|null):Promise<void>{
 if(expected&&(await ctx.deps.records.personalSync?.state(ctx.principal))?.epoch!==expected)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});
}
