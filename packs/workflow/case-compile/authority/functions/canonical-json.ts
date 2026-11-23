import { CallFailure } from './text.ts';
// Sorted compact JSON for local recipe and submission identity. This does not replace the runner contract algorithm.
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 1000) throw new CallFailure("invalid_parameters", 'JSON 嵌套过深', "提供嵌套不超过 1000 层的完整 JSON，保留原件另行核对后重试");
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') { if (!value.isWellFormed()) throw new CallFailure("invalid_parameters", 'JSON 含无效 Unicode', "提供无未配对代理字符的原始 JSON；重新导出原件，不猜补无效 Unicode"); return JSON.stringify(value); }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new CallFailure("invalid_parameters", 'JSON 含非有限数字', "把非有限数值改为原始资料中可明确表示的 JSON 数值；不能确定时补齐来源"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  if (typeof value !== 'object' || value === null) throw new CallFailure("invalid_parameters", '输入不是完整 JSON', "提供由对象、数组、字符串、有限数值、布尔值或 null 组成的完整 JSON");
  return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
}
