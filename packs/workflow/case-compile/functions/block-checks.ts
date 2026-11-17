// Checks declarations and reference graphs, never evaluates a device response or guesses semantic roles from words.
import TABLE from '../tables/blocks-format.json' with {type:'json'};
import {blockMeta} from './blocks.ts';
import {isRecord} from './text.ts';
import type {PlanSlots} from './slots.ts';
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
 for(const {step,index}of configured)if(!context.causal_links.some((link:any)=>link.from===step.id&&observations.some(row=>row.step.id===link.to&&row.index>=index)))note(step.origin??'/blocks','缺配置到后续观察的因果声明；下一步：模型引用原文，明确哪个观察检验该配置，不能从合法 after 推定因果');
 for(const [index,link]of context.causal_links.entries()){
  const from=meta.steps.get(link.from),to=meta.steps.get(link.to);if(!from||!to||from>to||!slots.steps[to-1].output)note('/block_context/causal_links/'+index,'因果边必须由已有步骤指向不早于它的原文观察',true);
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
