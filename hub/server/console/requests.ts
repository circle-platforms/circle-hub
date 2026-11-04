import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import type { RunRequestView } from '../../ports.ts';
import { html, link, section, table, type Html } from './html.ts';
import type { PageContext } from './pages.ts';
import { when } from './ui.ts';

/** The longest list of waiting requests a page draws: one task can hold thousands, and a table of 30,000 rows was 13.8 MB of page. */
const SHOWN_REQUESTS = 100;

/** The requests still waiting, overdue first and by due time; a list cut at SHOWN_REQUESTS says what it shows of how many. */
export async function awaitingRequests(ctx: PageContext, requests: readonly RunRequestView[], showTask = false): Promise<Html> {
  const merged = new Map(requests.filter(row => row.answered_by === null).map(row => [row.record, row]));
  if (merged.size === 0) return html``;
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const expired = (row: RunRequestView): boolean => Date.parse(row.due) < now;
  const sorted = [...merged.values()].sort((a, b) => Number(expired(b)) - Number(expired(a)) || a.due.localeCompare(b.due));
  const rows = await Promise.all(sorted.slice(0, SHOWN_REQUESTS).map(async row => [
    uiLabelOf('request_status', expired(row) ? 'overdue' : 'waiting'),
    uiLabelOf('request_kind', row.kind),
    ...(showTask ? [row.run ? link(`/console/runs/${row.run}`, '查看任务') : '—'] : []),
    await ctx.userName(row.audience), when(row.due), row.missing, row.next_action,
  ]));
  const cut = sorted.length > SHOWN_REQUESTS ? html`<p class="ch-meta">显示 ${SHOWN_REQUESTS} / 共 ${sorted.length} 条</p>` : '';
  return section('等待回应中的请求', html`${cut}${table(['状态', '类型', ...(showTask ? ['所属任务'] : []), '接收人', '期限', '待补充内容', '后续处理'], rows)}`, '请求的处理在接收人的客户端中完成；本页只显示请求的接收人、期限与状态。');
}
