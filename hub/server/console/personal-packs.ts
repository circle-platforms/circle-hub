import {PROTOCOL_CODES} from '../../../contracts/generated/protocol.ts';
// Member publication uses the same publisher as team packs, with an explicit personal namespace and owner-bound stages.
import {grantDialog,checkTable,grantPreviewLocation} from './grant-dialog.ts';
import {currentAudience} from './space-layout.ts';
import { rm } from 'node:fs/promises';
import { KNOWLEDGE_GRANTEE, KnowledgeGranteeSchema, isKnowledgeGrantAction, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { AccessError, RecordsError } from '../../records/api.ts';
import type { PackListing } from '../../ports.ts';
import { code, html, link, table, pageLayout, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import {when} from './ui.ts';
import {panel as card,areaPage as page,field,technical,dialog,actionLink} from './presentation.ts';
import { unpackZip } from './upload.ts';
import { PackStaging, stagedDigest } from './staging.ts';

export function personalPackForm(ctx:PageContext,action:string,fields:Html,label:string,multipart=false,disabled=false):Html{
  return html`<form method="post" action="/console/packs/do/${action}"${multipart?html` enctype="multipart/form-data"`:''}><input type="hidden" name="csrf" value="${ctx.csrf??''}">${fields}<button class="ch-btn ${action==='retire'||action==='revoke'?'ch-btn--danger':action==='discard'?'ch-btn--secondary':'ch-btn--primary'}" type="submit"${disabled?html` disabled`:html``}>${label}</button></form>`;
}
export async function personalPublishPage(ctx:PageContext,staging:PackStaging):Promise<PageResult>{
 if(!ctx.deps.registry?.personal)return neutralPage(ctx);
 const stages=staging.list(ctx.principal.id).filter(stage=>stage.space===ctx.principal.id),selected=ctx.url.searchParams.get('stage'),stage=stages.find(stage=>stage.id===selected);
 if(selected&&!stage)return neutralPage(ctx);
 const inspector=stage?html`<div data-inspector-content><span class="ch-tag">发布内容</span><h2 class="ch-panel-title">等待发布中</h2><p>到期时间 ${when(new Date(stage.expires).toISOString())}</p>${technical(code(stage.pack+'@'+stage.version),'查看待发布版本')}<footer class="ch-inspector-actions">${personalPackForm(ctx,'discard',html`<input type="hidden" name="stage" value="${stage.id}">`,'放弃')}${personalPackForm(ctx,'publish',html`<input type="hidden" name="stage" value="${stage.id}">`,'确认发布')}</footer></div>`:undefined;
 const upload=card({title:'上传发布内容',hint:'上传含 pack.json 的 zip，校验通过后暂存 30 分钟，确认时再次校验；私人内容不能请求团队资源、租约或外部效果。'},personalPackForm(ctx,'stage',field('发布内容 zip',html`<input type="file" name="archive" accept=".zip,application/zip" required>`),'上传并校验',true));
 const listing=card({title:'等待发布中'},table(['发布内容','到期时间'],stages.map((item,index)=>[link('/console/packs/-/publish','待发布内容 '+(index+1),{stage:item.id}),when(new Date(item.expires).toISOString())]),'没有暂存的发布内容',undefined,{selected:stages.findIndex(item=>item.id===selected),hrefs:stages.map(item=>'/console/packs/-/publish?'+new URLSearchParams({stage:item.id}))}));
 return {status:200,body:page(ctx.chrome('发布我的工作流或通用技能',{active:'packs',hint:'内容保存在 Hub 数据库和服务器备份中，仅本人及获分享权限者可用，管理员没有默认读权；沿用团队包的结构、沙箱、样例、引用与凭据校验'}),pageLayout(html`${upload}${listing}`,{inspector,detail:!!stage,back:link('/console/packs/-/publish','返回发布列表')}))};
}
export async function personalPackControls(ctx:PageContext,pack:PackListing):Promise<{body:Html;actions:Html}>{
  const personal=ctx.deps.registry?.personal;if(!personal||pack.space!==ctx.principal.id)return {body:html``,actions:html``};
  const fields=html`<input type="hidden" name="pack" value="${pack.id}"><input type="hidden" name="version" value="${pack.version}">`;
  const grants=await personal.grants(ctx.principal,pack.id);
  const audience=await currentAudience(ctx,pack.space,'/',false,pack.id);
  const targets=ctx.url.searchParams.get('grant_audience')==='administrators'?(await ctx.deps.records.principals.list()).filter(u=>!u.disabled&&u.role==='admin'):ctx.url.searchParams.get('grant_member')?[await ctx.deps.records.principals.findByName(ctx.url.searchParams.get('grant_member')!)].filter((u):u is NonNullable<typeof u>=>!!u&&!u.disabled):undefined;
  const sharingDialog=await grantDialog(ctx,{id:'grant-pack',workflow:true,trigger:false,content:pack.title+' · 仅可使用',current:audience.text,checks:await personal.precheckGrant(ctx.principal,pack.id,targets),grants,fields,form:(action,controls,label,disabled)=>personalPackForm(ctx,action,controls,label,false,disabled)});
  const canPublish=await ctx.deps.records.authorizations.canPublish(ctx.principal.id);
  const checked=ctx.url.searchParams.get('promote')==='1'?await personal.precheckPromotion(ctx.principal,pack.id+'@'+pack.version):null;
  const preview=checked?dialog('promote-personal-pack','发布到团队',html`<p>我的版本与分享保留；团队版本独立，确认时重新检查。</p><p>我的：保留不变 · ${audience.text}</p><p>团队：${uiLabelOf('audience_scope','team')}</p>${checkTable(checked.checks)}`,personalPackForm(ctx,'promote',fields,'确认发布到团队',false,!checked.ok)):html``;
  const body=html`<p>使用范围：${audience.text}</p>${sharingDialog}${preview}`;
  const retire=pack.withdrawn?html``:dialog('retire-personal-pack','下架我的版本',html`<p>停止新运行使用；版本记录仍按原摘要读取。</p>`,personalPackForm(ctx,'retire',fields,'下架此版本'));
  return {body:html`${body}${retire}`,actions:html`${pack.withdrawn?'':actionLink('#retire-personal-pack','下架…','danger')}${actionLink('#grant-pack','分享…')}${canPublish?actionLink('/console/packs/'+pack.id+'?'+new URLSearchParams({space:pack.space!,promote:'1'})+'#promote-personal-pack','分享到团队…'):html`<button class="ch-btn ch-btn--secondary" disabled title="没有发布权">分享到团队…</button>`}`};

}
export async function performPersonalPackAction(ctx:PageContext,action:string,values:{get(key:string):string|null|undefined},staging:PackStaging,upload?:{bytes:Buffer}):Promise<string>{
  const personal=ctx.deps.registry?.personal;if(!personal)throw new AccessError('对象不存在或无权读取');
  const get=(key:string)=>values.get(key)??'';
  if(action==='stage'){
    if(!upload)throw new RecordsError('请选择发布内容 zip');
    const unpacked=await unpackZip(upload.bytes);let kept=false;
    try{const checked=await personal.check(ctx.principal,unpacked.dir);if(!checked.ok)throw new RecordsError('发布校验未通过：'+checked.problems.map(row=>row.rule).join('、'));const stage=await staging.add(ctx.principal.id,unpacked,ctx.principal.id);kept=stage!==null;if(!stage)throw new RecordsError('暂存未完成，请重新上传');}finally{if(!kept)await rm(unpacked.root,{recursive:true,force:true});}
    return '/console/packs/-/publish';
  }
  if(action==='publish'||action==='discard'){
    const opened=await staging.open(get('stage'),ctx.principal.id);if(opened?.stage.space!==ctx.principal.id)throw new AccessError('对象不存在或无权读取');
    const taken=await staging.take(get('stage'),ctx.principal.id);if(!taken)throw new AccessError('对象不存在或无权读取');
    try{if(action==='publish'){if((await stagedDigest(taken.dir))?.digest!==taken.stage.digest)throw new RecordsError('暂存内容发生变化，请重新上传并校验');const published=await personal.publish(ctx.principal,taken.dir);if(!published.ok)throw new RecordsError('发布校验未通过：'+published.problems.map(row=>row.rule).join('、'));}}finally{await taken.done();}
    return '/console/packs';
  }
  const pack=get('pack');
  if(action==='grant'&&get('preview_grant')==='1')return grantPreviewLocation('/console/packs/'+encodeURIComponent(pack),{space:ctx.principal.id},'grant-pack',values);
  if(isKnowledgeGrantAction(action)){
    const audience=KnowledgeGranteeSchema.parse(get('audience'));
    const member=get('member_id')||(get('member')?(await ctx.deps.records.principals.findByName(get('member')))?.id:null);
    await personal.grant(ctx.principal,pack,{audience,member:member??null,revoke:action==='revoke'});
  }else if(action==='retire')await personal.retire(ctx.principal,pack,get('version'));
  else if(action==='promote'){const published=await personal.promote(ctx.principal,pack+'@'+get('version'));if(!published.ok)throw new RecordsError('发布校验未通过：'+published.problems.map(row=>row.rule).join('、'));return '/console/packs/'+encodeURIComponent(pack);}
  else throw new AccessError('对象不存在或无权读取');
  return '/console/packs/'+encodeURIComponent(pack)+'?space='+encodeURIComponent(ctx.principal.id);
}
