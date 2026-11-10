// Navigation and publication presentation only; kind selection never changes the uploaded manifest or its validation.
import { axisUiLabel, isPackKind, uiLabelOf, type PackKind } from '../../../contracts/generated/vocabulary.ts';
import { SKILLS_PLACE, type Html, type PageChrome } from './html.ts';
import type { PageContext } from './pages.ts';
import { tooltip } from './presentation.ts';

export function publishingKind(ctx: PageContext): PackKind {
  const kind = ctx.url.searchParams.get('kind');
  return isPackKind(kind) ? kind : 'workflow';
}

export function packHome(kind: PackKind): { active: NonNullable<PageChrome['active']>; path: string } {
  if (kind === 'product') return { active: 'knowledge', path: '/console/knowledge#product-sources' };
  if (kind === 'system') return { active: 'connections', path: '/console/connections?tab=packs' };
  return kind === 'skill' ? { active: 'skills', path: PACK_PLACES.skill.path } : { active: 'packs', path: PACK_PLACES.workflow.path };
}

/** The kinds that have a place of their own in the navigation (decision 151), each with its place. */
export const PACK_PLACES = {
  workflow: { active: 'packs', path: '/console/packs', title: uiLabelOf('pack_kind', 'workflow') },
  skill: { active: 'skills', path: '/console/skills', title: SKILLS_PLACE },
} as const satisfies Partial<Record<PackKind, { active: NonNullable<PageChrome['active']>; path: string; title: string }>>;
/** A kind with a place of its own: the keys of the table above, never a list of kinds written out again. */
export type PlaceKind = keyof typeof PACK_PLACES;
/** The page of one pack: a skill under the skills place, every other kind under the workflows path as before. */
export const packPath = (pack: { id: string; kind: PackKind }): string => (pack.kind === 'skill' ? PACK_PLACES.skill.path : PACK_PLACES.workflow.path) + '/' + pack.id;

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

/** What the two delivery rules mean, from the model's definition of done (V06) in plain words (issue 229). */
export const DONE_RULE_NOTE='记账型：每个条目都有终态、证据齐全、效果已知或已处置，就算交付；结果只显示已交付和各分区的数量，不显示“通过”。门禁型：要求同一运行、同一产物，全部必需的要求项都满足才算交付。';
/** Who may produce the result of a requirement (W02): the formal names stay, this says what they stand for. */
export const ACCEPTED_PRODUCER_NOTE='这一要求项的结果接受谁产生的：事实由 Hub 按规则算出；判断由模型给出；独立判断要求给出判断的不是起草者自己，是否独立按任务包的规定核对。';
export const doneRuleHead=():Html=>tooltip(axisUiLabel('done_rule'),DONE_RULE_NOTE);
export const acceptedProducerHead=():Html=>tooltip(axisUiLabel('accepted_producer'),ACCEPTED_PRODUCER_NOTE);

