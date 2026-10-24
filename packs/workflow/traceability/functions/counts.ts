// The counts check (pack function, applies run): the run-level facts of the matrix — how many defects of the build, how
// many traced, how many untraced — with the view facts that bound what the counts can say. The counts are recomputed from
// the frozen items; a view that declares itself complete (not truncated) must list exactly its stated totals, otherwise the
// view contradicts itself and the counts are refuted (advisory) instead of stated.
import { defectSystemInfoOf, parsePlmResponses, readClosedStatuses } from './plm-status.ts';
import { guarded, isRecord } from './text.ts';
import type { CheckOutcome, RunFacts, ViewFacts } from './types.ts';

const TIER = 'advisory' as const;

interface CountsItem {
  id: string;
  fields: { bug?: unknown; systems?: unknown; conflict?: unknown; cases?: unknown;declaration_status?:unknown };
}

function factsOf(raw: unknown): { items: CountsItem[]; facts: RunFacts } | null {
  if (!isRecord(raw) || !Array.isArray(raw.items) || !isRecord(raw.context)) return null;
  const groups = Array.isArray(raw.context.groups) ? raw.context.groups : [];
  if (!isRecord(groups[0]) || !isRecord(groups[0].views) || !isRecord(groups[0].views.defects) || !isRecord(groups[0].views.cases)) return null;
  const items: CountsItem[] = [];
  for (const value of raw.items) {
    if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.fields) || !Array.isArray(value.fields.cases)) return null;
    items.push(value as unknown as CountsItem);
  }
  return { items, facts: groups[0] as unknown as RunFacts };
}

/** The mismatch of one view that says it is complete but does not list what it counts, or null. */
function mismatchOf(name: string, view: ViewFacts): string | null {
  if (view.truncated) return null;
  if (view.total_keys !== view.listed_keys || view.total_entries !== view.listed_entries) {
    return `${name}声明未截断，但列出 ${view.listed_keys} 个键、${view.listed_entries} 个条目，与视图声明的 total_keys ${view.total_keys}、total_entries ${view.total_entries} 不一致`;
  }
  return null;
}

export function countsOutcome(
  subject: unknown,
  sources?: Readonly<Record<string, string>>,
  table?: unknown,
  unreadSources?: ReadonlyArray<{ reference: string; reason: string; external?: string; slot?: string }>,
): CheckOutcome {
  const read = factsOf(subject);
  if (read === null || read.items.length === 0) {
    return { verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('追溯统计的被判对象里没有条目或没有视图事实（任务包缺陷）'), reason: 'check_error', statement: '追溯统计的被判对象里没有条目或没有视图事实（任务包缺陷）', grounds: [], tier: TIER };
  }
  const { items, facts } = read;
  const grounds = [facts.views.defects.source, facts.views.cases.source];
  const defects = items.length;
  const traced = items.filter((item) => (item.fields.cases as unknown[]).length > 0).length;
  const untraced = defects - traced;
  const conflicts = items.filter((item) => item.fields.conflict === true).length;

  const closedStatuses = readClosedStatuses(table);
  const closedSet = new Set(closedStatuses);
  const { hasPlmSource, hasUnreadSources, statuses: plmStatuses, unread: plmUnread } = parsePlmResponses(sources, unreadSources);

  let closedDefects = 0;
  let closedTraced = 0;
  let closedUntraced = 0;
  let statusUnknown = 0;
  let statusUnread = 0;

  for (const item of items) {
    const bug = typeof item.fields.bug === 'string' && item.fields.bug !== '' ? item.fields.bug : item.id;
    const systems = Array.isArray(item.fields.systems) ? (item.fields.systems as string[]) : [];
    const info = defectSystemInfoOf(bug, systems, plmStatuses, plmUnread, closedSet, hasPlmSource, hasUnreadSources);
    if (info.unconnectedSystem) statusUnread++;
    else if (info.status === null) {
      statusUnknown += 1;
    } else if (info.isClosed) {
      closedDefects += 1;
      const caseCount = Array.isArray(item.fields.cases) ? item.fields.cases.length : 0;
      if (caseCount > 0) closedTraced += 1;
      else closedUntraced += 1;
    }
  }

  const data: Record<string, unknown> = {
    defects,
    release_status_undeclared:items.filter(item=>item.fields.declaration_status==='undeclared').length,
    traced,
    untraced,
    conflicts,
    closed_defects: closedDefects,
    closed_traced: closedTraced,
    closed_untraced: closedUntraced,
    status_unknown: statusUnknown,
    status_unread: statusUnread,
    closed_statuses: closedStatuses,
    statuses: facts.statuses,
    product: facts.product,
    build: facts.build,
    root: facts.root,
    views: { defects: facts.views.defects, cases: facts.views.cases },
  };
  const mismatches = [mismatchOf('缺陷索引', facts.views.defects), mismatchOf('用例索引', facts.views.cases)].filter((m): m is string => m !== null);
  if (mismatches.length > 0) {
    return { verdict: 'refute', code: 'traceability.count_mismatch', statement: `视图的计数自相矛盾，矩阵计数不可信：${mismatches.join('；')}`, grounds, tier: TIER, data };
  }
  let statement = `缺陷 ${defects} 个：已追溯 ${traced} 个，未追溯 ${untraced} 个；其中已关闭缺陷 ${closedDefects} 个：已追溯 ${closedTraced} 个，未追溯 ${closedUntraced} 个；缺陷系统状态未知 ${statusUnknown} 个（不算已关闭也不算未关闭）`;
  if (statusUnread > 0) statement += `；状态未读：系统未接入 ${statusUnread} 个（不算已关闭也不算未关闭）`;
  const undeclared=items.filter(item=>item.fields.declaration_status==='undeclared').length;if(undeclared>0)statement+='；发布说明状态未声明 '+undeclared+' 个；已修复判断未知，下一步发布页或缺陷系统维护者补原始状态后重产';
  if (conflicts > 0) statement += `；其中状态矛盾的缺陷 ${conflicts} 个`;
  if (facts.views.defects.skipped > 0) statement += `；缺陷索引有 ${facts.views.defects.skipped} 份列出的来源没有读取`;
  if (facts.views.cases.skipped > 0) statement += `；用例索引有 ${facts.views.cases.skipped} 份列出的来源没有读取，其中的用例不在计数里`;
  if (facts.views.defects.truncated || facts.views.cases.truncated) statement += '；视图被截断，计数只覆盖列出的部分';
  return { verdict: 'support', statement, grounds, tier: TIER, data };
}

/** Pack check function: PackCheckInput of hub/rules -> a one-element check-outcome@1 array. */
export default function countsCheck(input: unknown): unknown {
  const checkInput = isRecord(input) ? input : {};
  return guarded<unknown>(
    () => [
      countsOutcome(
        checkInput.subject,
        checkInput.sources as Readonly<Record<string, string>> | undefined,
        checkInput.table,
        checkInput.unread_sources as ReadonlyArray<{ reference: string; reason: string }> | undefined,
      ),
    ],
    (message) => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`追溯统计出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `追溯统计出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
