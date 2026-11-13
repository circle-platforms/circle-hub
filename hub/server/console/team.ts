import {memberDeletionDialog,memberDeletionProgress,deletionDialogId} from './member-deletion.ts';
import {spaceCapacityDialog} from './space-capacity.ts';
import {capacitySummary} from './capacity.ts';
import {dialog,actionLink,tooltip,field} from './presentation.ts';
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {commands} from './commands.ts';
import {memberSpaceMetadata} from './member-space-metadata.ts';
import {tokensForMembers,assignmentsForMembers} from './member-reads.ts';
import {connectedClients,clientLabel,type ConnectedClient} from './circles.ts';
import {CLIENT_COLUMNS,clientRow,clientInspector,noClients} from './connections.ts';
import {definitions,html,href,link,liveModule,page,pageLayout,table,type Html} from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './context.ts';
import { count, emptyBlock, postForm, segments, selectControl } from './components.ts';
import {box,button,card,chip,commandLink,commandModal,when,type CommandDialog} from './ui.ts';
import { registeredActionForm } from './command-form.ts';
import {actionForm} from './manage.ts';
import {RESOURCE_AUDIENCE} from './team-actions.ts';
import type {Principal,Team,TeamAssignments,TeamMember,TeamRow,Teams,User} from '../../records/api.ts';

/** The two tabs of the members page (decision 151, step 7): the members, and the clients they connected. One list each. */
const TEAM_TABS=['members','teams','clients'] as const;
type TeamTab=typeof TEAM_TABS[number];
const TEAM_TAB_LABEL:Record<TeamTab,string>={members:'成员',teams:'团队',clients:'已连接的客户端'};

/** Re-export records shapes for console-teams tests (synthetic PageContext). */
export type ConsoleTeam = Team;
export type ConsoleTeamRow = TeamRow;
export type ConsoleTeamMember = TeamMember;
export type ConsoleTeamAssignments = TeamAssignments;
export type ConsoleTeams = Teams;

type PackSource = { pack: string; via: 'user' | { team: string } };

/** Real kit always has teams (hub/records/index.ts); optional only for incomplete synthetic deps in unit tests. */
function teamsApi(ctx: PageContext): Teams | undefined {
  return (ctx.deps.records as { teams?: Teams }).teams;
}

/** list must not treat the built-in knowledge space id `team` as a team row (decision 3). */
function listedTeams(rows: readonly Team[]): TeamRow[] {
  return rows.filter((row) => row.id !== 'team' && row.deleted_at === null) as TeamRow[];
}

async function membershipsForUsers(ctx: PageContext, teams: Teams | undefined, userIds: readonly string[]): Promise<Map<string, Team[]>> {
  if (!teams) return new Map(userIds.map((id) => [id, []] as const));
  return teams.membershipsMany(ctx.principal, userIds);
}

async function packSourcesFor(ctx: PageContext, userId: string): Promise<PackSource[] | null> {
  // packSources is administrator-only (authorizations.ts); members fall back to direct assignments.
  if (!ctx.admin) return null;
  const auth = ctx.deps.records.authorizations;
  return auth.packSources ? auth.packSources(ctx.principal, userId) : null;
}

function workflowCell(titles: string[], sources: PackSource[] | null, packs: readonly { id: string; title: string }[], adminRole: boolean): unknown {
  if (adminRole) return '全部工作流';
  if (sources) {
    const labels = sources.map((row) => {
      const title = packs.find((pack) => pack.id === row.pack)?.title ?? '名称暂不可读';
      return row.via === 'user' ? `${title}（直接）` : `${title}（${row.via.team}）`;
    });
    return labels.length ? tooltip(`${count(labels.length)} 个`, labels.join('、')) : '无';
  }
  return titles.length ? tooltip(`${count(titles.length)} 个`, titles.join('、')) : '无';
}

