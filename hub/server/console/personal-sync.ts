// Console settings use password sessions and CSRF-protected console routes, never the Bearer-only sync API.
import {randomUUID} from 'node:crypto';
import {axisUiLabel,uiLabelOf,SyncModeSchema,SyncStatusSchema} from '../../../contracts/generated/vocabulary.ts';
import {RecordsError} from '../../records/api.ts';
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import type {PageContext} from './pages.ts';
import {html,href,type Html} from './html.ts';
import {panel,facts,badge,dialog,actionLink,tooltip,stat,technical} from './presentation.ts';
import {timestamp,size,number} from './knowledge-display.ts';
import {tokenClient,UNREPORTED_CLIENT} from './client-provenance.ts';
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
  confirmation=dialog('sync-resume',uiLabelOf('sync_mode','hub'),html`<p>重新连接后从客户端设备上的副本同步。同步到 Hub 的私人内容保存在 Hub 数据库和服务器备份中，先前的分享不会恢复。</p>`,resume);
  control=actionLink('#sync-resume',uiLabelOf('sync_mode','hub'),'primary');
 }else if(ctx.url.searchParams.get('sync')===SyncModeSchema.enum.local){
  const impact=await sync.modeCheck(ctx.principal,{mode:SyncModeSchema.enum.local});
  const purge=html`<form id="sync-mode-form" method="post" action="/console/knowledge/do/sync-mode">${hidden}<input type="hidden" name="expected_state" value="${impact.expected_state}"><input type="hidden" name="mode" value="${SyncModeSchema.enum.local}"><input type="hidden" name="check" value="${impact.check}"><button class="ch-btn ch-btn--danger" type="submit">${uiLabelOf('sync_mode','local')}</button></form>`;
  confirmation=dialog('sync-mode',uiLabelOf('sync_mode','local'),html`<p>清除 Hub 上的私人知识、原文、记忆和版本记录，文件夹分享随之失效。确认时重新检查待完成的分享到团队操作。</p>${purgeFacts(impact)}${runCitationText(impact)}<p>团队副本保留，客户端设备上的副本不受影响。恢复清除前的备份会带回旧内容。</p><label class="ch-field"><span><input type="checkbox" name="confirm_purge" value="true" required form="sync-mode-form">确认清除 Hub 上的私人空间内容</span></label>`,purge);
  control=actionLink('#sync-mode','清除 Hub 副本…','danger');
 }else control=actionLink(location(ctx,SyncModeSchema.enum.local)+'#sync-mode',uiLabelOf('sync_mode','local')+'…');
 const conflicts=state.status===SyncStatusSchema.enum.conflicted?await api.transact(ctx.principal,state.epoch,async(scope,tx)=>Number((await api.head(ctx.principal,scope.epoch,tx)).conflicts)):0;
 const details=html`${facts([[uiLabelOf('sync_field','last_synced_at'),state.last_synced_at?timestamp(state.last_synced_at):'—']])}${conflicts?html`${stat(uiLabelOf('sync_status','conflicted'),conflicts)}<p class="ch-meta">冲突版本保留，等待客户端选择后同步；未解决的记忆不用于新会话。</p>`:''}${local?html`<p>Hub 上的当前私人空间为空；本机副本与团队副本保留，运行引用过的私人原文已一并清除。</p>`:html`<p class="ch-meta">${tooltip('知识与记忆共用同步方式','同步到 Hub 的私人内容保存在 Hub 数据库和服务器备份中，仅本人及当前获分享权限者可读。')}</p>`}`;
 const actions=html`<footer class="ch-inspector-actions">${control}</footer>`;
 const pending=local?html``:await purgeRequestPanel(ctx,state.epoch);
 if(selected)return html`<div data-sync-settings data-inspector-content><div class="ch-actions"><span class="ch-tag">${axisUiLabel('sync_mode')}</span>${status}</div><h2 class="ch-panel-title">${uiLabelOf('sync_mode',state.mode)}</h2>${pending}${details}${actions}${confirmation}</div>`;
 // Decision 151: on the list page the setting is one line of facts with the way to change it; the controls, the
 // confirmation and the explanation are in the pane that 更改… opens. What needs attention stays visible: a pending purge,
 // unresolved conflicts, and that the Hub copy is empty, with the one action that state has (sync to the Hub again).
 const attention=html`${pending}${conflicts?html`<p class="ch-meta">${uiLabelOf('sync_status','conflicted')} ${conflicts.toLocaleString('en-US')}：冲突版本保留，等待客户端选择后同步；未解决的记忆不用于新会话。</p>`:''}${local?html`<p class="ch-meta">Hub 上的当前私人空间为空；本机副本与团队副本保留，运行引用过的私人原文已一并清除。</p>${actions}${confirmation}`:''}`;
 return html`<div data-sync-settings><p class="ch-meta" data-sync-line>${tooltip(axisUiLabel('sync_mode'),'知识与记忆共用同步方式。同步到 Hub 的私人内容保存在 Hub 数据库和服务器备份中，仅本人及当前获分享权限者可读。')}：${uiLabelOf('sync_mode',state.mode)} ${status} · ${uiLabelOf('sync_field','last_synced_at')} ${state.last_synced_at?timestamp(state.last_synced_at):'—'} · <a href="${location(ctx,'settings')}">更改…</a></p>${attention}</div>`;
}
type Impact={personal_bytes:number;directory_grants:number;team_copies_preserved:number;run_held_originals?:number;affected_runs?:number};
const purgeFacts=(impact:Impact)=>facts([['清除内容',size(impact.personal_bytes)],['文件夹分享',number(impact.directory_grants)],['保留的团队副本',number(impact.team_copies_preserved)],['运行引用的私人原文',number(impact.run_held_originals??0)],['受影响的运行',number(impact.affected_runs??0)]]);
/** Owner ruling 3 (issue 141): the confirmation says that cited originals go too and what the runs then show. */
function runCitationText(impact:Impact):Html{
 if(!impact.run_held_originals)return html`<p class="ch-meta">没有运行引用这些私人原文。</p>`;
 return html`<p data-purge-run-citations>运行引用过的 ${number(impact.run_held_originals)} 份私人原文一并清除；${number(impact.affected_runs??0)} 次运行的根据将标为“${uiLabelOf('validity_status','grounds_purged')}”，原因：${PROTOCOL_CODES.GROUNDS_PURGED.when}。运行记录和摘要保留。</p>`;
}
/** Purges a client asked for over the sync API: they run only after the owner confirms here (capability purge-confirmation). */
async function purgeRequestPanel(ctx:PageContext,epoch:string):Promise<Html>{
 const api=ctx.deps.records.personalSync,sync=ctx.deps.knowledge.personalSync;if(!api||!sync)return html``;
 const requests=await api.purgeRequests(ctx.principal);if(!requests.length)return html``;
 const impact=await sync.modeCheck(ctx.principal,{mode:SyncModeSchema.enum.local});
 const rows=await Promise.all(requests.map(async ({digest,body})=>{
  const client=await tokenClient(ctx,ctx.principal.id,body.token);
  const id='sync-purge-'+digest.slice(0,12);
  const confirm=html`<form id="${id}-form" method="post" action="/console/knowledge/do/sync-confirm-purge"><input type="hidden" name="csrf" value="${ctx.csrf??''}"><input type="hidden" name="epoch" value="${epoch}"><input type="hidden" name="record" value="${digest}"><button class="ch-btn ch-btn--danger" type="submit">确认清除</button></form>`;
  return html`<li><p>${client?.name??UNREPORTED_CLIENT} 请求清除 Hub 副本 · ${timestamp(body.at)}，${timestamp(body.expires_at)} 前有效</p>${technical(html`${facts([['名称来源',client?.origin??'未记录'],['同步请求',body.http_request]])}`)}${actionLink('#'+id,'确认清除…','danger')}${dialog(id,'确认清除 Hub 副本',html`<p>清除 Hub 上的私人知识、原文、记忆和版本记录，文件夹分享随之失效。团队副本与本机副本保留；恢复清除前的备份会带回旧内容。确认后，该客户端重试同一请求即可得到结果。</p>${purgeFacts(impact)}${runCitationText(impact)}<label class="ch-field"><span><input type="checkbox" name="confirm_purge" value="true" required form="${id}-form">确认清除 Hub 上的私人空间内容</span></label>`,confirm)}</li>`;
 }));
 return html`<section class="ch-section" data-sync-purge-requests><h3>待确认的清除请求</h3><p class="ch-meta">客户端经同步接口请求清除时，只有在这里确认后才会执行。</p><ul class="ch-feed">${rows}</ul></section>`;
}
/** A rendered form cannot restore content from an epoch that has since been purged. */
export async function checkPersonalFormEpoch(ctx:PageContext,expected:string|undefined|null):Promise<void>{
 if(expected&&(await ctx.deps.records.personalSync?.state(ctx.principal))?.epoch!==expected)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});
}
