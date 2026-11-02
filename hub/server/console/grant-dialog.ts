import {KNOWLEDGE_GRANTEE,KnowledgeGranteeSchema,uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import type {SharingCheck} from '../../knowledge/api.ts';
import type {PageContext} from './pages.ts';
import {html,href,table,link,type Html} from './html.ts';
import {timestamp} from './knowledge-display.ts';
import {evidence,tooltip,badge,field,dialog,actionLink} from './presentation.ts';

export function grantPreviewLocation(path:string,params:Record<string,string>,id:string,values:{get(key:string):string|null|undefined}):string{
 const audience=KnowledgeGranteeSchema.parse(values.get('audience'));
 return path+'?'+new URLSearchParams({...params,grant_audience:audience,grant_member:values.get('member')??''})+'#'+id;
}
export function checkTable(checks:readonly SharingCheck[]):Html{
 return table(['自动检查','状态','拒收码','原因与处理办法'],checks.map(row=>[uiLabelOf('share_check',row.check),badge(uiLabelOf('static_terminal',row.state),row.state==='violation'?'fail':row.state),row.code??'—',[row.message,row.fix].filter(Boolean).join('；')]),'没有检查结果');
}
export async function grantDialog(ctx:PageContext,input:{id:string;content:string;current:string;checks:readonly SharingCheck[];grants:readonly {audience:string;member:string|null;at:string;path?:string}[];form:(action:string,fields:Html,label:string,disabled?:boolean)=>Html;fields:Html;workflow?:boolean;trigger?:boolean}):Promise<Html>{
 const admins=(await ctx.deps.records.principals.list()).filter(user=>!user.disabled&&user.role==='admin').length;
 const key=(grant:typeof input.grants[number])=>JSON.stringify([grant.audience,grant.member,grant.path??'']);
 const chosen=input.grants.find(grant=>key(grant)===ctx.url.searchParams.get('share_selection'));
 const address=(grant:typeof input.grants[number])=>href(ctx.url.pathname,{...Object.fromEntries(ctx.url.searchParams),share_selection:key(grant)})+'#'+input.id;
 const rows=await Promise.all(input.grants.map(async grant=>[link(address(grant),grant.member?await ctx.userName(grant.member):uiLabelOf('knowledge_grantee','administrators')),evidence(input.content),timestamp(grant.at)]));
 const revoke=chosen?input.form('revoke',html`${input.fields}${chosen.path?html`<input type="hidden" name="path" value="${chosen.path}">`:''}<input type="hidden" name="audience" value="${chosen.audience}"><input type="hidden" name="member_id" value="${chosen.member??''}">`,'收回分享'):html``;
 const removeId='remove-'+input.id;
 const body=html`<p>${tooltip(html`分享：${input.current}`,'多项分享设置取并集，收回一项不影响其余设置；工作流使用权限与结果的分享范围分别判定。')}</p><p>${evidence(input.content)}</p>${input.form('grant',html`${input.fields}<div data-grant-controls>${field('分享给',html`<select name="audience">${KNOWLEDGE_GRANTEE.map(value=>html`<option value="${value}"${ctx.url.searchParams.get('grant_audience')===value?html` selected`:''}>${uiLabelOf('knowledge_grantee',value)}${value==='administrators'?'（当前 '+admins+' 人）':''}</option>`)}</select>`,'全体管理员包含以后新增的管理员；停用或降为成员后不再可读')}<div data-member-input>${field('成员用户名',html`<input name="member" autocomplete="off" maxlength="300" value="${ctx.url.searchParams.get('grant_member')??''}">`,'精确输入，不提供成员列表浏览')}</div><button class="ch-btn ch-btn--secondary" type="submit" name="preview_grant" value="1">预检分享</button></div>${checkTable(input.checks)}`,'分享',input.checks.some(row=>row.state!=='pass'))}${table(['对象','分享内容','分享时间'],rows,'尚未分享',undefined,{selected:input.grants.findIndex(grant=>grant===chosen),hrefs:input.grants.map(address)})}${chosen?html`<section class="ch-section" aria-label="选中分享"><h3 class="ch-panel-title">${chosen.member?await ctx.userName(chosen.member):uiLabelOf('knowledge_grantee','administrators')}</h3><p>${evidence(input.content)}</p><div class="ch-inspector-actions">${actionLink('#'+removeId,'收回分享…','danger')}</div></section>`:''}`;
 return html`${input.trigger===false?'':actionLink('#'+input.id,'分享…')}${dialog(input.id,'分享',body)}${chosen?dialog(removeId,'收回分享',html`<p>${evidence(input.content)}</p><p>收回后不能继续读取；已读或已引用的内容无法追回。</p>`,revoke):''}`;
}
