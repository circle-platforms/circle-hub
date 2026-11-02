// Console settings use password sessions and CSRF-protected console routes, never the Bearer-only sync API.
import {randomUUID} from 'node:crypto';
import {axisUiLabel,uiLabelOf,SyncModeSchema,SyncStatusSchema} from '../../../contracts/generated/vocabulary.ts';
import {RecordsError} from '../../records/api.ts';
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import type {PageContext} from './pages.ts';
import {html,href,type Html} from './html.ts';
import {panel,facts,badge,dialog,actionLink,tooltip,stat} from './presentation.ts';
import {timestamp,size,number} from './knowledge-display.ts';
export async function personalLocal(ctx:PageContext):Promise<boolean>{return await ctx.deps.records.personalPayloads?.mode(ctx.principal.id)===SyncModeSchema.enum.local;}
export const syncSelected=(ctx:PageContext)=>ctx.url.searchParams.has('sync');
const location=(ctx:PageContext,sync?:string)=>href('/console/knowledge',{scope:'personal',...(ctx.url.searchParams.get('view')==='memory'?{view:'memory'}:{}),sync});
export async function personalSyncNotice(ctx:PageContext):Promise<Html>{
 const sync=ctx.deps.knowledge.personalSync,api=ctx.deps.records.personalSync;if(!sync||!api)return html``;
 const state=await api.state(ctx.principal),local=state.mode===SyncModeSchema.enum.local,selected=syncSelected(ctx);
 const hidden=html`<input type="hidden" name="csrf" value="${ctx.csrf??''}"><input type="hidden" name="epoch" value="${state.epoch}"><input type="hidden" name="operation_id" value="${randomUUID()}">`;
 const status=badge(uiLabelOf('sync_status',state.status),state.status===SyncStatusSchema.enum.conflicted?'incomplete':state.status===SyncStatusSchema.enum.complete?'pass':null);
 let confirmation=html``,control:Html;
 if(local){
  const resume=html`<form method="post" action="/console/knowledge/do/sync-resume">${hidden}<input type="hidden" name="expected_state" value="${state.state_version}"><button class="ch-btn ch-btn--primary" type="submit">${uiLabelOf('sync_mode','hub')}</button></form>`;
  confirmation=dialog('sync-resume',uiLabelOf('sync_mode','hub'),html`<p>重新连接后从本机副本同步。同步到 Hub 的私人内容保存在 Hub 数据库和服务器备份中，先前的分享不会恢复。</p>`,resume);
  control=actionLink('#sync-resume',uiLabelOf('sync_mode','hub'),'primary');
 }else if(ctx.url.searchParams.get('sync')===SyncModeSchema.enum.local){
  const impact=await sync.modeCheck(ctx.principal,{mode:SyncModeSchema.enum.local});
  const purge=html`<form id="sync-mode-form" method="post" action="/console/knowledge/do/sync-mode">${hidden}<input type="hidden" name="expected_state" value="${impact.expected_state}"><input type="hidden" name="mode" value="${SyncModeSchema.enum.local}"><input type="hidden" name="check" value="${impact.check}"><button class="ch-btn ch-btn--danger" type="submit">${uiLabelOf('sync_mode','local')}</button></form>`;
  confirmation=dialog('sync-mode',uiLabelOf('sync_mode','local'),html`<p>清除 Hub 上的私人知识、原文、记忆和版本记录，文件夹分享随之失效。确认时重新检查待完成的分享到团队操作。</p>${facts([['清除内容',size(impact.personal_bytes)],['文件夹分享',number(impact.directory_grants)],['保留的团队副本',number(impact.team_copies_preserved)]])}<p>团队副本与运行中独立持有的原文保留，本机副本不受影响。恢复清除前的备份会带回旧内容。</p><label class="ch-field"><span><input type="checkbox" name="confirm_purge" value="true" required form="sync-mode-form">确认清除 Hub 上的私人空间内容</span></label>`,purge);
  control=actionLink('#sync-mode','清除 Hub 副本…','danger');
 }else control=actionLink(location(ctx,SyncModeSchema.enum.local)+'#sync-mode',uiLabelOf('sync_mode','local')+'…');
 const conflicts=state.status===SyncStatusSchema.enum.conflicted?await api.transact(ctx.principal,state.epoch,async(scope,tx)=>Number((await api.head(ctx.principal,scope.epoch,tx)).conflicts)):0;
 const details=html`${facts([[uiLabelOf('sync_field','last_synced_at'),state.last_synced_at?timestamp(state.last_synced_at):'—']])}${conflicts?html`${stat(uiLabelOf('sync_status','conflicted'),conflicts)}<p class="ch-meta">冲突版本保留，等待客户端选择后同步；未解决的记忆不用于新会话。</p>`:''}${local?html`<p>Hub 上的当前私人空间为空；本机副本、团队副本与运行中独立持有的原文保留。</p>`:html`<p class="ch-meta">${tooltip('知识与记忆共用同步方式','同步到 Hub 的私人内容保存在 Hub 数据库和服务器备份中，仅本人及当前获分享权限者可读。')}</p>`}`;
 const actions=html`<footer class="ch-inspector-actions">${control}</footer>`;
 if(selected)return html`<div data-sync-settings data-inspector-content><div class="ch-actions"><span class="ch-tag">${axisUiLabel('sync_mode')}</span>${status}</div><h2 class="ch-panel-title">${uiLabelOf('sync_mode',state.mode)}</h2>${details}${actions}${confirmation}</div>`;
 return html`<div data-sync-settings>${panel({title:axisUiLabel('sync_mode'),tail:actionLink(location(ctx,'settings'),'更改…','ghost')},html`<p>${uiLabelOf('sync_mode',state.mode)} ${status}</p>${details}${actions}${confirmation}`)}</div>`;
}
/** A rendered form cannot restore content from an epoch that has since been purged. */
export async function checkPersonalFormEpoch(ctx:PageContext,expected:string|undefined|null):Promise<void>{
 if(expected&&(await ctx.deps.records.personalSync?.state(ctx.principal))?.epoch!==expected)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});
}
