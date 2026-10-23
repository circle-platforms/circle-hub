// Preserve observed scalar values and field absence without inferring lifecycle semantics.
export type Scalar = string | number | boolean | null;
export const scalar = (value: unknown): Scalar => typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) ? value : null;
export function absent(record: Record<string, unknown>): string[] {
  return ['status', 'stage'].filter(key => Array.isArray(record.fields_absent) ? record.fields_absent.includes(key) : !Object.hasOwn(record, key) || record[key] === undefined);
}
export function rawText(row: { plm_returned: boolean; fields_absent: string[]; status: Scalar; stage: Scalar }, key: 'status' | 'stage'): string {
  return !row.plm_returned ? '应答未包含该编号' : row.fields_absent.includes(key) ? '字段未提供' : String(row[key]);
}
export const scalarKey = (value: Scalar): string => JSON.stringify([typeof value, value]);
