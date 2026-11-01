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
import { button, card, chip, commandLink, commandModal, kpi, kv, plannedCard, sectionHead, when, type CommandDialog, type Tone } from './ui.ts';

const PACK_ICON: Readonly<Record<PackKind, string>> = { workflow: 'pack-i', product: 'pack-i g', system: 'pack-i o', skill: 'pack-i v' };

export function stateOf(pack: PackListing): { text: string; tone: Tone | 'plain' } {
  if (pack.withdrawn) return { text: '已退役', tone: 'unchecked' };
  if (pack.kind === 'product') return pack.active ? { text: '已启用', tone: 'pass' } : { text: '未启用', tone: 'plain' };
  return { text: '已发布', tone: 'pass' };
}

/** Every version of each pack id, newest version first. */
export function byId(listings: readonly PackListing[]): Map<string, PackListing[]> {
  const out = new Map<string, PackListing[]>();
  for (const listing of listings) out.set(listing.id, [...(out.get(listing.id) ?? []), listing]);
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
  const listings = await ctx.deps.packs.list(ctx.principal);
  const groups = byId(listings);
  const live = listings.filter((p) => !p.withdrawn);
  const cards: Html[] = [];
  for (const [id, versions] of groups) {
    const pack = shownVersion(versions);
    const state = stateOf(pack);
    const assigned = ctx.admin ? await assignedNames(ctx, pack) : null;
    cards.push(html`<a class="pack" href="/console/packs/${id}">
<span class="pack-h"><span class="${PACK_ICON[pack.kind]}">${icon('pack')}</span><span class="grow"><b>${pack.title}</b><span class="sub">${uiLabelOf('pack_kind', pack.kind)} · <code>${pack.id}@${pack.version}</code></span></span>${chip(state.text, state.tone)}</span>
<span class="pack-m"><span>所有者 ${await ctx.userName(pack.owner)}</span><span>发布于 ${when(pack.published_at)}</span>${versions.length > 1 ? html`<span>${versions.length} 个版本</span>` : ''}</span>
${assigned === null ? '' : html`<span class="pack-m"><span>使用范围：${assigned.length === 0 ? '尚未指定成员' : assigned.join('、')}</span></span>`}
</a>`);
  }
  const kinds = (kind: PackKind) => live.filter((p) => p.kind === kind);
  const kpis = html`<section class="grid g4 section">
${kpi(uiLabelOf('pack_kind', 'workflow'), kinds('workflow').length, { unit: '个', note: '定义流程、检查项与要求项' })}
${kpi(uiLabelOf('pack_kind', 'product'), kinds('product').length, { unit: '个', note: `已启用 ${kinds('product').filter((p) => p.active).length} 个` })}
${kpi(uiLabelOf('pack_kind', 'system'), kinds('system').length, { unit: '个', note: '业务系统的只读访问方式' })}
${kpi('已退役版本', listings.filter((p) => p.withdrawn).length, { unit: '个', note: '只保留记录，不再用于新任务' })}
</section>`;
  const body = html`${liveModule('packs', ['pack.published'], html`${kpis}
${sectionHead('任务包', ctx.admin ? '全部任务包；点击查看要求项、检查项、版本与使用范围' : '本人可用的任务包；点击查看要求项与检查项')}
${cards.length === 0 ? html`<article class="card"><p class="empty">尚无可用的任务包</p><p class="sub mt4">${ctx.admin ? '在“发布任务包”中上传任务包。' : '任务包由管理员分配。'}</p></article>` : html`<div class="packs">${cards}</div>`}`)}
${sectionHead('定时任务与机器人', '按时间或事件自动执行：知识导入、系统巡检、未知项汇总')}
<section class="grid g2">${plannedCard('定时任务', '按计划或事件触发任务；需先开放“消息通知”与“数据回写”（当前均未开放），定时任务方可输出结果。', 'clock')}${plannedCard('机器人', '无人值守执行任务；机器人发出的请求在负责人的 Circle 下次连接时送达，或经消息渠道送达，待“消息通知”开放后确定。', 'users')}</section>`;
  return {
    status: 200,
    body: page(ctx.chrome('任务包', {
      active: 'packs',
      sub: '任务包定义统一的流程与检查项；所有成员按同一流程执行，结果按同一标准校验。',
      ...(ctx.admin ? { actions: button('/console/operations/pack', '发布任务包', { primary: true, icon: 'upload' }) } : {}),
    }), body),
  };
}

