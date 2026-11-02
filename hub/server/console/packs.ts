import {currentAudience,spaceLayout,selectedScope,inScope} from './space-layout.ts';
import {personalPackControls} from './personal-packs.ts';
// 任务包 (the design canvas's Workflows board): the packs the reader may use (administrators: every pack, with who may use
// it), and one pack's requirements, checks, versions and permissions. Publishing runs in the console (the publish
// operation); changing who may use or maintain a pack, retiring a version and switching a product pack are commands for the
// administrator's Circle (proposal decision 6 of 2026-10-31).
import { axisUiLabel, uiLabelOf, type PackKind } from '../../../contracts/generated/vocabulary.ts';
import type { LoadedWorkflow, PackListing } from '../../ports.ts';
import { compareVersions } from '../../runs/api.ts';
import { commands } from './commands.ts';
import { code, html, icon, link, liveModule, page, table, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import { button, card, chip, commandLink, commandModal, kv, sectionHead, when, type CommandDialog, type Tone } from './ui.ts';

const PACK_ICON: Readonly<Record<PackKind, string>> = { workflow: 'pack-i', product: 'pack-i g', system: 'pack-i o', skill: 'pack-i v' };

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

export async function packsPage(ctx: PageContext): Promise<PageResult> {
  const listings=await ctx.deps.packs.list(ctx.principal),scope=selectedScope(ctx);
  const groups = byId(listings.filter(pack=>inScope(scope,pack.space??'team',ctx.principal.id)));
  const canPublish=await ctx.deps.records.authorizations.canPublish(ctx.principal.id);
  const columns = async (kind: PackKind, hint: string,personal:boolean): Promise<Html> => {
    const cards: Html[] = [];
    for (const [id, versions] of groups) {
      const pack = shownVersion(versions);
      if (pack.kind !== kind||!!(pack.space&&pack.space!=='team')!==personal) continue;
      const state = stateOf(pack);
      const assigned = ctx.admin && kind === 'workflow' ? await assignedNames(ctx, pack) : null;
      const audience=await currentAudience(ctx,pack.space??'team','/',false,pack.id);
      cards.push(html`<a class="pack" href="/console/packs/${pack.id}${pack.space?'?space='+encodeURIComponent(pack.space):''}">
<span class="pack-h"><span class="${PACK_ICON[pack.kind]}">${icon('pack')}</span><span class="grow"><b>${pack.title}</b><br><span class="sub">${uiLabelOf('pack_kind', pack.kind)} · <code>${pack.id}@${pack.version}</code></span></span>${chip(state.text, state.tone)}</span>
<span class="pack-m"><span>所有者 ${await ctx.userName(pack.owner)}</span><span>发布于 ${when(pack.published_at)}</span>${versions.length > 1 ? html`<span>${versions.length} 个版本</span>` : ''}</span>
<span class="pack-m"><span>使用范围：${audience.text}</span><span>${uiLabelOf('knowledge_space_kind',pack.space&&pack.space!=='team'?'personal':'team')}</span></span>
</a>`);
    }
    return html`<div class="stack" id="${personal?'personal-':'team-'}${kind}">${sectionHead(uiLabelOf('knowledge_space_kind',personal?'personal':'team')+' · '+uiLabelOf('pack_kind', kind), `${cards.length} 个`, undefined, undefined, hint)}
${cards.length === 0 ? card(null, html`<p class="empty">尚无可用的${uiLabelOf('pack_kind', kind)}</p>`) : cards}</div>`;
  };
  const body = await spaceLayout(ctx,liveModule('packs', ['pack.published'], html`<div class="grid g2 section">
<section class="stack" aria-label="${uiLabelOf('pack_kind','workflow')}" id="workflow">${await columns('workflow','规定做法与验收要求；由 Circle 执行，Hub 按验收要求判定结果',true)}${await columns('workflow','团队工作流按分配使用',false)}</section>
<section class="stack" aria-label="${uiLabelOf('pack_kind','skill')}" id="skill">${await columns('skill','只规定做法，没有验收要求',true)}${await columns('skill','只规定做法，没有验收要求',false)}</section>
</div>`),listings);
  return { status: 200, body: page(ctx.chrome(uiLabelOf('pack_kind', 'workflow'), {
    active: 'packs', hint: '按当前读取权限列出工作流与通用技能',
    actions:html`${button('/console/packs/-/publish','发布个人工作流或通用技能',{icon:'upload'})}${canPublish?button('/console/operations/pack', '发布到团队', {primary:true,icon:'upload'}):html`<button class="btn" disabled title="没有发布权。可以先把个人工作流授权给指定成员使用；发布权由管理员在团队页设置">发布到团队</button>`}`,
  }), body) };
}

export const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function packPage(ctx: PageContext, id: string): Promise<PageResult> {
  if (!PACK_ID.test(id)) return neutralPage(ctx);
  const space=ctx.url.searchParams.get('space');
  const versions = byId(await ctx.deps.packs.list(ctx.principal)).get(space&&space!=='team'?space+'/'+id:id);
  if (versions === undefined) return neutralPage(ctx);
  const pack = shownVersion(versions);
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
  const head = card(null, html`<div class="dhead"><div class="grow"><div class="row"><span class="${PACK_ICON[pack.kind]}">${icon('pack')}</span><h2>${pack.title}</h2>${chip(state.text, state.tone)}</div>
<p class="sub mt4">${uiLabelOf('pack_kind', pack.kind)} · ${code(`${pack.id}@${pack.version}`)} · 所有者 ${await ctx.userName(pack.owner)} · 发布于 ${when(pack.published_at)} · 内容哈希 ${code(pack.digest.slice(0, 16))}</p></div>
${ctx.admin&&!pack.space ? html`<div class="actions">${button('/console/operations/pack', '发布新版本', { icon: 'upload',params:{kind:pack.kind} })}</div>` : ''}</div>`);
  const personalControls=await personalPackControls(ctx,pack);
  const requirements = loaded === null ? (pack.kind === 'workflow' ? card({title:'验收要求'}, html`<p class="notice">验收要求暂不可读</p>`) : html``) : card({ title: '验收要求', meta: `${loaded.requirements.length} 项` }, table(
    ['要求项', '说明', axisUiLabel('layer'), axisUiLabel('done_rule'), axisUiLabel('accepted_producer'), '必需', '检查项'],
    loaded.requirements.map((r) => [html`<b>${r.name}</b><div class="digest">${r.key}</div>`, r.description, r.layers.map((layer) => uiLabelOf('layer', layer)).join('、'), uiLabelOf('done_rule', r.done_rule), uiLabelOf('accepted_producer', r.accepted_producer), r.required ? '必需' : '可选', r.checks.length === 0 ? '未配置检查' : r.checks.join('、')]),
    '没有要求项',
  ));
  const checks = loaded === null ? html`` : card({ title: '检查项', hint: '阻断项未通过时结果不可用；提示项仅作标记' }, table(
    ['检查项', axisUiLabel('check_tier'), '检查脚本', axisUiLabel('source_role')],
    loaded.checks.map((c) => [html`<b>${c.title ?? c.id}</b><div class="digest">${c.id}</div>`, c.tier === undefined ? '—' : chip(uiLabelOf('check_tier', c.tier), c.tier === 'blocking' ? 'fail' : 'plain'), code(c.function ?? c.interpreter ?? '—'), uiLabelOf('source_role', c.judges)]),
    '没有检查项',
  ));
  const versionRows = versions.map((v) => {
    const s = stateOf(v);
    const retire = commands.packRetire(`${v.id}@${v.version}`);
    if (ctx.admin && !pack.space && !v.withdrawn) dialogs.push(retire);
    return [code(v.version), when(v.published_at), chip(s.text, s.tone), code(v.digest.slice(0, 16)), Object.entries(v.samples).map(([source, n]) => `${source} ${n}`).join('，') || '—', ctx.admin && !pack.space && !v.withdrawn ? commandLink(retire, '退役') : ''];
  });
  const assigned = ctx.admin ? await assignedNames(ctx, pack) : null;
  const permissionActions: Html[] = [];
  if (ctx.admin&&!pack.space) {
    if (pack.kind === 'workflow' && !pack.withdrawn) { const d = commands.packAssign(pack.id); dialogs.push(d); permissionActions.push(commandLink(d, '调整使用范围')); }
    if (pack.kind === 'product' && !pack.withdrawn) { const d = commands.packActivate(pack.id, pack.active); dialogs.push(d); permissionActions.push(commandLink(d, pack.active ? '停用产品知识来源' : '启用产品知识来源')); }
    const d = commands.packMaintainer(pack.id); dialogs.push(d); permissionActions.push(commandLink(d, '调整维护人'));
  }
  const permissions = card({ title: '版本与权限' }, html`${table(['版本', '发布时间', '状态', '内容哈希', '样例', ctx.admin ? '操作' : ''], versionRows)}
${kv([['所有者', await ctx.userName(pack.owner)], ...(assigned === null ? [] : [['使用范围', assigned.length === 0 ? '尚未指定成员' : assigned.join('、')] as const])])}
${permissionActions.length === 0 ? '' : html`<div class="card-f"><div class="row">${permissionActions}</div></div><p class="sub">调整使用范围、维护人与退役版本生成命令，在管理员的 Circle 中执行。</p>`}`);
  const body = html`${head}${personalControls}
<div class="section">${requirements}</div>
${loadFailed ? html`<p class="notice">该版本的验收要求与检查项暂不可读；版本与权限照常显示。</p>` : ''}
<section class="grid g-2-1 section"><div class="stack">${checks}</div>${permissions}</section>
${dialogs.map(commandModal)}`;
  const home = pack.kind === 'product' ? {active:'knowledge' as const,title:'知识库',path:'/console/knowledge',anchor:'product-sources'}
    : pack.kind === 'system' ? {active:'connections' as const,title:'连接',path:'/console/connections',anchor:'system-sources'}
    : {active:'packs' as const,title:uiLabelOf('pack_kind','workflow'),path:'/console/packs',anchor:pack.kind};
  const breadcrumb = html`${link(home.path,home.title)} › ${link(home.path+'#'+home.anchor,uiLabelOf('pack_kind',pack.kind))} › ${pack.title}`;
  return { status: 200, body: page(ctx.chrome(uiLabelOf('pack_kind', pack.kind), { active: home.active, sub: breadcrumb }), body) };
}
