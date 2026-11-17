import {recompositionGaps} from './recomposition.ts';
import {checkBlockExpected} from './block-expected.ts';
import BLOCK_TABLE from '../tables/blocks-format.json' with {type:'json'};
import {configuredExpectedSources} from './flat-expected.ts';
import {blockMeta,blockPointer,withoutModelIdentities} from './blocks.ts';
import {cellInput,cellSyntax} from './cell-selection.ts';
import {labelOf} from './generated/vocabulary.ts';
import {planCommands,deviceCommandLines} from './plan-commands.ts';
import {lineProfile,planProblems,planConflictText,PLAN_CONFLICT_FIX} from './channels.ts';
import { typedAuthorityGaps, authorityRecovery, typedAddressUses } from './typed-authority.ts';
import { authoredAddresses, type RunnerCovered } from './command-obligations.ts';
// Verify authored plans against original runner identities, runtime profile, manifest, and frozen lineage addresses.
import { quoteMatches } from './quote.ts';
import { encodeG, GSyntaxError } from './generated/skills/runner-workbook/workbook-writer/g-syntax.ts';
import { gOptions } from './generate.ts';
import { isRecord, markers, type Outcome, opened } from './text.ts';
import { parseRuntimeContract, runtimeMethod, type RuntimeContract } from './runtime-contract.ts';
import { parseProfile, allowedCall, type RuntimeProfile } from './profile.ts';
import { parseManifest, addressKey, type ManifestBed } from './manifest.ts';
import { hostReaches, inBlindSegment, interfacesOf, readAddress, triggerTypesOf, type LeaseRow } from './bed.ts';
import { readSlots, type PlanSlots } from './slots.ts';
import { bindArguments, hasShellDynamicSyntax, hasBalancedCommandText, hasSingleLineValue, hostProgramLine } from './binding.ts';
import {identityOf} from './typed-contract.ts';
import { replacedQuote } from './addresses.ts';
import { citedCriterion, type FrozenItemCriterion } from './subject.ts';
import { authorStepCoverage, fidelityBrief, fidelityProblems, uncoveredAuthorStepText, type FidelityBrief } from './fidelity.ts';
interface CheckSubject {projection_unknowns?:string[];recomposition_requested?:boolean;recomposition?:any;recomposition_problem?:string;bed_services?:unknown;manifest_sha256?:string;criteria_review?:unknown;expected_nodes?:unknown; command_catalog?:unknown;command_identities?:unknown; item: string; location: string | null; data: unknown; contract: RuntimeContract | null; profile: RuntimeProfile | null; beds: ManifestBed[]; leases: LeaseRow[]; now: string; case_texts: string[]; criteria: FrozenItemCriterion[]; problems: Array<{ capacityExceeded?:boolean; document: string; pointer: string; message: string }> }
function subjectOf(input: unknown): CheckSubject {
  const raw = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const contract = parseRuntimeContract(raw.contract); const manifest = parseManifest(raw.manifest);
  const profile = contract.ok && manifest.ok ? parseProfile(raw.profile, contract.contract, manifest.beds) : null;
  const problems = [...(!contract.ok ? contract.problems.map((v) => ({ document: 'contract', pointer: v.pointer, message: v.message })) : []), ...(!manifest.ok ? manifest.problems.map((v) => ({ document: 'inventory', pointer: v.pointer, message: v.message })) : []), ...(profile && !profile.ok ? profile.problems.map((v) => ({ document: 'profile', pointer: v.pointer, message: v.message,...(v.capacityExceeded?{capacityExceeded:true}:{}) })) : [])];
  return {projection_unknowns:raw.projection_unknowns as string[],recomposition_requested:raw.recomposition_requested===true,recomposition:raw.recomposition,recomposition_problem:typeof raw.recomposition_problem==='string'?raw.recomposition_problem:undefined,bed_services:raw.bed_services,manifest_sha256:typeof raw.manifest_sha256==='string'?raw.manifest_sha256:undefined,criteria_review:raw.criteria_review, expected_nodes:raw.expected_nodes,command_catalog:opened(raw.command_catalog),command_identities:raw.command_identities,problems, criteria: Array.isArray(raw.criteria) ? raw.criteria as FrozenItemCriterion[] : [], case_texts: Array.isArray(raw.case_texts) ? raw.case_texts.filter((v): v is string => typeof v === 'string') : [], item: typeof raw.item === 'string' ? raw.item : '', location: typeof raw.location === 'string' ? raw.location : null, data: raw.data, contract: contract.ok ? contract.contract : null, profile: profile?.ok ? profile.profile : null, beds: manifest.ok ? manifest.beds : [], leases: Array.isArray(raw.leases) ? raw.leases as LeaseRow[] : [], now: typeof raw.now === 'string' ? raw.now : new Date(0).toISOString() };
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
  return read.ok ? { slots: read.slots, errors: null } : { slots: null, errors: read.problems.map((v) => refute(s, v.pointer.includes('/quote') ? 'expect_without_source' : 'slots_invalid', `槽位 ${v.pointer}：${v.message}；${v.fix??'按 slots.schema.json 的形状修正'}`, `/data${v.pointer}`)) };
}
function typedPrerequisites(s: CheckSubject, slots: PlanSlots, covered?: RunnerCovered[]): Outcome[] | null {
  const recomposition=recompositionGaps(slots,s.recomposition,{item:s.item});
  const gaps0=[...(s.projection_unknowns??[]),...(s.recomposition_requested&&!s.recomposition?[s.recomposition_problem?`重组记录不可受理：${s.recomposition_problem}；改正绑定后开新的计划运行`:'缺可受理的重组记录：绑定的重组运行与结果没有通过核对；recomposition_run 绑重组运行记录，recomposition_result 绑重组运行号，开新的计划运行']:[]),...recomposition.filter(i=>i.verdict==='unknown').map(i=>i.message)];
  const invalidRecomposition=recomposition.filter(i=>i.verdict==='refute');
  if(invalidRecomposition.length)return [refute(s,'slots_invalid',invalidRecomposition.map(i=>i.message).join('；'),'/data/recomposition')];
  if(gaps0.length)return [{verdict:'unknown',reason:'missing_input',missing:gaps0.join('；'),statement:gaps0.join('；'),grounds:[],tier:'blocking',item:s.item}];
  // Model identity proposals belong to commands_known, not shared contract prerequisites.
  const plan=withoutModelIdentities(slots);
  const localCovered = covered ?? [];
  const gaps = typedAuthorityGaps(s.contract!, s.profile!, plan,s.command_identities,s.command_catalog,s.case_texts,s.manifest_sha256,s.bed_services,localCovered);
  if (!gaps.length) return null;
  const cleanup = s.contract!.cleanup;
  const cleanupText = runnerCleanupText(s.contract!, localCovered);
  const cleanupData = cleanup && localCovered.length ? { runner_cleanup: { source: cleanup.source, sha256: cleanup.sha256, pinned: cleanup.pinned, ...(cleanup.order ? { order: cleanup.order } : {}), covered: localCovered } } : {};
  const refuteGaps = gaps.filter((gap) => gap.verdict === 'refute');
  const unknownGaps = gaps.filter((gap) => gap.verdict !== 'refute');
  // Separate independent block-runtime capability unknowns from downstream command refutes so executor capability
  // omissions are not mislabeled as method_forbidden, while secondary non-block unknowns (e.g. missing inverse rule on
  // an already out-of-scope flat step) stay inside the single refute outcome as expected by author contracts.
  if (refuteGaps.length && !unknownGaps.some((gap) => gap.document === 'blocks')) {
    const first = refuteGaps[0]!;
    const pointer = first.requested !== undefined || blockMeta(slots) && first.pointer.startsWith('/blocks/') ? '/data' + first.pointer : '/data';
    return [refute(s, 'method_forbidden', authorityRecovery(gaps) + cleanupText, pointer, { problems: gaps, obligations: gaps.flatMap((gap) => (gap.obligation ? [gap.obligation] : [])), ...cleanupData })];
  }
  const outcomes: Outcome[] = [];
  if (refuteGaps.length) {
    const first = refuteGaps[0]!;
    const pointer = first.requested !== undefined || blockMeta(slots) && first.pointer.startsWith('/blocks/') ? '/data' + first.pointer : '/data';
    outcomes.push(refute(s, 'method_forbidden', authorityRecovery(refuteGaps) + cleanupText, pointer, { problems: refuteGaps, obligations: refuteGaps.flatMap((gap) => (gap.obligation ? [gap.obligation] : [])), ...cleanupData }));
  }
  if (unknownGaps.length) {
    const missing = authorityRecovery(unknownGaps) + (refuteGaps.length ? '' : cleanupText);
    outcomes.push({ verdict: 'unknown', reason: 'missing_input', missing, statement: missing, grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, data: { problems: unknownGaps, ...cleanupData } });
  }
  return outcomes;
}
/** What the runner's own cleanup discharges (decision 112), with its source, rule and how far its digest is pinned. */
function runnerCleanupText(contract: RuntimeContract, covered: readonly RunnerCovered[]): string {
  const c = contract.cleanup;
  if (!c || covered.length === 0) return '';
  const listed = covered.slice(0, 5).map((row) => `${row.object} 的“${row.line}”（规则 ${row.rule + 1}${row.source_line !== null ? `，${c.source} 第 ${row.source_line} 行` : ''}，前缀“${row.prefix}”${row.clears?.length ? `，触发 ${row.clears.map((cmd) => `“${cmd}”`).join('、')}` : ''}）`).join('、');
  const pinned = c.pinned ? '原合约的源文件摘要表记了同一摘要' : '原合约的源文件摘要表里没有这个文件，摘要只是 Hub 侧声明，跳转机上的字节未核对';
  const tailText = c.order?.tail.length ? `；${c.order.tail.map((t) => `“${t}”`).join('、')} 放在收尾末尾` : '';
  const beforeText = c.order?.before.length ? `；顺序约束：${c.order.before.map(([a, b]) => `“${a}”先于“${b}”`).join('、')}` : '';
  return `；其中 ${covered.length} 条配置命令由运行器自己的清理收尾，不要求逆命令（规则 ${c.source}@${c.sha256.slice(0, 12)}：自第 2 条用例开始前及整本关闭连接时，按清配对象（${c.objects.join('、')}）上 cmd_config 发出的命令行逐条比前缀、第一条命中即用${tailText}${beforeText}；${pinned}）：${listed}${covered.length > 5 ? ` 等 ${covered.length} 条` : ''}`;
}
/** How device commands are authorised (decision 114): by the locked command tree except the declared destructive commands. */
function destructiveText(contract: RuntimeContract): string {
  const d = contract.destructive;
  if (!d) return '';
  const parts = [d.exact.length ? `命令 ${d.exact.join('、')}` : '', d.prefixes.length ? `${d.prefixes.join('、')} 及其下的命令` : '', d.segments.length ? `路径里带 ${d.segments.join('、')} 的命令` : ''].filter(Boolean).join('；');
  return `；设备命令按锁定命令树放行，只拒运行器合约声明的破坏性命令（${d.source}@${d.sha256.slice(0, 12)}，同参考实现的禁令：${parts}）`;
}
export function checkContractShape(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const covered: RunnerCovered[] = [];
  const unverified = typedPrerequisites(s, read.slots, covered); if (unverified) return unverified;
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
      if (role === 'host_shell' && hasShellDynamicSyntax(cellInput(step)&&v.pointer===at+'/args/0'?cellSyntax(String(v.value)):String(v.value))) out.push(refute(s, 'host_shell_dynamic', '主机命令含有扩展、分隔或重定向语法，不符合声明的静态 POSIX 子集语法；改为单一的显式命令', v.pointer));
    }
    if(out.length===beforeStep)try { encodeG(step,gOptions(step.object,step.method,s.contract!,s.profile!)); } catch(error) { if(error instanceof GSyntaxError)out.push(refute(s,'param_value',`G 写法 ${error.rule}：${error.message}；修正该步骤后自动重核`,at+'/G')); else throw error; }
  }
  const cleanup = s.contract!.cleanup;
  return out.length ? out : [support(s, `${read.slots.steps.length} 步调用符合启用合约，${read.slots.steps.some(cellInput)?'参数角色、签名和单格回填格式已核对；单格实际值在上机时取得':'参数角色、签名和值规则均已核对'}${runnerCleanupText(s.contract!, covered)}${destructiveText(s.contract!)}`, { runtime_version: s.contract!.runtimeVersion, contract_sha256: s.contract!.pinned.identity, ...(cleanup && covered.length ? { runner_cleanup: { source: cleanup.source, sha256: cleanup.sha256, pinned: cleanup.pinned, ...(cleanup.order ? { order: cleanup.order } : {}), covered } } : {}) })];
}
export function checkAddresses(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const unverified = typedPrerequisites(s, read.slots); if (unverified) return unverified;
  const slots = read.slots; const bed = s.beds.find((v) => v.name === slots.bucket);
  const triggerTypes = triggerTypesOf(s.profile!.trigger_types);
  if (!bed || bed.name !== s.profile!.bed) return [refute(s, 'bed_unknown', 'bucket 必须是运行环境配置选定的清单自动化测试环境', '/data/bucket')];
  const out:Outcome[]=[];
  const uses=typedAddressUses(s.contract!,s.profile!,slots,s.command_catalog);
  const sourceIdentities=Array.isArray(s.command_identities)?s.command_identities:[];
  // The author's own addresses (decision 115, as SyntheticReference): parsed from the case's command lines by the locked tree.
  const authored=authoredAddresses(s.command_catalog,Array.isArray(s.case_texts)?s.case_texts as string[]:[]);
  const sourceValues=new Set([...sourceIdentities.flatMap(raw=>{const i=identityOf(raw);return i?i.parameters.flatMap(p=>p.parsed.kind==='address'&&(p.parsed.value.kind==='ipv4'||p.parsed.value.kind==='ipv6')?[addressKey(p.parsed.value.value)]:[]):[];}),...authored]);
  const kept:string[]=[];
  const from=new Set<string>(),to=new Set<string>();
  for(const [i,replacement]of slots.replacements.entries()){
    const source=addressKey(replacement.case),target=addressKey(replacement.bed),at='/data/replacements/'+i;
    if(!source||!target||from.has(source)||to.has(target)||source.split(':')[0]!==target.split(':')[0])out.push(refute(s,'replacement_invalid','替换必须是同一声明地址族的一一对应数值映射',at));
    if(source&&!sourceValues.has(source))out.push(refute(s,'replacement_invalid',`替换的来源 ${replacement.case} 不是作者命令里的地址：只能替换锁定命令树从作者原文命令里解析出的地址参数（这里解析出 ${authored.size} 个${authored.size?`：${[...authored].slice(0,10).join('、')}`:''}），不按外形从散文里找地址`,at));
    if(source&&target&&source!==target&&slots.replacements.some((other,j)=>j!==i&&addressKey(other.case)===target))out.push(refute(s,'replacement_invalid','替换映射不能形成链或环',at));
    if(source)from.add(source);if(target)to.add(target);
    if(readAddress(bed,s.leases,s.now,replacement.bed).kind==='off_bed')out.push(refute(s,'address_off_bed','环境不可达，整卷不跑。该地址不在任何设备接口所在网段，也不是本血缘租约地址。下一步：换用有触发设备的网段里的接口地址，或先取得本血缘租约后再编译',at));
    else if(inBlindSegment(bed,replacement.bed,triggerTypes))out.push(refute(s,'environment_unreachable','环境不可达，整卷不跑。该地址落在没有触发设备的盲网段。下一步：把计划地址改到有触发设备的网段，或在该网段补一台触发设备后重新冻结清单再编译',at));
  }
  for(const use of uses){
    if(use.value===null){
      const statement='本次核对未取得单格的实际地址值，不能按原有规则核对测试环境范围；下一步由编写模型提供可按原规则核对的明确地址，再重核。';
      out.push({verdict:'unknown',reason:'missing_input',missing:statement,statement,grounds:s.location?[s.location]:[],tier:TIER,item:s.item,pointer:use.pointer,data:{typed_position:use}});continue;
    }
    if(use.kind!=='ipv4'&&use.kind!=='ipv6')continue;
    // A role that says the address is not on the environment is not checked; a missing use is checked like a member (decision 115).
    if(use.bed_member===false)continue;
    const value=String(use.value);if(slots.replacements.some(r=>addressKey(r.case)===addressKey(value)&&addressKey(r.case)!==addressKey(r.bed)))out.push(refute(s,'replacement_missing','声明地址位置仍保留替换前的值',use.pointer));
    const off=readAddress(bed,s.leases,s.now,value).kind==='off_bed',blind=!off&&inBlindSegment(bed,value,triggerTypes);
    if(!off&&!blind)continue;
    // As the reference implementation does: an address the author wrote is kept and disclosed; only one the plan made up is refused.
    const key=addressKey(value);if(key&&authored.has(key)){if(!kept.includes(value))kept.push(value);continue;}
    if(off)out.push(refute(s,'address_off_bed','环境不可达，整卷不跑。该地址不在任何设备接口所在网段，也不是本血缘租约地址，也不是作者原文命令里的地址（作者写的地址照原值保留并披露，只拒计划自己改出来的）。下一步：换用有触发设备的网段里的接口地址，或用作者原文里的地址，或先取得本血缘租约后再编译',use.pointer));
    else out.push(refute(s,'environment_unreachable','环境不可达，整卷不跑。该地址落在没有触发设备的盲网段，也不是作者原文命令里的地址。下一步：把计划地址改到有触发设备的网段，或用作者原文里的地址，或在该网段补一台触发设备后重新冻结清单再编译',use.pointer));
  }
  // The reference engine's driver_no_declared_path (InfoTest structural_gate.py:951, env_facts.py:346): a query whose output an
  // assertion reads is sent from a host with an interface on the target's segment. A segment with some trigger device is not
  // enough when the step runs on another host (for example, a query from another host failed six times without reaching its target). A target the
  // author wrote that no listed host reaches is kept and disclosed, as there; any other unreachable pair is refused.
  for(const [index,step]of slots.steps.entries()){
    const host=s.profile!.hosts.find(h=>h.object===step.object&&h.method===step.method);
    const entry=host?runtimeMethod(s.contract!,step.object,step.method):undefined,a=entry?.authority;
    if(!host||!entry||!a||!slots.expects.some(e=>e.after===index+1))continue;
    for(const v of bindArguments(entry,step,blockMeta(slots)&&step.origin?'/data'+step.origin:`/data/steps/${index}`).values){
      if(a.parameters[v.name]?.role!=='host_shell')continue;
      for(const effect of a.effects)for(const address of hostProgramLine(effect.allowed_programs,String(v.value),cellInput(step)&&v.pointer.endsWith('/args/0'))?.addresses??[]){
        if(hostReaches(bed,host.device,address)!==false)continue;
        const reaching=s.profile!.hosts.filter(h=>hostReaches(bed,h.device,address)===true).map(h=>`${h.object}.${h.method}（${h.device}）`);
        const key=addressKey(address);
        if(key&&authored.has(key)&&!reaching.length){if(!kept.includes(address))kept.push(address);continue;}
        out.push(refute(s,'driver_no_path',`查询发不到目标：${step.object}.${step.method} 在清单设备 ${host.device} 上执行，它的接口（${interfacesOf(bed,host.device).join('、')||'清单未列'}）都不在 ${address} 所在网段，清单也没有声明路由；这一步的输出被断言读取，上机只会超时或网络不可达。下一步：改由与 ${address} 同网段的主机发起（${reaching.length?reaching.join('、'):'清单里没有这样的主机'}），或把目标换成 ${host.device} 所在网段上的被测设备接口地址`,v.pointer));
      }
    }
  }
  const disclosed=kept.length?`；作者原文命令里的 ${kept.length} 个地址不在本环境可达范围里，照原值保留（同 SyntheticReference：只拒计划自己编的地址，作者写的写进披露），上机时可能连不通：${kept.join('、')}`:'';
  return out.length?out:[support(s,uses.length+' 个声明地址/掩码/前缀位置已按类型、用途和冻结范围核对；普通文字不扫描'+disclosed+(slots.steps.some(cellInput)?'；单格回填位置的实际值在上机时取得':''),{typed_positions:uses,replacements:slots.replacements,author_kept:kept})];
}
/**
 * The reference engine's assertion_matches_command_echo (InfoTest structural_gate.py:1319): the runner's output window starts with
 * the echo of the command it reads, so an expected text that is part of that command is found whatever the device answers (a
 * fake pass), and an absence check on it always fails. Run 12 delivered three such cases and passed one whose device refused the
 * domain, because the name was in the error message and the command. Register-based expectations take their text elsewhere.
 */