/** Selection is resolved exclusively from the same authorized member/device projection as the tables. */
export async function teamPage(ctx:PageContext,member?:string):Promise<PageResult>{
 const {principals,authorizations}=ctx.deps.records,spaces=ctx.deps.knowledge?.spaces;
 if(member!==undefined&&!ctx.admin&&member!==ctx.principal.id)return neutralPage(ctx);
 // interfaces §5.2: default tab is 团队 (list); members/clients only when asked (admin).
 if(member===undefined&&!ctx.url.searchParams.get('circle')){
  const asked=ctx.url.searchParams.get('tab');
  if(!ctx.admin||(asked!=='members'&&asked!=='clients'))return teamsPage(ctx);
 }
 const users=ctx.admin?await principals.list():[await principals.get(ctx.principal.id)].filter(user=>user!==null);
 const selectedUser=member?users.find(user=>user.id===member):undefined;
 if(member&&!selectedUser)return neutralPage(ctx);
 const packs=(await ctx.deps.packs.list(ctx.principal)).filter(pack=>pack.kind==='workflow'&&!pack.space&&!pack.withdrawn);
 const circleId=ctx.url.searchParams.get('circle'),workflow=ctx.url.searchParams.get('workflow');
 const members:unknown[][]=[],circles:unknown[][]=[],connections:Array<{owner:string;token:Awaited<ReturnType<typeof principals.tokens>>[number]}>=[];
 const clientsOf=new Map<string,number>();
 const teams=teamsApi(ctx);
 const [assignedByUser,tokensByUser,teamsByUser]=await Promise.all([
  assignmentsForMembers(authorizations,users.map(user=>user.id)),
  tokensForMembers(principals,users.map(user=>user.id)),
  membershipsForUsers(ctx,teams,users.map(user=>user.id)),
 ]);
 for(const user of users){
  const assigned=assignedByUser.get(user.id)??[];
  const name=user.deleted_at?uiLabelOf('account_display_name','deleted_member'):user.name;
  for(const token of tokensByUser.get(user.id)??[]){
   if(token.revoked_at!==null||user.disabled||user.deleted_at)continue;
   connections.push({owner:user.name,token});clientsOf.set(user.id,(clientsOf.get(user.id)??0)+1);
  }
  const titles=assigned.map(id=>packs.find(pack=>pack.id===id)?.title??'名称暂不可读'),clients=clientsOf.get(user.id)??0;
  const belonging=(teamsByUser.get(user.id)??[]).map(team=>team.name).join('、')||'无';
  // List cells stay on direct assignments; the selected member's pane uses packSources when present (decision 1).
  members.push([link('/console/team/'+user.id,name),uiLabelOf('permission_role',user.role),chip(uiLabelOf('account_status',user.deleted_at?'deleted':user.disabled?'disabled':'enabled'),user.disabled?'plain':'pass'),belonging,user.deleted_at?'不适用':workflowCell(titles,null,packs,user.role==='admin'),clients?`${count(clients)} 个`:'无']);
 }
 const devices:Array<ConnectedClient&{id:string}>=(await connectedClients(ctx.deps.records,connections)).map(client=>({...client,id:client.token.id}));
 for(const device of devices)circles.push(clientRow(device,link(href('/console/team',{circle:device.id}),clientLabel(device))));
 const selectedDevice=circleId?devices.find(device=>device.id===circleId):undefined;
 if(circleId&&!selectedDevice)return neutralPage(ctx);
 const dialogs:CommandDialog[]=[];
 let inspector:Html,confirmations=html``,capacityLine=html``;
 if(selectedDevice){
  const revoke=commands.tokenRevoke(selectedDevice.token,selectedDevice.owner);
  if(ctx.admin)dialogs.push(revoke);
  inspector=html`<div data-inspector-content>${clientInspector(selectedDevice)}<footer class="ch-inspector-actions">${ctx.admin?commandLink(revoke,'断开…','ch-btn ch-btn--danger'):html`<span class="ch-meta">由管理员断开</span>`}</footer></div>`;
 }else if(selectedUser?.deleted_at){
  inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">成员</span>${chip(uiLabelOf('account_status','deleted'),'plain')}</div><h2 class="ch-panel-title">${uiLabelOf('account_display_name','deleted_member')}</h2>${definitions([['成员编号',selectedUser.id],['删除时间',when(selectedUser.deleted_at)]])}${ctx.admin?await memberDeletionProgress(ctx,selectedUser.id):''}</div>`;
 }else if(selectedUser){
  const deletion=ctx.admin&&ctx.url.searchParams.get('deletion')==='preview'?await memberDeletionDialog(ctx,selectedUser.id):html``;
  confirmations=html`${confirmations}${deletion}`;
  const user=selectedUser,assigned=assignedByUser.get(user.id)??[],canPublish=await authorizations.canPublish(user.id);
  const toggle=user.disabled?commands.userEnable(user):commands.userDisable(user),spare=commands.tokenIssue(user),invite=commands.userInvite(user),publish=commands.memberPublish(user.id,canPublish);
  if(ctx.admin)dialogs.push(toggle,publish,...(user.disabled?[]:[spare,invite]));
  const belonging=(teamsByUser.get(user.id)??[]).map(team=>team.name).join('、')||'无';
  const permissions:Array<[string,unknown]>=[['角色',uiLabelOf('permission_role',user.role)],['所属团队',belonging],['具有发布权',canPublish?'是':'否'],...await memberSpaceMetadata(ctx,user)];
  if(ctx.admin&&spaces){try{const usage=await spaces.usage(ctx.principal,user.id);confirmations=html`${confirmations}${await spaceCapacityDialog(ctx,user.id,usage)}`;permissions.push(['容量管理',actionLink('#adjust-member-capacity','调整容量…')]);}catch{/* usage failure stays unknown; do not block member management */}}
  const assignment=packs.find(pack=>pack.id===workflow);
  if(workflow&&!assignment)return neutralPage(ctx);
  const sources=await packSourcesFor(ctx,user.id);
  const usable=(packId:string)=>user.role==='admin'||(sources?sources.some(row=>row.pack===packId):assigned.includes(packId));
  const rows=packs.map(pack=>{
   const via=sources?.find(row=>row.pack===pack.id);
   const mark=usable(pack.id)?'是':'否';
   const note=via?via.via==='user'?'直接':`团队 ${via.via.team}`:assigned.includes(pack.id)?'直接':'';
   return [link('/console/team/'+user.id,pack.title,{workflow:pack.id}),note?`${mark} · ${note}`:mark];
  });
  let selectedAssignment=html``;
  if(assignment){
   const has=usable(assignment.id),change=commands.memberPack(user.id,assignment.id,assigned.includes(assignment.id));
   if(ctx.admin)dialogs.push(change);
   selectedAssignment=card({title:assignment.title},html`<p>${has?'可使用':'不可使用'}</p>${ctx.admin?commandLink(change,assigned.includes(assignment.id)?'移出使用范围…':'加入使用范围…',assigned.includes(assignment.id)?'ch-btn ch-btn--danger':'ch-btn ch-btn--secondary'):''}`);
  }
  if(ctx.admin)confirmations=html`${confirmations}${dialog('reset-member-password','重置成员密码',html`<p>生成仅显示一次的初始密码，使该账户的控制台会话失效；下次登录必须修改。</p>`,postForm({action:'/console/admin/do/password-reset',csrf:ctx.csrf??'',fields:html`<input type="hidden" name="user" value="${user.id}">`,submit:'重置密码',danger:true}))}`;
  inspector=html`<div data-inspector-content><div class="ch-actions"><span class="ch-tag">成员</span>${chip(uiLabelOf('account_status',user.deleted_at?'deleted':user.disabled?'disabled':'enabled'),user.disabled?'plain':'pass')}</div><h2 class="ch-panel-title">${user.name}</h2>${card({title:'权限'},definitions(permissions))}${ctx.admin?html`<div class="ch-actions">${commandLink(publish,'调整发布权…')}${actionLink('#reset-member-password','重置密码…','danger')}</div>`:''}${card({title:'工作流分配'},table([uiLabelOf('pack_kind','workflow'),'可使用'],rows,'尚无工作流',undefined,{selected:packs.findIndex(pack=>pack.id===workflow),hrefs:packs.map(pack=>href('/console/team/'+user.id,{workflow:pack.id}))}))}${selectedAssignment}${card({title:'已连接的客户端'},table(CLIENT_COLUMNS,devices.filter(device=>device.token.user===user.id).map(device=>clientRow(device,link(href('/console/team',{circle:device.id}),clientLabel(device)))),noClients(ctx.admin)))}<footer class="ch-inspector-actions">${ctx.admin?html`${commandLink(toggle,user.disabled?'启用…':'停用…',user.disabled?'ch-btn ch-btn--secondary':'ch-btn ch-btn--danger')}${actionLink('/console/team/'+user.id+'?deletion=preview#'+deletionDialogId,'删除成员…','danger')}${user.disabled?'':html`${commandLink(spare,'签发客户端访问令牌…')}${commandLink(invite,'签发邀请码…','ch-btn ch-btn--primary')}`}`:''}</footer></div>`;
 }else{
  let usage=null;if(ctx.admin&&spaces){try{usage=await spaces.usage(ctx.principal,'team');}catch{usage=null;}}
  if(usage)confirmations=html`${confirmations}${await spaceCapacityDialog(ctx,'team',usage)}`;
  // Decision 151: with nothing selected there is no pane. The member and client counts are the heads of the two lists; the
  // shared capacity, the one fact only the pane had, stands above them with the link that opens its dialog. Label is 公共空间
  // (decision 1500 / hub-terms); internal id `team` is unchanged.
  if(usage)capacityLine=html`<p class="ch-meta" data-team-capacity>公共空间容量 ${capacitySummary(usage)} · <a href="#adjust-team-capacity">调整容量…</a></p>`;
  inspector=html``;
 }
 const selected=!!selectedUser||!!selectedDevice;
 const asked=ctx.url.searchParams.get('tab');
 const tab:TeamTab=selectedDevice?'clients':selectedUser?'members':asked==='clients'?'clients':'members';
 const counts:Record<TeamTab,number|undefined>={members:users.length,teams:undefined,clients:devices.length};
 const tabs=liveModule('team-tabs',['member.connected'],segments('成员与团队',TEAM_TABS.map(key=>{
  const path=key==='teams'?'/console/team':href('/console/team',key==='members'?{tab:'members'}:{tab:key});
  return {href:path,label:TEAM_TAB_LABEL[key],count:counts[key],current:key===tab};
 }),'data-team-tabs'));
 const content=tab==='members'
  ?html`${capacityLine}${liveModule('members',['member.connected'],box(null,table(['名字','角色','状态','所属团队','可用的工作流','客户端'],members,'没有可读的成员',undefined,{selected:users.findIndex(user=>user.id===member),hrefs:users.map(user=>'/console/team/'+user.id)}),{flush:true}))}`
  :liveModule('member-circles',['member.connected'],box(null,table(CLIENT_COLUMNS,circles,noClients(ctx.admin),undefined,{selected:devices.findIndex(device=>device.id===circleId),hrefs:devices.map(device=>href('/console/team',{circle:device.id}))}),{flush:devices.length>0}));
 return {status:200,body:page(ctx.chrome('团队',{active:'team',hint:'第一个账户是管理员；账户仅由管理员添加，成员权限和工作流分配在此管理。',actions:html`${button('/console/password','修改密码')}${ctx.admin?button('/console/operations/member','添加成员',{primary:true,icon:'plus'}):''}`}),pageLayout(html`<div class="ch-stack" data-team>${tabs}<div class="ch-stack" data-team-tab="${tab}">${content}</div>${selected||tab!=='members'?'':confirmations}</div>`,{inspector:selected?liveModule('team-inspector',['member.connected'],html`${inspector}${confirmations}${dialogs.map(commandModal)}`):null,detail:selected,back:link('/console/team','返回团队',tab==='members'?{tab:'members'}:{tab})}))};
}

