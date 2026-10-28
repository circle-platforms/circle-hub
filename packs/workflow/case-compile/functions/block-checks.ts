// Checks declarations and reference graphs, never evaluates a device response or guesses semantic roles from words.
import TABLE from '../tables/blocks-format.json' with {type:'json'};
import {blockMeta} from './blocks.ts';
import {isRecord} from './text.ts';
import type {PlanSlots} from './slots.ts';
import type {RuntimeProfile} from './profile.ts';
import type {AuthorityGap} from './typed-authority.ts';
import {runtimeMethod,type RuntimeContract} from './runtime-contract.ts';
import {bindArguments} from './binding.ts';
import {readCommandPolicy,within} from './command-policy.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
export function blockGraphGaps(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,catalog:unknown,identities:ReadonlyMap<string,CommandIdentity>,services?:unknown):AuthorityGap[]{
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
  if(matches.length!==1){note(step.origin??'/blocks','缺主机观察的唯一应答者声明；下一步：模型明确 device / fixture / bed_service，未定写 undetermined 及出口');continue;}
  const row=matches[0],at='/block_context/responders/'+context.responders.indexOf(row);
  if(!TABLE.responder_kinds.includes(row.kind))note(at,'应答者类型不在包声明闭集中',true);
  else if(row.kind==='undetermined')note(at,(row.missing??'应答者未定')+'；下一步：'+(row.next_action??'模型核对来源和请求链后补明确应答者'));
  else if(row.kind==='device'&&!profile.seats.some(seat=>seat.device===row.ref))note(at,'设备应答者不在冻结设备座位中',true);
  else if(row.kind==='fixture'){const source=meta.steps.get(row.ref),target=meta.steps.get(step.id!);if(!source||!target||source>=target)note(at,'案内 fixture 必须指向本次观察之前已安排的步骤',true);}
  else if(row.kind==='bed_service'){if(!Array.isArray(services))note(at,'缺冻结台架服务清单；下一步：补绑定 inventory 后重新核验');else if(!services.some(service=>isRecord(service)&&service.host===row.ref))note(at,'床服务应答者没有冻结服务声明',true);}
 }
 for(const [index,expect]of slots.expects.entries())if(!observations.some(row=>row.step.id===expect.output))note(expect.origin??'/expects/'+index,'断言必须明确指向产生原文的观察，等待和配置不是输出',true);
 for(const [index,row]of context.responders.entries())if(!observations.some(value=>value.step.id===row.output))note('/block_context/responders/'+index,'应答者必须对应实际观察输出',true);
 return gaps;
}
