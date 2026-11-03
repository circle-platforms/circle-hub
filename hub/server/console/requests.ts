import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import type { RunRequestView } from '../../ports.ts';
import { html, link, section, table, type Html } from './html.ts';
import type { PageContext } from './pages.ts';
import { when } from './ui.ts';

/** Merge the two read projections without changing either request or its due time. */
export async function awaitingRequests(ctx: PageContext, requests: readonly RunRequestView[], overdue: readonly RunRequestView[] = [], showTask = false): Promise<Html> {
  const pastDue = new Set(overdue.map(row => row.record));
  const merged = new Map([...overdue, ...requests].filter(row => row.answered_by === null).map(row => [row.record, row]));
  if (merged.size === 0) return html``;
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const expired = (row: RunRequestView): boolean => pastDue.has(row.record) || Date.parse(row.due) < now;
  const sorted = [...merged.values()].sort((a, b) => Number(expired(b)) - Number(expired(a)) || a.due.localeCompare(b.due));
  const rows = await Promise.all(sorted.map(async row => [
    uiLabelOf('request_status', expired(row) ? 'overdue' : 'waiting'),
    uiLabelOf('request_kind', row.kind),
    ...(showTask ? [row.run ? link(`/console/runs/${row.run}`, '查看任务') : '—'] : []),
    await ctx.userName(row.audience), when(row.due), row.missing, row.next_action,
  ]));
  return section('等待回应中的请求', table(['状态', '类型', ...(showTask ? ['所属任务'] : []), '接收人', '期限', '待补充内容', '后续处理'], rows), '请求的处理在接收人的客户端中完成；本页只显示请求的接收人、期限与状态。');
}
