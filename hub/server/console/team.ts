import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { commands } from './commands.ts';
import { circleName } from './circles.ts';
import { code, definitions, html, link, liveModule, page, table } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import { button, card, chip, commandLink, commandModal, sectionHead, when, type CommandDialog } from './ui.ts';

/** Team management reads current permissions; changes keep the existing command boundary. */
export async function teamPage(ctx: PageContext, member?: string): Promise<PageResult> {
  const {principals, authorizations} = ctx.deps.records;
  if (member !== undefined && !ctx.admin && member !== ctx.principal.id) return neutralPage(ctx);
  const users = member !== undefined ? [await principals.get(member)].filter(user => user !== null)
    : ctx.admin ? await principals.list() : [await principals.get(ctx.principal.id)].filter(user => user !== null);
  if (member !== undefined && users.length === 0) return neutralPage(ctx);
  const packs = (await ctx.deps.packs.list(ctx.principal)).filter(pack => pack.kind === 'workflow' && !pack.withdrawn);
  const dialogs: CommandDialog[] = [];
  const members: unknown[][] = [], circles: unknown[][] = [], permissions: Array<[string, unknown]> = [], assignments: unknown[][] = [];
  for (const user of users) {
    const assigned = await authorizations.packsFor(user.id);
    const tokens = await principals.tokens(user.id);
    const toggle = user.disabled ? commands.userEnable(user) : commands.userDisable(user);
    const spare = commands.tokenIssue(user), invite = commands.userInvite(user);
    if (ctx.admin) dialogs.push(toggle, spare, ...(user.disabled ? [] : [invite]));
    members.push([link(`/console/team/${user.id}`, user.name), uiLabelOf('permission_role', user.role), uiLabelOf('account_status', user.disabled ? 'disabled' : 'enabled'),
      user.role === 'admin' ? '全部工作流' : assigned.join('、') || '—',
      ctx.admin ? html`${commandLink(toggle, user.disabled ? '启用' : '停用')} ${user.disabled ? '' : commandLink(invite, '签发邀请码')} ${commandLink(spare, '签发 Circle 访问令牌')}` : '—']);
    if (member !== undefined) {
      if (ctx.admin) permissions.push(['重置密码', html`<form method="post" action="/console/admin/do/password-reset"><input type="hidden" name="csrf" value="${ctx.csrf ?? ''}"><input type="hidden" name="user" value="${user.id}"><button type="submit" class="btn" title="生成仅显示一次的初始密码，使该账户的控制台会话失效；下次登录必须修改">重置密码</button></form>`]);
      const canPublish = await authorizations.canPublish(user.id);
      const publish = commands.memberPublish(user.id, canPublish);
      if (ctx.admin) dialogs.push(publish);
      permissions.push(['角色', uiLabelOf('permission_role', user.role)], ['具有发布权', canPublish ? '是' : '否']);
      if (ctx.admin) permissions.push(['调整发布权', commandLink(publish, '调整')]);
      if(ctx.admin&&ctx.deps.knowledge.spaces)permissions.push(['个人空间容量',html`<form method="post" action="/console/knowledge/do/quota"><input type="hidden" name="csrf" value="${ctx.csrf??''}"><input type="hidden" name="space" value="${user.id}"><label title="个人空间默认 1 GiB；包括原文、条目与历史版本。调整上限不授予读取个人内容的权限。">容量上限（字节）<input type="number" name="bytes" min="0" max="9007199254740991" step="1" required value="${await ctx.deps.knowledge.spaces.capacity(user.id)}"></label><button type="submit" class="btn">保存容量上限</button></form>`]);
      for (const pack of packs) {
        const has = assigned.includes(pack.id);
        const change = commands.memberPack(user.id, pack.id, has);
        if (ctx.admin) dialogs.push(change);
        assignments.push([link(`/console/packs/${pack.id}`, pack.title), has || user.role === 'admin' ? '是' : '否', ctx.admin ? commandLink(change, has ? '移出使用范围' : '加入使用范围') : '—']);
      }
    }
    for (const token of tokens) {
      if (token.revoked_at !== null || user.disabled) continue;
      const revoke = commands.tokenRevoke(token, user.name);
      if (ctx.admin && token.revoked_at === null) dialogs.push(revoke);
      circles.push([await circleName(principals, token),user.name,when(token.last_used_at),ctx.admin ? commandLink(revoke,'断开') : '由管理员断开']);
    }
  }
  return {status:200,body:page(ctx.chrome(member === undefined ? '团队' : users[0].name,{active:'team',hint:'第一个账户是管理员；账户仅由管理员添加，成员权限和工作流分配在此管理。',actions:html`${button('/console/password','修改密码')}${ctx.admin ? button('/console/operations/member','添加成员',{primary:true,icon:'plus'}) : ''}`}),html`
${member === undefined ? '' : html`<p>${link('/console/team','返回团队')}</p>`}
${liveModule('members',['member.connected'],card({title:member === undefined ? '成员' : '成员详情',meta:`${users.length} 人`},table(['名字','角色','状态','可用的工作流','操作'],members)))}
${member === undefined ? '' : html`${sectionHead('权限')}${card(null,definitions(permissions))}${sectionHead('工作流分配')}${card(null,table([uiLabelOf('pack_kind', 'workflow'),'可使用','操作'],assignments,'尚无工作流'))}`}
<div class="mt16">${liveModule('member-circles',['member.connected'],card({title:'已连接的 Circle',hint:'停用、启用和断开生成命令，在管理员的 Circle 或 Hub 主机上执行。'},table(['设备名','成员','最近使用时间','操作'],circles,'尚无已连接的 Circle')))}</div>
${liveModule('dialogs',['member.connected'],dialogs.map(commandModal))}`)};
}
