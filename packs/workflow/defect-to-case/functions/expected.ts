// Bound manual identities are frozen by projection. Expected-source warnings are also returned to the caller as gaps.
import type { ExpectedSourcesOutput, PackWarning } from '../../../../contracts/src/pack.ts';
import { unknownEntriesOf } from './compact-index.ts';
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Gap code of a bound case index that is truncated only because some cases' facts are unknown (index-view unknown_only). */
export const INDEX_UNKNOWN_ENTRIES = 'defect-to-case.index_unknown_entries';
export function expectedSources(input: unknown): ExpectedSourcesOutput {
  const raw = record(input) ? input : {};
  const context = record(raw.context) ? raw.context : {};
  const line = typeof context.line === 'string' && context.line.trim() ? context.line : null;
  const warnings: PackWarning[] = [];
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!record(item) || !record(item.fields) || !record(item.fields.allowed_quote_sources)) continue;
    const allowed = item.fields.allowed_quote_sources;
    if (allowed.manual !== null) continue;
    const id = typeof item.id === 'string' ? item.id : '本条缺陷';
    const field = typeof allowed.fix_field === 'string' ? `修复说明字段 ${allowed.fix_field}` : '';
    const notes = Array.isArray(allowed.fix_notes) && allowed.fix_notes.length > 0 ? 'fix_notes 中的 comment' : '';
    const where = [field, notes].filter(Boolean).join('，或') || '已冻结的修复说明';
    const next = line === null ? '运行没有版本线，manual 保持未绑定；若需要手册，先选有明确版本线的构建后重开运行' : `先核实 manual:cli:${line} 是否可读，存在时在 inputs.manual 绑定后重开运行；这条线没有手册则保持未绑定并保留来源限制`;
    warnings.push({ code: 'defect-to-case.manual_missing', item: id, message: `版本线 ${line ?? '未声明'} 未绑定手册${line === null ? '' : ` manual:cli:${line}`}；本次期望结果只能引用缺陷 ${id} 的${where}。下一步：${next}` });
  }
  // The Hub binds an index truncated only by unknown entries for this slot (workflow.json unknown_entries: disclose). The caller
  // is told at start_run: the count, the view's notes verbatim (they name the missing fact and the next action), and that a
  // draft with no visible duplicate stays unknown.
  const index = (Array.isArray(raw.inputs) ? raw.inputs : []).find((bound) => record(bound) && bound.slot === 'indexed_cases');
  if (record(index) && record(index.model)) {
    const unknown = unknownEntriesOf(index.model);
    if (unknown.only && unknown.entries !== null) {
      const notes = Array.isArray(index.model.notes) ? index.model.notes.filter((note): note is string => typeof note === 'string') : [];
      warnings.push({
        code: INDEX_UNKNOWN_ENTRIES,
        message: `已索引用例清单只因 ${unknown.entries} 个用例缺查询所需的事实而截断，这些用例没有列入，不是没有用例：去重只比较已列出的用例，可见重复照样驳回，没查出重复的草稿记未知，不说成没有重复。视图说明「${notes.join('；') || '无'}」。下一步：按视图说明补齐这些用例的事实后以新输入重开运行；同一修订重读补不出这些事实`,
        data: { unknown_entries: unknown.entries },
      });
    }
  }
  return { sources: [], warnings };
}
export default expectedSources;
