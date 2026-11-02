// Navigation and publication presentation only; kind selection never changes the uploaded manifest or its validation.
import { isPackKind, uiLabelOf, type PackKind } from '../../../contracts/generated/vocabulary.ts';
import type { PageChrome } from './html.ts';
import type { PageContext } from './pages.ts';

export function publishingKind(ctx: PageContext): PackKind {
  const kind = ctx.url.searchParams.get('kind');
  return isPackKind(kind) ? kind : 'workflow';
}

export function packHome(kind: PackKind): { active: NonNullable<PageChrome['active']>; path: string } {
  if (kind === 'product') return { active: 'knowledge', path: '/console/knowledge#product-sources' };
  if (kind === 'system') return { active: 'connections', path: '/console/connections#system-sources' };
  return { active: 'packs', path: '/console/packs' };
}

export function publication(ctx: PageContext, kind: PackKind = publishingKind(ctx)) {
  return {
    title: `发布${uiLabelOf('pack_kind', kind)}`,
    back: '/console/operations/pack' + (kind === 'workflow' ? '' : '?kind=' + encodeURIComponent(kind)),
    active: packHome(kind).active,
  };
}
