// Checks declarations and reference graphs, never evaluates a device response or guesses semantic roles from words.
import TABLE from '../tables/blocks-format.json' with {type:'json'};
import {blockMeta,type BlockMeta} from './blocks.ts';
import {listed,refusalText,shownValue} from './refusal-form.ts';
import {isRecord} from './text.ts';
import type {PlanSlots,PlanStep} from './slots.ts';
import type {RuntimeProfile} from './profile.ts';
import type {AuthorityGap} from './typed-authority.ts';
import {runtimeMethod,type RuntimeContract} from './runtime-contract.ts';
import {bindArguments} from './binding.ts';
import {readCommandPolicy,within} from './generated/skills/command-tools/command-check/command-policy.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
const MAX_LISTED=32;
const quoted=(value:unknown):string=>JSON.stringify(value)??String(value);
/** The ids a responder may name: every block whose call returns device text, in plan order. */
export const observationIds=(slots:PlanSlots):string[]=>slots.steps.flatMap(step=>step.output&&step.id!==undefined?[step.id]:[]);
/**
 * A responder row names the observation block it answers by that block's id (a saved name or a device is not one). A refusal says
 * the value written, lists this plan's observation ids (a closed set the plan itself defines) and, when the value is the saved name
 * of exactly one observation block, that block's id. It never rewrites the plan.
 */
export function responderOutputGaps(slots:PlanSlots,seats:readonly string[]=[]):AuthorityGap[]{
 const meta=blockMeta(slots),rows=slots.block_context?.responders;if(!meta||!Array.isArray(rows))return [];
 const ids=observationIds(slots),listed=ids.length?ids.slice(0,MAX_LISTED).join('、')+(ids.length>MAX_LISTED?`…（共 ${ids.length} 个，完整集合见结构化结果）`:''):'没有观察块';
 const kindOf=(id:string):string=>String(slots.blocks.find(block=>block.id===id)?.kind);
 return rows.flatMap((row:any,index:number)=>{
  const value=row?.output;if(typeof value==='string'&&ids.includes(value))return [];
  const saved=typeof value==='string'?meta.registers.get(value):undefined,expected=saved&&!saved.cell&&ids.includes(saved.block)?saved.block:undefined;
  const named=typeof value==='string'&&meta.steps.has(value)?value:undefined;
  const why=expected!==undefined?`；它是观察块 ${expected} 的保存名，应填块 id ${expected}`:saved?.cell?`；它是块 ${saved.block}（${kindOf(saved.block)}）保存的单格，不是观察块`:named!==undefined?`；它是块 ${named}（${kindOf(named)}）的 id，但该块不产生设备原文，不是观察块`:'';
  const ref=row?.kind==='device'&&seats.length&&!seats.includes(row.ref)?`；另外 kind=device 的 ref 要填冻结设备座位（${seats.join('、')}），这一条的 ref 是 ${quoted(row.ref)}`:'';
  return [{document:'blocks',pointer:`/block_context/responders/${index}/output`,verdict:'refute' as const,requested_output:value,allowed_output_ids:ids,...(expected!==undefined?{expected_output:expected}:{}),message:`应答者 output 写的是 ${quoted(value)}，它不是本条任何观察块的 id；output 要填产生设备原文的观察块的 id，不是保存名或设备名；本条的观察块 id：${listed}${why}${ref}；不自动改写计划`}];
 });
}
/** The ids of the blocks whose call returns device text and that are not earlier than step `position` (from 1), in plan order. */
const observationsFrom=(slots:PlanSlots,position:number):string[]=>slots.steps.flatMap((step,index)=>step.output&&step.id!==undefined&&index+1>=position?[step.id]:[]);
const kindOf=(slots:PlanSlots,id:string):string=>String(slots.blocks.find(block=>block.id===id)?.kind);
/**
 * Why one causal edge is refused, from what the plan itself defines: the edge as written, which end is wrong (an id of no step block,
 * an observation earlier than the step, an end that carries no device text), the ids that exist and the next step. The rule is the
 * one the check always had (an edge runs from an existing step to an observation block not earlier than it); the plan is not rewritten.
 */
