import { AccessError, type MemberCapabilities } from '../../records/api.ts';
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { emptyBlock, definitions, html, href, link, page, pageLayout, table, type Html } from './html.ts';
import { circleEntry, originOf, neutralPage, type PageContext, type PageResult } from './context.ts';
import { card, chip, when } from './ui.ts';
import { mePath } from './routes.ts';

const EMPTY_TEAM = '请管理员把你加入团队';
/** Boss 04:30 — occupied after assignment revoke; not 「未知」. */
export const NO_ASSIGNMENT_LABEL = '已无分配';

type OccupancyRow = { since: string; until: string | null; mine: boolean; name?: string; holder?: string };

/** Console accepts Codex's assigned/can_use fields when present; older singular occupancy stays readable. */
type EnvironmentRow = {
  name: string;
  assigned?: boolean;
  can_use?: boolean;
  canUse?: boolean;
  occupancy: MemberCapabilities['environments'][number]['occupancy'] | OccupancyRow[] | null;
  missing?: readonly string[];
};

function occupancyUntil(until: string | null): Html {
  return until ? when(until) : html`不限时长`;
}

function occupancyLine(row: OccupancyRow): Html {
  const until = occupancyUntil(row.until);
  if (row.mine) return html`本人占用 · 自 ${when(row.since)} · ${until}`;
  const who = row.name ?? row.holder ?? '其他成员';
  return html`被${who}的运行占用 · 自 ${when(row.since)} · ${until}`;
}

/** Accepts the single-row shape and Codex's array of holders; empty local lease is not physical idleness. */
function occupancyText(occupancy: EnvironmentRow['occupancy']): Html {
  if (occupancy === null) return html`未知（空租约不代表物理空闲）`;
  if (Array.isArray(occupancy)) {
    if (occupancy.length === 0) return html`本地无租约（不代表物理空闲）`;
    return html`${occupancy.map((row, index) => html`${index > 0 ? html`<br>` : ''}${occupancyLine(row)}`)}`;
  }
  return occupancyLine(occupancy);
}

export function environmentIsOccupied(occupancy: EnvironmentRow['occupancy']): boolean {
  if (occupancy === null) return false;
  if (Array.isArray(occupancy)) return occupancy.length > 0;
  return true;
}

/** True when the projection confirms the caller may no longer use this environment. */
export function environmentLacksAssignment(item: EnvironmentRow): boolean {
  if (item.assigned === false) return true;
  if (item.can_use === false || item.canUse === false) return true;
  return (item.missing ?? []).some((line) => line.includes(NO_ASSIGNMENT_LABEL) || line.includes('占着但已无分配'));
}

function occupancyCell(item: EnvironmentRow): Html {
  const text = occupancyText(item.occupancy);
  if (environmentIsOccupied(item.occupancy) && environmentLacksAssignment(item)) {
    return html`${text} ${chip(NO_ASSIGNMENT_LABEL, 'unchecked')}`;
  }
  return text;
}

/** Three steps for a logged-in member; invitation codes stay an administrator action (Boss 03:45 #1). */
function connectClientSection(ctx: PageContext): Html {
  const entry = circleEntry(originOf(ctx), false);
  return card(
    { title: '连接新的客户端', meta: 'MCP 标准连接确认', hint: '你已能登录控制台时，用下面三步把新客户端接到这个 Hub；不要自己签发邀请码。' },
    html`<ol class="ch-meta">
<li>把下面的条目写入客户端的 MCP 配置（名字与占位符须与 Circle 的 /hub 说明一致）。</li>
<li>在客户端发起连接；它会打开本 Hub 的浏览器连接确认页，并显示一串确认码。</li>
<li>在该确认页输入客户端显示的确认码并确认；也可先登录本控制台，再在打开的确认页完成确认。</li>
</ol>
<pre class="ch-quote"><code>${entry}</code></pre>
<p class="ch-meta">还没有控制台登录的成员，由管理员在团队页签发一次性邀请码；邀请码只在签发结果页显示一次。</p>`,
  );
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
      view.environments.map((item) => [item.name, occupancyCell(item as EnvironmentRow)]),
      { title: '当前没有已核对可占用的测试环境', text: '这只反映已核对的分配与本地租约，不证明物理空闲或无权。' },
    ),
  );
}

export function renderMemberCapabilities(
  view: MemberCapabilities,
  options: { viewingOther?: boolean; connect?: Html } = {},
): Html {
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
${options.connect ?? ''}
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
      pageLayout(renderMemberCapabilities(view, {
        viewingOther,
        connect: viewingOther ? undefined : connectClientSection(ctx),
      }), {
        ...(viewingOther ? { back: link(`/console/team/${targetId}`, '返回成员') } : {}),
      }),
    ),
  };
}

export function memberCapabilitiesHref(userId?: string): string {
  return userId === undefined ? mePath() : href(mePath(), { user: userId });
}