function countCell(value: number | undefined): string {
  return value === undefined ? '—' : count(value);
}

/** `/console/team` default tab and `/console/teams`: admin overview; a member only names of teams they belong to. */
export async function teamsPage(ctx: PageContext): Promise<PageResult> {
  const teams = teamsApi(ctx);
  const spaces = ctx.deps.knowledge?.spaces;
  // Teams.list already returns TeamRow with counts (interfaces §1 overview shape).
  const rows = teams ? listedTeams(await teams.list(ctx.principal)) : [];
  const detailPath = (id: string) => `/console/team/${id}`;
  const tableRows = rows.map((row) => {
    const name = link(detailPath(row.id), row.name);
    if (!ctx.admin) return [name];
    return [name, countCell(row.member_count), countCell(row.pack_count), countCell(row.resource_count)];
  });
  const columns = ctx.admin ? ['名称', '成员', uiLabelOf('pack_kind', 'workflow'), '业务系统'] : ['名称'];
  let create = html``;
  let confirmations = html``;
  let capacityLine = html``;
  if (ctx.admin) {
    let usage = null;
    if (spaces) {
      try { usage = await spaces.usage(ctx.principal, 'team'); } catch { usage = null; }
    }
    if (usage) {
      confirmations = html`${confirmations}${await spaceCapacityDialog(ctx, 'team', usage)}`;
      capacityLine = html`<p class="ch-meta" data-team-capacity>公共空间容量 ${capacitySummary(usage)} · <a href="#adjust-team-capacity">调整容量…</a></p>`;
    }
    create = card({ title: '新建团队', hint: '只有管理员能建团队和管成员。删除时一并撤回该团队名下的分配。' },
      registeredActionForm('team-create', ctx.csrf ?? '', '新建', { primary: true }));
    for (const row of rows) {
      const packs = row.pack_count ?? 0;
      const resources = row.resource_count ?? 0;
      const id = `delete-team-${row.id}`;
      confirmations = html`${confirmations}${dialog(id, '删除团队', html`<p>删除「${row.name}」会一并撤回它名下的分配：工作流 ${count(packs)} 条，业务系统 ${count(resources)} 条。名称可再用，编号不复用。</p>`, postForm({ action: '/console/admin/do/team-delete', csrf: ctx.csrf ?? '', fields: html`<input type="hidden" name="team" value="${row.id}">`, submit: '删除', danger: true }))}`;
    }
  }
  const list = rows.length === 0
    ? emptyBlock({title:'尚无团队',text: ctx.admin ? '新建一个团队后，再把成员、工作流和业务系统分给它。' : '管理员尚未把当前账户加入任何团队。'})
    : box(null, table(columns, tableRows, '尚无团队', undefined, {
        hrefs: rows.map((row) => detailPath(row.id)),
      }), { flush: true });
  const adminActions = ctx.admin && rows.length > 0
    ? html`<div class="ch-actions">${rows.map((row) => actionLink(`#delete-team-${row.id}`, `删除 ${row.name}…`, 'danger'))}</div>`
    : html``;
  const visibleTabs = ctx.admin ? TEAM_TABS : (['teams'] as const);
  const tabs = segments('成员与团队', [...visibleTabs].map((key) => ({
    href: key === 'teams' ? '/console/team' : href('/console/team', { tab: key }),
    label: TEAM_TAB_LABEL[key],
    current: key === 'teams',
  })), 'data-team-tabs');
  return {
    status: 200,
    body: page(ctx.chrome('团队', {
      active: 'team',
      hint: ctx.admin
        ? '管理员新建团队、加减成员、分配工作流与业务系统；删除时撤回该团队名下的分配。'
        : '只显示当前账户所属团队的名字。',
      actions: html`${button('/console/password', '修改密码')}${ctx.admin ? button('/console/operations/member', '添加成员', { primary: true, icon: 'plus' }) : ''}`,
    }), pageLayout(html`<div class="ch-stack" data-teams>${tabs}${capacityLine}${list}${adminActions}${create}${confirmations}</div>`, {})),
  };
}

