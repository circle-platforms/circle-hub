// Personal content has an empty server view after purge; a password session may start a fresh Hub epoch.
import {axisUiLabel,uiLabelOf,SyncModeSchema} from '../../../contracts/generated/vocabulary.ts';
import {RecordsError} from '../../records/api.ts';
import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
import type {PageContext} from './pages.ts';
import {html,type Html} from './html.ts';
import {card} from './ui.ts';
export async function personalLocal(ctx:PageContext):Promise<boolean>{return await ctx.deps.records.personalPayloads?.mode(ctx.principal.id)===SyncModeSchema.enum.local;}
export async function personalSyncNotice(ctx:PageContext):Promise<Html>{
 if(!await personalLocal(ctx))return html``;
 const state=await ctx.deps.records.personalSync?.state(ctx.principal);
 return card({title:axisUiLabel('sync_mode')},html`<p>${uiLabelOf('sync_mode','local')}</p>${state?html`<form method="post" action="/console/knowledge/do/sync-resume"><input type="hidden" name="csrf" value="${ctx.csrf??''}"><input type="hidden" name="epoch" value="${state.epoch}"><input type="hidden" name="expected_state" value="${state.state_version}"><button class="btn primary" type="submit">${uiLabelOf('sync_mode','hub')}</button></form>`:''}`);
}

/** A rendered form cannot restore content from an epoch that has since been purged. */
export async function checkPersonalFormEpoch(ctx:PageContext,expected:string|undefined|null):Promise<void>{
 if(expected&&(await ctx.deps.records.personalSync?.state(ctx.principal))?.epoch!==expected)throw new RecordsError(PROTOCOL_CODES.SYNC_EPOCH_CHANGED.when,{code:'SYNC_EPOCH_CHANGED'});
}
