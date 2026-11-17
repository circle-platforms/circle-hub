import {recompositionGaps} from './recomposition.ts';
import {checkBlockExpected} from './block-expected.ts';
import {blockMeta,blockPointer,withoutModelIdentities} from './blocks.ts';
import {labelOf} from './generated/vocabulary.ts';
import {planCommands} from './plan-commands.ts';
import { typedAuthorityGaps, authorityRecovery, typedAddressUses } from './typed-authority.ts';
import { authoredAddresses, type RunnerCovered } from './command-obligations.ts';
// Verify authored plans against original runner identities, runtime profile, manifest, and frozen lineage addresses.
import { quoteMatches } from './quote.ts';
import { encodeG, GSyntaxError } from './g-syntax.ts';
import { gOptions } from './generate.ts';
import { isRecord, markers, type Outcome, opened } from './text.ts';
import { parseRuntimeContract, runtimeMethod, type RuntimeContract } from './runtime-contract.ts';
import { parseProfile, allowedCall, type RuntimeProfile } from './profile.ts';
import { parseManifest, addressKey, type ManifestBed } from './manifest.ts';
import { bedFacts, bedView, hostsReaching, inBlindSegment, interfaceOn, isBlind, pairsText, readAddress, triggerTypesOf, type AddressReading, type LeaseRow } from './bed.ts';
import { readSlots, type PlanSlots, type PlanPrecondition } from './slots.ts';
import { bindArguments, hasShellDynamicSyntax, hasBalancedCommandText, hasSingleLineValue } from './binding.ts';
import {identityOf} from './typed-contract.ts';
import { replacedQuote } from './addresses.ts';
import { citedCriterion, type FrozenItemCriterion } from './subject.ts';
interface CheckSubject {preconditions?:Array<{reference:string;text:string}>;projection_unknowns?:string[];recomposition_requested?:boolean;recomposition?:any;bed_services?:unknown;manifest_sha256?:string;criteria_review?:unknown;expected_nodes?:unknown; command_catalog?:unknown;command_identities?:unknown; item: string; location: string | null; data: unknown; contract: RuntimeContract | null; profile: RuntimeProfile | null; beds: ManifestBed[]; leases: LeaseRow[]; now: string; case_texts: string[]; criteria: FrozenItemCriterion[]; problems: Array<{ capacityExceeded?:boolean; document: string; pointer: string; message: string }> }
function subjectOf(input: unknown): CheckSubject {
  const raw = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const contract = parseRuntimeContract(raw.contract); const manifest = parseManifest(raw.manifest);
  const profile = contract.ok && manifest.ok ? parseProfile(raw.profile, contract.contract, manifest.beds) : null;
  const problems = [...(!contract.ok ? contract.problems.map((v) => ({ document: 'contract', pointer: v.pointer, message: v.message })) : []), ...(!manifest.ok ? manifest.problems.map((v) => ({ document: 'inventory', pointer: v.pointer, message: v.message })) : []), ...(profile && !profile.ok ? profile.problems.map((v) => ({ document: 'profile', pointer: v.pointer, message: v.message,...(v.capacityExceeded?{capacityExceeded:true}:{}) })) : [])];
  return {preconditions:Array.isArray(raw.preconditions)?raw.preconditions.filter((leaf:unknown):leaf is {reference:string;text:string}=>isRecord(leaf)&&typeof leaf.reference==='string'&&typeof leaf.text==='string'):undefined,projection_unknowns:raw.projection_unknowns as string[],recomposition_requested:raw.recomposition_requested===true,recomposition:raw.recomposition,bed_services:raw.bed_services,manifest_sha256:typeof raw.manifest_sha256==='string'?raw.manifest_sha256:undefined,criteria_review:raw.criteria_review, expected_nodes:raw.expected_nodes,command_catalog:opened(raw.command_catalog),command_identities:raw.command_identities,problems, criteria: Array.isArray(raw.criteria) ? raw.criteria as FrozenItemCriterion[] : [], case_texts: Array.isArray(raw.case_texts) ? raw.case_texts.filter((v): v is string => typeof v === 'string') : [], item: typeof raw.item === 'string' ? raw.item : '', location: typeof raw.location === 'string' ? raw.location : null, data: raw.data, contract: contract.ok ? contract.contract : null, profile: profile?.ok ? profile.profile : null, beds: manifest.ok ? manifest.beds : [], leases: Array.isArray(raw.leases) ? raw.leases as LeaseRow[] : [], now: typeof raw.now === 'string' ? raw.now : new Date(0).toISOString() };
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
function typedPrerequisites(s: CheckSubject, slots: PlanSlots, covered?: RunnerCovered[]): Outcome[] | null {
  const gaps0=[...(s.projection_unknowns??[]),...(s.recomposition_requested&&!s.recomposition?['缺可受理的独立重组记录；等待重组模型与核对方在编写之前完成重组并绑定真实 Hub 运行及结果']:[]),...recompositionGaps(slots,s.recomposition,s.manifest_sha256).filter(i=>i.verdict==='unknown').map(i=>i.message)];
  const invalidRecomposition=recompositionGaps(slots,s.recomposition,s.manifest_sha256).filter(i=>i.verdict==='refute');
  if(invalidRecomposition.length)return [refute(s,'slots_invalid',invalidRecomposition.map(i=>i.message).join('；'),'/data/recomposition')];
  if(gaps0.length)return [{verdict:'unknown',reason:'missing_input',missing:gaps0.join('；'),statement:gaps0.join('；'),grounds:[],tier:'blocking',item:s.item}];
  // Model identity proposals belong to commands_known, not shared contract prerequisites.
  const plan=withoutModelIdentities(slots);
  const gaps = typedAuthorityGaps(s.contract!, s.profile!, plan,s.command_identities,s.command_catalog,s.case_texts,s.manifest_sha256,s.bed_services,covered);
  if (!gaps.length) return null;
  const missing = authorityRecovery(gaps);
  if(gaps.some(g=>g.verdict==='refute')){const first=gaps.find(gap=>gap.verdict==='refute')!;const pointer=blockMeta(slots)&&first.pointer.startsWith('/blocks/')?'/data'+first.pointer:'/data';return [refute(s,'method_forbidden',missing,pointer,{problems:gaps,obligations:gaps.flatMap(gap=>gap.obligation?[gap.obligation]:[])})];}
  return [{ verdict: 'unknown', reason: 'missing_input', missing, statement: missing, grounds: s.location ? [s.location] : [], tier: TIER, item: s.item, data: { problems: gaps } }];
}
/** What the runner's own cleanup discharges (decision 112), with its source, rule and how far its digest is pinned. */
function runnerCleanupText(contract: RuntimeContract, covered: readonly RunnerCovered[]): string {
  const c = contract.cleanup;
  if (!c || covered.length === 0) return '';
  const listed = covered.slice(0, 5).map((row) => `${row.object} 的“${row.line}”（规则 ${row.rule + 1}${row.source_line !== null ? `，${c.source} 第 ${row.source_line} 行` : ''}，前缀“${row.prefix}”）`).join('、');
  const pinned = c.pinned ? '原合约的源文件摘要表记了同一摘要' : '原合约的源文件摘要表里没有这个文件，摘要只是 Hub 侧声明，跳转机上的字节未核对';
  return `；其中 ${covered.length} 条配置命令由运行器自己的清理收尾，不要求逆命令（规则 ${c.source}@${c.sha256.slice(0, 12)}：每个用例开始前和整本结束时按发过的命令行逐条比前缀、第一条命中即用；${pinned}）：${listed}${covered.length > 5 ? ` 等 ${covered.length} 条` : ''}`;
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
      if (role === 'host_shell' && hasShellDynamicSyntax(String(v.value))) out.push(refute(s, 'host_shell_dynamic', '主机命令含有扩展、分隔或重定向语法，不符合声明的静态 POSIX 子集语法；改为单一的显式命令', v.pointer));
    }
    if(out.length===beforeStep)try { encodeG(step,gOptions(step.object,step.method,s.contract!,s.profile!)); } catch(error) { if(error instanceof GSyntaxError)out.push(refute(s,'param_value',`G 写法 ${error.rule}：${error.message}；修正该步骤后自动重核`,at+'/G')); else throw error; }
  }
  const cleanup = s.contract!.cleanup;
  return out.length ? out : [support(s, `${read.slots.steps.length} 步调用符合启用合约，参数角色、签名和值规则均已核对${runnerCleanupText(s.contract!, covered)}${destructiveText(s.contract!)}`, { runtime_version: s.contract!.runtimeVersion, contract_sha256: s.contract!.pinned.identity, ...(cleanup && covered.length ? { runner_cleanup: { source: cleanup.source, sha256: cleanup.sha256, pinned: cleanup.pinned, covered } } : {}) })];
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
  // The bed as the model was shown it (fields.bed): the same facts, so a refusal names the pairs the item already lists.
  const facts=bedFacts(bed,triggerTypes),view=bedView(bed,s.profile!);
  // The blind rule covers a device-under-test interface and a lineage-leased address; any other address on the bed is only
  // checked to be on it (a reply address on a server is legitimate on a segment no trigger device reaches).
  const blind=(reading:AddressReading,value:string):boolean=>reading.kind==='interface'?reading.type==='load-balancer'&&isBlind(facts,value):reading.kind==='allocated'&&inBlindSegment(bed,value,triggerTypes);
  const kindsOn=(subnet:string)=>[...new Set((facts.segments.find(g=>g.subnet===subnet)?.members??[]).filter(m=>m.type!=='load-balancer').map(m=>m.type))].sort().join('、')||'无';
  const triggers=triggerTypes.size?[...triggerTypes].sort().join('、'):'任何',basis=s.profile!.trigger_types===undefined?'包默认':'配置声明';
  const blindText=(reading:AddressReading,value:string,authorNote:boolean):string=>`环境不可达，整卷不跑。${reading.kind==='interface'?`${value} 是 ${reading.device} 的接口地址，所在网段 ${reading.subnet} 上没有 ${triggers} 类型的设备（该网段上的其他设备类型：${kindsOn(reading.subnet)}；触发类型取${basis}）`:`${value} 是本血缘租约的地址，落在没有 ${triggers} 类型设备的网段（触发类型取${basis}）`}；监听和查询目标要落在有触发设备的网段。${authorNote?'它也不是作者原文命令里的地址（作者写的地址照原值保留并披露，只拒计划自己改出来的）。':''}下一步：改用有主机配对的监听地址，由配对的同网段主机发查询——${pairsText(view)}；或在该网段补触发设备后重新冻结清单再编译`;
  // When no open host shares a segment with any listener the pairing table is empty and no repair of the plan can help: that is
  // a missing fact of the deployment (an unknown with an administrator's exit), not a refusal the model could mend.
  const unreachable:Outcome[]=[],stuck=view.listeners.every(l=>l.hosts.length===0);
  const from=new Set<string>(),to=new Set<string>();
  for(const [i,replacement]of slots.replacements.entries()){
    const source=addressKey(replacement.case),target=addressKey(replacement.bed),at='/data/replacements/'+i;
    if(!source||!target||from.has(source)||to.has(target)||source.split(':')[0]!==target.split(':')[0])out.push(refute(s,'replacement_invalid','替换必须是同一声明地址族的一一对应数值映射',at));
    if(source&&!sourceValues.has(source))out.push(refute(s,'replacement_invalid',`替换的来源 ${replacement.case} 不是作者命令里的地址：只能替换锁定命令树从作者原文命令里解析出的地址参数（这里解析出 ${authored.size} 个${authored.size?`：${[...authored].slice(0,10).join('、')}`:''}），不按外形从散文里找地址`,at));
    if(source&&target&&source!==target&&slots.replacements.some((other,j)=>j!==i&&addressKey(other.case)===target))out.push(refute(s,'replacement_invalid','替换映射不能形成链或环',at));
    if(source)from.add(source);if(target)to.add(target);
    const reading=readAddress(bed,s.leases,s.now,replacement.bed);
    if(reading.kind==='off_bed')out.push(refute(s,'address_off_bed','环境不可达，整卷不跑。该地址不在任何设备接口所在网段，也不是本血缘租约地址。下一步：换用有触发设备的网段里的接口地址，或先取得本血缘租约后再编译',at));
    else if(blind(reading,replacement.bed))unreachable.push(refute(s,'environment_unreachable',blindText(reading,replacement.bed,false),at));
  }
  for(const use of uses){
    if(use.kind!=='ipv4'&&use.kind!=='ipv6')continue;
    // A role that says the address is not on the environment is not checked; a missing use is checked like a member (decision 115).
    if(use.bed_member===false)continue;
    const value=String(use.value);if(slots.replacements.some(r=>addressKey(r.case)===addressKey(value)&&addressKey(r.case)!==addressKey(r.bed)))out.push(refute(s,'replacement_missing','声明地址位置仍保留替换前的值',use.pointer));
    const reading=readAddress(bed,s.leases,s.now,value),off=reading.kind==='off_bed',blinded=!off&&blind(reading,value);
    if(!off&&!blinded)continue;
    // As the reference implementation does: an address the author wrote is kept and disclosed; only one the plan made up is refused.
    const key=addressKey(value);if(key&&authored.has(key)){if(!kept.includes(value))kept.push(value);continue;}
    if(off)out.push(refute(s,'address_off_bed','环境不可达，整卷不跑。该地址不在任何设备接口所在网段，也不是本血缘租约地址，也不是作者原文命令里的地址（作者写的地址照原值保留并披露，只拒计划自己改出来的）。下一步：换用有触发设备的网段里的接口地址，或用作者原文里的地址，或先取得本血缘租约后再编译',use.pointer));
    else unreachable.push(refute(s,'environment_unreachable',blindText(reading,value,true),use.pointer));
  }
  // A query that an assertion reads is sent from a host that shares a segment with its target (the inventory declares no
  // routes, so a different segment has no declared path). Only a consumed query is judged: a step whose reply nothing reads
  // (traffic made for the statistics that follow) is not an assertion on a path.
  const consumer=new Map<number,number>();
  for(const e of slots.expects){
    if(e.operator==='found_times'||e.actual_register===undefined)if(!consumer.has(e.after))consumer.set(e.after,e.after);
    for(const register of [e.register,e.actual_register])if(register!==undefined){const at=slots.steps.findIndex(step=>step.save_as===register);if(at>=0&&!consumer.has(at+1))consumer.set(at+1,e.after);}
  }
  const unreached:string[]=[];
  for(const use of uses){
    if(use.query===undefined||!consumer.has(use.query.step)||(use.kind!=='ipv4'&&use.kind!=='ipv6')||unreachable.some(row=>row.pointer===use.pointer))continue;
    const value=String(use.value),step=slots.steps[use.query.step-1],host=s.profile!.hosts.find(h=>h.object===step.object&&h.method===step.method),device=host&&bed.devices.find(d=>d.name===host.device);
    if(!host||!device||interfaceOn(device,value)!==undefined)continue;
    const peers=hostsReaching(bed,s.profile!.hosts,value),key=addressKey(value);
    if(key&&authored.has(key)&&!peers.length){if(!unreached.includes(value))unreached.push(value);continue;}
    const own=[...device.ipv4,...device.ipv6].map(i=>i.subnet);
    unreachable.push(refute(s,'environment_unreachable',`发起机与目标不同网段，整卷不跑。第 ${use.query.step} 步在 ${host.object}.${host.method}（设备 ${host.device}，${own.length?`网段 ${own.join('、')}`:'清单里没有它的接口地址'}）上查询 ${value}，第 ${consumer.get(use.query.step)} 步的断言读这条查询的回显；清单没有声明网段之间的路由，本规则只认同网段，这条查询没有声明的通路。同网段的已开放主机：${peers.length?peers.map(p=>`${p.object}.${p.method}（设备 ${p.device}）`).join('、'):'没有'}。下一步：把这一步改到同网段主机上发，或把目标改成该主机同网段的监听地址（监听配置里的地址同步改）；配对表——${pairsText(view)}`,use.pointer));
  }
  if(unreachable.length&&stuck&&!out.length)return [{verdict:'unknown',reason:'missing_input',missing:`缺的事实：本配置没有任何已开放的主机与被测设备的监听地址同网段（监听候选 ${view.listeners.length} 个，盲地址 ${view.blind.length} 个，触发类型 ${view.trigger_types.join('、')||'无'}），计划无处可发查询`,statement:`缺的事实：本配置没有任何已开放的主机与被测设备的监听地址同网段（监听候选 ${view.listeners.length} 个，盲地址 ${view.blind.length} 个，触发类型 ${view.trigger_types.join('、')||'无'}），计划里 ${unreachable.length} 处地址或查询因此没有可达的写法。下一步：管理员在 runtime-profile 的 hosts 里开放触发设备的主机方法，或在清单里补触发设备，重新发布后新开运行`,grounds:s.location?[s.location]:[],tier:TIER,item:s.item}];
  out.push(...unreachable);
  const disclosed=(kept.length?`；作者原文命令里的 ${kept.length} 个地址不在本环境可达范围里，照原值保留（同 SyntheticReference：只拒计划自己编的地址，作者写的写进披露），上机时可能连不通：${kept.join('、')}`:'')+(unreached.length?`；作者原文命令里的 ${unreached.length} 个查询目标没有任何已开放的主机与它同网段，照原值保留，上机时可能连不通：${unreached.join('、')}`:'');
  return out.length?out:[support(s,uses.length+' 个声明地址/掩码/前缀位置已按类型、用途和冻结范围核对；普通文字不扫描'+disclosed,{typed_positions:uses,replacements:slots.replacements,author_kept:kept,...(unreached.length?{author_unreached:unreached}:{})})];
}
export function checkExpectedSources(input: unknown): Outcome[] {
  const s = subjectOf(input); const missing = prerequisites(s); if (missing) return missing;
  const read = slotsOf(s); if (read.errors) return read.errors;
  const unverified = typedPrerequisites(s, read.slots); if (unverified) return unverified;
  // The expectations and the precondition leaves are judged together, so one repair round can mend both. With nothing to say
  // about a precondition the answer is the expectations' own, unchanged.
  const body = expectedBody(s, read.slots), ledger = preconditionOutcomes(s, read.slots);
  return ledger.length ? [...body.filter((row) => row.verdict !== 'support'), ...ledger] : body;
}
function expectedBody(s: CheckSubject, slots: PlanSlots): Outcome[] {
  const out: Outcome[] = [];
  if(blockMeta(slots))return checkBlockExpected(slots,s.expected_nodes,s.criteria_review,isRecord(s.command_catalog)?s.command_catalog.root:undefined,s.item);
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
  out.push(...echoOutcomes(s, slots));
  if (out.length) return out;
  const accepted = [...new Map(byCriterion.map((row) => [row.criterion.declaration, { declaration: row.criterion.declaration, review: row.criterion.review, reviewer: row.criterion.reviewer, expects: byCriterion.filter((other) => other.criterion.declaration === row.criterion.declaration).map((row) => row.at) }])).values()];
  const told = accepted.length === 0
    ? `${slots.expects.length} 个期望结果都有逐字来源，文字出自替换后引文且判断的步骤合式`
    : `${slots.expects.length} 个期望结果都有逐字来源：${slots.expects.length - byCriterion.length} 条出自替换后引文，${byCriterion.length} 条逐字取自冻结的已受理判据声明（${accepted.map((row) => `声明 ${row.declaration}，复核 ${row.review}，复核人 ${row.reviewer}，期望 ${row.expects.map((at) => at + 1).join('/')} 条`).join('；')}）；新判据的引文在本次运行边界上另行逐字核对`;
  const judgments=slots.expects.flatMap((expect,index)=>expect.basis==='model_judgment'?[{index,...expect}]:[]);
  if(judgments.length){const result=support(s,`${judgments.length} 条模型主张的来源引文、步骤与取值规则已核验：${labelOf('expectation_basis','model_judgment')}，${labelOf('qualifier_mark','conditional_on_judgment')}；Hub 不判断所选文字是否正确`,{model_expectations:judgments,replacements:slots.replacements,...(accepted.length?{accepted_criteria:accepted}:{})});result.grounds=[...new Set([...result.grounds,...judgments.map(expect=>expect.quote.reference)])];result.judgment_sources=judgments.map(expect=>`/plan/0/data/expects/${expect.index}`);return [result];}
  return [support(s, told, { replacements: slots.replacements, ...(accepted.length ? { accepted_criteria: accepted } : {}) })];
}