/** `/console/team/tm_…` (and `/console/teams/<id>` alias): admin sees members and assignments; a member with no access gets the neutral page. */
export async function teamDetailPage(ctx: PageContext, teamId: string): Promise<PageResult> {
  if (!teamId.startsWith('tm_') || teamId === 'team') return neutralPage(ctx);
  const teams = teamsApi(ctx);
  if (!teams) return neutralPage(ctx);
  const team = await teams.get(ctx.principal, teamId);
  if (!team || team.id === 'team' || team.deleted_at) return neutralPage(ctx);
  if (!ctx.admin) {
    return {
      status: 200,
      body: page(ctx.chrome(team.name, { active: 'team', hint: '普通成员只看到自己所属团队的名字。', actions: button('/console/team', '返回团队') }),
        pageLayout(html`<div class="ch-stack" data-team-detail>${card({ title: team.name }, definitions([['名称', team.name]]))}</div>`, { back: link('/console/team', '返回团队') })),
    };
  }
  const [members, assignments, packs, resources, users] = await Promise.all([
    teams.members(ctx.principal, team.id),
    teams.assignments(ctx.principal, team.id),
    ctx.deps.packs.list(ctx.principal),
    ctx.deps.resources.list(ctx.principal),
    ctx.deps.records.principals.list(),
  ]);
  const workflows = packs.filter((pack) => pack.kind === 'workflow' && !pack.space && !pack.withdrawn);
  const packName = (id: string) => workflows.find((pack) => pack.id === id)?.title ?? resources.find((row) => row.id === id)?.name ?? id;
  const activeUsers = users.filter((user) => !user.disabled && !user.deleted_at);
  const memberIds = new Set(members.map((row) => row.user.id));
  const memberRows = members.map((row) => {
    const name = row.user.deleted_at ? uiLabelOf('account_display_name', 'deleted_member') : row.user.name;
    const status = chip(uiLabelOf('account_status', row.user.deleted_at ? 'deleted' : row.user.disabled ? 'disabled' : 'enabled'), row.user.disabled || row.user.deleted_at ? 'plain' : 'pass');
    const remove = row.user.deleted_at ? '' : actionForm('team-remove', ctx.csrf ?? '', html`<input type="hidden" name="team" value="${team.id}"><input type="hidden" name="user" value="${row.user.id}">`, '移出', { inline: true });
    return [link(`/console/team/${row.user.id}`, name), uiLabelOf('permission_role', row.user.role), status, when(row.added_at), remove];
  });
  const assignedPacks = new Set(assignments.packs.filter((row) => !row.body.revoked).map((row) => row.body.object));
  const assignedResources = assignments.resources.filter((row) => !row.body.revoked);
  const packRows = workflows.map((pack) => {
    const has = assignedPacks.has(pack.id);
    const form = actionForm(has ? 'pack-unassign-team' : 'pack-assign-team', ctx.csrf ?? '', html`<input type="hidden" name="team" value="${team.id}"><input type="hidden" name="pack" value="${pack.id}">`, has ? '撤回' : '分配', { inline: true });
    return [pack.title, has ? '已分配' : '未分配', form];
  });
  const resourceRows = assignedResources.map((row) => {
    const id = row.body.object;
    const form = actionForm('resource-unassign', ctx.csrf ?? '', html`<input type="hidden" name="resource" value="${id}"><input type="hidden" name="audience" value="${RESOURCE_AUDIENCE.team}"><input type="hidden" name="team" value="${team.id}">`, '撤回', { inline: true });
    return [packName(id), when(row.body.decided_at), form];
  });
  const addCandidates = activeUsers.filter((user) => !memberIds.has(user.id));
  const addMember = card({ title: '加入成员' }, actionForm('team-add', ctx.csrf ?? '', html`<input type="hidden" name="team" value="${team.id}">${field('成员', selectControl(
    'user',
    addCandidates.map((user) => ({ value: user.id, label: user.name })),
    addCandidates.length === 0 ? { value: '', label: '没有可加入的账户' } : undefined,
    { required: true, disabled: addCandidates.length === 0 },
  ))}`, '加入'));
  const assignResource = card({ title: '分配业务系统' }, actionForm('resource-assign', ctx.csrf ?? '', html`<input type="hidden" name="audience" value="${RESOURCE_AUDIENCE.team}"><input type="hidden" name="team" value="${team.id}">${field('业务系统', selectControl(
    'resource',
    resources.map((row) => ({ value: row.id, label: row.name })),
    resources.length === 0 ? { value: '', label: '尚无业务系统' } : undefined,
    { required: true, disabled: resources.length === 0 },
  ))}`, '分配'));
  const packCount = assignedPacks.size;
  const resourceCount = assignedResources.length;
  const deleteId = 'delete-team-detail';
  const deleteDialog = dialog(deleteId, '删除团队', html`<p>删除「${team.name}」会一并撤回它名下的分配：工作流 ${count(packCount)} 条，业务系统 ${count(resourceCount)} 条。</p>`, postForm({ action: '/console/admin/do/team-delete', csrf: ctx.csrf ?? '', fields: html`<input type="hidden" name="team" value="${team.id}">`, submit: '删除', danger: true }));
  return {
    status: 200,
    body: page(ctx.chrome(team.name, {
      active: 'team',
      hint: '成员继承所在团队的工作流分配；业务系统按团队或全体分配，没有分配不开放。',
      actions: html`${button('/console/team', '返回团队')}${actionLink(`#${deleteId}`, '删除团队…', 'danger')}`,
    }), pageLayout(html`<div class="ch-stack" data-team-detail>
${card({ title: '概况' }, definitions([['名称', team.name], ['成员', count(members.length)], [uiLabelOf('pack_kind', 'workflow'), count(packCount)], ['业务系统', count(resourceCount)], ['创建时间', when(team.created_at)]]))}
${card({ title: '成员' }, table(['名字', '角色', '状态', '加入时间', ''], memberRows, '没有成员'))}
${addMember}
${card({ title: '工作流分配' }, table([uiLabelOf('pack_kind', 'workflow'), '状态', ''], packRows, '尚无工作流'))}
${card({ title: '业务系统分配' }, table(['名称', '分配时间', ''], resourceRows, '尚未分配业务系统'))}
${assignResource}
${deleteDialog}
</div>`, { back: link('/console/team', '返回团队') })),
  };
}

/** Copy for connections/system-add: audience options live in team-actions (packs owns the form). */
export { RESOURCE_AUDIENCE_OPTIONS, SYSTEM_ADD_AUDIENCE_HINT } from './team-actions.ts';
