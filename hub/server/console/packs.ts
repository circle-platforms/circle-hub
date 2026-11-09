import {memoReadPort} from '../../records/api.ts';
import {currentAudience,spaceLayout,selectedScope,inScope} from './space-layout.ts';
import {personalPackControls} from './personal-packs.ts';
// 任务包 (the design canvas's Workflows board): the packs the reader may use (administrators: every pack, with who may use
// it), and one pack's requirements, checks, versions and permissions. Publishing runs in the console (the publish
// operation); changing who may use or maintain a pack, retiring a version and switching a product pack are commands for the
// administrator's Circle (proposal decision 6 of 2026-10-31).
import { PACK_KIND, axisUiLabel, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { acceptedProducerHead, doneRuleHead } from './pack-display.ts';
import type { LoadedWorkflow, PackListing } from '../../ports.ts';
import {KnowledgeSearchScopeSchema,type KnowledgeSearchScope} from '../../../contracts/generated/vocabulary.ts';
import {timestamp} from './knowledge-display.ts';
import {panel as card,badge as chip,technical,facts as kv,commandLink,commandModal,dialog,actionLink} from './presentation.ts';
import { compareVersions } from '../../runs/api.ts';
import { commands } from './commands.ts';
import { code, html, href, link, liveModule, page, pageLayout, table, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import { button, type CommandDialog, type Tone } from './ui.ts';

export function stateOf(pack: PackListing): { text: string; tone: Tone | 'plain' } {
  if (pack.withdrawn) return { text: uiLabelOf('pack_status', 'retired'), tone: 'unchecked' };
  if (pack.kind === 'product') return pack.active ? { text: uiLabelOf('pack_status', 'enabled'), tone: 'pass' } : { text: uiLabelOf('pack_status', 'inactive'), tone: 'plain' };
  return { text: uiLabelOf('pack_status', 'published'), tone: 'pass' };
}

export const packIdentity=(pack:PackListing)=>pack.space&&pack.space!=='team'?pack.space+'/'+pack.id:pack.id;

/** Every version of each pack id, newest version first. */
export function byId(listings: readonly PackListing[]): Map<string, PackListing[]> {
  const out = new Map<string, PackListing[]>();
  for (const listing of listings) out.set(packIdentity(listing), [...(out.get(packIdentity(listing)) ?? []), listing]);
  for (const versions of out.values()) versions.sort((a, b) => compareVersions(b.version, a.version));
  return out;
}

/** The version a card shows: the newest one still published, else the newest. */
export const shownVersion = (versions: readonly PackListing[]): PackListing => versions.find((v) => !v.withdrawn) ?? versions[0];

async function assignedNames(ctx: PageContext, pack: PackListing): Promise<string[] | null> {
  if (pack.assigned_to === undefined) return null;
  return Promise.all(pack.assigned_to.map((user) => ctx.userName(user)));
}

async function usageAudience(ctx:PageContext,pack:PackListing):Promise<string>{
  if(pack.space&&pack.space!=='team')return (await currentAudience(ctx,pack.space,'/',false,pack.id)).text;
  if(pack.kind!=='workflow')return uiLabelOf('audience_scope','team');
  if(!ctx.admin)return uiLabelOf('knowledge_search_scope','team');
  const users=(await memoReadPort(ctx.deps.records.principals,['get','list']).list()).filter(user=>!user.disabled);
  const assigned=new Set(pack.assigned_to??await ctx.deps.records.authorizations.usersOf(pack.id));
  const eligible=users.filter(user=>assigned.has(user.id));
  if(!eligible.length)return uiLabelOf('audience_scope','team_unassigned');
  return eligible.map(user=>user.name).join('、');
}

export async function packsPage(ctx: PageContext): Promise<PageResult> {
  const listings=await ctx.deps.packs.list(ctx.principal),scope=selectedScope(ctx);
  const canPublish=await ctx.deps.records.authorizations.canPublish(ctx.principal.id);
  const body=await spaceLayout(ctx,liveModule('packs',['pack.published'],await packList(ctx,listings,scope)),listings);
  return { status: 200, body: page(ctx.chrome(uiLabelOf('pack_kind', 'workflow'), {
    active: 'packs', hint: '按当前读取权限列出工作流与通用技能',
    actions:html`${button('/console/packs/-/publish','发布我的工作流或通用技能',{icon:'upload'})}${canPublish?button('/console/operations/pack', '发布到团队', {primary:true,icon:'upload'}):html`<button class="ch-btn ch-btn--secondary" disabled title="没有发布权。可以先把我的工作流分享给指定成员使用；发布权由管理员在团队页设置">发布到团队</button>`}`,
  }), body) };
}

export const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function packList(ctx:PageContext,listings:readonly PackListing[],scope:KnowledgeSearchScope,selected?:PackListing):Promise<Html>{
  const groups=byId(listings.filter(pack=>inScope(scope,pack.space??'team',ctx.principal.id)));
  const values=KnowledgeSearchScopeSchema.enum,scopes=scope==='all'?[values.personal,values.shared,values.team]:[scope];
  const kinds=selected&&(selected.kind==='product'||selected.kind==='system')?[selected.kind]:PACK_KIND.filter(kind=>kind==='workflow'||kind==='skill');
  const sections:Html[]=[];
  for(const kind of kinds)for(const group of scopes){
    const rows:Html[]=[];
    for(const versions of groups.values()){
      const pack=shownVersion(versions);
      if(pack.kind!==kind||!inScope(group,pack.space??'team',ctx.principal.id))continue;
      const state=stateOf(pack),url=href('/console/packs/'+pack.id,{space:pack.space,scope});
      const on=selected!==undefined&&packIdentity(selected)===packIdentity(pack);
      rows.push(html`<li class="ch-row${on?' is-selected':''}"${on?html` aria-current="true"`:''} data-row-href="${url}"><span class="ch-row-mark" aria-hidden="true"></span><div class="ch-row-body"><a class="ch-row-title" href="${url}">${pack.title}</a><div class="ch-row-meta">${chip(state.text,state.tone)}<span>使用范围：${await usageAudience(ctx,pack)}</span>${timestamp(pack.published_at)}</div></div></li>`);
    }
    if(group==='shared'&&!rows.length)continue;
    sections.push(html`<section class="ch-section" id="${group}-${kind}" aria-label="${uiLabelOf('pack_kind',kind)}">${group===scopes[0]?html`<span id="${kind}" aria-hidden="true"></span>`:''}${card({title:uiLabelOf('knowledge_search_scope',group)+' · '+uiLabelOf('pack_kind',kind),meta:`${rows.length} 个`,hint:kind==='workflow'?'规定做法与验收要求；由客户端执行，Hub 按验收要求判定结果':'只规定做法，没有验收要求'},rows.length?html`<ul class="ch-list">${rows}</ul>`:html`<div class="ch-empty"><p class="ch-empty-title">尚无可用的${uiLabelOf('pack_kind',kind)}</p></div>`)}</section>`);
  }
  return html`<div class="ch-section" data-area-content>${sections}</div>`;
}

export async function packPage(ctx: PageContext, id: string): Promise<PageResult> {
  if (!PACK_ID.test(id)) return neutralPage(ctx);
  const space=ctx.url.searchParams.get('space');
  const listings=await ctx.deps.packs.list(ctx.principal);
  const versions = byId(listings).get(space&&space!=='team'?space+'/'+id:id);
  if (versions === undefined) return neutralPage(ctx);
  const version=ctx.url.searchParams.get('version');
  const pack=version?versions.find(pack=>pack.version===version):shownVersion(versions);
  if(!pack)return neutralPage(ctx);
  const state = stateOf(pack);
  const dialogs: CommandDialog[] = [];
  let loaded: LoadedWorkflow | null = null;
  let loadFailed = false;
  if (pack.kind === 'workflow') {
    try {
      loaded = await ctx.deps.workflows.byDigest(pack.digest,pack.space);
      loadFailed = loaded === null;
    } catch {
      loadFailed = true;
    }
  }
  const head = card(null, html`<div class="ch-section"><div class="ch-section"><div class="ch-actions"><span class="ch-tag">${uiLabelOf('pack_kind',pack.kind)}</span><h2>${pack.title}</h2>${chip(state.text, state.tone)}</div>
<p class="ch-meta">${uiLabelOf('pack_kind', pack.kind)} · 所有者 ${await ctx.userName(pack.owner)} · 发布于 ${timestamp(pack.published_at)}</p>${technical(kv([['标识',code(`${pack.id}@${pack.version}`)],['内容哈希',code(pack.digest)]]))}</div>
</div>`);
  const personalControls=await personalPackControls(ctx,pack);
  const requirements = loaded === null ? (pack.kind === 'workflow' ? card({title:'验收要求'}, html`<p class="notice">验收要求暂不可读</p>`) : html``) : card({ title: '验收要求', meta: `${loaded.requirements.length} 项` }, table(
    ['要求项', '说明', axisUiLabel('layer'), doneRuleHead(), acceptedProducerHead(), '必需', '检查项'],
    loaded.requirements.map((r) => [html`<b>${r.name}</b>${technical(code(r.key),'查看')}`, r.description, r.layers.map((layer) => uiLabelOf('layer', layer)).join('、'), uiLabelOf('done_rule', r.done_rule), uiLabelOf('accepted_producer', r.accepted_producer), r.required ? '必需' : '可选', r.checks.length === 0 ? '未配置检查' : r.checks.map(id=>loaded?.checks.find(check=>check.id===id)?.title??'检查项').join('、')]),
    '没有要求项',
  ));
  const checks = loaded === null ? html`` : card({ title: '检查项', hint: '阻断项未通过时结果不可用；提示项仅作标记' }, table(
    ['检查项', axisUiLabel('check_tier'), '检查脚本', axisUiLabel('source_role')],
    loaded.checks.map((c) => [html`<b>${c.title ?? '检查项'}</b>${technical(code(c.id),'查看')}`, c.tier === undefined ? '—' : chip(uiLabelOf('check_tier', c.tier), c.tier === 'blocking' ? 'fail' : 'plain'), technical(code(c.function ?? c.interpreter ?? '—'),'查看'), uiLabelOf('source_role', c.judges)]),
    '没有检查项',
  ));
  const versionRows = versions.map((v) => {
    const s = stateOf(v);
    return [timestamp(v.published_at), chip(s.text, s.tone), technical(kv([['版本',code(v.version)],['内容哈希',code(v.digest)]]),'查看'), Object.values(v.samples).reduce((sum,n)=>sum+n,0), link('/console/packs/'+pack.id,'选择',{space:pack.space,version:v.version,scope:ctx.url.searchParams.get('scope')})];
  });
  const assigned = ctx.admin ? await assignedNames(ctx, pack) : null;
  const permissionActions: Html[] = [];
  if (ctx.admin&&!pack.space) {
    if (pack.kind === 'workflow' && !pack.withdrawn) { const d = commands.packAssign(pack.id); dialogs.push(d); permissionActions.push(commandLink(d, '调整使用范围')); }
    if (pack.kind === 'product' && !pack.withdrawn) { const d = commands.packActivate(pack.id, pack.active); dialogs.push(d); permissionActions.push(commandLink(d, pack.active ? '停用产品知识来源' : '启用产品知识来源')); }
    const d = commands.packMaintainer(pack.id); dialogs.push(d); permissionActions.push(commandLink(d, '调整维护人'));
  }
  const permissions = card({ title: '版本记录',hint:'使用范围、维护人与下架动作在 Hub 所在主机上执行生成的命令。' }, html`${table(['发布时间', '状态', '查看', '样例', '版本'], versionRows,'没有版本记录',undefined,{selected:versions.indexOf(pack),hrefs:versions.map(version=>href('/console/packs/'+pack.id,{space:pack.space,version:version.version,scope:ctx.url.searchParams.get('scope')}))})}
${kv([['所有者', await ctx.userName(pack.owner)], ...(assigned === null ? [] : [['使用范围', assigned.length === 0 ? uiLabelOf('audience_scope','team_unassigned') : assigned.join('、')] as const])])}
${permissionActions.length === 0 ? '' : html`<div class="ch-actions"><div class="ch-actions">${permissionActions}</div></div>`}`);
  if(ctx.admin&&!pack.space&&!pack.withdrawn)dialogs.push(commands.packRetire(`${pack.id}@${pack.version}`));
  const body = html`${head}
<div class="ch-section">${requirements}</div>${personalControls.body}
${loadFailed ? html`<p class="notice">该版本的验收要求与检查项暂不可读；版本与权限照常显示。</p>` : ''}
<section class="ch-section"><div class="ch-section">${checks}</div>${dialog('pack-versions','版本记录',permissions)}</section>
${dialogs.map(commandModal)}<footer class="ch-inspector-actions">${actionLink('#pack-versions','版本记录','ghost')}${personalControls.actions}${ctx.admin&&!pack.space&&!pack.withdrawn?commandLink(commands.packRetire(`${pack.id}@${pack.version}`),'退役…','ch-btn ch-btn--danger'):''}${ctx.admin&&!pack.space?button('/console/operations/pack','发布新版本…',{primary:true,params:{kind:pack.kind}}):''}</footer>`;
  const home = pack.kind === 'product' ? {active:'knowledge' as const,title:'知识库',path:'/console/knowledge',anchor:'product-sources'}
    : pack.kind === 'system' ? {active:'connections' as const,title:'连接',path:'/console/connections',anchor:'system-sources'}
    : {active:'packs' as const,title:uiLabelOf('pack_kind','workflow'),path:'/console/packs',anchor:pack.kind};
  const breadcrumb = html`${link(home.path,home.title)} › ${link(home.path+'#'+home.anchor,uiLabelOf('pack_kind',pack.kind))} › ${pack.title}`;
  const scope=selectedScope(ctx);
  const listing=await packList(ctx,listings,scope,pack);
  const layout=pageLayout(listing,{inspector:html`<div class="ch-section" data-area-content data-inspector-content>${body}</div>`,detail:true,back:link(home.path,'返回列表',{scope})});
  return { status: 200, body: page(ctx.chrome(home.title, { active: home.active, crumbs:breadcrumb }),home.active==='packs'?await spaceLayout(ctx,layout,listings):layout) };
}
