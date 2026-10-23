import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { checkError, detailOf, readSubject } from './check.ts';
import { isRecord } from './text.ts';

export default function counts(input: unknown): CheckOutcome[] {
  try {
    if (!isRecord(input)) return checkError();
    const { items, facts } = readSubject(input.subject);
    const rows = items.map(i => detailOf(i.fields, input.sources));
    const traced = rows.filter(r => r.cases.length > 0).length;
    const plmUnread = rows.filter(r => !r.plm_returned).length;
    const states = new Map<string | null, number>();
    for (const r of rows) if (r.plm_returned) states.set(r.status, (states.get(r.status) ?? 0) + 1);
    const statuses = [...states].sort(([a], [b]) => a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1).map(([status, count]) => ({ status, count }));
    const view = isRecord(facts.view) ? facts.view : {};
    const data = { stories: rows.length, traced, untraced: rows.length - traced, plm_unread: plmUnread, statuses, product: facts.product, build: facts.build, root: facts.root, scope: facts.scope };
    const base = { tier: 'advisory' as const, grounds: [...new Set([String(view.source), ...rows.flatMap(r => r.references)])], data };
    if (view.truncated === false && (view.total_keys !== view.listed_keys || view.total_entries !== view.listed_entries)) return [{ ...base, verdict: 'refute', code: 'story-traceability.count_mismatch', statement: '用例索引声明未截断却与总数不符；请管理员运行知识同步，完成后重跑' }];
    return [{ ...base, verdict: 'support', statement: `需求 ${rows.length} 个：已追溯 ${traced} 个，未追溯 ${rows.length - traced} 个；PLM 没返回 ${plmUnread} 个；${facts.scope}；原样状态计数：${statuses.map(s => `${s.status ?? '未知'} ${s.count} 个`).join('、')}${view.truncated || Number(view.skipped) > 0 || Number(view.missing) > 0 ? '；来源部分可读，统计仅覆盖已读部分；请管理员运行知识同步，完成后重跑' : ''}` }];
  } catch { return checkError(); }
}
