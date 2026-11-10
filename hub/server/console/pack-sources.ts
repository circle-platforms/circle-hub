// Published product and system integrations, within the catalog's existing visibility. Missing declaration metadata stays unknown.
import {packPurpose} from './pack-display.ts';
import { uiLabelOf, type PackKind } from '../../../contracts/generated/vocabulary.ts';
import type { ResourceListing } from '../../ports.ts';
import { code, html, link, liveModule, table, type Html } from './html.ts';
import type { PageContext } from './pages.ts';
import { byId, shownVersion, stateOf } from './packs.ts';
import {sectionHead} from './ui.ts';
import {panel as card,badge as chip,technical} from './presentation.ts';

/** The catalog remains the permission boundary; declarations and connections only enrich already-visible rows. */
export async function packSources(ctx: PageContext, kind: Extract<PackKind, 'product' | 'system'>, resources: readonly ResourceListing[] = []): Promise<Html> {
  const packs = [...byId(await ctx.deps.packs.list(ctx.principal)).values()].map(shownVersion).filter(pack => pack.kind === kind);
  const products = kind === 'product' && packs.length > 0 ? await ctx.deps.products?.products() ?? [] : [];
  const rows = packs.map(pack => {
    const state = stateOf(pack);
    const product = products.find(handle => handle.id === pack.id && handle.version === pack.version)?.product;
    const systems = resources.filter(resource => resource.system_pack.split('@')[0] === pack.id);
    const scope = kind === 'product' ? (product === undefined ? '—' : product.title)
      : systems.length === 0 ? '—' : html`${systems.map(resource => html`<div>${resource.name}${technical(code(resource.system_pack),'查看')}</div>`)}`;
    return [link(`/console/packs/${pack.id}`, pack.title), technical(code(pack.version),'查看'), chip(state.text, state.tone), scope];
  });
  const id = kind === 'product' ? 'product-sources' : 'system-sources';
  return liveModule(id, ['pack.published'], html`${sectionHead(uiLabelOf('pack_kind', kind), `${packs.length} 个`, undefined, id,
    kind === 'product' ? '当前账户可见的产品知识来源；产品线取当前启用版本的声明，暂不可读时显示破折号' : '当前账户可见的业务系统接入；对应系统取已有连接，不发出业务系统请求')}
<p class="ch-meta">${packPurpose(kind)}</p>${card(null, table(['名称', '版本', '状态', kind === 'product' ? '产品线' : '对应的业务系统'], rows, `当前账户没有可见的${uiLabelOf('pack_kind', kind)}`))}`);
}