function assertionsInCommand(s: CheckSubject, slots: PlanSlots): Outcome[] {
  const out: Outcome[] = [];
  for (const [i, expect] of slots.expects.entries()) {
    if (expect.register !== undefined || typeof expect.text !== 'string' || !expect.text) continue;
    const step = slots.steps[expect.after - 1]; if (!step) continue;
    const allowed = allowedCall(s.profile!, step.object, step.method);
    if (!allowed || !Object.values(allowed.parameters).some((role) => role === 'device_cli' || role === 'host_shell')) continue;
    const command = [...step.args.map(String), ...Object.values(step.keywords ?? {}).map(String)];
    if (!command.some((text) => text.includes(expect.text))) continue;
    const pointer = blockMeta(slots) && expect.origin ? '/data' + expect.origin : `/data/expects/${i}`;
    out.push(refute(s, 'assertion_in_command', `断言文字“${expect.text.length > 80 ? expect.text.slice(0, 80) + '…' : expect.text}”就在它读取的第 ${expect.after} 步命令里；运行器读取的输出以命令回显开头，这条断言无论设备回什么都能找到（找不到型则必然失败），分不出成败。下一步：改成只会出现在设备输出数据行里的文字（计数、状态值、应答记录等），或换一条不含该文字的观察命令`, `${pointer}/text`));
  }
  return out;
}

