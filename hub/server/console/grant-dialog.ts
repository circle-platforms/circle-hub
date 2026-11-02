import {KNOWLEDGE_GRANTEE,KnowledgeGranteeSchema,uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import type {SharingCheck} from '../../knowledge/api.ts';
import type {PageContext} from './pages.ts';
import {html,table,type Html} from './html.ts';
import {timestamp} from './knowledge-display.ts';

export function grantPreviewLocation(path:string,params:Record<string,string>,id:string,values:{get(key:string):string|null|undefined}):string{
 const audience=KnowledgeGranteeSchema.parse(values.get('audience'));
 return path+'?'+new URLSearchParams({...params,grant_audience:audience,grant_member:values.get('member')??''})+'#'+id;
}
export function checkTable(checks:readonly SharingCheck[]):Html{
 return table(['自动检查','状态','拒收码','原因与处理办法'],checks.map(row=>[uiLabelOf('share_check',row.check),uiLabelOf('static_terminal',row.state),row.code??'—',[row.message,row.fix].filter(Boolean).join('；')]),'没有检查结果');
}
export async function grantDialog(ctx:PageContext,input:{id:string;content:string;current:string;checks:readonly SharingCheck[];grants:readonly {audience:string;member:string|null;at:string;path?:string}[];form:(action:string,fields:Html,label:string,disabled?:boolean)=>Html;fields:Html;workflow?:boolean;trigger?:boolean}):Promise<Html>{
 const admins=(await ctx.deps.records.principals.list()).filter(user=>!user.disabled&&user.role==='admin').length;
 return html`${input.trigger===false?'':html`<a class="btn" href="#${input.id}">授权…</a>`}<div class="modal" id="${input.id}" role="dialog" aria-modal="true" aria-label="授权"><div class="dialog"><h3 title="授权按并集生效。收回后不能继续读取；已读或已引用的内容无法追回。${input.workflow?'被授权者的运行结果对发起人和全部被授权者可见。':''}">授权</h3><p>当前范围：${input.current}</p><p>${input.content}</p>${input.form('grant',html`${input.fields}<div class="grant-controls"><label title="全体管理员包含以后新增的管理员；停用或降为成员后不再可读">授权给<select name="audience">${KNOWLEDGE_GRANTEE.map(value=>html`<option value="${value}"${ctx.url.searchParams.get('grant_audience')===value?html` selected`:''}>${uiLabelOf('knowledge_grantee',value)}${value==='administrators'?'（当前 '+admins+' 人）':''}</option>`)}</select></label><label class="member-input" title="精确输入，不提供成员目录浏览">成员用户名<input name="member" autocomplete="off" maxlength="300" value="${ctx.url.searchParams.get('grant_member')??''}"></label><button class="btn" type="submit" name="preview_grant" value="1">预检授权</button></div>${checkTable(input.checks)}`,'授权',input.checks.some(row=>row.state!=='pass'))}${table(['对象','授权内容','授权时间','操作'],await Promise.all(input.grants.map(async grant=>[grant.member?await ctx.userName(grant.member):uiLabelOf('knowledge_grantee','administrators'),input.content,timestamp(grant.at),input.form('revoke',html`${input.fields}${grant.path?html`<input type="hidden" name="path" value="${grant.path}">`:''}<input type="hidden" name="audience" value="${grant.audience}"><input type="hidden" name="member_id" value="${grant.member??''}">`,'收回授权')])),'尚无授权')}<a class="btn" href="#_">关闭</a></div></div>`;
}
