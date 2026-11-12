// Published product and system integrations, within the catalog's existing visibility. Missing declaration metadata stays unknown.
import {packPurpose} from './pack-display.ts';
import { uiLabelOf, type PackKind } from '../../../contracts/generated/vocabulary.ts';
import type { PackListing, ResourceListing } from '../../ports.ts';
import { code, html, link, liveModule, table, type Html } from './html.ts';
import type { PageContext } from './pages.ts';
import { byId, shownVersion, stateOf } from './packs.ts';
import {box,sectionHead} from './ui.ts';
import {panel as card,badge as chip,technical,tooltip} from './presentation.ts';

/**
 * The catalog remains the permission boundary; declarations and connections only enrich already-visible rows.
 * `bare` is the table as the content of a tab that already names it (the connections page): no heading of its own, the
 * purpose as the hint of the first column, and no version cell (technical values stand on the pack's own page).
 */
export async function packSources(ctx: PageContext, kind: Extract<PackKind, 'product' | 'system'>, resources: readonly ResourceListing[] = [], options: { listings?: readonly PackListing[]; bare?: boolean } = {}): Promise<Html> {
  const packs = [...byId(options.listings ?? await ctx.deps.packs.list(ctx.principal)).values()].map(shownVersion).filter(pack => pack.kind === kind);
  const products = kind === 'product' && packs.length > 0 ? await ctx.deps.products?.products() ?? [] : [];
  const rows = packs.map(pack => {
    const state = stateOf(pack);
    const product = products.find(handle => handle.id === pack.id && handle.version === pack.version)?.product;
    const systems = resources.filter(resource => resource.system_pack.split('@')[0] === pack.id);
    const scope = kind === 'product' ? (product === undefined ? '—' : product.title)
      : systems.length === 0 ? '—' : options.bare ? systems.map(resource => resource.name).join('、') : html`${systems.map(resource => html`<div>${resource.name}${technical(code(resource.system_pack),'查看接入包编号')}</div>`)}`;
    return [link(`/console/packs/${pack.id}`, pack.title), ...(options.bare ? [] : [technical(code(pack.version),'查看版本号')]), chip(state.text, state.tone), scope];
  });
  const id = kind === 'product' ? 'product-sources' : 'system-sources';
  const empty = `当前账户没有可见的${uiLabelOf('pack_kind', kind)}`, last = kind === 'product' ? '产品线' : '对应的业务系统';
  if (options.bare) return liveModule(id, ['pack.published'], box(null, table([tooltip('名称', packPurpose(kind)), '状态', last], rows, empty), { flush: true }));
  return liveModule(id, ['pack.published'], html`${sectionHead(uiLabelOf('pack_kind', kind), `${packs.length} 个`, undefined, id,
    kind === 'product' ? '当前账户可见的产品知识来源；产品线取当前启用版本的声明，暂不可读时显示破折号' : '当前账户可见的业务系统接入；对应系统取已有连接，不发出业务系统请求')}
<p class="ch-meta">${packPurpose(kind)}</p>${card(null, table(['名称', '版本', '状态', last], rows, empty))}`);
}