export function checkExpectedSources(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const unverified = typedPrerequisites(s, read.slots); if (unverified) return unverified;
  const slots = read.slots; const out: Outcome[] = [];
  if(blockMeta(slots)){const echoed=assertionsInCommand(s,slots);const judged=checkBlockExpected(slots,s.expected_nodes,s.criteria_review,isRecord(s.command_catalog)?s.command_catalog.root:undefined,s.item);return echoed.length?[...echoed,...judged.filter(o=>o.verdict!=='support')]:judged;}
  if (!slots.expects.length) return [refute(s, 'expect_without_source', '至少一条期望结果必须带逐字来源并指明它判断的步骤', '/data/expects')];
  const byCriterion: Array<{ at: number; criterion: FrozenItemCriterion }> = [];
  const configured:Array<{at:number;source:ReturnType<typeof configuredExpectedSources>['sources'][number]}>=[];
  let configurationSources:ReturnType<typeof configuredExpectedSources>|undefined;
  for (const [i, expect] of slots.expects.entries()) {
    const pointer = `/data/expects/${i}`;
    if (!hasSingleLineValue(expect.text)) out.push(refute(s, 'expect_value', '断言必须是单行、无首尾空白、无等号前缀、无占位符，并符合发布配置的取值规则', `${pointer}/text`));
    if(expect.op==='not_found'){
      const missing=(message:string):Outcome=>({verdict:'unknown',reason:'missing_input',missing:message,statement:message,grounds:[],tier:TIER,item:s.item,pointer});
      if(!Array.isArray(s.expected_nodes)||s.expected_nodes.some(node=>!isRecord(node)||typeof node.reference!=='string'||typeof node.text!=='string'))return [missing('缺本条原始用例的冻结期望节点；下一步：绑定完整原件后重新核对不存在检查')];
      const node=s.expected_nodes.find(node=>isRecord(node)&&node.reference===expect.quote.reference);
      if(!isRecord(node)||typeof node.text!=='string'||!quoteMatches(node.text,expect.quote.text))out.push(refute(s,'expect_not_in_quote','不存在检查的 quote 必须逐字引用本条原始用例的期望节点',`${pointer}/quote`));
      else {
       let declared=true;
       if(node.declaration!==undefined){
        const author=isRecord(node.declaration)?node.declaration:null;
        if(!author||!BLOCK_TABLE.assertion_ops.some(row=>row.op===author.op)||typeof author.literal!=='string'||!author.literal){declared=false;out.push(missing('作者字面声明格式未知；下一步：由资料维护者核对原声明，不能由模型改写算子或文字'));}
        else if(author.op!=='not_found'||author.literal!==expect.text||author.count!==undefined){declared=false;out.push(refute(s,'expect_not_in_quote','不存在检查不能更改作者明确声明的算子或字面文字',pointer));}
       }
       if(declared&&!quoteMatches(replacedQuote(expect.quote.text,slots.replacements),expect.text)){
        configurationSources??=configuredExpectedSources(s.contract!,s.profile!,slots,s.command_catalog);
        if(configurationSources.problems.length)for(const problem of configurationSources.problems)out.push(problem.verdict==='unknown'?missing(problem.message):refute(s,'expect_not_in_quote',problem.message,`${pointer}/text`));
        else {
          const sources=configurationSources.sources.filter(source=>source.literals.includes(expect.text)&&source.inverse<expect.after-1&&(source.until===undefined||expect.after-1<source.until));
          const source=sources.find(source=>source.direction_known)??sources[0];
          if(source&&!source.direction_known)out.push(missing('产品逆操作声明不能确定唯一配置方向；下一步：资料维护者明确有向逆操作声明，或保留原始期望的字面片段'));
          else if(source)configured.push({at:i,source});
          else out.push(refute(s,'expect_not_in_quote','不存在检查的文字必须来自原始期望，或本条在查询前配置并按声明逆操作撤销、且未重建的完整文字参数',`${pointer}/text`));
        }
       }
      }
    }else if(expect.basis==='model_judgment'){
      if(!Array.isArray(s.expected_nodes)||s.expected_nodes.some(node=>!isRecord(node)||typeof node.reference!=='string'||typeof node.text!=='string'))return [{verdict:'unknown',reason:'missing_input',missing:'缺被判对象本用例期望节点的冻结原文与引用身份；下一步：用完整脑图原件开新运行，不用其他用例、标题或步骤代替',statement:'模型判断的原始期望节点尚未绑定；补齐原件后重核',grounds:[],tier:TIER,item:s.item}];
      if(!s.expected_nodes.some(node=>isRecord(node)&&node.reference===expect.quote.reference&&typeof node.text==='string'&&quoteMatches(node.text,expect.quote.text)))out.push(refute(s,'expect_not_in_quote','模型判断的 quote 必须逐字引用被判对象中本用例的期望节点，不能引用标题、步骤、其他用例或判据声明',`${pointer}/quote`));
    }else {
    // W10 step two binds a reviewed criterion to the frozen declaration, never the plan's own copy.
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
  out.push(...assertionsInCommand(s, slots));
  if (out.length) return out;
  const accepted = [...new Map(byCriterion.map((row) => [row.criterion.declaration, { declaration: row.criterion.declaration, review: row.criterion.review, reviewer: row.criterion.reviewer, expects: byCriterion.filter((other) => other.criterion.declaration === row.criterion.declaration).map((row) => row.at) }])).values()];
  const told = configured.length
    ? `${slots.expects.length} 个期望结果的来源与步骤已核对，其中 ${configured.length} 条不存在检查使用本条计划中配置后按声明逆操作撤销的完整文字参数`
    : accepted.length === 0
    ? `${slots.expects.length} 个期望结果都有逐字来源，文字出自替换后引文且判断的步骤合式`
    : `${slots.expects.length} 个期望结果都有逐字来源：${slots.expects.length - byCriterion.length} 条出自替换后引文，${byCriterion.length} 条逐字取自冻结的已受理判据声明（${accepted.map((row) => `声明 ${row.declaration}，复核 ${row.review}，复核人 ${row.reviewer}，期望 ${row.expects.map((at) => at + 1).join('/')} 条`).join('；')}）；新判据的引文在本次运行边界上另行逐字核对`;
  const configuredData=configured.length?{configured_expectations:configured.map(row=>({expect:row.at+1,configured_step:row.source.configured+1,inverse_step:row.source.inverse+1,object:row.source.object}))}:{};
  const judgments=slots.expects.flatMap((expect,index)=>expect.basis==='model_judgment'?[{index,...expect}]:[]);
  if(judgments.length){const result=support(s,`${judgments.length} 条模型主张的来源引文、步骤与取值规则已核验：${labelOf('expectation_basis','model_judgment')}，${labelOf('qualifier_mark','conditional_on_judgment')}；Hub 不判断所选文字是否正确`,{model_expectations:judgments,replacements:slots.replacements,...(accepted.length?{accepted_criteria:accepted}:{}),...configuredData});result.grounds=[...new Set([...result.grounds,...judgments.map(expect=>expect.quote.reference)])];result.judgment_sources=judgments.map(expect=>`/plan/0/data/expects/${expect.index}`);return [result];}
  return [support(s, told, { replacements: slots.replacements, ...(accepted.length ? { accepted_criteria: accepted } : {}),...configuredData })];
}

export function checkCommandsKnown(input:unknown):Outcome[]{
 const s=subjectOf(input),missing=prerequisites(s);if(missing)return missing;const read=slotsOf(s);if(read.errors)return read.errors;
 const covered:RunnerCovered[]=[];
 const gaps=typedPrerequisites(s,read.slots,covered);if(gaps)return gaps;
 const resolved=planCommands(s.contract!,s.profile!,read.slots,s.command_catalog);
 const declarations=resolved.problems.filter(problem=>problem.pointer==='/command_identities');
 if(declarations.length)return declarations.map(problem=>refute(s,'slots_invalid',problem.message+'；删除可选 command_identities，由 Hub 从 steps 解析；或按 Hub 回执修正声明','/data/command_identities'));
 const rows=planProblems(lineProfile(s.command_catalog,resolved.byLine));
 if(rows.length){
  const sent=deviceCommandLines(s.contract!,s.profile!,read.slots,resolved.answers),where=sent.find(row=>row.line===rows[0].b[0]);
  return [refute(s,'combination_forbidden',`${rows.map(planConflictText).join('；')}。${PLAN_CONFLICT_FIX}`,'/data'+(where?blockPointer(read.slots,where.pointer):'/steps'),{conflicts:rows})];
 }
 return [support(s,resolved.templates.length?'设备命令的静态部分与单格回填位置已按锁定目录核对；单格实际值在上机时取得':'所有设备命令均由锁定目录完整解析，已核用例声明（如有）、类型与效果授权',{command_identities:resolved.identities,...(resolved.templates.length?{command_templates:resolved.templates}:{}),command_catalog:resolved.catalog})];
}
/** The brief of the plan this subject holds, and the audit verdict it carries (which is no part of the brief): null brief when the case has no authored action. */
function briefOf(s: CheckSubject): { brief: FidelityBrief | null; plan: Record<string, unknown>; fidelity: unknown } {
  const frozen = isRecord(s.recomposition) && isRecord(s.recomposition.record) ? s.recomposition.record : s.recomposition;
  const { fidelity, ...plan } = isRecord(s.data) ? s.data : {};
  return { brief: fidelityBrief(s.item, frozen, plan), plan, fidelity };
}
/**
 * scenario_kept, the part that needs no audit: every authored action of the frozen recomposition record is named by at least one
 * step's (or block's) author_step_refs (functions/fidelity.ts authorStepCoverage, the program's half of InfoTest's
 * author_procedure_coverage gate). Round 36: the sync plan passed every other local check and the audit then found author step a2
 * realized by no step, a full writer rework; the plan check refuses it first, naming the step, where the plan would carry it, what
 * the plan does carry and what to do next. A case without authored actions has nothing to cover.
 */
export function checkAuthorStepCoverage(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const { brief, plan } = briefOf(s);
  if (!brief) return [support(s, '这条用例没有重组记录里的作者动作原句，没有要覆盖的作者步骤')];
  const coverage = authorStepCoverage(brief, plan);
  if (coverage.uncovered.length) return coverage.uncovered.map((step) => refute(s, 'author_step_unreferenced', uncoveredAuthorStepText(brief, coverage, step), '/data' + coverage.list, { author_step: step.n }));
  return [support(s, `作者 ${brief.author_steps.length} 条动作原句都有计划${coverage.noun}在 author_step_refs 写了它的编号；这一项只核编号，计划${coverage.noun}是否真的实现了它由场景保真审计判断`, { author_steps: brief.author_steps.map((step) => ({ n: step.n, carriers: coverage.carriers.filter((row) => row.refs.includes(step.n)).map((row) => row.index) })) })];
}
/**
 * scenario_kept: the audit verdict in data.fidelity answers the brief of this very plan and keeps every authored action of the
 * frozen recomposition record (functions/fidelity.ts, after the reference engine's scenario fidelity). A case without authored
 * actions has nothing to audit.
 */
export function checkScenarioFidelity(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const { brief, fidelity } = briefOf(s);
  if (!brief) return [support(s, '这条用例没有重组记录里的作者动作原句，场景保真不适用')];
  const judged = fidelityProblems(brief, fidelity);
  if (judged.problems.length) return judged.problems.map((p) => refute(s, p.code, p.message, p.pointer));
  return [support(s, `作者 ${judged.rows.length} 条动作原句逐条判为保住，判断针对这份计划的简报 ${brief.brief_sha256.slice(0, 12)}…；审计由客户端新开的会话做出，Hub 只核对格式和简报摘要`, { brief_sha256: brief.brief_sha256, steps: judged.rows, disclosure: (fidelity as { disclosure: string }).disclosure })];
}