function causalEdgeText(slots:PlanSlots,meta:BlockMeta,link:{from:string;to:string}):string{
 const from=meta.steps.get(link.from),to=meta.steps.get(link.to),faults:string[]=[];
 // An id that is the saved name of a block's output is not an id; the block that owns it is named, as for a responder's output.
 const hint=(value:string):string=>{const saved=meta.registers.get(value);return saved===undefined?'':saved.cell?`；它是块 ${saved.block}（${kindOf(slots,saved.block)}）保存的单格，不是块 id`:`；它是块 ${saved.block} 保存的名字，块 id 是 ${saved.block}`;};
 if(from===undefined)faults.push(`起点 from 写的是 ${quoted(link.from)}，它不是本条任何步骤块的 id${hint(link.from)}`);
 if(to===undefined)faults.push(`终点 to 写的是 ${quoted(link.to)}，它不是本条任何步骤块的 id${hint(link.to)}`);
 else{
  if(from!==undefined&&from>to)faults.push(`终点 ${link.to}（第 ${to} 步）排在起点 ${link.from}（第 ${from} 步）之前，边只能指向不早于起点的观察`);
  if(!slots.steps[to-1]!.output)faults.push(`终点 ${link.to} 是 ${kindOf(slots,link.to)} 块（第 ${to} 步），不产生设备原文，不是观察块`);
 }
 const fromWrong=from===undefined,toWrong=to===undefined||from!==undefined&&from>to||!slots.steps[to-1]!.output;
 const all=[...meta.steps.keys()],ends=from===undefined?`to 取本条的观察块 id：${listed(observationsFrom(slots,1),MAX_LISTED)}`:`to 取 ${link.from}（第 ${from} 步）之后（含它自己）的观察块 id：${listed(observationsFrom(slots,from),MAX_LISTED)}`;
 const starts=`from 取本条的步骤块 id：${listed(all,MAX_LISTED)}`;
 const quoteRule='quote 仍逐字取手册里说明它们关系的原文';
 return refusalText({
  what:`因果边必须由已有步骤指向不早于它的原文观察，这一条不是：${faults.join('；')}`,
  seen:shownValue({from:link.from,to:link.to}),
  allowed:[fromWrong?starts:ends],
  also:[...(fromWrong&&toWrong?[ends]:[]),...(fromWrong?[]:[`本条的块 id（按计划顺序）：${listed(all,MAX_LISTED)}`])],
  next:fromWrong&&toWrong?`from 改成本条的块 id，to 改成上面允许的观察块 id（真正检验这条配置的那一个），${quoteRule}`:fromWrong?`from 改成本条的块 id（上面列出的），to 不变，${quoteRule}`:`to 改成上面允许的观察块 id（真正检验这条配置的那一个），${quoteRule}；边的终点必须是观察，不能指向另一条配置，也不能指向排在起点前面的块`,
 });
}
/**
 * Why a configuration block has no causal edge to a later observation: its block id, the edges that start at it and do not count
 * (and why), the observation blocks after it that could carry the edge and the form of the edge to add.
 */
