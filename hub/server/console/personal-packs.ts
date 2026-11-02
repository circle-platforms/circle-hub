// Member publication uses the same publisher as team packs, with an explicit personal namespace and owner-bound stages.
import {grantDialog,checkTable} from './grant-dialog.ts';
import {currentAudience} from './space-layout.ts';
import { rm } from 'node:fs/promises';
import { KNOWLEDGE_GRANTEE, KnowledgeGranteeSchema, isKnowledgeGrantAction, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { AccessError, RecordsError } from '../../records/api.ts';
import type { PackListing } from '../../ports.ts';
import { code, html, link, page, table, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import { card, when } from './ui.ts';
import { unpackZip } from './upload.ts';
import { PackStaging, stagedDigest } from './staging.ts';

export function personalPackForm(ctx:PageContext,action:string,fields:Html,label:string,multipart=false,disabled=false):Html{
  return html`<form method="post" action="/console/packs/do/${action}"${multipart?html` enctype="multipart/form-data"`:''}><input type="hidden" name="csrf" value="${ctx.csrf??''}">${fields}<button class="btn mt12" type="submit"${disabled?html` disabled`:html``}>${label}</button></form>`;
}
export async function personalPublishPage(ctx:PageContext,staging:PackStaging):Promise<PageResult>{
  if(!ctx.deps.registry?.personal)return neutralPage(ctx);
  const stages=staging.list(ctx.principal.id).filter(stage=>stage.space===ctx.principal.id);
  return {status:200,body:page(ctx.chrome('发布个人工作流或通用技能',{active:'packs',hint:'内容保存在 Hub 数据库和服务器备份中，仅本人及获授权者可用，管理员没有默认读权；沿用团队包的结构、沙箱、样例、引用与凭据校验'}),html`<div class="stack">${card({title:'上传发布内容',hint:'上传含 pack.json 的 zip；校验通过后暂存 30 分钟，确认时再次校验'},personalPackForm(ctx,'stage',html`<label>发布内容 zip<input type="file" name="archive" accept=".zip,application/zip" required></label>`,'上传并校验',true))}${card({title:'等待发布中'},table(['包','到期时间','操作'],stages.map(stage=>[code(stage.pack+'@'+stage.version),when(new Date(stage.expires).toISOString()),html`${personalPackForm(ctx,'publish',html`<input type="hidden" name="stage" value="${stage.id}">`,'确认发布')}${personalPackForm(ctx,'discard',html`<input type="hidden" name="stage" value="${stage.id}">`,'放弃')}`]),'没有暂存的发布内容'))}</div>`)};
}
export async function personalPackControls(ctx:PageContext,pack:PackListing):Promise<Html>{
  const personal=ctx.deps.registry?.personal;if(!personal||pack.space!==ctx.principal.id)return html``;
  const fields=html`<input type="hidden" name="pack" value="${pack.id}"><input type="hidden" name="version" value="${pack.version}">`;
  const grants=await personal.grants(ctx.principal,pack.id);
  const audience=await currentAudience(ctx,pack.space,'/',false,pack.id);
  const targets=ctx.url.searchParams.get('grant_audience')==='administrators'?(await ctx.deps.records.principals.list()).filter(u=>!u.disabled&&u.role==='admin'):ctx.url.searchParams.get('grant_member')?[await ctx.deps.records.principals.findByName(ctx.url.searchParams.get('grant_member')!)].filter((u):u is NonNullable<typeof u>=>!!u&&!u.disabled):undefined;
  const dialog=await grantDialog(ctx,{id:'grant-pack',workflow:true,content:pack.id+'@'+pack.version+' · 仅可使用',current:audience.text,checks:await personal.precheckGrant(ctx.principal,pack.id,targets),grants,fields,form:(action,controls,label,disabled)=>personalPackForm(ctx,action,controls,label,false,disabled)});
  const canPublish=await ctx.deps.records.authorizations.canPublish(ctx.principal.id);
  const checked=ctx.url.searchParams.get('promote')==='1'?await personal.precheckPromotion(ctx.principal,pack.id+'@'+pack.version):null;
  return html`<p>使用范围：${audience.text}</p>${dialog}${card({title:'发布到团队',hint:'个人版本与授权保留；团队版本按使用范围共享。确认时重新检查，已有个人运行仍保持个人读权'},checked?html`<p>个人：保留不变 · ${audience.text}</p><p>团队：新写入一条 · ${uiLabelOf('audience_scope','team')}</p>${checkTable(checked.checks)}${personalPackForm(ctx,'promote',fields,'确认发布到团队',false,!checked.ok)}`:canPublish?link('/console/packs/'+pack.id,'发布到团队…',{space:pack.space,promote:'1'}):html`<button class="btn" disabled title="没有发布权。可以先把个人工作流授权给指定成员使用；发布权由管理员在团队页设置">发布到团队</button>`)}${pack.withdrawn?'':card({title:'下架个人版本',hint:'停止新运行使用；历史运行仍按原摘要读取'},personalPackForm(ctx,'retire',fields,'下架此版本'))}`;

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
  if(isKnowledgeGrantAction(action)){
    const audience=KnowledgeGranteeSchema.parse(get('audience'));
    const member=get('member_id')||(get('member')?(await ctx.deps.records.principals.findByName(get('member')))?.id:null);
    await personal.grant(ctx.principal,pack,{audience,member:member??null,revoke:action==='revoke'});
  }else if(action==='retire')await personal.retire(ctx.principal,pack,get('version'));
  else if(action==='promote'){const published=await personal.promote(ctx.principal,pack+'@'+get('version'));if(!published.ok)throw new RecordsError('发布校验未通过：'+published.problems.map(row=>row.rule).join('、'));return '/console/packs/'+encodeURIComponent(pack);}
  else throw new AccessError('对象不存在或无权读取');
  return '/console/packs/'+encodeURIComponent(pack)+'?space='+encodeURIComponent(ctx.principal.id);
}
