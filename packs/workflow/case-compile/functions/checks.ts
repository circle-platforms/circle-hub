// Verify authored plans against original runner identities, runtime profile, manifest, and frozen lineage addresses.
import { isRecord, markers, type Outcome } from './text.ts';
import { parseRuntimeContract, runtimeMethod, type RuntimeContract } from './runtime-contract.ts';
import { parseProfile, allowedCall, type RuntimeProfile } from './profile.ts';
import { parseManifest, addressKey, type ManifestBed } from './manifest.ts';
import { readAddress, type LeaseRow } from './bed.ts';
import { readSlots, type PlanSlots } from './slots.ts';
import { bindArguments, hasBalancedCommandText } from './binding.ts';
import { literalAddresses, replacedQuote, deniedCommand, isHostLiteral } from './addresses.ts';
interface CheckSubject { item: string; location: string | null; data: unknown; contract: RuntimeContract | null; profile: RuntimeProfile | null; beds: ManifestBed[]; leases: LeaseRow[]; now: string }
function subjectOf(input: unknown): CheckSubject {
  const raw = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const contract = parseRuntimeContract(raw.contract); const manifest = parseManifest(raw.manifest);
  const profile = contract.ok && manifest.ok ? parseProfile(raw.profile, contract.contract, manifest.beds) : null;
  return { item: typeof raw.item === 'string' ? raw.item : '', location: typeof raw.location === 'string' ? raw.location : null, data: raw.data, contract: contract.ok ? contract.contract : null, profile: profile?.ok ? profile.profile : null, beds: manifest.ok ? manifest.beds : [], leases: Array.isArray(raw.leases) ? raw.leases as LeaseRow[] : [], now: typeof raw.now === 'string' ? raw.now : new Date(0).toISOString() };
}
const TIER = 'blocking' as const;
function support(s: CheckSubject, statement: string, data?: Record<string, unknown>): Outcome { return { verdict: 'support', statement: statement + markers(s.profile?.synthetic === true, s.contract ?? undefined), grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, ...(data ? { data } : {}) }; }
function refute(s: CheckSubject, code: string, statement: string, pointer: string): Outcome { return { verdict: 'refute', code: `case-compile.${code}`, statement: statement + markers(s.profile?.synthetic === true, s.contract ?? undefined), grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, pointer }; }
function prerequisites(s: CheckSubject): Outcome[] | null { return s.contract && s.profile ? null : [{ verdict: 'unknown', reason: 'check_error', statement: '冻结的合约、配置或清单无法重算；缺少匹配身份的完整输入，客户端须请求管理员重新发布并开始新运行。不证明在真实设备上跑得通。', grounds: [], tier: TIER, item: s.item }]; }
function slotsOf(s: CheckSubject): { slots: PlanSlots; errors: null } | { slots: null; errors: Outcome[] } {
  const read = readSlots(s.data);
  return read.ok ? { slots: read.slots, errors: null } : { slots: null, errors: read.problems.map((v) => refute(s, v.pointer.includes('/quote') ? 'expect_without_source' : 'slots_invalid', `槽位 ${v.pointer}：${v.message}；按 slots.schema.json 的形状修正`, `/data${v.pointer}`)) };
}
export function checkContractShape(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const out: Outcome[] = [];
  for (const [i, step] of read.slots.steps.entries()) {
    const at = `/data/steps/${i}`;
    const method = runtimeMethod(s.contract!, step.object, step.method);
    if (!method) { out.push(refute(s, 'method_forbidden', `第 ${i + 1} 步不是合约启用的组合`, at)); continue; }
    const allowed = allowedCall(s.profile!, step.object, step.method);
    if (!allowed) { out.push(refute(s, 'method_not_allowed', `第 ${i + 1} 步虽在合约启用集合里，本轮配置没有允许`, at)); continue; }
    if (Object.values(allowed.parameters).some((role) => role === 'literal_assertion')) { out.push(refute(s, 'assertion_in_steps', '断言写进 expects，带引文和 after', at)); continue; }
    const bound = bindArguments(method, step, at);
    for (const v of bound.problems) out.push(refute(s, v.code, `第 ${i + 1} 步：${v.message}`, v.pointer));
    for (const v of bound.values) {
      if (method.parameters.some((param) => param.name === v.name && param.redacted)) continue;
      const role = allowed.parameters[v.name];
      if (!Object.hasOwn(allowed.parameters, v.name)) { out.push(refute(s, 'param_unassigned', `参数 ${v.name} 没有角色；先在运行环境配置里给它定角色，再按角色筛查`, v.pointer)); continue; }
      if (role === 'wait' && (!/^[0-9]+$/.test(v.value) || !Number.isSafeInteger(Number(v.value)) || Number(v.value) < 1 || s.profile!.max_wait_seconds === null || Number(v.value) > s.profile!.max_wait_seconds)) out.push(refute(s, 'wait_value', '等待值必须是配置上限内的正整数 ASCII 秒数；改为明确时长', v.pointer));
      if (role === 'device_cli' && !hasBalancedCommandText(v.value.normalize('NFKC'))) out.push(refute(s, 'param_value', '命令目录正规化后的引号必须成对，不能以反斜杠结尾；先修正命令文字', v.pointer));
      if (role === 'device_cli' && deniedCommand(v.value, s.profile!.denied.device)) out.push(refute(s, 'device_command_denied', `第 ${i + 1} 步命中发布配置的设备命令拒绝表`, v.pointer));
      if (role === 'host_shell' && deniedCommand(v.value, s.profile!.denied.host)) out.push(refute(s, 'host_command_denied', `第 ${i + 1} 步命中发布配置的主机命令拒绝表`, v.pointer));
    }
  }
  return out.length ? out : [support(s, `${read.slots.steps.length} 步调用符合启用合约与本轮允许集合，签名和值均已核对`, { runtime_version: s.contract!.runtimeVersion, contract_sha256: s.contract!.digest })];
}
export function checkAddresses(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const slots = read.slots; const bed = s.beds.find((v) => v.name === slots.bucket);
  if (!bed || bed.name !== s.profile!.bed) return [refute(s, 'bed_unknown', 'bucket 必须是运行环境配置选定的清单台架', '/data/bucket')];
  const out: Outcome[] = []; let count = 0;
  const from = new Set<string>(); const to = new Set<string>();
  for (const [i, replacement] of slots.replacements.entries()) {
    const source = addressKey(replacement.case); const target = addressKey(replacement.bed);
    if (!source || !target || from.has(source) || to.has(target)) out.push(refute(s, 'replacement_invalid', '替换表必须是一一对应的字面地址映射，按地址数值比较', `/data/replacements/${i}`));
    if (source) from.add(source); if (target) to.add(target);
    if (readAddress(bed, s.leases, s.now, replacement.bed).kind === 'off_bed') out.push(refute(s, 'address_off_bed', '替换后的地址不在本台架或本血缘分配集合里', `/data/replacements/${i}/bed`));
  }
  const examine = (value: string, pointer: string, device: string | null): void => {
    for (const address of literalAddresses(value)) {
      if (!isHostLiteral(address, value, bed)) continue;
      count++;
      const found = readAddress(bed, s.leases, s.now, address.text);
      if (found.kind === 'off_bed') { out.push(refute(s, 'address_off_bed', `字面地址 ${address.text} 不在本台架或本血缘分配集合里`, pointer)); continue; }
      if (slots.replacements.some((v) => addressKey(v.case) === address.key && addressKey(v.bed) !== address.key)) out.push(refute(s, 'replacement_missing', '步骤或期望文字里仍有未替换的原用例地址；槽位必须写最终文字', pointer));
      if (device && found.kind === 'interface' && found.device !== device && found.type !== 'server') out.push(refute(s, 'address_wrong_device', '设备命令只许本设备接口地址、本血缘分配地址和服务器接口地址', pointer));
    }
  };
  for (const [i, step] of slots.steps.entries()) {
    const method = runtimeMethod(s.contract!, step.object, step.method); const allowed = allowedCall(s.profile!, step.object, step.method);
    const bound = method ? bindArguments(method, step, `/data/steps/${i}`).values : [];
    for (const v of bound) if (allowed && !Object.hasOwn(allowed.parameters, v.name) && !method?.parameters.some((p) => p.name === v.name && p.redacted)) out.push(refute(s, 'param_unassigned', `参数 ${v.name} 没有角色，地址用途无法核对；请在运行环境配置里给它定角色`, v.pointer));
    const seat = s.profile!.seats.find((v) => v.object === step.object);
    const values = [...step.args.map((value, k) => ({ value, pointer: `/data/steps/${i}/args/${k}` })), ...Object.entries(step.keywords).map(([name, value]) => ({ value, pointer: `/data/steps/${i}/keywords/${name.replaceAll('~', '~0').replaceAll('/', '~1')}` }))];
    for (const v of values) {
      const parameter = bound.find((b) => b.pointer === v.pointer);
      examine(v.value, v.pointer, parameter && allowed?.parameters[parameter.name] === 'device_cli' ? seat?.device ?? null : null);
    }
  }
  slots.expects.forEach((v, i) => examine(v.text, `/data/expects/${i}/text`, null));
  return out.length ? out : [support(s, `${count} 个字面地址都对得上台架 ${bed.name}；替换表 ${slots.replacements.length} 项已按最终文字核对`, { replacements: slots.replacements })];
}
export function checkExpectedSources(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const slots = read.slots; const out: Outcome[] = [];
  if (!slots.expects.length) return [refute(s, 'expect_without_source', '至少一条期望结果必须带逐字来源并指明它判断的步骤', '/data/expects')];
  for (const [i, expect] of slots.expects.entries()) {
    const pointer = `/data/expects/${i}`;
    if (!replacedQuote(expect.quote.text, slots.replacements).includes(expect.text)) out.push(refute(s, 'expect_not_in_quote', '期望文字不是套用地址替换表后引文的逐字片段', `${pointer}/text`));
    const step = slots.steps[expect.after - 1]; const allowed = step ? allowedCall(s.profile!, step.object, step.method) : null;
    if (!allowed || !Object.values(allowed.parameters).some((role) => role === 'device_cli' || role === 'host_shell')) out.push(refute(s, 'expect_after', 'after 必须指向设备命令行或主机 shell 步骤，不能指向等待或断言步骤', `${pointer}/after`));
  }
  return out.length ? out : [support(s, `${slots.expects.length} 个期望结果都有逐字来源，文字出自替换后引文且判断的步骤合式`, { replacements: slots.replacements })];
}
