import {labelOf} from './generated/vocabulary.ts';
import {planCommands} from './plan-commands.ts';
import { typedAuthorityGaps, authorityRecovery, typedAddressUses } from './typed-authority.ts';
// Verify authored plans against original runner identities, runtime profile, manifest, and frozen lineage addresses.
import { quoteMatches } from './quote.ts';
import { encodeG, GSyntaxError } from './g-syntax.ts';
import { gOptions } from './generate.ts';
import { isRecord, markers, type Outcome } from './text.ts';
import { parseRuntimeContract, runtimeMethod, type RuntimeContract } from './runtime-contract.ts';
import { parseProfile, allowedCall, type RuntimeProfile } from './profile.ts';
import { parseManifest, addressKey, type ManifestBed } from './manifest.ts';
import { inBlindSegment, readAddress, triggerTypesOf, type LeaseRow } from './bed.ts';
import { readSlots, type PlanSlots } from './slots.ts';
import { bindArguments, hasShellDynamicSyntax, hasBalancedCommandText, hasSingleLineValue } from './binding.ts';
import {identityOf} from './typed-contract.ts';
import { replacedQuote } from './addresses.ts';
import { citedCriterion, type FrozenItemCriterion } from './subject.ts';
interface CheckSubject {expected_nodes?:unknown; command_catalog?:unknown;command_identities?:unknown; item: string; location: string | null; data: unknown; contract: RuntimeContract | null; profile: RuntimeProfile | null; beds: ManifestBed[]; leases: LeaseRow[]; now: string; case_texts: string[]; criteria: FrozenItemCriterion[]; problems: Array<{ capacityExceeded?:boolean; document: string; pointer: string; message: string }> }
function subjectOf(input: unknown): CheckSubject {
  const raw = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const contract = parseRuntimeContract(raw.contract); const manifest = parseManifest(raw.manifest);
  const profile = contract.ok && manifest.ok ? parseProfile(raw.profile, contract.contract, manifest.beds) : null;
  const problems = [...(!contract.ok ? contract.problems.map((v) => ({ document: 'contract', pointer: v.pointer, message: v.message })) : []), ...(!manifest.ok ? manifest.problems.map((v) => ({ document: 'inventory', pointer: v.pointer, message: v.message })) : []), ...(profile && !profile.ok ? profile.problems.map((v) => ({ document: 'profile', pointer: v.pointer, message: v.message,...(v.capacityExceeded?{capacityExceeded:true}:{}) })) : [])];
  return { expected_nodes:raw.expected_nodes,command_catalog:raw.command_catalog,command_identities:raw.command_identities,problems, criteria: Array.isArray(raw.criteria) ? raw.criteria as FrozenItemCriterion[] : [], case_texts: Array.isArray(raw.case_texts) ? raw.case_texts.filter((v): v is string => typeof v === 'string') : [], item: typeof raw.item === 'string' ? raw.item : '', location: typeof raw.location === 'string' ? raw.location : null, data: raw.data, contract: contract.ok ? contract.contract : null, profile: profile?.ok ? profile.profile : null, beds: manifest.ok ? manifest.beds : [], leases: Array.isArray(raw.leases) ? raw.leases as LeaseRow[] : [], now: typeof raw.now === 'string' ? raw.now : new Date(0).toISOString() };
}
const TIER = 'blocking' as const;
function support(s: CheckSubject, statement: string, data?: Record<string, unknown>): Outcome { return { verdict: 'support', statement: statement + markers(s.profile?.synthetic === true, s.contract ?? undefined), grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, ...(data ? { data } : {}) }; }
function refute(s: CheckSubject, code: string, statement: string, pointer: string, data?:Record<string,unknown>): Outcome { return { verdict: 'refute', code: `case-compile.${code}`, statement: statement + markers(s.profile?.synthetic === true, s.contract ?? undefined), grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, pointer, ...(data?{data}: {}) }; }
function prerequisites(s: CheckSubject): Outcome[] | null {
  if (s.problems.some(problem=>problem.capacityExceeded))return s.problems.filter(problem=>problem.capacityExceeded).map(problem=>refute(s,'bed_unknown',problem.message,'/profile'+problem.pointer));
  if (s.contract && s.profile) return null;
  const details = s.problems.map((v) => `${v.document}${v.pointer}：${v.message}`);
  const statement = `这一条在等某一步：冻结输入无法重算，缺少可核验的 ${[...new Set(s.problems.map((v) => v.document))].join('、')}；等管理员按这些文档和指针修复并重新绑定后，开始新运行重算。${details.slice(0, 5).join('；')}；在等的那一步完成之前不证明在真实设备上跑得通。`;
  return [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (statement), reason: 'missing_input', statement, grounds: [], tier: TIER, item: s.item, data: { problems: s.problems, waiting_for: { step: '管理员按这些文档和指针修复并重新绑定，开始新运行', documents: [...new Set(s.problems.map((v) => v.document))] } } }];
}
function slotsOf(s: CheckSubject): { slots: PlanSlots; errors: null } | { slots: null; errors: Outcome[] } {
  const read = readSlots(s.data);
  return read.ok ? { slots: read.slots, errors: null } : { slots: null, errors: read.problems.map((v) => refute(s, v.pointer.includes('/quote') ? 'expect_without_source' : 'slots_invalid', `槽位 ${v.pointer}：${v.message}；按 slots.schema.json 的形状修正`, `/data${v.pointer}`)) };
}
function typedPrerequisites(s: CheckSubject, slots: PlanSlots): Outcome[] | null {
  // Model identity proposals belong to commands_known, not shared contract prerequisites.
  const {command_identities:_modelDeclaration,...plan}=slots;
  const gaps = typedAuthorityGaps(s.contract!, s.profile!, plan,s.command_identities,s.command_catalog,s.case_texts);
  if (!gaps.length) return null;
  const missing = authorityRecovery(gaps);
  if(gaps.some(g=>g.verdict==='refute'))return [refute(s,'method_forbidden',missing,'/data',{problems:gaps,obligations:gaps.flatMap(gap=>gap.obligation?[gap.obligation]:[])})];
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
      if (role === 'host_shell' && hasShellDynamicSyntax(String(v.value))) out.push(refute(s, 'host_shell_dynamic', '主机命令含有扩展、分隔或重定向语法，不符合声明的静态 POSIX 子集语法；改为单一的显式命令', v.pointer));
    }
    if(out.length===beforeStep)try { encodeG(step,gOptions(step.object,step.method,s.contract!,s.profile!)); } catch(error) { if(error instanceof GSyntaxError)out.push(refute(s,'param_value',`G 写法 ${error.rule}：${error.message}；修正该步骤后自动重核`,at+'/G')); else throw error; }
  }
  return out.length ? out : [support(s, `${read.slots.steps.length} 步调用符合启用合约，参数角色、签名和值规则均已核对`, { runtime_version: s.contract!.runtimeVersion, contract_sha256: s.contract!.pinned.identity })];
}
export function checkAddresses(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const unverified = typedPrerequisites(s, read.slots); if (unverified) return unverified;
  const slots = read.slots; const bed = s.beds.find((v) => v.name === slots.bucket);
  const triggerTypes = triggerTypesOf(s.profile!.trigger_types);
  if (!bed || bed.name !== s.profile!.bed) return [refute(s, 'bed_unknown', 'bucket 必须是运行环境配置选定的清单台架', '/data/bucket')];
  const out:Outcome[]=[];
  const uses=typedAddressUses(s.contract!,s.profile!,slots,s.command_catalog);
  const sourceIdentities=Array.isArray(s.command_identities)?s.command_identities:[];
  const sourceValues=new Set(sourceIdentities.flatMap(raw=>{const i=identityOf(raw);return i?i.parameters.flatMap(p=>p.parsed.kind==='address'&&(p.parsed.value.kind==='ipv4'||p.parsed.value.kind==='ipv6')?[addressKey(p.parsed.value.value)]:[]):[];}));
  const from=new Set<string>(),to=new Set<string>();
  for(const [i,replacement]of slots.replacements.entries()){
    const source=addressKey(replacement.case),target=addressKey(replacement.bed),at='/data/replacements/'+i;
    if(!source||!target||from.has(source)||to.has(target)||source.split(':')[0]!==target.split(':')[0])out.push(refute(s,'replacement_invalid','替换必须是同一声明地址族的一一对应数值映射',at));
    if(source&&!sourceValues.has(source))return [{verdict:'unknown',reason:'missing_input',missing:'替换来源的冻结类型化参数身份；下一步由用例生产器补 data.command_identities 并重开运行',statement:'不能把原文中外形像地址的文字作为替换依据；缺冻结类型化参数身份，下一步补源声明后重跑',grounds:[],tier:TIER,item:s.item}];
    if(source&&target&&source!==target&&slots.replacements.some((other,j)=>j!==i&&addressKey(other.case)===target))out.push(refute(s,'replacement_invalid','替换映射不能形成链或环',at));
    if(source)from.add(source);if(target)to.add(target);
    if(readAddress(bed,s.leases,s.now,replacement.bed).kind==='off_bed')out.push(refute(s,'address_off_bed','环境不可达，整卷不跑。该地址不在任何设备接口所在网段，也不是本血缘租约地址。下一步：换用有触发设备的网段里的接口地址，或先取得本血缘租约后再编译',at));
    else if(inBlindSegment(bed,replacement.bed,triggerTypes))out.push(refute(s,'environment_unreachable','环境不可达，整卷不跑。该地址落在没有触发设备的盲网段。下一步：把计划地址改到有触发设备的网段，或在该网段补一台触发设备后重新冻结清单再编译',at));
  }
  for(const use of uses){
    if(use.kind!=='ipv4'&&use.kind!=='ipv6')continue;
    if(typeof use.bed_member!=='boolean')return [{verdict:'unknown',reason:'missing_input',missing:'地址参数的合约闭集角色及 bed_member 用途；下一步合约发布管理员补字段并重新绑定',statement:'地址用途未声明，当前阻止派发；下一步由合约发布管理员补角色用途后重开运行',grounds:[],tier:TIER,item:s.item}];
    if(!use.bed_member)continue;
    const value=String(use.value);if(slots.replacements.some(r=>addressKey(r.case)===addressKey(value)&&addressKey(r.case)!==addressKey(r.bed)))out.push(refute(s,'replacement_missing','声明地址位置仍保留替换前的值',use.pointer));
    if(readAddress(bed,s.leases,s.now,value).kind==='off_bed')out.push(refute(s,'address_off_bed','环境不可达，整卷不跑。该地址不在任何设备接口所在网段，也不是本血缘租约地址。下一步：换用有触发设备的网段里的接口地址，或先取得本血缘租约后再编译',use.pointer));
    else if(inBlindSegment(bed,value,triggerTypes))out.push(refute(s,'environment_unreachable','环境不可达，整卷不跑。该地址落在没有触发设备的盲网段。下一步：把计划地址改到有触发设备的网段，或在该网段补一台触发设备后重新冻结清单再编译',use.pointer));
  }
  return out.length?out:[support(s,uses.length+' 个声明地址/掩码/前缀位置已按类型、用途和冻结范围核对；普通文字不扫描',{typed_positions:uses,replacements:slots.replacements})];
}
export function checkExpectedSources(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const unverified = typedPrerequisites(s, read.slots); if (unverified) return unverified;
  const slots = read.slots; const out: Outcome[] = [];
  if (!slots.expects.length) return [refute(s, 'expect_without_source', '至少一条期望结果必须带逐字来源并指明它判断的步骤', '/data/expects')];
  const byCriterion: Array<{ at: number; criterion: FrozenItemCriterion }> = [];
  for (const [i, expect] of slots.expects.entries()) {
    const pointer = `/data/expects/${i}`;
    if (!hasSingleLineValue(expect.text)) out.push(refute(s, 'expect_value', '断言必须是单行、无首尾空白、无等号前缀、无占位符，并符合发布配置的取值规则', `${pointer}/text`));
    // W10 step two: an expectation may be taken from a criterion declaration the Hub froze into this run after an account
    // other than the author accepted it. Such an expectation cites the declaration by its exact rec: reference, and both
    // the quoted criterion and the expectation are compared with the frozen bytes, never with the plan's own copy.
    if(expect.basis==='model_judgment'){
      if(!Array.isArray(s.expected_nodes)||s.expected_nodes.some(node=>!isRecord(node)||typeof node.reference!=='string'||typeof node.text!=='string'))return [{verdict:'unknown',reason:'missing_input',missing:'缺被判对象本用例期望节点的冻结原文与引用身份；下一步：用完整脑图原件开新运行，不用其他用例、标题或步骤代替',statement:'模型判断的原始期望节点尚未绑定；补齐原件后重核',grounds:[],tier:TIER,item:s.item}];
      if(!s.expected_nodes.some(node=>isRecord(node)&&node.reference===expect.quote.reference&&typeof node.text==='string'&&quoteMatches(node.text,expect.quote.text)))out.push(refute(s,'expect_not_in_quote','模型判断的 quote 必须逐字引用被判对象中本用例的期望节点，不能引用标题、步骤、其他用例或判据声明',`${pointer}/quote`));
    }else {
    const criterion = citedCriterion(s.criteria, expect.quote.reference);
    if (criterion !== null) {
      if (expect.quote.text !== criterion.new) out.push(refute(s, 'expect_not_in_criterion', `引用的判据文字与冻结的已受理声明 ${criterion.declaration} 不符；照开始运行答复里的新判据逐字抄写，或改回原引文`, `${pointer}/quote/text`));
      else if (!quoteMatches(criterion.new, expect.text)) out.push(refute(s, 'expect_not_in_criterion', `期望必须是新判据（声明 ${criterion.declaration}）的逐字片段；不改写、不拼接、不加占位符`, `${pointer}/text`));
      else byCriterion.push({ at: i, criterion });
    } else if (expect.quote.reference.startsWith('rec:')) {
      // The plan cites a record — a criterion declaration — that the Hub did not freeze into this run, so there are no
      // frozen bytes to compare with. The scheme of a declared reference decides this, never a word in any text.
      out.push(refute(s, 'expect_not_in_criterion', `期望引用记录 ${expect.quote.reference}，但本次运行没有冻结这条已受理判据声明；缺的事实：本运行冻结的声明；下一步：由作者以外的账号复核接受该声明后以本运行为前驱开新修订，或改回逐字出自期望来源的引文`, `${pointer}/quote/reference`));
    } else if (!quoteMatches(replacedQuote(expect.quote.text, slots.replacements), expect.text)) {
      out.push(refute(s, 'expect_not_in_quote', '期望必须逐字来自原引文；普通断言文字不做地址扫描或隐式替换，请保留原文或先补结构化断言合约', `${pointer}/text`));
    }
    }
    const step = slots.steps[expect.after - 1]; const allowed = step ? allowedCall(s.profile!, step.object, step.method) : null;
    if (!allowed || !Object.values(allowed.parameters).some((role) => role === 'device_cli' || role === 'host_shell')) out.push(refute(s, 'expect_after', 'after 必须指向设备命令行或主机 shell 步骤，不能指向等待或断言步骤', `${pointer}/after`));
  }
  if (out.length) return out;
  const accepted = [...new Map(byCriterion.map((row) => [row.criterion.declaration, { declaration: row.criterion.declaration, review: row.criterion.review, reviewer: row.criterion.reviewer, expects: byCriterion.filter((other) => other.criterion.declaration === row.criterion.declaration).map((row) => row.at) }])).values()];
  const told = accepted.length === 0
    ? `${slots.expects.length} 个期望结果都有逐字来源，文字出自替换后引文且判断的步骤合式`
    : `${slots.expects.length} 个期望结果都有逐字来源：${slots.expects.length - byCriterion.length} 条出自替换后引文，${byCriterion.length} 条逐字取自冻结的已受理判据声明（${accepted.map((row) => `声明 ${row.declaration}，复核 ${row.review}，复核人 ${row.reviewer}，期望 ${row.expects.map((at) => at + 1).join('/')} 条`).join('；')}）；新判据的引文在本次运行边界上另行逐字核对`;
  const judgments=slots.expects.flatMap((expect,index)=>expect.basis==='model_judgment'?[{index,...expect}]:[]);
  if(judgments.length){const result=support(s,`${judgments.length} 条模型主张的来源引文、步骤与取值规则已核验：${labelOf('expectation_basis','model_judgment')}，${labelOf('qualifier_mark','conditional_on_judgment')}；Hub 不判断所选文字是否正确`,{model_expectations:judgments,replacements:slots.replacements,...(accepted.length?{accepted_criteria:accepted}:{})});result.grounds=[...new Set([...result.grounds,...judgments.map(expect=>expect.quote.reference)])];result.judgment_sources=judgments.map(expect=>`/plan/0/data/expects/${expect.index}`);return [result];}
  return [support(s, told, { replacements: slots.replacements, ...(accepted.length ? { accepted_criteria: accepted } : {}) })];
}

/** commands_known resolves whole plan commands against the locked grammar, then checks typed authority. */
export function checkCommandsKnown(input:unknown):Outcome[]{
 const s=subjectOf(input),missing=prerequisites(s);if(missing)return missing;const read=slotsOf(s);if(read.errors)return read.errors;
 const gaps=typedPrerequisites(s,read.slots);if(gaps)return gaps;const resolved=s.contract&&s.profile?planCommands(s.contract,s.profile,read.slots,s.command_catalog):null;const declarations=resolved?.problems.filter(problem=>problem.pointer==='/command_identities')??[];if(declarations.length)return declarations.map(problem=>refute(s,'slots_invalid',problem.message+'；删除可选 command_identities，由 Hub 从 steps 解析；或按 Hub 回执修正声明','/data/command_identities'));return [support(s,'所有设备命令均由锁定目录完整解析，已核用例声明（如有）、类型与效果授权',{command_identities:resolved?.identities??[],command_catalog:resolved?.catalog})];
}
