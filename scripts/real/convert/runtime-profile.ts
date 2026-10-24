import DISPATCH from '../../../packs/workflow/case-compile/tables/dispatch-roles.json' with { type: 'json' };
import FORMAT from '../../../packs/workflow/case-compile/tables/runtime-profile-format.json' with { type: 'json' };
import { parseManifest } from '../../../packs/workflow/case-compile/functions/manifest.ts';
import { parseProfile } from '../../../packs/workflow/case-compile/functions/profile.ts';
import { parseRuntimeContract, type RuntimeContract } from '../../../packs/workflow/case-compile/functions/runtime-contract.ts';
import { argumentsOf, jsonBytes, main, output, parserDiagnostics, parserRefusal, readJson, record, requireFact, summary } from './io.ts';
const pair = (v: { object: unknown; method: unknown }) => JSON.stringify([v.object, v.method]);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
interface Unopened { object: string; method: string; parameters: Array<{ name: string; missing: string; reason: string; next: string }> }
type Method = RuntimeContract['enabled'][number];
const pointerPart = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
function dispatchPolicy(method: Method) {
  const policy = DISPATCH.dispatches.find(row => row.dispatch === method.dispatch);
  requireFact(policy, '派发方式缺少包格式表声明；集成者核对合约与 case-compile 版本后重跑');
  return policy;
}
function methodReview(method: Method) {
  const policy = dispatchPolicy(method);
  return policy.requires_method_review || method.parameters.length === 0 ? {
    missing: policy.missing ?? '零参数方法内部动作没有被参数角色和拒绝表核验',
    next: policy.next ?? `集成者逐个只读审阅后在 allowed 项显式写 ${FORMAT.method_review_field}:true 决定开；否则列 unopened，重新发布后新开运行`,
  } : null;
}
function unsupplied(method: Method, value: Record<string, unknown>): Set<string> {
  const names = value.unsupplied ?? [];
  requireFact(Array.isArray(names) && names.every(name => typeof name === 'string') && new Set(names).size === names.length, 'unsupplied 必须是无重复参数名列表；逐项声明永不传入的可选参数');
  requireFact(names.every(name => method.parameters.some(p => p.name === name && !p.required) && !(record(value.parameters) && Object.hasOwn(value.parameters, name))), 'unsupplied 含必需、签名外或已定角色的参数；核对签名后只列永不传入的可选参数');
  return new Set(names);
}
const blockedCredentials = (method: Method) => method.parameters.some(p => p.required && p.redacted) || method.parameters.length > 0 && method.parameters.every(p => p.redacted);
export function draftProfile(environment: unknown, manifest: unknown, rawContract: unknown, decisions?: unknown) {
  const contract = parseRuntimeContract(rawContract); const beds = parseManifest(manifest);
  requireFact(contract.ok, contract.ok ? '' : parserDiagnostics('runtime-contract', contract.problems, '集成者重新只读取得网关钉住的合约原件后重跑'));
  if (!beds.ok) throw parserRefusal('case-compile manifest', beds.problems, '集成者核对该清单字段，重新转换完整清单后重跑');
  requireFact(beds.beds.length === 1, '清单 /beds 缺少唯一台架；集成者明确本轮单台架输入后重跑');
  requireFact(record(environment) && environment.ready === true && Number.isSafeInteger(environment.device_count) && (environment.device_count as number) > 0, '缺少成功预检及 device_count；集成者重新只读取得环境预检回答');
  const wanted = contract.contract;
  requireFact(decisions === undefined || record(decisions) && Array.isArray(decisions.allowed) && Array.isArray(decisions.unopened), '角色决定文件须有 allowed 和 unopened 列表；按 README 填写');
  const decisionsRecord = record(decisions) ? decisions : {};
  const given = Array.isArray(decisionsRecord.allowed) ? decisionsRecord.allowed : [];
  const unopened = Array.isArray(decisionsRecord.unopened) ? [...decisionsRecord.unopened] : [];
  for (const method of wanted.enabled.filter(blockedCredentials)) {
    requireFact(!given.some(v => record(v) && pair({ object: v.object, method: v.method }) === pair(method)), '必需脱敏参数或仅有脱敏参数的组合不能开放；集成者核对认证接入并保持未开');
    if (!unopened.some(v => record(v) && pair({ object: v.object, method: v.method }) === pair(method))) unopened.push({ object: method.object, method: method.method, parameters: method.parameters.filter(p => p.redacted).map(p => ({ name: p.name, missing: '合约未提供可核验的凭据参数', reason: '脱敏凭据不能经工作簿传入', next: '集成者只读核对认证接入并另开合约任务，当前保持未开' })) });
  }
  for (const method of wanted.enabled) {
    const policy = dispatchPolicy(method);
    if (policy.roles.length || blockedCredentials(method)) continue;
    const index = given.findIndex(v => record(v) && pair({ object: v.object, method: v.method }) === pair(method));
    requireFact(index < 0, `/allowed/${index} 没有可核验的派发角色；${policy.missing}；${policy.next}`);
    if (!unopened.some(v => record(v) && pair({ object: v.object, method: v.method }) === pair(method))) {
      const gap = { missing: policy.missing!, reason: policy.missing!, next: policy.next! };
      unopened.push({ object: method.object, method: method.method, parameters: method.parameters.map(p => ({ name: p.name, ...gap })), ...(!method.parameters.length ? gap : {}) });
    }
  }
  const pending: Array<{ pointer: string; missing: string; next: string }> = [];
  const add = (pointer: string, missing: string, next: string) => pending.push({ pointer, missing, next });
  const allowed = wanted.enabled.filter(method => !unopened.some(v => record(v) && pair({ object: v.object, method: v.method }) === pair(method))).map((method, i) => {
    const found = given.find((v) => record(v) && pair({ object: v.object, method: v.method }) === pair(method));
    const roles = record(found) && record(found.parameters) ? found.parameters : {};
    for (const parameter of method.parameters) requireFact(!parameter.redacted || !Object.hasOwn(roles, parameter.name), `/allowed/${i}/parameters/${pointerPart(parameter.name)} 脱敏参数不能定角色；删去该角色后重跑 --check`);
    const omitted = unsupplied(method, record(found) ? found : {});
    const policy = dispatchPolicy(method);
    const parameters = Object.fromEntries(method.parameters.filter(p => !p.redacted && !omitted.has(p.name)).map((parameter) => {
      const role = roles[parameter.name];
      const pointer = `/allowed/${i}/parameters/${pointerPart(parameter.name)}`;
      if (role !== undefined) requireFact(typeof role === 'string' && policy.roles.some(candidate => candidate === role), `${pointer} 的角色不在该派发方式的包格式表中；集成者按 dispatch-roles.json 改正或列为 unopened 后重跑`);
      if (typeof role === 'string') return [parameter.name, role];
      add(pointer, '签名不能证明参数角色', `集成者核对参数语义后填写包表中的角色${parameter.required ? '' : '，或在该 allowed 项 unsupplied 中声明永不传入'}；不能归入角色则移到 unopened 并另开包检查任务`);
      return [parameter.name, null];
    }));
    const review = methodReview(method);
    const reviewed = record(found) && found[FORMAT.method_review_field] === true;
    if (review && !reviewed) add(`/allowed/${i}/${FORMAT.method_review_field}`, review.missing, review.next);
    return { object: method.object, method: method.method, parameters, ...(omitted.size ? { unsupplied: [...omitted] } : {}), ...(reviewed ? { [FORMAT.method_review_field]: true } : {}) };
  });
  // Never silently discard an explicit operator decision, including disabled or extra combinations.
  const enabled = new Set(wanted.enabled.map(pair)); const seen = new Set<string>();
  for (const v of [...given, ...unopened]) {
    requireFact(record(v) && typeof v.object === 'string' && typeof v.method === 'string', '角色决定组合形状无效；补齐 object 和 method');
    const key = pair({ object: v.object, method: v.method });
    requireFact(enabled.has(key) && !seen.has(key), '角色决定含非启用或重复组合；核对合约后改正'); seen.add(key);
    if (given.includes(v)) {
      const method = wanted.enabled.find((e) => pair(e) === key)!;
      requireFact(record(v.parameters) && Object.keys(v.parameters).every((name) => method.parameters.some((p) => p.name === name)), '角色决定含签名外参数；核对原签名后改正');
    }
  }
  // The denial word list is retired (R5): dispatch authority comes from the contract's closed roles, complete commands
  // and effect table, so the draft no longer asks for /denied.
  for (const pointer of ['/synthetic', '/workbook', '/seats', '/hosts', '/max_wait_seconds', '/fold_newlines']) add(pointer, '缺少运行环境部署事实', '集成者从运行器格式和只读预检填写，重新运行 --check；不得以空列表代替未核对的事实');
  const profile = { schema: FORMAT.profile_schema, synthetic: null, runtime: { minimum_version: wanted.runtimeVersion, contract_sha256: wanted.digest }, bed: beds.beds[0]!.name, device_count: environment.device_count, max_wait_seconds: null, fold_newlines: null, workbook: null, seats: null, hosts: null, allowed, unopened, pending };
  return profile;
}
export function checkCoverage(profile: unknown, contract: RuntimeContract): void {
  requireFact(record(profile) && Array.isArray(profile.allowed) && Array.isArray(profile.unopened), '缺少 allowed 或 unopened；逐项登记全部启用组合');
  const enabled = new Map(contract.enabled.map((v) => [pair(v), v])); const seen = new Set<string>();
  for (const [list, values] of [['allowed', profile.allowed], ['unopened', profile.unopened]] as const) for (const [index, value] of values.entries()) {
    requireFact(record(value) && typeof value.object === 'string' && typeof value.method === 'string', '组合缺少 object 或 method；按合约改正');
    const key = pair({ object: value.object, method: value.method }); const method = enabled.get(key);
    requireFact(method && !seen.has(key), '组合不是启用子集或重复出现；逐项核对 allowed 和 unopened'); seen.add(key);
    if (list === 'allowed') {
      requireFact(!blockedCredentials(method), '必需脱敏参数或仅有脱敏参数的组合不能开放；集成者核对认证接入并列为未开');
      if (record(value.parameters)) for (const parameter of method.parameters) requireFact(!parameter.redacted || !Object.hasOwn(value.parameters, parameter.name), `/allowed/${index}/parameters/${pointerPart(parameter.name)} 脱敏参数不能定角色；删去该角色后重跑 --check`);
      const policy = dispatchPolicy(method);
      const pointer = `/allowed/${index}`;
      requireFact(policy.roles.length > 0, `${pointer} 的派发方式当前没有可核验角色；${policy.missing}；${policy.next}`);
      const review = methodReview(method);
      if (review) requireFact(value[FORMAT.method_review_field] === true, `${pointer}/${FORMAT.method_review_field} 缺少明确开通决定；${review.missing}；${review.next}`);
      if (record(value.parameters)) for (const [name, role] of Object.entries(value.parameters)) requireFact(typeof role === 'string' && policy.roles.some(candidate => candidate === role), `${pointer}/parameters/${pointerPart(name)} 的角色不在该派发方式的包格式表中；集成者按 dispatch-roles.json 改正或保持未开后重跑 --check`);
      const omitted = unsupplied(method, value);
      requireFact(record(value.parameters) && method.parameters.every(p => p.redacted && !p.required ? !Object.hasOwn(value.parameters as object, p.name) : omitted.has(p.name) || Object.hasOwn(value.parameters as object, p.name) && typeof (value.parameters as Record<string, unknown>)[p.name] === 'string' && FORMAT.parameter_roles.includes((value.parameters as Record<string, string>)[p.name]!)), '启用组合仍有可传参数无角色；定角色、显式列入 unsupplied 或列为未开');
    } else {
      if (!method.parameters.length) requireFact(Array.isArray(value.parameters) && value.parameters.length === 0 && text(value.missing) && text(value.reason) && text(value.next), '零参数未开项缺少方法级事实、原因或下一步；集成者核对方法语义并明确决定后重跑 --check');
      else requireFact(Array.isArray(value.parameters) && value.parameters.length > 0 && value.parameters.every((p: unknown) => record(p) && method.parameters.some((parameter) => parameter.name === p.name) && text(p.missing) && text(p.reason) && text(p.next)), '未开项缺少参数、原因、缺失事实或下一步；补齐后另开包角色检查任务');
    }
  }
  requireFact(seen.size === enabled.size, '启用组合有遗漏；逐项补入 allowed 或 unopened');
}
export function checkProfile(profile: unknown, manifest: unknown, rawContract: unknown) {
  const contract = parseRuntimeContract(rawContract); const beds = parseManifest(manifest);
  requireFact(contract.ok, contract.ok ? '' : parserDiagnostics('runtime-contract', contract.problems, '集成者重新只读取得网关钉住的合约原件后重跑 --check'));
  if (!beds.ok) throw parserRefusal('case-compile manifest', beds.problems, '集成者核对该清单字段，重新转换清单后重跑 --check');
  checkCoverage(profile, contract.contract);
  requireFact(record(profile) && Array.isArray(profile.pending) && profile.pending.length === 0, '仍有待填事实；集成者填写并逐项清除 pending 后重跑 --check');
  const parsed = parseProfile(profile, contract.contract, beds.beds);
  requireFact(parsed.ok, parsed.ok ? '' : parserDiagnostics('runtime-profile', parsed.problems, '集成者从只读预检和合约补齐该字段，使用同一清单重跑 --check'));
  requireFact(record(profile) && profile.synthetic === false, '部署配置的 synthetic 必须是 false；集成者核对真实接入事实后设为 false 并重跑 --check');
  // The denial word lists were retired with the closed-set roles: a profile that still carries one is refused
  // by parseProfile above ('拒绝词表已退役'), and dispatch authority rests on the contract's closed roles and
  // effect table. What the conversion still checks is the closed roles themselves.
  for (const role of ['device_cli', 'host_shell'] as const) {
    requireFact(!parsed.profile.allowed.some(call => Object.values(call.parameters).includes(role)) || Object.keys(parsed.profile.allowed.find(call => Object.values(call.parameters).includes(role))?.parameters ?? []).length > 0, `allowed 里 ${role} 角色的参数映射为空；请集成者核对闭集角色后重跑 --check`);
  }
  requireFact(parsed.profile.seats.every((v) => v.ordinal < parsed.profile.device_count), '座位序号超出预检设备数；重新核对座位顺序');
  return parsed.profile;
}
export function run(args: string[]): void {
  const checking = args.includes('--check'); const normalized = args.filter((arg) => arg !== '--check');
  const { files, options } = argumentsOf(normalized, 3, ['--out', '--decisions']);
  requireFact(!checking || !options['--decisions'], '--check 不接收角色决定草稿；直接核验填写后的配置');
  const source = readJson(files[0]!, checking ? '运行环境配置' : '环境预检'); const manifest = readJson(files[1]!, '台架清单'); const contract = readJson(files[2]!, '运行器合约');
  const profile = checking ? (checkProfile(source, manifest, contract), source) : draftProfile(source, manifest, contract, options['--decisions'] ? readJson(options['--decisions'], '角色决定') : undefined);
  const bytes = jsonBytes(profile); const filename = checking ? 'runtime-profile.json' : 'runtime-profile.draft.json';
  output(options['--out'] ?? '', filename, bytes);
  summary(record(profile) && Array.isArray(profile.allowed) ? profile.allowed.length : 0, bytes, checking ? { name: 'runtime-profile', file: filename } : undefined);
}
main(import.meta.url, run);