export const PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function packPage(ctx: PageContext, id: string): Promise<PageResult> {
  if (!PACK_ID.test(id)) return neutralPage(ctx);
  const versions = byId(await ctx.deps.packs.list(ctx.principal)).get(id);
  if (versions === undefined) return neutralPage(ctx);
  const pack = shownVersion(versions);
  const state = stateOf(pack);
  const dialogs: CommandDialog[] = [];
  let loaded: LoadedWorkflow | null = null;
  let loadFailed = false;
  if (pack.kind === 'workflow') {
    try {
      loaded = await ctx.deps.workflows.byDigest(pack.digest);
    } catch {
      loadFailed = true;
    }
  }
  const head = card(null, html`<div class="dhead"><div class="grow"><div class="row"><span class="${PACK_ICON[pack.kind]}">${icon('pack')}</span><h2>${pack.title}</h2>${chip(state.text, state.tone)}</div>
<p class="sub mt4">${uiLabelOf('pack_kind', pack.kind)} · ${code(`${pack.id}@${pack.version}`)} · 所有者 ${await ctx.userName(pack.owner)} · 发布于 ${when(pack.published_at)} · 内容哈希 ${code(pack.digest.slice(0, 16))}</p></div>
${ctx.admin ? html`<div class="actions">${button('/console/operations/pack', '发布新版本', { icon: 'upload' })}</div>` : ''}</div>`);
  let flow: Html = html``;
  if (loaded !== null) {
    const judged = loaded.requirements.some((r) => r.accepted_producer !== 'fact');
    const effects = (loaded.effects ?? []).length > 0;
    flow = card({ title: '流程', meta: '各步骤的执行位置' }, html`<div class="stages">
<div class="stage circle"><span class="host"><span class="dot unknown"></span>本机 Circle</span><b>读取</b><span class="sub">${loaded.workflow.inputs.map((input) => input.description).join('；') || '—'}</span></div>
${judged ? html`<div class="stage circle"><span class="host"><span class="dot unknown"></span>本机 Circle</span><b>生成结论</b><span class="sub">模型在本机运行，按任务包规程提交</span></div>` : ''}
<div class="stage on-hub"><span class="host"><span class="dot info"></span>Hub</span><b>校验</b><span class="sub">${loaded.checks.length} 个检查项 · 引用校验与沙箱复验</span></div>
${effects ? html`<div class="stage on-hub"><span class="host"><span class="dot info"></span>Hub</span><b>派发</b><span class="sub">校验通过后派发到运行环境</span></div>` : ''}
</div>`);
  }
  const requirements = loaded === null ? html`` : card({ title: '要求项', meta: `${loaded.requirements.length} 项` }, table(
    ['要求项', '说明', axisUiLabel('layer'), axisUiLabel('done_rule'), axisUiLabel('accepted_producer'), '必需', '检查项'],
    loaded.requirements.map((r) => [html`<b>${r.name}</b><div class="digest">${r.key}</div>`, r.description, r.layers.map((layer) => uiLabelOf('layer', layer)).join('、'), uiLabelOf('done_rule', r.done_rule), uiLabelOf('accepted_producer', r.accepted_producer), r.required ? '必需' : '可选', r.checks.length === 0 ? '未配置检查' : r.checks.join('、')]),
    '没有要求项',
  ));
  const checks = loaded === null ? html`` : card({ title: '检查项', meta: '阻断项未通过时结果不可用；提示项仅作标记' }, table(
    ['检查项', axisUiLabel('check_tier'), '检查脚本', axisUiLabel('source_role')],
    loaded.checks.map((c) => [html`<b>${c.title ?? c.id}</b><div class="digest">${c.id}</div>`, c.tier === undefined ? '—' : chip(uiLabelOf('check_tier', c.tier), c.tier === 'blocking' ? 'fail' : 'plain'), code(c.function ?? c.interpreter ?? '—'), uiLabelOf('source_role', c.judges)]),
    '没有检查项',
  ));
  const versionRows = versions.map((v) => {
    const s = stateOf(v);
    const retire = commands.packRetire(`${v.id}@${v.version}`);
    if (ctx.admin && !v.withdrawn) dialogs.push(retire);
    return [code(v.version), when(v.published_at), chip(s.text, s.tone), code(v.digest.slice(0, 16)), Object.entries(v.samples).map(([source, n]) => `${source} ${n}`).join('，') || '—', ctx.admin && !v.withdrawn ? commandLink(retire, '退役') : ''];
  });
  const assigned = ctx.admin ? await assignedNames(ctx, pack) : null;
  const permissionActions: Html[] = [];
  if (ctx.admin) {
    if (pack.kind === 'workflow' && !pack.withdrawn) { const d = commands.packAssign(pack.id); dialogs.push(d); permissionActions.push(commandLink(d, '调整使用范围')); }
    if (pack.kind === 'product' && !pack.withdrawn) { const d = commands.packActivate(pack.id, pack.active); dialogs.push(d); permissionActions.push(commandLink(d, pack.active ? '停用产品包' : '启用产品包')); }
    const d = commands.packMaintainer(pack.id); dialogs.push(d); permissionActions.push(commandLink(d, '调整维护人'));
  }
  const permissions = card({ title: '版本与权限' }, html`${table(['版本', '发布时间', '状态', '内容哈希', '样例', ctx.admin ? '操作' : ''], versionRows)}
${kv([['所有者', await ctx.userName(pack.owner)], ...(assigned === null ? [] : [['使用范围', assigned.length === 0 ? '尚未指定成员' : assigned.join('、')] as const])])}
${permissionActions.length === 0 ? '' : html`<div class="card-f"><div class="row">${permissionActions}</div></div><p class="sub">调整使用范围、维护人与退役版本生成命令，在管理员的 Circle 中执行。</p>`}`);
  const body = html`${head}
${loaded === null ? '' : html`<div class="mt16">${flow}</div>`}
${loadFailed ? html`<p class="notice">该版本的流程与检查项暂不可读；版本与权限照常显示。</p>` : ''}
<section class="grid g-2-1 section"><div class="stack">${requirements}${checks}</div>${permissions}</section>
${dialogs.map(commandModal)}`;
  return { status: 200, body: page(ctx.chrome('任务包', { active: 'packs', sub: html`${link('/console/packs', '全部任务包')} · ${pack.title}` }), body) };
}