function missingEdgeText(slots:PlanSlots,meta:BlockMeta,links:Array<{from:string;to:string}>,step:PlanStep,index:number):string{
 const id=String(step.id),later=observationsFrom(slots,index);
 const why=(to:string):string=>{const at=meta.steps.get(to);return at===undefined?'终点不是本条任何步骤块的 id':!slots.steps[at-1]!.output?`终点是 ${kindOf(slots,to)} 块，不是观察块`:'终点排在它前面';};
 const own=links.flatMap((link,at)=>link.from===step.id?[`第 ${at+1} 条（to=${link.to}，${why(link.to)}）不算数`]:[]);
 return refusalText({
  what:`配置块 ${id}（${step.object}.${step.method}，第 ${index} 步）没有因果边指向它之后的观察块`,
  seen:own.length?`block_context.causal_links 里以它为起点的边：${own.join('；')}`:'block_context.causal_links 里没有以它为起点的边',
  allowed:[later.length?`to 取 ${id} 之后（含它自己）的观察块 id：${listed(later,MAX_LISTED)}`:'无，它之后没有观察块'],
  next:later.length?`在 block_context.causal_links 加一条 {"from":"${id}","to":"<上面允许的一个>","quote":{"reference":"<引用>","text":"<逐字原文>"}}，to 选真正检验这条配置的观察，quote 逐字取手册里说明这条配置影响该观察的原文；不能从合法 after 推定因果`:`先在它之后安排检验它的观察块，再写 {"from":"${id}","to":"<那个观察块的 id>","quote":{"reference":"<引用>","text":"<逐字原文>"}}；不能从合法 after 推定因果`,
 });
}
export function blockGraphGaps(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,catalog:unknown,identities:ReadonlyMap<string,Pick<CommandIdentity,'path'>>,services?:unknown):AuthorityGap[]{
 const meta=blockMeta(slots);if(!meta)return [];
 const gaps:AuthorityGap[]=[],note=(pointer:string,message:string,refute=false)=>gaps.push({document:'blocks',pointer,message,verdict:refute?'refute':'unknown'});
 const context=slots.block_context;
 if(!context||!Array.isArray(context.preconditions)||!Array.isArray(context.causal_links)||!Array.isArray(context.responders)){note('/block_context','缺显式前置、因果边及应答者声明（无前置也要写空表）；下一步：模型按作者原文补结构及引文，不猜测不存在前置');return gaps;}
 const observations=slots.steps.map((step,index)=>({step,index:index+1})).filter(row=>row.step.output);
 const policy=readCommandPolicy(isRecord(catalog)?catalog.policy:undefined);
 const configured=slots.steps.map((step,index)=>({step,index:index+1})).filter(({step})=>{
  if(step.cleanup)return false;if(step.block_kind==='CONFIG')return true;
  const entry=runtimeMethod(contract,step.object,step.method),allowed=profile.allowed.find(call=>call.object===step.object&&call.method===step.method);
  return !!entry&&bindArguments(entry,step,'').values.some(value=>{const identity=identities.get(String(value.value));return allowed?.parameters[value.name]==='device_cli'&&identity&&policy&&!policy.read_only.some(prefix=>within(identity.path,prefix));});
 });
 if(configured.length&&(!observations.length||configured.at(-1)!.index>observations.at(-1)!.index))note('/blocks','最后一条业务配置晚于最后一次观察；清理段须显式标记且不能冒充业务观察',true);
 for(const {step,index}of configured)if(!context.causal_links.some((link:any)=>link.from===step.id&&observations.some(row=>row.step.id===link.to&&row.index>=index)))note(step.origin??'/blocks',missingEdgeText(slots,meta,context.causal_links,step,index));
 for(const [index,link]of context.causal_links.entries()){
  const from=meta.steps.get(link.from),to=meta.steps.get(link.to);if(!from||!to||from>to||!slots.steps[to-1].output)note('/block_context/causal_links/'+index,causalEdgeText(slots,meta,link),true);
 }
 for(const [index,pre]of context.preconditions.entries()){
  const target=meta.steps.get(pre.for),at='/block_context/preconditions/'+index;
  if(!TABLE.precondition_states.includes(pre.state)||!target)note(at,'前置状态或适用步骤不在声明结构中',true);
  if(pre.state==='unmet')note(at,(pre.missing??'前置尚未满足')+'；下一步：'+(pre.next_action??'模型按作者原文补前置验证及责任方，不把缺前置的反向场景改成正向场景'));
  else if(!pre.established_by.length)note(at,'缺验证此 present/absent 前置的步骤；下一步：明确引用已安排的观察，不由代码添加配置');
  for(const id of pre.established_by){const source=meta.steps.get(id);if(!source||target&&source>=target)note(at,'前置依据步骤必须存在并早于被约束步骤',true);}
 }
 for(const {step}of observations){
  const allowed=profile.allowed.find(call=>call.object===step.object&&call.method===step.method);
  if(!Object.values(allowed?.parameters??{}).includes('host_shell'))continue;
  const matches=context.responders.filter((value:any)=>value.output===step.id);
  if(matches.length!==1){
   const others=matches.length?`；第 ${context.responders.flatMap((value:any,at:number)=>value.output===step.id?[at+1]:[]).join('、')} 条都写了它，只能留一条`:context.responders.length?`；现有应答者的 output 是 ${context.responders.map((value:any)=>quoted(value.output)).join('、')}，没有一条等于这个块的 id`:'';
   note(step.origin??'/blocks',`观察块 ${step.id}（${step.object}.${step.method}）是主机命令的观察，block_context.responders 里要有且只有一条 output 等于 ${quoted(step.id)} 的应答者声明，现在有 ${matches.length} 条${others}；下一步：补上这一条，kind 写 device / fixture / bed_service，未定写 undetermined 及出口`);continue;
  }
  const row=matches[0],at='/block_context/responders/'+context.responders.indexOf(row);
  if(!TABLE.responder_kinds.includes(row.kind))note(at,'应答者类型不在包声明闭集中',true);
  else if(row.kind==='undetermined')note(at,(row.missing??'应答者未定')+'；下一步：'+(row.next_action??'模型核对来源和请求链后补明确应答者'));
  else if(row.kind==='fixture'){const source=meta.steps.get(row.ref),target=meta.steps.get(step.id!);if(!source||!target||source>=target)note(at,'案内 fixture 必须指向本次观察之前已安排的步骤',true);}
  else if(row.kind==='bed_service'){if(!Array.isArray(services))note(at,'缺冻结自动化测试环境服务清单；下一步：补绑定 inventory 后重新核验');else if(!services.some(service=>isRecord(service)&&service.host===row.ref))note(at,'床服务应答者没有冻结服务声明',true);}
 }
 for(const [index,expect]of slots.expects.entries())if(!observations.some(row=>row.step.id===expect.output))note(expect.origin??'/expects/'+index,'断言必须明确指向产生原文的观察，等待和配置不是输出',true);
 gaps.push(...responderOutputGaps(slots,[...new Set(profile.seats.map(seat=>seat.device))]));
 return gaps;
}
