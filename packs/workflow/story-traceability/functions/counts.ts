import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { checkError, detailOf, readSubject } from './check.ts';
import { scalarKey, type Scalar } from './plm-fields.ts';
import { scopeText } from './scope.ts';
import { isRecord } from './text.ts';

export default function counts(input: unknown): CheckOutcome[] {
  try {
    if (!isRecord(input)) return checkError();
    const { items, facts } = readSubject(input.subject);
    const rows = items.map(i => detailOf(i.fields, input.sources, input.unread_sources));
    const traced = rows.filter(r => (r.indexed_match_count ?? r.cases.length) > 0).length;
    const plmUnread = rows.filter(r => r.plm_responded && !r.plm_returned).length;
    const plmUnavailable = rows.filter(r => !r.plm_responded).length;
    const states = new Map<Scalar, number>();
    for (const r of rows) if (r.plm_returned && !r.fields_absent.includes('status') && !r.fields_nonscalar?.includes('status')) states.set(r.status, (states.get(r.status) ?? 0) + 1);
    const statuses = [...states].sort(([a], [b]) => scalarKey(a) < scalarKey(b) ? -1 : scalarKey(a) > scalarKey(b) ? 1 : 0).map(([status, count]) => ({ status, count }));
    const statusAbsent = rows.filter(r => r.plm_returned && r.fields_absent.includes('status')).length;
    const statusNonscalar = rows.filter(r => r.plm_returned && r.fields_nonscalar?.includes('status')).length;
    const stageNonscalar = rows.filter(r => r.plm_returned && r.fields_nonscalar?.includes('stage')).length;
    const view = isRecord(facts.view) ? facts.view : {};
    const data = { stories: rows.length, traced, untraced: rows.length - traced, plm_unread: plmUnread, plm_unavailable: plmUnavailable, status_absent: statusAbsent, status_nonscalar: statusNonscalar, stage_nonscalar: stageNonscalar, statuses, product: facts.product, build: facts.build, root: facts.root, scope: facts.scope };
    const base = { tier: 'advisory' as const, grounds: [...new Set([String(view.source), ...rows.flatMap(r => r.references)])], data };
    if (view.truncated === false && (view.total_keys !== view.listed_keys || view.total_entries !== view.listed_entries)) return [{ ...base, verdict: 'refute', code: 'story-traceability.count_mismatch', statement: '用例索引声明未截断却与总数不符；请管理员运行知识同步，完成后重跑' }];
    return [{ ...base, verdict: 'support', statement: `需求 ${rows.length} 个：已追溯 ${traced} 个，未追溯 ${rows.length - traced} 个；PLM 没返回 ${plmUnread} 个；PLM 详情未读到 ${plmUnavailable} 个；${scopeText(facts.scope)}；PLM 返回的状态不是单个值的有 ${statusNonscalar} 个，没有按状态计数；PLM 返回的阶段不是单个值的有 ${stageNonscalar} 个；status 字段未提供 ${statusAbsent} 个；原样状态计数：${statuses.map(s => `${String(s.status)} ${s.count} 个`).join('、')}${view.truncated || Number(view.skipped) > 0 || Number(view.missing) > 0 ? '；用例明细仅为当前视图已列出的索引条目，下限已逐项标明' : ''}` }];
  } catch { return checkError(); }
}
