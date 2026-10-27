// The deployment profile selects a subset of the published contract; it cannot invent type, role or effect authority.
import DISPATCH from '../tables/dispatch-roles.json' with {type:'json'};
import FORMAT from '../tables/runtime-profile-format.json' with { type: 'json' };
import { isRecord } from './text.ts';
import { runtimeMethod, sourceDocument, type RuntimeContract, type RuntimeEntry, type Problem } from './runtime-contract.ts';
import { readAuthority } from './typed-contract.ts';
import type { ManifestBed } from './manifest.ts';
export interface AllowedCall { reviewed?:boolean; object: string; method: string; parameters: Record<string, string>; unsupplied?: string[] }
export interface RuntimeProfile {
  block_model?:boolean;
  synthetic: boolean;
  max_wait_seconds: number | null;
  runtimeVersion: string;
  digest: string;
  bed: string;
  device_count: number;
  fold_newlines: Array<{ object: string; method: string }>;
  workbook: { sheet: string; header: string[]; identity_marker: string; range_name: string; closing_row: string[]; autoid_pattern: string };
  seats: Array<{ object: string; device: string; ordinal: number }>;
  hosts: Array<{ object: string; method: string; device: string; ordinal?:number }>;
  allowed: AllowedCall[];
  denied?: { device: string[]; host: string[] };
  /** The deployment's declared trigger-capable device types (a subset of the manifest device types); absent means the
   *  pack's whole closed set, server included. */
  trigger_types?: string[];
}
export type ParsedProfile = { ok: true; profile: RuntimeProfile } | { ok: false; problems: Problem[] };
export const oneLine = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.trim() === value && !/[\r\n\v\f\u0085\u2028\u2029]/.test(value) && !value.startsWith('=');
export function allowedCall(profile: RuntimeProfile, object: string, method: string): AllowedCall | null { return profile.allowed.find((v) => v.object === object && v.method === method) ?? null; }
function neverSupplied(raw: Record<string, unknown>, method: RuntimeEntry | null, listed: Record<string, unknown>): { names: string[]; problem: string | null } {
  if (raw.unsupplied === undefined) return { names: [], problem: null };
  const names = raw.unsupplied;
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length) return { names: [], problem: 'unsupplied 必须是无重复参数名列表' };
  if (names.some((name) => { const param = method?.parameters.find((item) => item.name === name); return !param || param.required || Object.hasOwn(listed, name); })) return { names: [], problem: 'unsupplied 含必需、签名外或已定角色的参数' };
  return { names: names as string[], problem: null };
}
export function parseProfile(value: unknown, contract: RuntimeContract, beds: readonly ManifestBed[]): ParsedProfile {
  const problems: Problem[] = [];
  const issue = (pointer: string, message: string) => problems.push({ pointer, message, fix: '管理员按 runtime-profile@1 形状核对配置、启用合约及台架清单，重新发布后开始新运行' });
  if (!isRecord(value)) return { ok: false, problems: [{ pointer: '', message: '运行环境配置不是对象', fix: '绑定发布的 runtime-profile@1 文档' }] };
  if (value.schema !== FORMAT.profile_schema) issue('/schema', '不是 runtime-profile@1');
  if (typeof value.synthetic !== 'boolean') issue('/synthetic', '没有明确的 synthetic 布尔声明');
  if (value.trigger_types !== undefined) {
    if (!Array.isArray(value.trigger_types) || value.trigger_types.some((type) => typeof type !== 'string' || !FORMAT.trigger_types.includes(type)) || new Set(value.trigger_types).size !== (value.trigger_types as string[]).length) issue('/trigger_types', 'trigger_types 必须是无重复的包声明触发类型子集；显式空数组表示没有触发类型');
  }
  const runtime = isRecord(value.runtime) ? value.runtime : {};
  if (runtime.minimum_version !== contract.runtimeVersion) issue('/runtime/minimum_version', '运行时版本与合约不符');
  if (runtime.contract_sha256 !== contract.pinned.identity) issue('/runtime/contract_sha256', '期望合约摘要与网关钉住的原合约身份不符');
  if (!Number.isSafeInteger(value.device_count) || (value.device_count as number) < 1) issue('/device_count', '缺少只读预检的正整数设备数');
  const bed = beds.find((v) => v.name === value.bed);
  if (!bed) issue('/bed', '配置的台架不在清单里');
  const workbook = isRecord(value.workbook) ? value.workbook : {};
  for (const key of ['sheet', 'identity_marker', 'range_name', 'autoid_pattern']) if (!oneLine(workbook[key])) issue(`/workbook/${key}`, '工作簿格式字面量不是合式的单行文字');
  const header = Array.isArray(workbook.header) ? workbook.header : [];
  if (header.length !== FORMAT.header_columns || header.some((v) => !oneLine(v)) || new Set(header).size !== header.length) issue('/workbook/header', '表头必须是九个不同的非空单行文字');
  const closing = Array.isArray(workbook.closing_row) ? workbook.closing_row : [];
  if (closing.length !== FORMAT.header_columns || closing.some((v) => typeof v !== 'string' || v !== '' && !oneLine(v)) || !closing.some((v) => v !== '')) issue('/workbook/closing_row', '收尾行必须是九格文字，至少一格非空');
  if(closing.slice(4).some(v=>v!=='')||closing[2]!==''&&(typeof closing[2]!=='string'||!/^[0-9]+$/.test(closing[2])||!Number.isSafeInteger(Number(closing[2]))||Number(closing[2])===1))problems.push({pointer:'/workbook/closing_row',message:'收尾行 E–I 必须为空，C 只能为空或不等于 1 的安全非负整数',fix:'管理员按 runtime-profile@1 修正收尾行后重新发布'});
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
    const type=bed?.devices.find(device=>device.name===raw.device)?.type;
    const capacity=Math.min(bed?.devices.filter(device=>device.type===(type??'load-balancer')).length??0,Number(value.device_count));
    if(bed&&Number.isSafeInteger(value.device_count)&&Number(value.device_count)>0&&Number.isSafeInteger(raw.ordinal)&&Number(raw.ordinal)>=capacity)problems.push({pointer:`${at}/ordinal`,message:`框架取不到那台设备，整卷不跑：对象 ${String(raw.object)} 的零基序号 ${String(raw.ordinal)} 超出 ${type??'load-balancer'} 容量 ${capacity}`,fix:'按冻结台架清单与预检设备数量修正对象映射后整卷重编译',capacityExceeded:true});
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
    const device=bed?.devices.find(device=>device.name===raw.device);
    if(raw.ordinal!==undefined){
      if(!Number.isSafeInteger(raw.ordinal)||Number(raw.ordinal)<0)issue(at+'/ordinal','对象序号必须是显式安全非负整数');
      else if(device&&Number(raw.ordinal)>=bed!.devices.filter(member=>member.type===device.type).length)problems.push({pointer:at+'/ordinal',message:`框架取不到那台设备，整卷不跑：对象 ${String(raw.object)} 的零基序号 ${raw.ordinal} 超出 ${device.type} 容量`,fix:'按冻结台架同类型设备数量修正序号后整卷重编译',capacityExceeded:true});
    }
    hosts.push({ object: String(raw.object), method: String(raw.method), device: String(raw.device),...(typeof raw.ordinal==='number'?{ordinal:raw.ordinal}:{}) });
  }
  const allowed: AllowedCall[] = [];
  const pairs = new Set<string>();
  if (!Array.isArray(value.allowed) || !value.allowed.length) issue('/allowed', '允许组合必须是非空列表');
  for (const [i, raw] of (Array.isArray(value.allowed) ? value.allowed : []).entries()) {
    const at = `/allowed/${i}`;
    if (!isRecord(raw)) { issue(at, '允许组合不是对象'); continue; }
    const method = runtimeMethod(contract, String(raw.object), String(raw.method));
    if (!method) issue(at, '允许组合不在合约启用集合里');
    const declared=DISPATCH.dispatches.find(v=>v.dispatch===method?.dispatch);
    const listed=isRecord(raw.parameters)?raw.parameters:{};
    const omitted=neverSupplied(raw,method??null,listed);
    if(omitted.problem)issue(`${at}/unsupplied`,omitted.problem);
    else if(method&&omitted.names.length){
      const document=sourceDocument(contract);
      const rawEntry=document&&Array.isArray(document.entries)?document.entries.find(item=>isRecord(item)&&item.e===method.object&&item.f===method.method):null;
      if(isRecord(rawEntry)&&document)method.authority=readAuthority(document,rawEntry,method.parameters.map(param=>param.name),omitted.names);
    }
    const roleIssue=(pointer:string)=>problems.push({pointer,message:declared?.roles.length?'该派发方式不支持配置的参数角色；不能冒充其他角色':declared?.missing??'派发方式缺少可核验角色声明',fix:declared?.roles.length?'集成者按派发角色声明表修正配置或保持未开，重新发布后新开运行':declared?.next??'按包格式表补齐派发角色及检查，另写一页后重新发布'});
    if(method&&!method.authority&&(declared?.requires_method_review||method.parameters.length===0)&&raw[FORMAT.method_review_field]!==true)problems.push({pointer:at+'/'+FORMAT.method_review_field,message:declared?.requires_method_review?declared.missing!:'零参数方法内部动作没有被参数角色和拒绝表核验',fix:declared?.requires_method_review?declared.next!:'集成者逐个只读审阅后在 allowed 项显式写 reviewed:true 决定开；否则保持未开，重新发布后新开运行'});
    if(!method?.authority&&(!declared||!declared.roles.length))roleIssue(at);
    const pair = JSON.stringify([raw.object, raw.method]); if (pairs.has(pair)) issue(at, '允许组合重复'); pairs.add(pair);
    if (!isRecord(raw.parameters)) issue(`${at}/parameters`, '没有参数角色映射对象');
    const parameters = Object.create(null) as Record<string, string>;
    for (const [name, role] of Object.entries(isRecord(raw.parameters) ? raw.parameters : {})) {
      const pat = `${at}/parameters/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      const param = method?.parameters.find((v) => v.name === name);
      if(typeof role==='string'&&!method?.authority&&!declared?.roles.some(candidate=>candidate===role))roleIssue(pat);
      if (!param || param.redacted) issue(pat, '参数不在签名里或是脱敏凭据参数');
      if (typeof role !== 'string' || (!FORMAT.parameter_roles.includes(role)&&!method?.authority?.roles[role])) issue(pat, '不认识的参数角色');
      if (role === 'device_cli' && !seats.some((v) => v.object === raw.object)) issue(pat, '设备命令参数没有匹配的座位');
      if (role === 'host_shell' && !hosts.some((v) => v.object === raw.object && v.method === raw.method)) issue(pat, '主机 shell 参数没有匹配的主机方法');
      if (typeof role === 'string') parameters[name] = role;
    }
    allowed.push({ object: String(raw.object), method: String(raw.method), parameters, ...(raw[FORMAT.method_review_field]===true?{reviewed:true}:{}), ...(omitted.names.length?{unsupplied:omitted.names}:{}) });
  }
  if(value.block_model!==undefined&&typeof value.block_model!=='boolean')issue('/block_model','block_model 必须是显式布尔声明');
  const assertions = allowed.filter((v) => Object.values(v.parameters).some((role) => role === 'literal_assertion'));
  const document=sourceDocument(contract),runnerRuntime=isRecord(document?.runtime)?document.runtime:{},block=isRecord(runnerRuntime.block_model)?runnerRuntime.block_model:{},defaultCall=isRecord(block.default_assertion)?block.default_assertion:{};
  const defaults=value.block_model===true?assertions.filter(call=>call.object===defaultCall.object&&call.method===defaultCall.method):assertions;
  if (defaults.length !== 1) issue('/allowed', '必须配置唯一的字面断言组合，供生成器从 expects 产生断言');
  for (const call of assertions) {
    const names = Object.keys(call.parameters).filter((name) => call.parameters[name] === 'literal_assertion');
    const method = runtimeMethod(contract, call.object, call.method);
    // A required parameter filled by the executor (the previous step's return, e.g. the `result` of the two-argument
    // checkpoints) is not the model's to write: only such parameters may be required besides the expectation.
    if (names.length !== 1 || method?.parameters.some((p) => p.required && p.name !== names[0] && call.parameters[p.name] !== 'executor_return'&&!(value.block_model===true&&call.parameters[p.name]==='checkpoint_count'))) issue('/allowed', '字面断言只能有一个期望参数，其他必填参数只能是由执行器提供上一步返回的参数');
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
  if(value.denied!==undefined)issue('/denied','拒绝词表已退役；删除该字段，按 runtime-contract@2 的闭集角色、完整命令与效果授权重发');
  return problems.length ? { ok: false, problems } : { ok: true, profile: { ...(value.block_model!==undefined?{block_model:value.block_model===true}:{}),synthetic: value.synthetic === true, max_wait_seconds: hasWait ? value.max_wait_seconds as number : null, runtimeVersion: contract.runtimeVersion, digest: contract.pinned.identity, bed: String(value.bed), device_count: value.device_count as number, fold_newlines, workbook: workbook as unknown as RuntimeProfile['workbook'], seats, hosts, allowed, ...(Array.isArray(value.trigger_types) ? { trigger_types: value.trigger_types as string[] } : {}) } };
}
