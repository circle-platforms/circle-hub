// Original runner contract, not an adapter into a new contract format. Identity covers all original members.
import { createHash } from 'node:crypto';
import FORMAT from '../tables/runtime-contract-format.json' with { type: 'json' };
import { isRecord } from './text.ts';
export interface Problem { pointer: string; message: string; fix: string }
export interface RuntimeParameter { name: string; kind: string; required: boolean; redacted: boolean }
export interface RuntimeEntry { object: string; method: string; dispatch: string; parameters: RuntimeParameter[] }
export interface RuntimeContract { runtimeVersion: string; digest: string; objects: string[]; enabled: RuntimeEntry[] }
export type ParsedRuntimeContract = { ok: true; contract: RuntimeContract } | { ok: false; problems: Problem[] };
const SHA = /^[a-f0-9]{64}$/;
const pointer = (value: string): string => value.replaceAll('~', '~0').replaceAll('/', '~1');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Python-compatible sorted compact JSON, with UTF-8 text preserved. Unsafe numbers cannot prove original identity. */
export function contractCanonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('合约数字必须是可精确表示的整数');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(contractCanonical).join(',')}]`;
  if (!isRecord(value)) throw new Error('合约含有不是 JSON 的值');
  return `{${Object.keys(value).sort().map((key) => {
    if (/[\uD800-\uDFFF]/.test(key)) throw new Error('合约键含有 BMP 以外或未配对的字符');
    return `${JSON.stringify(key)}:${contractCanonical(value[key])}`;
  }).join(',')}}`;
}
export function runtimeDigest(value: Record<string, unknown>): string {
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'contract_sha256'));
  return createHash('sha256').update(contractCanonical(unsigned), 'utf8').digest('hex');
}
export function runtimeMethod(contract: RuntimeContract, object: string, method: string): RuntimeEntry | null {
  return contract.enabled.find((entry) => entry.object === object && entry.method === method) ?? null;
}
/** Whole-document refusal: no unknown format value can silently remove an unsafe entry from the integrity check. */
export function parseRuntimeContract(value: unknown, expected?: { runtimeVersion: string; digest: string }): ParsedRuntimeContract {
  const problems: Problem[] = [];
  const issue = (at: string, message: string) => problems.push({ pointer: at, message, fix: '按运行器原始函数合约格式改正并重算身份；管理员重新发布合约和匹配的运行环境配置' });
  if (!isRecord(value)) return { ok: false, problems: [{ pointer: '', message: '运行器合约不是对象', fix: '绑定发布的原格式运行器合约' }] };
  const inspect = (v: unknown, at: string): void => {
    if (typeof v === 'number' && !Number.isSafeInteger(v)) issue(at, '数字不是可精确表示的整数');
    if (Array.isArray(v)) v.forEach((child, i) => inspect(child, `${at}/${i}`));
    else if (isRecord(v)) for (const [key, child] of Object.entries(v)) {
      if (/[\uD800-\uDFFF]/.test(key)) issue(`${at}/${pointer(key)}`, '键含有 BMP 以外或未配对的字符');
      inspect(child, `${at}/${pointer(key)}`);
    }
  };
  inspect(value, '');
  if (value.schema !== FORMAT.contract_schema) issue('/schema', '不是运行器原始函数合约 schema');
  if (value.complete !== true) issue('/complete', '合约没有声明完整');
  const runtime = isRecord(value.runtime) ? value.runtime : {};
  for (const field of ['minimum_version', 'runner_source']) if (!nonempty(runtime[field])) issue(`/runtime/${field}`, '缺少运行时标识或源文件名');
  if (typeof runtime.runner_sha256 !== 'string' || !SHA.test(runtime.runner_sha256)) issue('/runtime/runner_sha256', '源文件摘要写法无效');
  if (typeof runtime.found_times_supported !== 'boolean') issue('/runtime/found_times_supported', '能力标志不是布尔值');
  if (!isRecord(value.source_hashes)) issue('/source_hashes', '缺少源文件摘要表');
  else for (const [path, digest] of Object.entries(value.source_hashes)) if (!path || typeof digest !== 'string' || !SHA.test(digest)) issue(`/source_hashes/${pointer(path)}`, '源文件摘要写法无效');
  if (!isRecord(value.atlas_snapshot)) issue('/atlas_snapshot', '缺少快照元数据');
  if (!(Array.isArray(value.execute_actions) || isRecord(value.execute_actions))) issue('/execute_actions', '缺少动作注册表（本轮不开放）');
  if (!isRecord(value.certification) || value.certification.schema !== FORMAT.certification_schema || !Number.isSafeInteger(value.certification.receipt_count) || (value.certification.receipt_count as number) < 0) issue('/certification', '认证集合形状无效');
  const objects = new Map<string, string>();
  if (!Array.isArray(value.objects)) issue('/objects', '没有对象列表');
  for (const [i, object] of (Array.isArray(value.objects) ? value.objects : []).entries()) {
    const at = `/objects/${i}`;
    if (!isRecord(object)) { issue(at, '对象条目不是对象'); continue; }
    if (!nonempty(object.name)) issue(`${at}/name`, '对象没有名称');
    else { if (objects.has(object.name)) issue(`${at}/name`, '对象名重复'); objects.set(object.name, String(object.status)); }
    if (!FORMAT.statuses.includes(String(object.status))) issue(`${at}/status`, '不认识的对象状态');
    if (object.reason !== undefined && typeof object.reason !== 'string') issue(`${at}/reason`, '禁用原因不是文字');
  }
  const enabled: RuntimeEntry[] = [];
  const pairs = new Set<string>();
  if (!Array.isArray(value.entries)) issue('/entries', '没有函数条目列表');
  for (const [i, entry] of (Array.isArray(value.entries) ? value.entries : []).entries()) {
    const at = `/entries/${i}`;
    if (!isRecord(entry)) { issue(at, '函数条目不是对象'); continue; }
    if (!nonempty(entry.e) || !objects.has(String(entry.e))) issue(`${at}/e`, '函数条目的对象不存在');
    if (!nonempty(entry.f)) issue(`${at}/f`, '函数条目没有方法名');
    const pair = JSON.stringify([entry.e, entry.f]);
    if (pairs.has(pair)) issue(at, '对象和方法组合重复');
    pairs.add(pair);
    if (!FORMAT.statuses.includes(String(entry.status))) issue(`${at}/status`, '不认识的条目状态');
    if (!FORMAT.dispatches.includes(String(entry.dispatch))) issue(`${at}/dispatch`, '不认识的派发方式');
    if (entry.status === 'enabled' && objects.get(String(entry.e)) !== 'enabled') issue(`${at}/status`, '未启用对象下存在启用条目');
    const authority = entry.status_authority;
    if (typeof authority !== 'string' || !(FORMAT.status_authorities.includes(authority) || authority.startsWith(FORMAT.receipt_authority_prefix) && SHA.test(authority.slice(FORMAT.receipt_authority_prefix.length)))) issue(`${at}/status_authority`, '不认识的状态来源');
    for (const field of ['python_symbol', 'g_syntax', 'h_semantics', 'i_semantics', 'reason', 'minimum_runtime']) if (typeof entry[field] !== 'string') issue(`${at}/${field}`, '函数说明字段不是文字');
    if (!isRecord(entry.source) || !nonempty(entry.source.path) || !Number.isSafeInteger(entry.source.line) || (entry.source.line as number) < 1) issue(`${at}/source`, '函数源位置不合式');
    if (entry.certification_candidate !== undefined && typeof entry.certification_candidate !== 'boolean') issue(`${at}/certification_candidate`, '认证候选标志不是布尔值');
    const signature = isRecord(entry.signature) ? entry.signature : {};
    if (!Array.isArray(signature.parameters)) issue(`${at}/signature/parameters`, '没有签名参数列表');
    const parameters: RuntimeParameter[] = [];
    const names = new Set<string>();
    for (const [k, param] of (Array.isArray(signature.parameters) ? signature.parameters : []).entries()) {
      const pat = `${at}/signature/parameters/${k}`;
      if (!isRecord(param)) { issue(pat, '参数不是对象'); continue; }
      if (!nonempty(param.name) || names.has(String(param.name))) issue(`${pat}/name`, '参数名为空或重复');
      names.add(String(param.name));
      if (!FORMAT.parameter_kinds.includes(String(param.kind))) issue(`${pat}/kind`, '不认识的参数种类');
      if (typeof param.required !== 'boolean') issue(`${pat}/required`, '必填标志不是布尔值');
      if (!(param.default === null || typeof param.default === 'string')) issue(`${pat}/default`, '默认值不是源码文字或 null');
      parameters.push({ name: String(param.name), kind: String(param.kind), required: param.required === true, redacted: param.default === FORMAT.redacted_default });
    }
    for (const [field, required] of [['required', true], ['optional', false]] as const) {
      const wanted = parameters.filter((param) => param.required === required).map((param) => param.name);
      if (JSON.stringify(signature[field]) !== JSON.stringify(wanted)) issue(`${at}/signature/${field}`, '签名参数分组与逐参数标志不一致');
    }
    if (typeof signature.text !== 'string') issue(`${at}/signature/text`, '签名说明不是文字');
    if (entry.status === 'enabled' && entry.certification_candidate !== true) enabled.push({ object: String(entry.e), method: String(entry.f), dispatch: String(entry.dispatch), parameters });
  }
  let digest = '';
  try { digest = runtimeDigest(value); } catch { /* Precise numeric/key problems were already listed above. */ }
  if (typeof value.contract_sha256 !== 'string' || !SHA.test(value.contract_sha256)) issue('/contract_sha256', '声明的合约摘要无效');
  else if (digest !== value.contract_sha256) issue('/contract_sha256', '重算合约摘要与声明值不一致');
  if (expected && (expected.digest !== digest || expected.runtimeVersion !== runtime.minimum_version)) issue('/runtime', '合约身份与运行环境配置的期望值不一致');
  return problems.length ? { ok: false, problems } : { ok: true, contract: { digest, runtimeVersion: String(runtime.minimum_version), objects: [...objects.keys()], enabled } };
}
