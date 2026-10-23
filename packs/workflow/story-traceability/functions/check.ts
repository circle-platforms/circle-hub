import type { CheckOutcome } from '../../../../contracts/src/tables.ts';
import { absent, scalar, rawText } from './plm-fields.ts';
import { normalizeId } from './ids.ts';
import { isRecord, clip, shown } from './text.ts';
import type { Row } from './project.ts';

export function readSubject(input: unknown): { items: Array<{ id: string; fields: Row }>; facts: Record<string, unknown> } {
  if (!isRecord(input) || !Array.isArray(input.items) || !isRecord(input.context) || !Array.isArray(input.context.groups) || !isRecord(input.context.groups[0])) throw new Error('缺少条目或视图事实');
  return { items: input.items as Array<{ id: string; fields: Row }>, facts: input.context.groups[0] };
}
// Build-derived scopes read batch details as expected sources before verification.
export function detailOf(row: Row, sources: unknown, unread: unknown = []): Row {
  if (row.plm_returned || !isRecord(sources)) return row;
  const records: Record<string, unknown>[] = []; const references: string[] = [];
  const excluded = new Set(Array.isArray(unread) ? unread.map(value => typeof value === 'string' ? value : isRecord(value) ? value.reference : null) : []);
  let responded = row.plm_responded;
  for (const [reference, text] of Object.entries(sources)) {
    if (typeof text !== 'string' || excluded.has(reference)) continue;
    let value: unknown; try { value = JSON.parse(text); } catch { continue; }
    if (!isRecord(value) || !Array.isArray(value.stories)) continue;
    for (const record of value.stories) if (isRecord(record) && normalizeId(String(record.id)) === row.id) { records.push(record); references.push(reference); responded = true; }
    if (Array.isArray(value.unread) && value.unread.some(id => normalizeId(String(id)) === row.id)) { references.push(reference); responded = true; }
  }
  const refs = [...new Set([...row.references, ...references])];
  if (!records.length) return { ...row, plm_responded: responded, references: refs };
  const r = records[0];
  if (records.some(other => JSON.stringify([other.status ?? null, other.stage ?? null, absent(other)]) !== JSON.stringify([r.status ?? null, r.stage ?? null, absent(r)]))) throw new Error('Conflicting story sources');
  return { ...row, references: refs, plm_returned: true, plm_responded: true, status: scalar(r.status), stage: scalar(r.stage), fields_absent: absent(r), title: typeof r.title === 'string' ? r.title : null };
}

export const checkError = (): CheckOutcome[] => [{ verdict: 'unknown', reason: 'check_error', tier: 'advisory', grounds: [], statement: '需求追溯检查缺少有效事实；下一步：把运行编号交给任务包维护人修复后重跑' }];
export default function check(input: unknown): CheckOutcome[] {
  try {
    if (!isRecord(input)) return checkError();
    const { items, facts } = readSubject(input.subject);
    return items.map((item, at): CheckOutcome => {
      const row = detailOf(item.fields, input.sources, input.unread_sources);
      const offending = row.cases.filter(c => c.stories !== null && !c.stories.some(id => normalizeId(id) === row.id));
      const missingFields = row.fields_absent;
      const data = { story: row.id, status: row.status, stage: row.stage, plm_returned: row.plm_returned, plm_responded: row.plm_responded, fields_absent: missingFields, case_count: row.cases.length, cases: row.cases, scope: row.scope,
        gaps: row.plm_responded ? [] : ['PLM 需求详情没有读到（来源不可用）'], next_actions: row.plm_returned ? [] : row.plm_responded ? [`请用户确认需求编号 ${row.id}；应答未包含该编号不证明需求不存在`] : ['请管理员核对需求详情批次的读取记录和访问，修复来源后重新读取并重跑'] };
      const view = isRecord(facts.view) ? facts.view : {};
      Object.assign(data, { coverage: { root: facts.root, source: view.source, complete: true, entries: view.listed_entries, keys: view.listed_keys, cut_keys: view.cut_keys ?? [] } });
      const base = { item: item.id, pointer: `/items/${at}/fields`, tier: 'advisory' as const, grounds: [String(view.source), ...row.references, ...row.cases.map(c => c.reference)], data };
      if (offending.length) return { ...base, verdict: 'refute', code: 'story-traceability.join_mismatch', statement: '列出的用例原始需求编号不含被判需求；请任务包维护人修复索引连接后重跑' };
      const partial = view.truncated === true || Number(view.skipped) > 0 || Number(view.missing) > 0 ? '；来源部分可读' : '';
      const status = rawText(row, 'status'); const stage = rawText(row, 'stage');
      let statement = `需求 ${row.id}（状态：${status}；阶段：${stage}）：${row.cases.length} 个已索引用例${row.cases.length ? `追溯：${row.cases.slice(0, 5).map(c => `${c.document ?? ''}:${c.case} ${shown(c.title, 30)}`).join('；')}${row.cases.length > 5 ? `；另有 ${row.cases.length - 5} 个` : ''}` : ''}${partial}；${row.scope}${row.plm_returned ? '' : row.plm_responded ? `；PLM 应答里没有编号 ${row.id}；请用户确认需求编号` : '；PLM 需求详情没有读到（来源不可用）；请管理员核对详情批次的读取记录与访问'}`;
      if (!row.cases.length) statement += `；在构建 ${row.build}、知识根 ${facts.root} 的完整需求号索引视图（已读 ${view.listed_entries} 个用例条目）里，没有条目携带需求号 ${row.id}；不推断未索引用例`;

      return { ...base, verdict: 'support', statement: clip(statement, 500) };
    });
  } catch { return checkError(); }
}
