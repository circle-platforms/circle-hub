import type { MemberCapabilities } from '../../records/api.ts';
import { AccessError } from '../../records/errors.ts';
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { emptyBlock, definitions, html, href, link, page, pageLayout, table, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './context.ts';
import { card, chip, when } from './ui.ts';
import { mePath } from './routes.ts';

const EMPTY_TEAM = '请管理员把你加入团队';

function occupancyText(occupancy: MemberCapabilities['environments'][number]['occupancy']): Html {
  if (occupancy === null) return html`未知`;
  const who = occupancy.mine ? '本人' : occupancy.holder ?? '其他成员';
  const until = occupancy.until ? when(occupancy.until) : '进行中';
  return html`${who} · 自 ${when(occupancy.since)} · ${until}`;
}

function packRows(items: MemberCapabilities['workflows']): unknown[][] {
  return items.map((item) => [
    item.name,
    item.ref,
    item.owner === undefined ? '公共空间' : item.owner,
  ]);
}

function environmentSection(view: MemberCapabilities): Html {
  const access = view.environmentAccess;
  if (!access.ready) {
    return card(
      { title: '测试环境', hint: '未就绪只表示尚未核对；缺什么和下一步写在下面。' },
      definitions([
        ['状态', '未知'],
        ['缺什么', access.missing ?? '未知'],
        ['下一步', access.nextAction ?? '未知'],
      ]),
    );
  }
  return card(
    { title: '测试环境' },
    table(
      ['名称', '占用'],
      view.environments.map((item) => [item.name, occupancyText(item.occupancy)]),
      { title: '当前没有已核对可占用的测试环境', text: '这只反映已核对的分配与本地租约，不证明物理空闲或无权。' },
    ),
  );
}

export function renderMemberCapabilities(view: MemberCapabilities, options: { viewingOther?: boolean } = {}): Html {
  const status = view.member.enabled
    ? chip(uiLabelOf('account_status', 'enabled'), 'pass')
    : chip(uiLabelOf('account_status', 'disabled'), 'plain');
  const teamsBody = view.teams.length === 0
    ? emptyBlock({ title: EMPTY_TEAM })
    : table(['团队'], view.teams.map((name) => [name]));
  const denials = view.denials.length === 0
    ? html`<p class="ch-meta">暂无已披露的限制。</p>`
    : table(['原因', '下一步'], view.denials.map((row) => [row.reason, row.nextAction]));
  const heading = options.viewingOther
    ? html`<p class="ch-meta">管理员按 ${view.member.name} 的视角查看。</p>`
    : html``;
  return html`<div class="ch-stack" data-member-capabilities>
${heading}
${card({ title: '账户' }, definitions([['名字', view.member.name], ['状态', status]]))}
${card({ title: '团队' }, teamsBody)}
${card({ title: uiLabelOf('pack_kind', 'workflow') }, table(['名称', '引用', '归属'], packRows(view.workflows), '尚无可用的已分配工作流'))}
${card({ title: uiLabelOf('pack_kind', 'skill') }, table(['名称', '引用', '归属'], packRows(view.skills), '尚无可用的通用技能'))}
${card({ title: '连接' }, table(['名称', '系统包', '测试环境'], view.connections.map((item) => [item.name, item.systemPack, item.environment]), '尚无可用的已分配连接'))}
${environmentSection(view)}
${card({ title: '当前不能做的事' }, denials)}
</div>`;
}

/** `/console/me` — the member home projection; administrators may pass `?user=` to preview another member. */
export async function memberCapabilitiesPage(ctx: PageContext): Promise<PageResult> {
  const asked = ctx.url.searchParams.get('user');
  const targetId = asked && asked.length > 0 && asked !== ctx.principal.id ? asked : undefined;
  if (targetId !== undefined && !ctx.admin) return neutralPage(ctx);
  let view: MemberCapabilities;
  try {
    view = await ctx.deps.memberCapabilities(ctx.principal, targetId);
  } catch (error) {
    if (error instanceof AccessError) return neutralPage(ctx);
    throw error;
  }
  const viewingOther = targetId !== undefined;
  const title = viewingOther ? `${view.member.name} 能做的事` : '我能做的事';
  return {
    status: 200,
    body: page(
      ctx.chrome(title, {
        active: 'team',
        hint: viewingOther ? '只读投影，与 list_task_packs 同源；不改对方权限。' : '按当前账户的团队与分配列出可做的事；内部编号不在此页展示。',
        actions: viewingOther ? undefined : html`${link('/console/team', '打开团队')}`,
      }),
      pageLayout(renderMemberCapabilities(view, { viewingOther }), {
        ...(viewingOther ? { back: link(`/console/team/${targetId}`, '返回成员') } : {}),
      }),
    ),
  };
}

export function memberCapabilitiesHref(userId?: string): string {
  return userId === undefined ? mePath() : href(mePath(), { user: userId });
}
