import {stat,dialog,actionLink,field} from './presentation.ts';
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {commands} from './commands.ts';
import {memberSpaceMetadata} from './member-space-metadata.ts';
import {tokensForMembers,assignmentsForMembers} from './member-reads.ts';
import {circleNames} from './circles.ts';
import {definitions,html,href,link,liveModule,page,pageLayout,table,type Html} from './html.ts';
import {neutralPage,type PageContext,type PageResult} from './pages.ts';
import {button,card,chip,commandLink,commandModal,when,type CommandDialog} from './ui.ts';

/** Selection is resolved exclusively from the same authorized member/device projection as the tables. */
export async function teamPage(ctx:PageContext,member?:string):Promise<PageResult>{
 const {principals,authorizations}=ctx.deps.records;
 if(member!==undefined&&!ctx.admin&&member!==ctx.principal.id)return neutralPage(ctx);
 const users=ctx.admin?await principals.list():[await principals.get(ctx.principal.id)].filter(user=>user!==null);
 const selectedUser=member?users.find(user=>user.id===member):undefined;
 if(member&&!selectedUser)return neutralPage(ctx);
 const packs=(await ctx.deps.packs.list(ctx.principal)).filter(pack=>pack.kind==='workflow'&&!pack.space&&!pack.withdrawn);
 const circleId=ctx.url.searchParams.get('circle'),workflow=ctx.url.searchParams.get('workflow');
 const members:unknown[][]=[],circles:unknown[][]=[],devices:Array<{id:string;name:string;owner:string;token:Awaited<ReturnType<typeof principals.tokens>>[number]}>=[];
 const [assignedByUser,tokensByUser]=await Promise.all([assignmentsForMembers(authorizations,users.map(user=>user.id)),tokensForMembers(principals,users.map(user=>user.id))]);
 const names=await circleNames(principals,users.filter(user=>!user.disabled).flatMap(user=>(tokensByUser.get(user.id)??[]).filter(token=>token.revoked_at===null)));
 for(const user of users){
  const assigned=assignedByUser.get(user.id)??[];
  members.push([link('/console/team/'+user.id,user.name),uiLabelOf('permission_role',user.role),chip(uiLabelOf('account_status',user.disabled?'disabled':'enabled'),user.disabled?'plain':'pass'),user.role==='admin'?'全部工作流':assigned.map(id=>packs.find(pack=>pack.id===id)?.title??'名称暂不可读').join('、')||'—']);
  for(const token of tokensByUser.get(user.id)??[]){
   if(token.revoked_at!==null||user.disabled)continue;
   const name=names.get(token.id)!,url=href('/console/team',{circle:token.id});
   devices.push({id:token.id,name,owner:user.name,token});
   circles.push([link(url,name),user.name,when(token.last_used_at)]);
  }
 }
 const selectedDevice=circleId?devices.find(device=>device.id===circleId):undefined;
 if(circleId&&!selectedDevice)return neutralPage(ctx);
 const dialogs:CommandDialog[]=[];
 let inspector:Html,confirmations=html``;
 if(selectedDevice){
  const revoke=commands.tokenRevoke(selectedDevice.token,selectedDevice.owner);
  if(ctx.admin)dialogs.push(revoke);
  inspector=html`<div data-inspector-content><span class="ch-tag">Circle</span><h2 class="ch-panel-title">${selectedDevice.name}</h2>${definitions([['成员',selectedDevice.owner],['最近使用时间',when(selectedDevice.token.last_used_at)]])}<footer class="ch-inspector-actions">${ctx.admin?commandLink(revoke,'断开…','ch-btn ch-btn--danger'):html`<span class="ch-meta">由管理员断开</span>`}</footer></div>`;
 }else if(selectedUser){
  const user=selectedUser,assigned=assignedByUser.get(user.id)??[],canPublish=await authorizations.canPublish(user.id);
  const toggle=user.disabled?commands.userEnable(user):commands.userDisable(user),spare=commands.tokenIssue(user),invite=commands.userInvite(user),publish=commands.memberPublish(user.id,canPublish);
  if(ctx.admin)dialogs.push(toggle,spare,publish,...(user.disabled?[]:[invite]));
  const permissions:Array<[string,unknown]>=[['角色',uiLabelOf('permission_role',user.role)],['具有发布权',canPublish?'是':'否'],...await memberSpaceMetadata(ctx,user)];
  if(ctx.admin&&ctx.deps.knowledge.spaces)permissions.push(['私人空间容量',html`<form method="post" action="/console/knowledge/do/quota"><input type="hidden" name="csrf" value="${ctx.csrf??''}"><input type="hidden" name="space" value="${user.id}">${field('容量上限（字节）',html`<input type="number" name="bytes" min="0" max="9007199254740991" step="1" required value="${await ctx.deps.knowledge.spaces.capacity(user.id)}">`,'调整容量不授予读取私人内容的权限')}<button type="submit" class="ch-btn ch-btn--secondary">保存容量上限</button></form>`]);
  const assignment=packs.find(pack=>pack.id===workflow);
  if(workflow&&!assignment)return neutralPage(ctx);
  const rows=packs.map(pack=>[link('/console/team/'+user.id,pack.title,{workflow:pack.id}),assigned.includes(pack.id)||user.role==='admin'?'是':'否']);
  let selectedAssignment=html``;
  if(assignment){
   const has=assigned.includes(assignment.id),change=commands.memberPack(user.id,assignment.id,has);
   if(ctx.admin)dialogs.push(change);
   selectedAssignment=card({title:assignment.title},html`<p>${has||user.role==='admin'?'可使用':'不可使用'}</p>${ctx.admin?commandLink(change,has?'移出使用范围…':'加入使用范围…',has?'ch-btn ch-btn--danger':'ch-btn ch-btn--secondary'):''}`);
  }
  if(ctx.admin)confirmations=dialog('reset-member-password','重置成员密码',html`<p>生成仅显示一次的初始密码，使该账户的控制台会话失效；下次登录必须修改。</p>`,html`<form method="post" action="/console/admin/do/password-reset"><input type="hidden" name="csrf" value="${ctx.csrf??''}"><input type="hidden" name="user" value="${user.id}"><button type="submit" class="ch-btn ch-btn--danger">重置密码</button></form>`);
  inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">成员</span>${chip(uiLabelOf('account_status',user.disabled?'disabled':'enabled'),user.disabled?'plain':'pass')}</div><h2 class="ch-panel-title">${user.name}</h2>${card({title:'权限'},definitions(permissions))}${ctx.admin?html`<div class="ch-actions">${commandLink(publish,'调整发布权…')}${actionLink('#reset-member-password','重置密码…','danger')}</div>`:''}${card({title:'工作流分配'},table([uiLabelOf('pack_kind','workflow'),'可使用'],rows,'尚无工作流',undefined,{selected:packs.findIndex(pack=>pack.id===workflow),hrefs:packs.map(pack=>href('/console/team/'+user.id,{workflow:pack.id}))}))}${selectedAssignment}<footer class="ch-inspector-actions">${ctx.admin?html`${commandLink(toggle,user.disabled?'启用…':'停用…',user.disabled?'ch-btn ch-btn--secondary':'ch-btn ch-btn--danger')}${commandLink(spare,'签发 Circle 访问令牌…')}${user.disabled?'':commandLink(invite,'签发邀请码…','ch-btn ch-btn--primary')}`:''}</footer></div>`;
 }else inspector=html`<h2 class="ch-panel-title">团队</h2>${stat(ctx.admin?'成员':'当前可见成员',users.length)}${stat('已启用',users.filter(user=>!user.disabled).length)}${stat('已连接的 Circle',devices.length)}`;
 const selected=!!selectedUser||!!selectedDevice;
 return {status:200,body:page(ctx.chrome('团队',{active:'team',hint:'第一个账户是管理员；账户仅由管理员添加，成员权限和工作流分配在此管理。',actions:html`${button('/console/password','修改密码')}${ctx.admin?button('/console/operations/member','添加成员',{primary:true,icon:'plus'}):''}`}),pageLayout(html`
 ${liveModule('members',['member.connected'],card({title:'成员',meta:users.length},table(['名字','角色','状态','可用的工作流'],members,'没有可读的成员',undefined,{selected:selectedDevice?-1:users.findIndex(user=>user.id===member),hrefs:users.map(user=>'/console/team/'+user.id)})))}
 ${liveModule('member-circles',['member.connected'],card({title:'已连接的 Circle'},table(['设备名','成员','最近使用时间'],circles,'尚无已连接的 Circle',undefined,{selected:devices.findIndex(device=>device.id===circleId),hrefs:devices.map(device=>href('/console/team',{circle:device.id}))})))}`,{inspector:liveModule('team-inspector',['member.connected'],html`${inspector}${confirmations}${dialogs.map(commandModal)}`),detail:selected,back:link('/console/team','返回团队')}))};
}
