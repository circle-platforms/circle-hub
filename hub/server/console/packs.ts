import {packPurpose,packPath,PACK_PLACES,type PlaceKind} from './pack-display.ts';
import {memoReadPort} from '../../records/api.ts';
import {currentAudience,spaceLayout,selectedScope,inScope} from './space-layout.ts';
import {personalPackControls} from './personal-packs.ts';
// 任务包 (the design canvas's Workflows board): the packs the reader may use (administrators: every pack, with who may use
// it), and one pack's requirements, checks, versions and permissions. Publishing runs in the console (the publish
// operation); changing who may use or maintain a pack, retiring a version and switching a product pack are commands for the
// administrator's Circle (proposal decision 6 of 2026-10-31).
// Decision 151, step 6: a place is one table, and a pack is a page of its own with its content in tabs. It used to open in a
// pane beside the list, where the requirement table was cut off at the pane's edge.
import { axisUiLabel, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { acceptedProducerHead, doneRuleHead } from './pack-display.ts';
import type { LoadedWorkflow, PackListing } from '../../ports.ts';
import {KnowledgeSearchScopeSchema,type KnowledgeSearchScope} from '../../../contracts/generated/vocabulary.ts';
import {timestamp} from './knowledge-display.ts';
import {badge as chip,facts as kv,commandLink,commandModal,tooltip} from './presentation.ts';
import { compareVersions } from '../../runs/api.ts';
import { commands } from './commands.ts';
import { code, html, href, link, liveModule, page, pageLayout, table, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import { box, button, type CommandDialog, type Tone } from './ui.ts';

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

/** The list of one place: workflows, or skills (decision 151). Each place lists only its own kind. */
export async function packsPage(ctx: PageContext, kind: PlaceKind = 'workflow'): Promise<PageResult> {
  const listings=await ctx.deps.packs.list(ctx.principal),scope=selectedScope(ctx),place=PACK_PLACES[kind],noun=uiLabelOf('pack_kind',kind);
  const canPublish=await ctx.deps.records.authorizations.canPublish(ctx.principal.id);
  const body=await spaceLayout(ctx,liveModule('packs',['pack.published'],await packList(ctx,listings,scope,kind)),listings,kind);
  return { status: 200, body: page(ctx.chrome(place.title, {
    active: place.active, hint: packPurpose(kind)+'这里只列出当前账户可用的内容。',
    actions:html`${button('/console/packs/-/publish',`发布我的${noun}`,{icon:'upload'})}${canPublish?button('/console/operations/pack', '发布到团队', {primary:true,icon:'upload',...(kind==='workflow'?{}:{params:{kind}})}):html`<button class="ch-btn ch-btn--secondary" disabled title="没有发布权。可以先把我的${noun}分享给指定成员使用；发布权由管理员在团队页设置">发布到团队</button>`}`,
  }), body) };
}

export const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Whose a pack is, as the scope it is listed under: the reader's own, shared with the reader, or the team's. */
const scopeOf=(ctx:PageContext,pack:PackListing):KnowledgeSearchScope=>{
  const values=KnowledgeSearchScopeSchema.enum;
  return !pack.space||pack.space==='team'?values.team:pack.space===ctx.principal.id?values.personal:values.shared;
};

/**
 * One table for the place: the reader's own first, then what is shared with them, then the team's. Under 全部 a column says
 * which of the three a row is; a group with nothing in it takes no room (it used to be a titled empty card above the list).
 */
async function packList(ctx:PageContext,listings:readonly PackListing[],scope:KnowledgeSearchScope,place:PlaceKind):Promise<Html>{
  const groups=byId(listings.filter(pack=>inScope(scope,pack.space??'team',ctx.principal.id)));
  const values=KnowledgeSearchScopeSchema.enum,noun=uiLabelOf('pack_kind',place),every=scope===values.all;
  const rows:unknown[][]=[],hrefs:string[]=[];
  for(const group of [values.personal,values.shared,values.team])for(const versions of groups.values()){
    const pack=shownVersion(versions);
    if(pack.kind!==place||scopeOf(ctx,pack)!==group)continue;
    const state=stateOf(pack),url=href(packPath(pack),{space:pack.space,scope});
    rows.push([html`<a class="ch-row-title" href="${url}">${pack.title}</a>`,...(every?[html`<span data-pack-scope="${group}">${uiLabelOf('knowledge_search_scope',group)}</span>`]:[]),html`<span data-pack-audience>${await usageAudience(ctx,pack)}</span>`,timestamp(pack.published_at),chip(state.text,state.tone)]);
    hrefs.push(url);
  }
  const empty={title:`尚无可用的${noun}`,text:scope===values.personal?`发布我的${noun}后只有本人可用，之后可以分享给成员或发布到团队。`:scope===values.shared?`其他成员分享的${noun}在此列出。`:`发布或获得分配后在此列出。`};
  return html`<section class="ch-section" id="${place}" aria-label="${noun}" data-area-content>${box(null,table(['名称',...(every?['所属']:[]),'使用范围','发布时间','状态'],rows,empty,'packs',{hrefs}),{flush:true})}</section>`;
}

/** The tabs of one pack's page: a workflow has all four, every other kind the last two (it declares no acceptance). */
const PACK_TABS = ['requirements', 'checks', 'versions', 'technical'] as const;
type PackTab = typeof PACK_TABS[number];
const PACK_TAB_LABEL: Record<PackTab, string> = { requirements: '验收要求', checks: '检查项', versions: '版本记录', technical: '技术信息' };

export async function packPage(ctx: PageContext, id: string): Promise<PageResult> {
  if (!PACK_ID.test(id)) return neutralPage(ctx);
  const space=ctx.url.searchParams.get('space');
  const listings=await ctx.deps.packs.list(ctx.principal);
  const versions = byId(listings).get(space&&space!=='team'?space+'/'+id:id);
  if (versions === undefined) return neutralPage(ctx);
  const version=ctx.url.searchParams.get('version');
  const pack=version?versions.find(pack=>pack.version===version):shownVersion(versions);
  if(!pack)return neutralPage(ctx);
  const state = stateOf(pack), path = packPath(pack);
  const dialogs: CommandDialog[] = [];
  let loaded: LoadedWorkflow | null = null;
  if (pack.kind === 'workflow') {
    try {
      loaded = await ctx.deps.workflows.byDigest(pack.digest,pack.space);
    } catch {
      loaded = null;
    }
  }
  // Every link of the page keeps the space, the list's scope and the version on show.
  const place = { space: pack.space, scope: ctx.url.searchParams.get('scope') }, kept = { ...place, ...(version ? { version: pack.version } : {}) };
  const tabsOf: readonly PackTab[] = pack.kind === 'workflow' ? PACK_TABS : PACK_TABS.filter((key) => key === 'versions' || key === 'technical');
  const asked = ctx.url.searchParams.get('tab'), tab = tabsOf.find((key) => key === asked) ?? tabsOf[0];
  const counts: Partial<Record<PackTab, number>> = { ...(loaded === null ? {} : { requirements: loaded.requirements.length, checks: loaded.checks.length }), versions: versions.length };
  const kindTitle=uiLabelOf('pack_kind',pack.kind);
  const tabs = html`<nav class="ch-seg" aria-label="${kindTitle}内容" data-pack-tabs>${tabsOf.map((key) => html`<a href="${href(path, { ...kept, ...(key === tabsOf[0] ? {} : { tab: key }) })}"${key === tab ? html` aria-current="page"` : ''}>${PACK_TAB_LABEL[key]}${counts[key] === undefined ? '' : html` <span class="ch-count">${counts[key]!.toLocaleString('en-US')}</span>`}</a>`)}</nav>`;
  const unreadable = box(null, html`<p class="notice">该版本的验收要求与检查项暂不可读；版本记录照常显示。</p>`);
  let content: Html;
  if (tab === 'requirements') {
    content = loaded === null ? unreadable : box(null, table(
      ['要求项', '说明', axisUiLabel('layer'), doneRuleHead(), acceptedProducerHead(), '必需', '检查项'],
      loaded.requirements.map((r) => [html`<b>${r.name}</b>`, r.description, r.layers.map((layer) => uiLabelOf('layer', layer)).join('、'), uiLabelOf('done_rule', r.done_rule), uiLabelOf('accepted_producer', r.accepted_producer), r.required ? '必需' : '可选', r.checks.length === 0 ? '未配置检查' : r.checks.map(id=>loaded?.checks.find(check=>check.id===id)?.title??'检查项').join('、')]),
      '没有要求项', 'pack-requirements'), { flush: true });
  } else if (tab === 'checks') {
    content = loaded === null ? unreadable : box(null, table(
      ['检查项', tooltip(axisUiLabel('check_tier'), '阻断项未通过时结果不可用；提示项仅作标记'), axisUiLabel('source_role'), '用于要求项'],
      loaded.checks.map((c) => [html`<b>${c.title ?? '检查项'}</b>`, c.tier === undefined ? '—' : chip(uiLabelOf('check_tier', c.tier), c.tier === 'blocking' ? 'fail' : 'plain'), uiLabelOf('source_role', c.judges), loaded?.requirements.filter((r) => r.checks.includes(c.id)).map((r) => r.name).join('、') || '—']),
      '没有检查项'), { flush: true });
  } else if (tab === 'versions') {
    const workflow = pack.kind === 'workflow';
    content = box(null, table(
      ['发布时间', '状态', ...(workflow ? ['样例'] : []), '显示'],
      versions.map((v) => { const s = stateOf(v); return [timestamp(v.published_at), chip(s.text, s.tone), ...(workflow ? [Object.values(v.samples).reduce((sum,n)=>sum+n,0)] : []), v === pack ? '当前显示' : link(path, '查看这个版本', { ...place, version: v.version })]; }),
      '没有版本记录', undefined, { selected: versions.indexOf(pack), hrefs: versions.map((v) => href(path, { ...place, version: v.version })) }), { flush: true });
  } else {
    // The values a person does not read stand on this tab alone: identifiers, digests, version numbers and check scripts.
    content = box({ title: '技术信息', meta: '供排查和对账使用' }, html`<div class="ch-stack" data-technical>${kv([['标识',code(`${pack.id}@${pack.version}`)],['内容哈希',code(pack.digest)]])}
${loaded === null ? '' : html`${table(['要求项', '键'], loaded.requirements.map((r) => [r.name, code(r.key)]), '没有要求项')}
${table(['检查项', '标识', '检查脚本'], loaded.checks.map((c) => [c.title ?? '检查项', code(c.id), c.function ? html`${code(c.function.module)} · ${code(c.function.export ?? 'default')}` : code(c.interpreter ?? '—')]), '没有检查项')}`}
${table(['发布时间', '版本', '内容哈希'], versions.map((v) => [timestamp(v.published_at), code(v.version), code(v.digest)]), '没有版本记录')}</div>`);
  }
  // What the page opens with: the state, whose it is, who may use it, and the actions on exactly that.
  const personalControls=await personalPackControls(ctx,pack);
  const access: Html[] = [];
  if (ctx.admin&&!pack.space) {
    if (pack.kind === 'workflow' && !pack.withdrawn) { const d = commands.packAssign(pack.id); dialogs.push(d); access.push(html`<a href="#${d.id}">调整使用范围…</a>`); }
    if (pack.kind === 'product' && !pack.withdrawn) { const d = commands.packActivate(pack.id, pack.active); dialogs.push(d); access.push(html`<a href="#${d.id}">${pack.active ? '停用产品知识来源…' : '启用产品知识来源…'}</a>`); }
    const d = commands.packMaintainer(pack.id); dialogs.push(d); access.push(html`<a href="#${d.id}">调整维护人…</a>`);
  }
  const retire = ctx.admin&&!pack.space&&!pack.withdrawn ? commands.packRetire(`${pack.id}@${pack.version}`) : null;
  if (retire) dialogs.push(retire);
  const current = shownVersion(versions);
  const head = html`<section class="ch-section" data-pack-head><p class="ch-meta" data-pack-facts>${chip(state.text, state.tone)} ${uiLabelOf('knowledge_search_scope', scopeOf(ctx, pack))} · 所有者 ${await ctx.userName(pack.owner)} · 发布于 ${timestamp(pack.published_at)}</p>
${pack === current ? '' : html`<p class="notice" data-pack-earlier>这里显示的是较早的版本。${link(path, '查看当前版本', place)}</p>`}
<div class="ch-toolbar">${personalControls.body.text ? personalControls.body : html`<p>使用范围：${await usageAudience(ctx, pack)}</p>`}${access.length === 0 ? '' : html`<div class="ch-actions">${access}</div>`}</div></section>`;
  const actions = html`${personalControls.actions}${retire ? commandLink(retire, '退役…', 'ch-btn ch-btn--danger') : ''}${ctx.admin&&!pack.space?button('/console/operations/pack','发布新版本…',{primary:true,params:{kind:pack.kind}}):''}`;
  const body = html`<div class="ch-stack" data-pack-page>${head}${tabs}<div data-pack-tab="${tab}">${content}</div>${dialogs.map(commandModal)}</div>`;
  // Where the kind is listed: a section of the knowledge page, a tab of the connections page, or a place of its own.
  const home = pack.kind === 'product' ? {active:'knowledge' as const,title:'知识库',path:'/console/knowledge',list:'/console/knowledge/products'}
    : pack.kind === 'system' ? {active:'connections' as const,title:'连接',path:'/console/connections',list:'/console/connections?tab=packs'}
    : {...PACK_PLACES[pack.kind],list:PACK_PLACES[pack.kind].path};
  // A place that lists one kind is not followed by that kind's name again.
  // The page itself, the pack's title, is the last place of the trail: page() adds it.
  const breadcrumb = [link(home.path,home.title),...(home.title===kindTitle||pack.kind==='skill'?[]:[link(home.list,kindTitle)])];
  const layout=pageLayout(body,{inspector:null});
  return { status: 200, body: page(ctx.chrome(pack.title, { active: home.active, crumbs:breadcrumb, ...(actions.text ? { actions } : {}) }),pack.kind==='workflow'||pack.kind==='skill'?await spaceLayout(ctx,layout,listings,pack.kind):layout) };
}
