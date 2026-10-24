import { typedAuthorityGaps, authorityRecovery } from './typed-authority.ts';
// Verify authored plans against original runner identities, runtime profile, manifest, and frozen lineage addresses.
import { quoteMatches } from './quote.ts';
import { encodeG, GSyntaxError } from './g-syntax.ts';
import { gOptions } from './generate.ts';
import { isRecord, markers, type Outcome } from './text.ts';
import { parseRuntimeContract, runtimeMethod, type RuntimeContract } from './runtime-contract.ts';
import { parseProfile, allowedCall, type RuntimeProfile } from './profile.ts';
import { parseManifest, addressKey, type ManifestBed } from './manifest.ts';
import { readAddress, type LeaseRow } from './bed.ts';
import { readSlots, type PlanSlots } from './slots.ts';
import { bindArguments, hasShellDynamicSyntax, hasBalancedCommandText, hasSingleLineValue } from './binding.ts';
import { literalAddresses, replacedQuote, deniedCommand, isHostLiteral, hasNoncanonicalDottedQuad, hasAmbiguousIpv4 } from './addresses.ts';
interface CheckSubject { item: string; location: string | null; data: unknown; contract: RuntimeContract | null; profile: RuntimeProfile | null; beds: ManifestBed[]; leases: LeaseRow[]; now: string; case_texts: string[]; problems: Array<{ document: string; pointer: string; message: string }> }
function subjectOf(input: unknown): CheckSubject {
  const raw = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const contract = parseRuntimeContract(raw.contract); const manifest = parseManifest(raw.manifest);
  const profile = contract.ok && manifest.ok ? parseProfile(raw.profile, contract.contract, manifest.beds) : null;
  const problems = [...(!contract.ok ? contract.problems.map((v) => ({ document: 'contract', pointer: v.pointer, message: v.message })) : []), ...(!manifest.ok ? manifest.problems.map((v) => ({ document: 'inventory', pointer: v.pointer, message: v.message })) : []), ...(profile && !profile.ok ? profile.problems.map((v) => ({ document: 'profile', pointer: v.pointer, message: v.message })) : [])];
  return { problems, case_texts: Array.isArray(raw.case_texts) ? raw.case_texts.filter((v): v is string => typeof v === 'string') : [], item: typeof raw.item === 'string' ? raw.item : '', location: typeof raw.location === 'string' ? raw.location : null, data: raw.data, contract: contract.ok ? contract.contract : null, profile: profile?.ok ? profile.profile : null, beds: manifest.ok ? manifest.beds : [], leases: Array.isArray(raw.leases) ? raw.leases as LeaseRow[] : [], now: typeof raw.now === 'string' ? raw.now : new Date(0).toISOString() };
}
const TIER = 'blocking' as const;
function support(s: CheckSubject, statement: string, data?: Record<string, unknown>): Outcome { return { verdict: 'support', statement: statement + markers(s.profile?.synthetic === true, s.contract ?? undefined), grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, ...(data ? { data } : {}) }; }
function refute(s: CheckSubject, code: string, statement: string, pointer: string, data?:Record<string,unknown>): Outcome { return { verdict: 'refute', code: `case-compile.${code}`, statement: statement + markers(s.profile?.synthetic === true, s.contract ?? undefined), grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, pointer, ...(data?{data}: {}) }; }
function prerequisites(s: CheckSubject): Outcome[] | null {
  if (s.contract && s.profile) return null;
  const details = s.problems.map((v) => `${v.document}${v.pointer}：${v.message}`);
  return [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`冻结输入无法重算；缺少可核验的 ${[...new Set(s.problems.map((v) => v.document))].join('、')}。下一步由客户端请求管理员按这些文档和指针修复并重新绑定，开始新运行。${details.slice(0, 5).join('；')}；不证明在真实设备上跑得通。`), reason: 'check_error', statement: `冻结输入无法重算；缺少可核验的 ${[...new Set(s.problems.map((v) => v.document))].join('、')}。下一步由客户端请求管理员按这些文档和指针修复并重新绑定，开始新运行。${details.slice(0, 5).join('；')}；不证明在真实设备上跑得通。`, grounds: [], tier: TIER, item: s.item, data: { problems: s.problems } }];
}
function slotsOf(s: CheckSubject): { slots: PlanSlots; errors: null } | { slots: null; errors: Outcome[] } {
  const read = readSlots(s.data);
  return read.ok ? { slots: read.slots, errors: null } : { slots: null, errors: read.problems.map((v) => refute(s, v.pointer.includes('/quote') ? 'expect_without_source' : 'slots_invalid', `槽位 ${v.pointer}：${v.message}；按 slots.schema.json 的形状修正`, `/data${v.pointer}`)) };
}
function typedPrerequisites(s: CheckSubject, slots: PlanSlots): Outcome[] | null {
  const gaps = typedAuthorityGaps(s.contract!, s.profile!, slots);
  if (!gaps.length) return null;
  const missing = authorityRecovery(gaps);
  return [{ verdict: 'unknown', reason: 'missing_input', missing, statement: missing, grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, data: { problems: gaps } }];
}
export function checkContractShape(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const unverified = typedPrerequisites(s, read.slots); if (unverified) return unverified;
  const out: Outcome[] = [];
  for (const [i, step] of read.slots.steps.entries()) {
    const at = `/data/steps/${i}`; const beforeStep=out.length;
    const method = runtimeMethod(s.contract!, step.object, step.method);
    if (!method) { out.push(refute(s, 'method_forbidden', `第 ${i + 1} 步不是合约启用的组合`, at)); continue; }
    const allowed=allowedCall(s.profile!,step.object,step.method);if(!allowed){out.push(refute(s,'method_not_allowed','该启用组合当前未开；换用配置已开放的组合。扩展角色须由集成者另写一页、重新发布后新开运行',at,{unassigned_parameters:method.parameters.map(p=>p.name)}));continue;}
    if (Object.values(allowed.parameters).some((role) => role === 'literal_assertion')) { out.push(refute(s, 'assertion_in_steps', '断言写进 expects，带引文和 after', at)); continue; }
    const bound = bindArguments(method, step, at);
    for (const v of bound.problems) out.push(refute(s, v.code, `第 ${i + 1} 步：${v.message}`, v.pointer));
    for (const v of bound.values) {
      if (method.parameters.some((param) => param.name === v.name && param.redacted)) continue;
      const role = allowed.parameters[v.name];
      if (!Object.hasOwn(allowed.parameters, v.name)) { out.push(refute(s, 'param_unassigned', `参数 ${v.name} 在已开放组合中没有角色；去掉该参数或换用配置已开放的组合。集成者补角色后重新发布、新开运行`, v.pointer)); continue; }
      if ((role === 'device_cli' || role === 'host_shell') && typeof v.value !== 'string') { out.push(refute(s, 'param_value', '命令角色必须是单行文字', v.pointer)); continue; }
      if (role === 'wait' && (v.pointer.includes('/keywords/') && Object.values(allowed.parameters).every((role) => role === 'wait') || !/^[0-9]+$/.test(String(v.value)) || !Number.isSafeInteger(Number(v.value)) || Number(v.value) < 1 || s.profile!.max_wait_seconds === null || Number(v.value) > s.profile!.max_wait_seconds)) out.push(refute(s, 'wait_value', '等待值必须是配置上限内的正整数 ASCII 秒数；改为明确时长', v.pointer));
      if ((role === 'device_cli' || role === 'host_shell') && !hasBalancedCommandText(String(v.value)) && !bound.problems.some((problem) => problem.code === 'param_value' && problem.pointer === v.pointer)) out.push(refute(s, 'param_value', '声明为命令的值须符合原文 POSIX 子集：引号成对且不能以反斜杠结尾；不正规化字形', v.pointer));
      if (role === 'device_cli' && deniedCommand(String(v.value), s.profile!.denied.device)) out.push(refute(s, 'device_command_denied', `第 ${i + 1} 步命中发布配置的设备命令拒绝表`, v.pointer));
      if (role === 'host_shell' && hasShellDynamicSyntax(String(v.value))) out.push(refute(s, 'host_shell_dynamic', '主机命令含有扩展、分隔或重定向语法，无法按文字拒绝表完整核对；改为单一的显式命令', v.pointer));
      if (role === 'host_shell' && deniedCommand(String(v.value), s.profile!.denied.host)) out.push(refute(s, 'host_command_denied', `第 ${i + 1} 步命中发布配置的主机命令拒绝表`, v.pointer));
    }
    if(out.length===beforeStep)try { encodeG(step,gOptions(step.object,step.method,s.contract!,s.profile!)); } catch(error) { if(error instanceof GSyntaxError)out.push(refute(s,'param_value',`G 写法 ${error.rule}：${error.message}；修正该步骤后自动重核`,at+'/G')); else throw error; }
  }
  return out.length ? out : [support(s, `${read.slots.steps.length} 步调用符合启用合约，参数角色、签名和值规则均已核对`, { runtime_version: s.contract!.runtimeVersion, contract_sha256: s.contract!.digest })];
}
export function checkAddresses(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const unverified = typedPrerequisites(s, read.slots); if (unverified) return unverified;
  const slots = read.slots; const bed = s.beds.find((v) => v.name === slots.bucket);
  if (!bed || bed.name !== s.profile!.bed) return [refute(s, 'bed_unknown', 'bucket 必须是运行环境配置选定的清单台架', '/data/bucket')];
  const out: Outcome[] = []; let count = 0;
  const sourceAddresses = new Set([...s.case_texts, ...slots.expects.map((v) => v.quote.text)].flatMap((text) => literalAddresses(text).map((v) => v.key).filter((key): key is string => key !== null)));
  const from = new Set<string>(); const to = new Set<string>();
  for (const [i, replacement] of slots.replacements.entries()) {
    const source = addressKey(replacement.case); const target = addressKey(replacement.bed);
    if (!source || !target || from.has(source) || to.has(target)) out.push(refute(s, 'replacement_invalid', '替换表必须是一一对应的字面地址映射，按地址数值比较', `/data/replacements/${i}`));
    if (source && !sourceAddresses.has(source)) out.push(refute(s, 'replacement_invalid', '替换源没有出现在原用例文字或期望引文中，不能披露为已核验映射', `/data/replacements/${i}/case`));
    if (source && target && source !== target && slots.replacements.some((other, j) => j !== i && addressKey(other.case) === target)) out.push(refute(s, 'replacement_invalid', '替换表不能形成链或环；目标不能成为另一条替换源', `/data/replacements/${i}`));
    if (source) from.add(source); if (target) to.add(target);
    if (readAddress(bed, s.leases, s.now, replacement.bed).kind === 'off_bed') out.push(refute(s, 'address_off_bed', '替换后的地址不在本台架或本血缘分配集合里', `/data/replacements/${i}/bed`));
  }
  const examine = (value: string, pointer: string, device: string | null, role?: string): void => {
    if (hasNoncanonicalDottedQuad(value) || role === 'host_shell' && hasAmbiguousIpv4(value)) out.push(refute(s, 'address_notation', '命令含非标准或有歧义的 IPv4 数字记法；地址写规范四段点分，非地址选项改用更小单位的整数或明确等待步骤', pointer));
    for (const address of literalAddresses(value)) {
      if (!isHostLiteral(address, value, bed)) continue;
      count++;
      if (slots.replacements.some((v) => addressKey(v.case) === address.key && addressKey(v.bed) !== address.key)) { out.push(refute(s, 'replacement_missing', '步骤或期望文字仍有原用例地址；按 replacements 改成最终文字，Hub 不改写步骤', pointer)); continue; }
      const found = readAddress(bed, s.leases, s.now, address.text);
      if (found.kind === 'off_bed') { out.push(refute(s, 'address_off_bed', `字面地址 ${address.text} 不在本台架或本血缘分配集合里`, pointer)); continue; }

      // Decision 35 permits every interface of this bed, including other devices, plus lineage allocations.
    }
  };
  for (const [i, step] of slots.steps.entries()) {
    const method = runtimeMethod(s.contract!, step.object, step.method); const allowed = allowedCall(s.profile!, step.object, step.method) ?? { object: step.object, method: step.method, parameters: Object.create(null) as Record<string, string> };
    if(method&&!allowedCall(s.profile!,step.object,step.method))out.push(refute(s,'method_not_allowed','该启用组合当前未开；换用配置已开放的组合',`/data/steps/${i}`,{unassigned_parameters:method.parameters.map(p=>p.name)}));
    const bound = method ? bindArguments(method, step, `/data/steps/${i}`).values : [];
    for (const v of bound) if (allowedCall(s.profile!,step.object,step.method) && !Object.hasOwn(allowed.parameters, v.name) && !method?.parameters.some((p) => p.name === v.name && p.redacted)) out.push(refute(s, 'param_unassigned', `参数 ${v.name} 没有角色，地址用途无法核对；去掉该参数或换用配置已开放的组合，集成者补角色后才能新开运行`, v.pointer));
    const seat = s.profile!.seats.find((v) => v.object === step.object);
    const values = [...step.args.map((value, k) => ({ value, pointer: `/data/steps/${i}/args/${k}` })), ...Object.entries(step.keywords).map(([name, value]) => ({ value, pointer: `/data/steps/${i}/keywords/${name.replaceAll('~', '~0').replaceAll('/', '~1')}` }))];
    for (const v of values) {
      const parameter = bound.find((b) => b.pointer === v.pointer);
      examine(String(v.value), v.pointer, parameter && allowed?.parameters[parameter.name] === 'device_cli' ? seat?.device ?? null : null, parameter ? allowed?.parameters[parameter.name] : undefined);
    }
  }
  slots.expects.forEach((v, i) => examine(v.text, `/data/expects/${i}/text`, null));
  return out.length ? out : [support(s, `${count} 个字面地址都对得上台架 ${bed.name}；替换表 ${slots.replacements.length} 项已按最终文字核对`, { replacements: slots.replacements })];
}
export function checkExpectedSources(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const unverified = typedPrerequisites(s, read.slots); if (unverified) return unverified;
  const slots = read.slots; const out: Outcome[] = [];
  if (!slots.expects.length) return [refute(s, 'expect_without_source', '至少一条期望结果必须带逐字来源并指明它判断的步骤', '/data/expects')];
  for (const [i, expect] of slots.expects.entries()) {
    const pointer = `/data/expects/${i}`;
    if (!hasSingleLineValue(expect.text)) out.push(refute(s, 'expect_value', '断言必须是单行、无首尾空白、无等号前缀、无占位符的有效原文；从引文选择可写片段', `${pointer}/text`));
    if (!quoteMatches(replacedQuote(expect.quote.text, slots.replacements), expect.text)) out.push(refute(s, 'expect_not_in_quote', '期望文字不符合地址替换后引文的逐字规则（只忽略引文规则允许的空白差异）；从替换后引文选择片段并自动重核', `${pointer}/text`));
    const step = slots.steps[expect.after - 1]; const allowed = step ? allowedCall(s.profile!, step.object, step.method) : null;
    if (!allowed || !Object.values(allowed.parameters).some((role) => role === 'device_cli' || role === 'host_shell')) out.push(refute(s, 'expect_after', 'after 必须指向设备命令行或主机 shell 步骤，不能指向等待或断言步骤', `${pointer}/after`));
  }
  return out.length ? out : [support(s, `${slots.expects.length} 个期望结果都有逐字来源，文字出自替换后引文且判断的步骤合式`, { replacements: slots.replacements })];
}
