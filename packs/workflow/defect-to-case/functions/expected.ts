// Bound manual identities are frozen by projection. Expected-source warnings are also returned to the caller as gaps.
import type { ExpectedSourcesOutput, PackWarning } from '../../../../contracts/src/pack.ts';
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
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
  return { sources: [], warnings };
}
export default expectedSources;
