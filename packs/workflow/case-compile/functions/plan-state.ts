// Only declared plan fields determine stage eligibility; skipped is not a verified impossibility claim.
import { isRecord } from './text.ts';
export function planStateOf(value: unknown, excluded: ReadonlySet<string> = new Set()): { process: boolean; reason: string | null } {
  if (!isRecord(value) || typeof value.item !== 'string') return { process: false, reason: '缺少条目身份' };
  if (excluded.has(value.item)) return { process: false, reason: '已在本次范围中明确排除' };
  if (value.handling === 'skipped') return { process: false, reason: '模型声明跳过，理由尚未因此核验为真' };
  return { process: true, reason: null };
}
