// Deployment profile owned by this pack; it assigns meaning absent from the runner's signature contract.
import { parseProbes, type Probe } from './probes.ts';
import FORMAT from '../tables/runtime-profile-format.json' with { type: 'json' };
import { isRecord } from './text.ts';
import { runtimeMethod, type RuntimeContract, type Problem } from './runtime-contract.ts';
import type { ManifestBed } from './manifest.ts';
export interface AllowedCall { object: string; method: string; parameters: Record<string, string> }
export interface RuntimeProfile {
  probes?: Probe[];
  synthetic: boolean;
  max_wait_seconds: number | null;
  runtimeVersion: string;
  digest: string;
  bed: string;
  device_count: number;
  fold_newlines: Array<{ object: string; method: string }>;
  workbook: { sheet: string; header: string[]; identity_marker: string; range_name: string; closing_row: string[]; autoid_pattern: string };
  seats: Array<{ object: string; device: string; ordinal: number }>;
  hosts: Array<{ object: string; method: string; device: string }>;
  allowed: AllowedCall[];
  denied: { device: string[]; host: string[] };
}
export type ParsedProfile = { ok: true; profile: RuntimeProfile } | { ok: false; problems: Problem[] };
export const oneLine = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.trim() === value && !/[\r\n\v\f\u0085\u2028\u2029]/.test(value) && !value.startsWith('=');
export function allowedCall(profile: RuntimeProfile, object: string, method: string): AllowedCall | null { return profile.allowed.find((v) => v.object === object && v.method === method) ?? null; }
export function parseProfile(value: unknown, contract: RuntimeContract, beds: readonly ManifestBed[]): ParsedProfile {
  const problems: Problem[] = [];
  const issue = (pointer: string, message: string) => problems.push({ pointer, message, fix: '管理员按 runtime-profile@1 形状核对配置、启用合约及台架清单，重新发布后开始新运行' });
  if (!isRecord(value)) return { ok: false, problems: [{ pointer: '', message: '运行环境配置不是对象', fix: '绑定发布的 runtime-profile@1 文档' }] };
  if (value.schema !== FORMAT.profile_schema) issue('/schema', '不是 runtime-profile@1');
  if (typeof value.synthetic !== 'boolean') issue('/synthetic', '没有明确的 synthetic 布尔声明');
  const runtime = isRecord(value.runtime) ? value.runtime : {};
  if (runtime.minimum_version !== contract.runtimeVersion) issue('/runtime/minimum_version', '运行时版本与合约不符');
  if (runtime.contract_sha256 !== contract.digest) issue('/runtime/contract_sha256', '期望合约摘要与重算身份不符');
  if (!Number.isSafeInteger(value.device_count) || (value.device_count as number) < 1) issue('/device_count', '缺少只读预检的正整数设备数');
  const bed = beds.find((v) => v.name === value.bed);
  if (!bed) issue('/bed', '配置的台架不在清单里');
  const workbook = isRecord(value.workbook) ? value.workbook : {};
  for (const key of ['sheet', 'identity_marker', 'range_name', 'autoid_pattern']) if (!oneLine(workbook[key])) issue(`/workbook/${key}`, '工作簿格式字面量不是合式的单行文字');
  const header = Array.isArray(workbook.header) ? workbook.header : [];
  if (header.length !== FORMAT.header_columns || header.some((v) => !oneLine(v)) || new Set(header).size !== header.length) issue('/workbook/header', '表头必须是九个不同的非空单行文字');
  const closing = Array.isArray(workbook.closing_row) ? workbook.closing_row : [];
  if (closing.length !== FORMAT.header_columns || closing.some((v) => typeof v !== 'string' || v !== '' && !oneLine(v)) || !closing.some((v) => v !== '')) issue('/workbook/closing_row', '收尾行必须是九格文字，至少一格非空');
  if (typeof workbook.autoid_pattern === 'string') {
    try { if (!workbook.autoid_pattern.startsWith('^') || !workbook.autoid_pattern.endsWith('$') || workbook.autoid_pattern.length > 200) throw new Error(); new RegExp(workbook.autoid_pattern, 'u'); } catch { issue('/workbook/autoid_pattern', '用例号形状必须是有首尾锚点的正则表达式，至多 200 字符'); }
  }
  const seats: RuntimeProfile['seats'] = [];
  const objects = new Set<string>(); const devices = new Set<string>(); const ordinals = new Set<number>();
  if (!Array.isArray(value.seats)) issue('/seats', '没有座位列表');
  for (const [i, raw] of (Array.isArray(value.seats) ? value.seats : []).entries()) {
    const at = `/seats/${i}`;
    if (!isRecord(raw)) { issue(at, '座位不是对象'); continue; }
    if (typeof raw.object !== 'string' || !contract.objects.includes(raw.object) || objects.has(raw.object)) issue(`${at}/object`, '座位对象不存在或重复');
    if (typeof raw.device !== 'string' || !bed?.devices.some((d) => d.name === raw.device && d.type === 'load-balancer') || devices.has(raw.device)) issue(`${at}/device`, '座位设备不是台架里的被测设备或重复');
    if (!Number.isSafeInteger(raw.ordinal) || (raw.ordinal as number) < 0 || ordinals.has(raw.ordinal as number)) issue(`${at}/ordinal`, '网关序号不是非负整数或重复');
    objects.add(String(raw.object)); devices.add(String(raw.device)); ordinals.add(raw.ordinal as number);
    seats.push({ object: String(raw.object), device: String(raw.device), ordinal: raw.ordinal as number });
  }
  const hosts: RuntimeProfile['hosts'] = [];
  const hostPairs = new Set<string>();
  if (!Array.isArray(value.hosts)) issue('/hosts', '没有主机方法列表');
  for (const [i, raw] of (Array.isArray(value.hosts) ? value.hosts : []).entries()) {
    const at = `/hosts/${i}`;
    if (!isRecord(raw)) { issue(at, '主机方法不是对象'); continue; }
    if (typeof raw.object !== 'string' || typeof raw.method !== 'string' || !runtimeMethod(contract, raw.object, raw.method)) issue(at, '主机方法不是合约启用组合');
    const pair = JSON.stringify([raw.object, raw.method]); if (hostPairs.has(pair)) issue(at, '主机方法重复'); hostPairs.add(pair);
    if (typeof raw.device !== 'string' || !bed?.devices.some((d) => d.name === raw.device && d.type !== 'load-balancer' && d.type !== 'console')) issue(`${at}/device`, '主机方法没有指向台架的测试主机');
    hosts.push({ object: String(raw.object), method: String(raw.method), device: String(raw.device) });
  }
  const allowed: AllowedCall[] = [];
  const pairs = new Set<string>();
  if (!Array.isArray(value.allowed) || !value.allowed.length) issue('/allowed', '允许组合必须是非空列表');
  for (const [i, raw] of (Array.isArray(value.allowed) ? value.allowed : []).entries()) {
    const at = `/allowed/${i}`;
    if (!isRecord(raw)) { issue(at, '允许组合不是对象'); continue; }
    const method = runtimeMethod(contract, String(raw.object), String(raw.method));
    if (!method) issue(at, '允许组合不在合约启用集合里');
    const pair = JSON.stringify([raw.object, raw.method]); if (pairs.has(pair)) issue(at, '允许组合重复'); pairs.add(pair);
    if (!isRecord(raw.parameters)) issue(`${at}/parameters`, '没有参数角色映射对象');
    const parameters = Object.create(null) as Record<string, string>;
    for (const [name, role] of Object.entries(isRecord(raw.parameters) ? raw.parameters : {})) {
      const pat = `${at}/parameters/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      const param = method?.parameters.find((v) => v.name === name);
      if (!param || param.redacted) issue(pat, '参数不在签名里或是脱敏凭据参数');
      if (typeof role !== 'string' || !FORMAT.parameter_roles.includes(role)) issue(pat, '不认识的参数角色');
      if (role === 'device_cli' && !seats.some((v) => v.object === raw.object)) issue(pat, '设备命令参数没有匹配的座位');
      if (role === 'host_shell' && !hosts.some((v) => v.object === raw.object && v.method === raw.method)) issue(pat, '主机 shell 参数没有匹配的主机方法');
      if (typeof role === 'string') parameters[name] = role;
    }
    allowed.push({ object: String(raw.object), method: String(raw.method), parameters });
  }
  const assertions = allowed.filter((v) => Object.values(v.parameters).some((role) => role === 'literal_assertion'));
  if (assertions.length !== 1) issue('/allowed', '必须配置唯一的字面断言组合，供生成器从 expects 产生断言');
  for (const call of assertions) {
    const names = Object.keys(call.parameters).filter((name) => call.parameters[name] === 'literal_assertion');
    const method = runtimeMethod(contract, call.object, call.method);
    if (names.length !== 1 || method?.parameters.some((p) => p.required && p.name !== names[0])) issue('/allowed', '字面断言只能有一个期望参数，不能缺少其他必填参数');
  }
  const fold_newlines: RuntimeProfile['fold_newlines'] = [];
  if (value.fold_newlines !== undefined && !Array.isArray(value.fold_newlines)) issue('/fold_newlines', '折叠换行名单必须是对象和方法组合列表');
  const folded = new Set<string>();
  for (const [i, raw] of (Array.isArray(value.fold_newlines) ? value.fold_newlines : []).entries()) {
    if (!isRecord(raw) || typeof raw.object !== 'string' || typeof raw.method !== 'string' || !allowed.some((v) => v.object === raw.object && v.method === raw.method)) { issue(`/fold_newlines/${i}`, '折叠换行名单必须是本轮允许的组合'); continue; }
    const key = JSON.stringify([raw.object, raw.method]); if (folded.has(key)) issue(`/fold_newlines/${i}`, '折叠换行组合重复'); folded.add(key);
    fold_newlines.push({ object: raw.object, method: raw.method });
  }
  const hasWait = allowed.some((call) => Object.values(call.parameters).some((role) => role === 'wait'));
  if (hasWait && (!Number.isSafeInteger(value.max_wait_seconds) || (value.max_wait_seconds as number) < 1)) issue('/max_wait_seconds', '等待角色必须配置明确的正整数秒数上限');
  const denied = isRecord(value.denied) ? value.denied : {};
  for (const key of ['device', 'host']) if (!Array.isArray(denied[key]) || (denied[key] as unknown[]).some((v) => !oneLine(v))) issue(`/denied/${key}`, '拒绝表必须是单行非空文字列表（没有条目写 []）');
  const parsedProbes = parseProbes(value.probes, contract, seats, allowed);
  problems.push(...parsedProbes.problems);
  return problems.length ? { ok: false, problems } : { ok: true, profile: { ...(value.probes === undefined ? {} : { probes: parsedProbes.probes }), synthetic: value.synthetic === true, max_wait_seconds: hasWait ? value.max_wait_seconds as number : null, runtimeVersion: contract.runtimeVersion, digest: contract.digest, bed: String(value.bed), device_count: value.device_count as number, fold_newlines, workbook: workbook as unknown as RuntimeProfile['workbook'], seats, hosts, allowed, denied: denied as unknown as RuntimeProfile['denied'] } };
}
