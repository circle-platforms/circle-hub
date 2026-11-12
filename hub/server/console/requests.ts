import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import type { RunRequestView } from '../../ports.ts';
import { html, link, table, type Html } from './html.ts';
import type { PageContext } from './pages.ts';
import { box, chip, count, when } from './ui.ts';

/** The most kinds of request a page draws: a pack can ask something different of each of thousands of items, and a table of 30,000 rows was 13.8 MB of page. */
const SHOWN_GROUPS = 100;
/** How many recipients a merged row names before it says how many more there are. */
const NAMED_RECIPIENTS = 3;

export interface RequestGroup { kind: RunRequestView['kind']; missing: string; next_action: string; rows: RunRequestView[]; due: string; overdue: number; runs: string[]; audiences: string[] }

/**
 * The waiting requests merged by what they ask for (decision 151): a pack that asks the same of every item, or a run with
 * several submissions, issues one request many times, and a table of them said one thing in hundreds of rows. A group keeps
 * its earliest deadline, how many of its requests are overdue, the tasks it belongs to and its recipients. Groups with an
 * overdue request first, then by the earliest deadline, then the larger group.
 */
export function groupRequests(requests: readonly RunRequestView[], now: number): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const row of new Map(requests.filter((row) => row.answered_by === null).map((row) => [row.record, row])).values()) {
    const key = JSON.stringify([row.kind, row.missing, row.next_action]);
    const group = groups.get(key) ?? { kind: row.kind, missing: row.missing, next_action: row.next_action, rows: [], due: row.due, overdue: 0, runs: [], audiences: [] };
    group.rows.push(row);
    if (row.due < group.due) group.due = row.due;
    if (Date.parse(row.due) < now) group.overdue++;
    if (row.run !== undefined && !group.runs.includes(row.run)) group.runs.push(row.run);
    if (!group.audiences.includes(row.audience)) group.audiences.push(row.audience);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.overdue > 0) - Number(a.overdue > 0) || a.due.localeCompare(b.due) || b.rows.length - a.rows.length);
}

/** The requests still waiting, one row per kind of request; nothing when none waits. */
export async function awaitingRequests(ctx: PageContext, requests: readonly RunRequestView[], showTask = false): Promise<Html> {
  const groups = groupRequests(requests, (ctx.deps.now?.() ?? new Date()).getTime());
  if (groups.length === 0) return html``;
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const cut = groups.length > SHOWN_GROUPS ? html`<p class="ch-meta" data-cut>显示 ${SHOWN_GROUPS} / 共 ${count(groups.length)} 类</p>` : '';
  const rows = await Promise.all(groups.slice(0, SHOWN_GROUPS).map(async (group) => {
    const names = await Promise.all(group.audiences.slice(0, NAMED_RECIPIENTS).map((id) => ctx.userName(id)));
    return [
      html`<b>${group.missing}</b><p class="ch-meta">${group.next_action}</p>`,
      uiLabelOf('request_kind', group.kind),
      html`${count(group.rows.length)} 条`,
      ...(showTask ? [group.runs.length === 1 ? link(`/console/runs/${group.runs[0]}`, html`查看任务<span class="ch-visually-hidden">：${group.missing}</span>`) : group.runs.length === 0 ? '—' : `${count(group.runs.length)} 个任务`] : []),
      names.join('、') + (group.audiences.length > NAMED_RECIPIENTS ? ` 等 ${count(group.audiences.length)} 人` : ''),
      html`${when(group.due)}${group.overdue > 0 ? html` ${chip(`${count(group.overdue)} 条${uiLabelOf('request_status', 'overdue')}`, 'fail')}` : ''}`,
    ];
  }));
  return html`<section class="ch-section" data-requests>${box({ title: `${uiLabelOf('request_status', 'waiting')}的请求`, meta: `共 ${count(total)} 条，内容相同的归并为 ${count(groups.length)} 类`, hint: '请求的处理在接收人的客户端中完成；本页只显示请求的内容、接收人与期限。内容和后续处理都相同的请求归并为一行。' },
    table(['待补充内容', '类型', '数量', ...(showTask ? ['所属任务'] : []), '接收人', '最早期限'], rows, '没有记录', 'requests'), { flush: true, ...(cut ? { foot: cut } : {}) })}</section>`;
}
