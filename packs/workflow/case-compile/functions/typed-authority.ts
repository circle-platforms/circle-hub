import {blockMeta,blockPointer} from './blocks.ts';
import {blockGraphGaps} from './block-checks.ts';
import {blockRuntimeGaps,assertionTarget,assertionCells} from './block-runtime.ts';
import {prepareRestores} from './block-restore.ts';
import {commandObligations,definitionKey} from './command-obligations.ts';
import {within} from './command-policy.ts';
import {planCommands} from './plan-commands.ts';
// One authority boundary is shared by checks, generation, workbook verification and dispatch.
import { runtimeMethod, type RuntimeContract } from './runtime-contract.ts';
import type { RuntimeProfile } from './profile.ts';
import {readSlots, type PlanSlots} from './slots.ts';
import {bindArguments} from './binding.ts';
import {identityOf,identityKey,valueProblem,type Authority,type ValueType} from './typed-contract.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
import type {Verdict} from '../../../../contracts/generated/vocabulary.ts';
import {addressKey} from './manifest.ts';
export interface AuthorityGap { document: string; pointer: string; message: string; verdict?:Verdict;obligation?:Record<string,unknown> }
export function replacedIdentity(identity:CommandIdentity,slots:PlanSlots):CommandIdentity {
 const out=structuredClone(identity);for(const p of out.parameters)if(p.parsed.kind==='address'&&(p.parsed.value.kind==='ipv4'||p.parsed.value.kind==='ipv6')){const original=p.parsed.value.value;const replacement=slots.replacements.find(r=>addressKey(r.case)===addressKey(original));if(replacement){p.parsed.value.value=replacement.bed;p.raw=replacement.bed;}}return out;
}
export function typedAuthorityGaps(contract: RuntimeContract, profile: RuntimeProfile, slots: PlanSlots, known?:unknown,catalog?:unknown,caseTexts:readonly string[]=[],manifestSha?:string,services?:unknown): AuthorityGap[] {
 const blockGaps=blockRuntimeGaps(contract,profile,slots,catalog);if(blockGaps.length)return blockGaps;
 const gaps:AuthorityGap[]=[];const note=(pointer:string,message:string,verdict:Verdict='unknown')=>gaps.push({document:'contract',pointer,message,verdict});
 const resolution=planCommands(contract,profile,slots,catalog);gaps.push(...resolution.problems);gaps.push(...prepareRestores(contract,profile,slots,catalog,resolution.byLine,manifestSha));gaps.push(...blockGraphGaps(contract,profile,slots,catalog,resolution.byLine,services));const knownIds=Array.isArray(known)?known.map(identityOf):known===undefined?[]:null;
 const keys=new Set((knownIds??[]).filter((i):i is CommandIdentity=>i!==null).map(i=>definitionKey(replacedIdentity(i,slots))));
 const usage=new Map<string,{budget:number;count:number}>();
 const effectUse=(a:Authority,at:string)=>{for(const e of a.effects){const row=usage.get(e.id)??{budget:e.budget,count:0};row.count++;row.budget=Math.min(row.budget,e.budget);usage.set(e.id,row);if(row.count>row.budget)note(at,`效果 ${e.id} 的计划调用 ${row.count} 次超过声明预算 ${row.budget} 次`,'refute');}};
 for(const [index,step]of slots.steps.entries()){
  const at=`/steps/${index}`,entry=runtimeMethod(contract,step.object,step.method),allowed=profile.allowed.find(p=>p.object===step.object&&p.method===step.method);
  if(!entry||!allowed){note(at,'方法不在合约与发布配置的共同允许集合','refute');continue;}
  const a=entry.authority;if(!a){note(entry.sourcePointer??at,'缺 runtime-contract@2 的类型、角色闭集、效果表和来源引用；旧合约一律未核对');continue;}
  effectUse(a,at);
  const bound=bindArguments(entry,step,at,new Set(Object.entries(allowed.parameters).filter(([,role])=>role==='executor_return').map(([name])=>name)));for(const problem of bound.problems)note(problem.pointer,problem.message,'refute');
  const omitted=new Set(allowed.unsupplied??[]);
  for(const v of bound.values){if(omitted.has(v.name)){note(v.pointer,`参数 ${v.name} 已声明永不传入`,'refute');continue;}const p=a.parameters[v.name];if(!p){note(v.pointer,`参数 ${v.name} 的原合约类型与角色未声明`);continue;}if(allowed.parameters[v.name]!==p.role){note(v.pointer,`参数 ${v.name} 的配置角色不等于合约闭集声明`,'refute');continue;}
   const kind=p.type.address_kind??p.type.declaration.catalog_type;if((kind==='ipv4'||kind==='ipv6')&&typeof a.roles[p.role]?.bed_member!=='boolean')note(v.pointer,'地址角色缺 bed_member 用途声明');
   const problem=valueProblem(p.type,v.value);if(problem)note(v.pointer,problem,'refute');
   if(p.role==='host_shell'&&!a.effects.some(e=>e.allowed_literals.includes(String(v.value))))note(v.pointer,'主机命令不在合约效果表的完整字面允许集合','refute');
   if(p.role==='device_cli'){
    if(knownIds===null||knownIds.some(i=>i===null)){note(v.pointer,'用例声明身份结构未核对；修正 case_index 的明确声明后重核');continue;}
    const parsed=resolution.byLine.get(String(v.value));const matches=parsed?[parsed]:[];
    if(matches.length!==1)continue;
    const identity=matches[0];if(step.cleanup!==true&&knownIds.length&&!keys.has(definitionKey(identity)))note(v.pointer,'计划命令与用例明确声明的命令身份不一致（已核显式类型化替换）','refute');
    if(!a.effects.some(e=>(e.command_scope!==undefined||e.commands!==undefined)&&(e.command_scope===undefined||e.command_scope.some(prefix=>within(identity.path,prefix)))&&(e.commands===undefined||e.commands.some(i=>identityKey(replacedIdentity(i,slots))===identityKey(identity)))))note(v.pointer,'完整命令身份不在合约声明范围与逐条允许集合的交集','refute');
    for(const parameter of identity.parameters)if(parameter.parsed.kind==='address'&&(parameter.parsed.value.kind==='ipv4'||parameter.parsed.value.kind==='ipv6')){const role=commandRole(a,identity,parameter.position,parameter.role?.name);if(!role||typeof a.roles[role]?.bed_member!=='boolean')note(v.pointer,`命令参数位置 ${parameter.position} 缺合约闭集角色及 bed_member 用途声明`);}
   }
  }
 }
 for(const [i,expect]of slots.expects.entries()){
  const target=assertionTarget(contract,profile,expect),entry=target?.entry,a=entry?.authority,name=target?Object.keys(target.call.parameters).find(name=>target.call.parameters[name]==='literal_assertion'):null;
  if(!a||!name||!a.parameters[name])note(entry?.sourcePointer??'/entries','断言方法缺类型、角色或效果依据');
  else{effectUse(a,`/expects/${i}`);if(a.parameters[name].role!=='literal_assertion')note(`/expects/${i}`,'断言角色不等于原合约声明','refute');if(!expect.register){const problem=valueProblem(a.parameters[name].type,assertionCells(expect,target!).g);if(problem)note(`/expects/${i}/text`,problem,'refute');}if(expect.count!==undefined&&target){const countName=Object.keys(target.call.parameters).find(name=>target.call.parameters[name]==='checkpoint_count');if(countName&&a.parameters[countName]){const problem=valueProblem(a.parameters[countName].type,expect.count);if(problem)note(`/expects/${i}/count`,problem,'refute');}}}
 }
 gaps.push(...commandObligations((awaitOperations(contract,profile,slots)),slots,catalog,caseTexts));
 return gaps.map(gap=>({...gap,pointer:blockPointer(slots,gap.pointer)}));
}
function awaitOperations(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots){return slots.steps.flatMap((step,index)=>{const entry=runtimeMethod(contract,step.object,step.method),allowed=profile.allowed.find(call=>call.object===step.object&&call.method===step.method);if(!entry||!allowed)return [];return bindArguments(entry,step,`/steps/${index}`).values.filter(value=>allowed.parameters[value.name]==='device_cli'&&typeof value.value==='string').map(value=>({line:String(value.value),pointer:value.pointer,object:step.object,cleanup:step.cleanup===true}));});}
function commandRole(a:Authority,i:CommandIdentity,position:number,native?:string):string|null {
 const declared=a.effects.flatMap(e=>e.command_roles.filter(b=>b.signature===i.signature&&b.position===position).map(b=>b.role));
 if(native&&a.roles[native]&&a.effects.some(e=>e.roles.includes(native)))declared.push(native);
 const roles=[...new Set(declared)];return roles.length===1?roles[0]:null;
}
export interface AddressUse {value:string|number;kind:string;bed_member:boolean|undefined;pointer:string}
export function typedAddressUses(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,catalog?:unknown):AddressUse[]{
 // Flat callers keep their existing boundary; a block carrier must be lowered even when its steps is empty.
 if(slots.blocks?.length){
  const parsed=readSlots(slots);
  if(!parsed.ok)throw new Error('类型化地址检查需要完整结构计划：'+parsed.problems.map(problem=>problem.pointer+' '+problem.message).join('；'));
  slots=parsed.slots;
 }
 const resolved=planCommands(contract,profile,slots,catalog);
 const uses:AddressUse[]=[];const put=(type:ValueType,value:string|number,a:Authority,role:string,pointer:string)=>{const kind=type.address_kind??type.declaration.catalog_type;if(kind==='ipv4'||kind==='ipv6'||kind==='mask'||kind==='ipv4_prefix'||kind==='ipv6_prefix')uses.push({value,kind,bed_member:a.roles[role]?.bed_member,pointer});};
 for(const [index,step]of slots.steps.entries()){const entry=runtimeMethod(contract,step.object,step.method),a=entry?.authority;if(!entry||!a)continue;for(const v of bindArguments(entry,step,blockMeta(slots)&&step.origin?'/data'+step.origin:`/data/steps/${index}`).values){const param=a.parameters[v.name];if(!param)continue;put(param.type,v.value,a,param.role,v.pointer);if(param.role==='device_cli')for(const raw of [resolved.byLine.get(String(v.value))]){const i=identityOf(raw);if(!i)continue;for(const p of i.parameters)if(p.parsed.kind==='address'){const role=commandRole(a,i,p.position,p.role?.name);uses.push({value:p.parsed.value.value,kind:p.parsed.value.kind,bed_member:role?a.roles[role]?.bed_member:undefined,pointer:v.pointer+'/command_parameters/'+p.position});}}}}
 const assertion=profile.allowed.find(call=>Object.values(call.parameters).includes('literal_assertion'));if(assertion){const a=runtimeMethod(contract,assertion.object,assertion.method)?.authority,name=Object.keys(assertion.parameters).find(n=>assertion.parameters[n]==='literal_assertion');if(a&&name&&a.parameters[name])slots.expects.forEach((e,i)=>put(a.parameters[name].type,e.text,a,a.parameters[name].role,`/data/expects/${i}/text`));}
 return uses;
}
export const authorityRecovery = (gaps: readonly AuthorityGap[]): string => {
 const repair=gaps.some(gap=>gap.verdict==='refute')?'当前运行者按指针和未完成义务补齐作者命令、合法参数及逆序清理，再重新核验；不得改冻结授权绕过':'当前运行者按指针请求产品包、合约或台架发布管理员补齐相应事实；产品命令规则更新后重新育苗并开新运行';
 return `缺少原合约的类型与效果事实或不符合显式授权：${gaps.map(gap => `${gap.document}${gap.pointer}：${gap.message}`).join('；')}。下一步：${repair}；原合约按 runtime-contract@2 核对。不得编辑冻结 profile 绕过。Hub 为缺失事实绑定具名受众与期限；当前不生成或派发工作簿。`;
};
