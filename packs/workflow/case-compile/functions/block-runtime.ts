// Explicit runner declarations, never method-name heuristics or inspection of device output.
import TABLE from '../tables/blocks-format.json' with {type:'json'};
import {isRecord} from './text.ts';
import {sourceDocument,runtimeMethod,type RuntimeContract,type RuntimeEntry} from './runtime-contract.ts';
import type {RuntimeProfile,AllowedCall} from './profile.ts';
import type {PlanSlots,PlanExpect} from './slots.ts';
import type {AuthorityGap} from './typed-authority.ts';
import {blockMeta,escapedLiteral} from './blocks.ts';
export function runtimeBlocks(contract:RuntimeContract):Record<string,any>|null{
 const document=sourceDocument(contract),runtime=isRecord(document?.runtime)?document.runtime:{};
 return isRecord(runtime.block_model)&&runtime.block_model.schema===TABLE.runtime_schema?runtime.block_model:null;
}
export interface AssertionTarget {call:AllowedCall;entry:RuntimeEntry;matching:string}
export function assertionTarget(contract:RuntimeContract,profile:RuntimeProfile,expect?:PlanExpect):AssertionTarget|null{
 const calls=profile.allowed.filter(call=>Object.values(call.parameters).includes('literal_assertion'));
 if(!expect?.operator){const declaration=runtimeBlocks(contract)?.default_assertion;const found=profile.block_model===true&&isRecord(declaration)?calls.filter(call=>call.object===declaration.object&&call.method===declaration.method):calls;const call=found.length===1?found[0]:null;const entry=call?runtimeMethod(contract,call.object,call.method):null;return call&&entry?{call,entry,matching:'literal'}:null;}
 const block=runtimeBlocks(contract);if(!block||profile.block_model!==true)return null;
 const source=expect.register?'register':'literal';
 const choices=expect.comparison==='differs'?(isRecord(block.differs)?[block.differs]:[]):Array.isArray(block.operators)?block.operators.filter((row:any)=>isRecord(row)&&row.op===expect.operator&&row.expected===source):[];
 if(choices.length!==1)return null;const row=choices[0];
 if(!TABLE.matching_modes.includes(row.matching)||expect.register&&row.matching==='escaped_literal'||expect.comparison==='differs'&&row.matching!=='exact_text'||expect.comparison!=='differs'&&row.matching==='exact_text')return null;
 const call=calls.find(call=>call.object===row.object&&call.method===row.method),entry=call?runtimeMethod(contract,call.object,call.method):null;
 return call&&entry?{call,entry,matching:row.matching}:null;
}
export function assertionCells(expect:PlanExpect,target:AssertionTarget):{g:string;h:string;i:string}{
 return {g:expect.register?'':target.matching==='escaped_literal'?escapedLiteral(expect.text):expect.text,h:expect.register??'',i:expect.count!==undefined?String(expect.count):expect.actual_register??''};
}
export function blockRuntimeGaps(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,catalog?:unknown):AuthorityGap[]{
 const meta=blockMeta(slots);if(!meta)return [];
 const gaps:AuthorityGap[]=[],note=(pointer:string,message:string,refute=false)=>gaps.push({document:'blocks',pointer,message,verdict:refute?'refute':'unknown'});
 for(const row of meta.deferred)note(row.pointer,row.missing+'；下一步：'+row.next_action);
 if(gaps.length)return gaps;
 const cap=runtimeBlocks(contract),document=sourceDocument(contract),runtime=isRecord(document?.runtime)?document.runtime:{};
 if(profile.block_model!==true||!cap){note('/blocks','缺已发布 block-runtime 能力及 profile 的显式启用；下一步：执行器维护者只读核对实现、补声明并重新发布合约/profile，不能改冻结输入绕过');return gaps;}
 const outputs=Array.isArray(cap.output_methods)?cap.output_methods:[];
 for(const [index,step]of slots.steps.entries()){
  const at=step.origin??'/steps/'+index,call=profile.allowed.find(value=>value.object===step.object&&value.method===step.method);
  if(step.output&&!outputs.some((row:any)=>isRecord(row)&&row.object===step.object&&row.method===step.method&&row.output===TABLE.raw_output))note(at,'缺该调用产生完整原文输出的运行器声明；下一步：维护者补 output_methods 后重新发布，不从方法名猜输出');
  if(step.save_as&&(contract.objects.includes(step.save_as)||Array.isArray(cap.reserved_registers)&&cap.reserved_registers.includes(step.save_as)))note(at,'捕获寄存器与运行器对象或保留命名冲突',true);
  if(step.save_as&&!Array.isArray(cap.reserved_registers))note(at,'缺运行器保留寄存器闭集；下一步：维护者按实现声明完整命名空间，不按前缀猜测');
  if(step.save_as&&cap.capture_registers!==true)note(at,'缺 H 列原文捕获能力；下一步：执行器维护者实现并声明 capture_registers 后重开运行');
  if(step.block_kind==='SLEEP'&&(!call||!Object.values(call.parameters).length||Object.values(call.parameters).some(role=>role!=='wait')))note(at,'SLEEP 必须精确对应本轮允许的 wait 调用',true);
  if(step.restore_for!==undefined){
   const registrations=Array.isArray(cap.restore_methods)?cap.restore_methods:[],registration=registrations.find((row:any)=>isRecord(row)&&row.object===step.object&&row.method===step.method);
   const entry=runtimeMethod(contract,step.object,step.method),name=entry?.parameters.find(parameter=>parameter.kind==='positional_only'||parameter.kind==='positional_or_keyword')?.name;
   if(!registration||registration.raw_input!==true||registration.complete_command_parse!==true||registration.role_checks!==true||registration.effect_scope_checks!==true||cap.restore_registers!==true)note(at,'缺捕获还原的发送前完整语法、参数角色与效果范围守卫；下一步：执行器维护者实现 guarded restore 并发布原合约，不用普通命令调用插入未知原文');
   else if(!entry?.authority||!name||call?.parameters[name]!==TABLE.restore_role||entry.authority.parameters[name]?.role!==TABLE.restore_role||!entry.authority.effects.some(effect=>effect.command_scope?.length))note(at,'捕获还原方法没有独立的 captured_restore 角色与闭集命令范围',true);
   else if(typeof registration.root_parameter!=='string'||!isRecord(catalog)||typeof catalog.root!=='string')note(at,'缺守卫方法的锁根参数声明或锁定目录；下一步：维护者补 root_parameter 并重新绑定目录');
   else if(Object.hasOwn(step.keywords,registration.root_parameter)&&step.keywords[registration.root_parameter]!==catalog.root)note(at,'捕获还原的守卫没有绑定本次冻结命令树根',true);
   const target=slots.steps[(step.restore_for??0)-1];if(!target||target.cleanup||target.object!==step.object||!profile.allowed.some(call=>call.object===target.object&&call.method===target.method&&Object.values(call.parameters).includes('device_cli')))note(at,'恢复必须指向本设备的业务配置，不能指等待、观察或别的设备',true);
  }
 }
 for(const [index,expect]of slots.expects.entries()){
  const at=expect.origin??'/expects/'+index;
  if(runtime.checkpoint_two_argument!==true)note(at,'缺 checkpoint_two_argument=true 的显式能力；下一步：执行器维护者核对检查点参数及原文来源后发布，不默认开放');
  if(expect.count!==undefined&&runtime.found_times_supported!==true)note(at,'缺 found_times_supported=true 的能力；下一步：维护者证明并发布次数检查实现，或保留 unmet 出口');
  if(expect.register&&cap.checkpoint_expected_register!==true)note(at,'缺检查点 H 列期望寄存器能力；下一步：维护者补声明后发布');
  if(expect.actual_register&&cap.checkpoint_result_register!==true)note(at,'缺检查点 I 列实际原文寄存器能力；下一步：维护者补声明后发布');
  const target=assertionTarget(contract,profile,expect);
  if(!target)note(at,'缺该断言族及字面/寄存器来源的唯一运行器映射；捕获差异需要全值字面不等，不能以正则型 not_found 代替；下一步：维护者补明确方法及匹配语义后发布');
  else if(!target.entry.authority)note(at,'断言方法缺类型化授权与效果依据；下一步：维护者补原始运行器类型和角色声明');
  else {if(expect.count!==undefined){const countName=Object.keys(target.call.parameters).find(name=>target.call.parameters[name]==='checkpoint_count');if(!countName||target.entry.authority.parameters[countName]?.role!=='checkpoint_count')note(at,'次数算子缺由 I 列提供 count 的独立角色，不能冒充前次输出',true);}
  const name=Object.keys(target.call.parameters).find(name=>target.call.parameters[name]==='literal_assertion');if(!name||target.entry.authority.parameters[name]?.role!=='literal_assertion')note(at,'断言的角色不等于合约声明',true);if(expect.register&&name&&target.entry.authority.parameters[name]?.type.declaration.catalog_type!=='string')note(at,'原文寄存器不能代替非文字类型参数',true);}
 }
 return gaps;
}
