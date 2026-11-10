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

export function packPurpose(kind:PackKind):string{
 if(kind==='workflow')return '要完成一项有验收要求的任务，选择工作流；客户端依照做法执行，Hub 按声明的验收要求核验提交结果。';
 if(kind==='skill')return '要让客户端遵循一套通用做法，选择通用技能；技能不设验收要求，不单独启动核验任务。';
 if(kind==='system')return '要读取一种业务系统，先发布业务系统接入，再在连接页配置具体系统；接入包声明访问方式和允许的只读接口。';
 return '要提供产品的版本、构建与知识来源，选择产品知识来源；启用后按其声明读取。';
}

export function publication(ctx: PageContext, kind: PackKind = publishingKind(ctx)) {
  return {
    title: `发布${uiLabelOf('pack_kind', kind)}`,
    back: '/console/operations/pack' + (kind === 'workflow' ? '' : '?kind=' + encodeURIComponent(kind)),
    active: packHome(kind).active,
  };
}
