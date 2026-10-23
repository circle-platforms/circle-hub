// Preserve observed scalar values and field absence without inferring lifecycle semantics.
export type Scalar = string | number | boolean | null;
export const scalar = (value: unknown): Scalar => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : null;
export function absent(record: Record<string, unknown>): string[] {
  return ['status', 'stage'].filter(key => Array.isArray(record.fields_absent) ? record.fields_absent.includes(key) : !Object.hasOwn(record, key) || record[key] === undefined);
}
export function nonscalar(record: Record<string, unknown>): string[] {
  const missing = absent(record);
  return ['status', 'stage'].filter(key => !missing.includes(key) && (
    Array.isArray(record.fields_nonscalar) && record.fields_nonscalar.includes(key)
    || record[key] !== null && typeof record[key] !== 'string' && typeof record[key] !== 'boolean'
      && !(typeof record[key] === 'number' && Number.isFinite(record[key]))));
}
export function rawText(row: { plm_returned: boolean; plm_responded?: boolean; fields_absent: string[]; fields_nonscalar?: string[]; status: Scalar; stage: Scalar }, key: 'status' | 'stage'): string {
  return !row.plm_returned ? row.plm_responded ? '应答未包含该编号' : '详情来源不可用' : row.fields_absent.includes(key) ? '字段未提供' : row.fields_nonscalar?.includes(key) ? 'PLM 返回的值不是单个值' : String(row[key]);
}
export const scalarKey = (value: Scalar): string => JSON.stringify([typeof value, value]);