/** The commands a step sends: the values of its device-command and host-shell parameters. */
function commandsOf(s: CheckSubject, step: PlanSlots['steps'][number]): string[] {
  const entry = runtimeMethod(s.contract!, step.object, step.method), allowed = allowedCall(s.profile!, step.object, step.method);
  if (!entry || !allowed) return [];
  return bindArguments(entry, step, '').values.filter((value) => (allowed.parameters[value.name] === 'device_cli' || allowed.parameters[value.name] === 'host_shell') && typeof value.value === 'string').map((value) => String(value.value));
}
/**
 * An expectation whose text already stands in the command it reads. The device echoes the command ahead of its answer, so
 * such a text is found whatever the device answers (a presence that proves nothing), or an absence that cannot hold. A plain
 * substring test between two fields of the plan; the runner's regular expressions are not interpreted here.
 */
function echoOutcomes(s: CheckSubject, slots: PlanSlots): Outcome[] {
  const out: Outcome[] = [];
  for (const [i, expect] of slots.expects.entries()) {
    if (expect.register !== undefined || expect.text === '') continue;
    const step = slots.steps[expect.after - 1]; if (!step) continue;
    if (!commandsOf(s, step).some((command) => command.includes(expect.text))) continue;
    out.push(refute(s, 'expect_in_command', `第 ${expect.after} 步的命令文字里已经含有期望文字「${expect.text.length > 60 ? expect.text.slice(0, 60) + '…' : expect.text}」：设备回显把命令本身带回来，${expect.operator === 'not_found' ? '这条“不出现”断言必然失败' : '这条断言不管设备答什么都成立（空真通过）'}。下一步：期望改成只会出现在设备输出里的文字（输出表里的相邻文字或状态词，取自手册或作者的期望原文）；作者的描述性期望按 model_judgment 写并在 rationale 说明依据`, `/data/expects/${i}/text`));
  }
  return out;
}
/** Every precondition leaf of the case is stated by the plan: the steps that establish it, or that it cannot be established. */
function preconditionOutcomes(s: CheckSubject, slots: PlanSlots): Outcome[] {
  const leaves = s.preconditions;
  // A run frozen before the leaves were listed has none to cover.
  if (!Array.isArray(leaves) || leaves.length === 0) return [];
  const block = blockMeta(slots) !== undefined, out: Outcome[] = [];
  const where = block ? '/data/block_context/preconditions' : '/data/preconditions';
  const declared: Array<{ reference: string; entry?: PlanPrecondition; at: string }> = block
    ? (Array.isArray(slots.block_context?.preconditions) ? slots.block_context!.preconditions as unknown[] : []).flatMap((row, i) => isRecord(row) && isRecord(row.quote) && typeof row.quote.reference === 'string' ? [{ reference: row.quote.reference, at: `${where}/${i}` }] : [])
    : (slots.preconditions ?? []).map((entry, i) => ({ reference: entry.reference, entry, at: `${where}/${i}` }));
  const known = new Set(leaves.map((leaf) => leaf.reference));
  for (const leaf of leaves) {
    const own = declared.filter((row) => row.reference === leaf.reference);
    if (own.length === 0) out.push(refute(s, 'precondition_missing', `前置叶子「${leaf.text}」（${leaf.reference}）在计划里没有声明。缺的位置：${block ? 'block_context.preconditions 里 quote.reference 等于该叶子的一项' : 'preconditions 里 reference 等于该叶子的一项'}。下一步：在 steps 里写建立这个状态的设备命令或主机命令（早于第一个被断言的步骤），再声明 ${block ? '该前置（state、for、established_by、quote 逐字抄叶子）' : `{"reference":"${leaf.reference}","established_by":[步骤号…]}`}；叶子里的环境分句（客户端、IPv6 环境等）以 fields.bed 为准，不由命令建立；确实建立不了就声明 unmet 并写缺什么和下一步，该用例停在未知，其余用例把它的 autoid 写进新运行的 parameters.exclude 后照常出簿`, where, { missing: [leaf.reference] }));
    else if (own.length > 1) out.push(refute(s, 'slots_invalid', `前置叶子 ${leaf.reference} 被声明了 ${own.length} 次；每个叶子恰一项`, own[1].at));
  }
  for (const row of declared) if (!known.has(row.reference)) out.push(refute(s, 'slots_invalid', `前置声明的 reference ${row.reference} 不是本用例的前置叶子；照条目 fields.preconditions 逐字抄`, row.at));
  if (block) return out;
  const first = slots.expects.length ? Math.min(...slots.expects.map((expect) => expect.after)) : Infinity;
  for (const row of declared) {
    const entry = row.entry; if (!entry || !known.has(row.reference)) continue;
    const leaf = leaves.find((value) => value.reference === row.reference)!;
    if (entry.unmet) { out.push({ verdict: 'unknown', reason: 'missing_input', missing: `计划声明前置「${leaf.text}」未满足（模型声明，Hub 未核对）：${entry.unmet.missing}`, statement: `计划声明前置「${leaf.text}」未满足（模型声明，Hub 未核对）：缺的事实：${entry.unmet.missing}。下一步：${entry.unmet.next_action}。本用例不能出工作簿；其余用例把本用例的 autoid 写进新运行的 parameters.exclude 后照常出簿，最终报告逐条写明被排除的用例、缺什么、下一步`, grounds: s.location ? [s.location] : [], tier: TIER, item: s.item }); continue; }
    for (const [j, n] of (entry.established_by ?? []).entries()) {
      const step = slots.steps[n - 1], allowed = step ? allowedCall(s.profile!, step.object, step.method) : null, at = `${row.at}/established_by/${j}`;
      const why = !step ? `第 ${n} 步不存在（计划共 ${slots.steps.length} 步）` : step.cleanup === true ? `第 ${n} 步是清理步骤，清理在用例结束时做，不建立前置` : !Object.values(allowed?.parameters ?? {}).some((role) => role === 'device_cli' || role === 'host_shell') ? `第 ${n} 步不是设备命令或主机命令（等待和断言不建立状态）` : n >= first ? `第 ${n} 步不早于第一个被断言的步骤（第 ${first} 步）；前置要在被断言的观察之前建立` : '';
      if (why) out.push(refute(s, 'slots_invalid', `前置「${leaf.text}」的建立步骤不成立：${why}`, at));
    }
  }
  return out;
}
/** commands_known resolves whole plan commands against the locked grammar, then checks typed authority. */
export function checkCommandsKnown(input:unknown):Outcome[]{
 const s=subjectOf(input),missing=prerequisites(s);if(missing)return missing;const read=slotsOf(s);if(read.errors)return read.errors;
 const gaps=typedPrerequisites(s,read.slots);if(gaps)return gaps;const resolved=s.contract&&s.profile?planCommands(s.contract,s.profile,read.slots,s.command_catalog):null;const declarations=resolved?.problems.filter(problem=>problem.pointer==='/command_identities')??[];if(declarations.length)return declarations.map(problem=>refute(s,'slots_invalid',problem.message+'；删除可选 command_identities，由 Hub 从 steps 解析；或按 Hub 回执修正声明','/data/command_identities'));return [support(s,'所有设备命令均由锁定目录完整解析，已核用例声明（如有）、类型与效果授权',{command_identities:resolved?.identities??[],command_catalog:resolved?.catalog})];
}
