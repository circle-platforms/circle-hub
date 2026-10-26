// Sorted compact JSON for local recipe and submission identity. This does not replace the runner contract algorithm.
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 1000) throw new Error('JSON 嵌套过深');
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { if (!value.isWellFormed()) throw new Error('JSON 含无效 Unicode'); return JSON.stringify(value); }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('JSON 含非有限数字'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  if (typeof value !== 'object' || value === null) throw new Error('输入不是完整 JSON');
  return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
}
