// Eligibility uses declared handling and frozen scope identities, never prose or an old unbound result.
import { isRecord } from './text.ts';
export function planStateOf(value: unknown, excluded: ReadonlySet<string> = new Set(), run?: unknown): { process: boolean; excluded: boolean; skipped: boolean; reason: string | null } {
  if (!isRecord(value) || typeof value.item !== 'string') return { process: false, excluded: false, skipped: false, reason: '缺少条目身份' };
  const record = isRecord(run) && isRecord(run.run) ? run.run : run;
  const params = isRecord(record) && isRecord(record.parameters) ? record.parameters : {};
  const item = isRecord(record) && Array.isArray(record.items) ? record.items.find(i => isRecord(i) && i.id === value.item) : null;
  const fields = isRecord(item) && isRecord(item.fields) ? item.fields : {};
  const autoid = typeof fields.autoid === 'string' ? fields.autoid : null;
  const frozen = Array.isArray(params.exclude) ? params.exclude : [];
  if (excluded.has(value.item) || autoid !== null && excluded.has(autoid) || frozen.includes(value.item) || autoid !== null && frozen.includes(autoid)) return { process: false, excluded: true, skipped: false, reason: '已在本次范围中明确排除' };
  if (value.handling === 'skipped') return { process: false, excluded: false, skipped: true, reason: '模型声明跳过，理由尚未因此核验为真' };
  if (value.handling !== 'handled') return { process: false, excluded: false, skipped: false, reason: '未声明有效的处理方式' };
  return { process: true, excluded: false, skipped: false, reason: null };
}
