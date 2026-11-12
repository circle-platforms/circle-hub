// Work-language lowering only: no device output is inspected and no command is inferred from prose.
import TABLE from '../tables/blocks-format.json' with {type:'json'};
import SHAPE from '../tables/block-plan.schema.json' with {type:'json'};
import {schema} from './schema.ts';
import {cellArguments,cellTemplate} from './cell-selection.ts';
import {isRecord} from './text.ts';
import type {PlanSlots,PlanStep,PlanExpect,SlotProblem} from './slots.ts';
export interface RegisterDefinition {name:string;block:string;step:number;object:string;cell?:boolean}
export interface BlockMeta {raw:Record<string,unknown>;registers:Map<string,RegisterDefinition>;steps:Map<string,number>;deferred:Array<{pointer:string;missing:string;next_action:string}>}
const normalized=new WeakMap<object,BlockMeta>();
export const blockMeta=(slots:PlanSlots)=>normalized.get(slots);
export function withoutModelIdentities(slots:PlanSlots):PlanSlots{const {command_identities:_ignored,...copy}=slots;const meta=normalized.get(slots);if(meta)normalized.set(copy,meta);return copy;}
export const sourcePlan=(slots:PlanSlots):unknown=>normalized.get(slots)?.raw??slots;
export const isNormalized=(value:unknown):value is PlanSlots=>typeof value==='object'&&value!==null&&normalized.has(value);
export function identifier(value:unknown):value is string{
 if(typeof value!=='string'||!value.length||value.length>TABLE.limits.register_chars)return false;
 return [...value].every((c,index)=>c==='_'||c>='A'&&c<='Z'||c>='a'&&c<='z'||index>0&&c>='0'&&c<='9');
}
export function blockPointer(slots:PlanSlots,pointer:string):string{
 const parts=pointer.split('/');if(parts[1]==='steps'&&Number.isSafeInteger(Number(parts[2]))){const step=slots.steps[Number(parts[2])];if(step?.origin){
  if(step.block_kind==='SELECT_CELL'){
   const base=step.origin.slice(0,-'/call'.length);
   if(parts[3]==='args'&&Number(parts[4])>0)return base+'/select/where/'+(Number(parts[4])-1)+'/value';
   if(parts[3]==='keywords'&&['separator','columns','format','header'].includes(parts[4]))return base+'/table/'+parts[4];
   if(parts[3]==='keywords'&&parts[4]==='column')return base+'/column';
   if(parts[3]==='keywords'&&parts[4]==='row')return base+'/select/row';
  }
  return step.origin+parts.slice(3).map(part=>'/'+part).join('');
 }}
 if(parts[1]==='expects'&&Number.isSafeInteger(Number(parts[2]))){const expect=slots.expects[Number(parts[2])];if(expect?.origin)return expect.origin+parts.slice(3).map(part=>'/'+part).join('');}
 return pointer;
}
export function readBlockSlots(value:Record<string,unknown>):{ok:true;slots:PlanSlots}|{ok:false;problems:SlotProblem[]}{
 if(!schema(SHAPE).safeParse(value).success)return {ok:false,problems:[{pointer:'/blocks',message:'块计划不符合包声明的完整形状；按 slots.schema.json 修正，不能与 steps/expects 混写'}]};
 const blocks=value.blocks as Array<Record<string,any>>,steps:PlanStep[]=[],expects:PlanExpect[]=[],problems:SlotProblem[]=[];
 const meta:BlockMeta={raw:value,registers:new Map(),steps:new Map(),deferred:[]},ids=new Set<string>(),assertions=new Set<string>();
 const issue=(pointer:string,message:string)=>problems.push({pointer,message});
 const capture=(name:unknown,id:string,index:number,at:string,object:string,cell=false)=>{
  if(!identifier(name))issue(at,'寄存器必须是区分大小写的 ASCII 标识符，不能以数字开头');
  else if(meta.registers.has(name))issue(at,'寄存器已经捕获，不能覆盖先前原文');
  else meta.registers.set(name,{name,block:id,step:index,object,...(cell?{cell:true}:{})});
 };
 const expectation=(raw:Record<string,any>,after:number,origin:string,extra:Partial<PlanExpect>={})=>{
  const id=raw.id??blocks[Number(origin.split('/')[2])]?.id;
  if(!identifier(id)||assertions.has(id)){issue(origin+'/id','断言 id 不合式或重复');return;}
  assertions.add(id);
  if(!TABLE.assertion_ops.some(row=>row.op===raw.op))issue(origin+'/op','断言族不在包声明的闭集中');
  if(raw.op==='found_times'&&(!Number.isSafeInteger(raw.count)||raw.count<1))issue(origin+'/count','次数断言必须有正整数 count');
  if(raw.op!=='found_times'&&raw.count!==undefined)issue(origin+'/count','只有次数断言可以写 count');
  expects.push({id,origin,operator:raw.op,output:raw.output,text:raw.literal??raw.quote?.text??'',quote:raw.quote,after,expectation:raw.expectation,...(raw.count!==undefined?{count:raw.count}:{}),...(raw.criterion?{criterion:raw.criterion,basis:'model_judgment',rationale:'类型化判据声明须经独立复核'}:{}),...extra});
 };
 for(const [index,block]of blocks.entries()){
  const at='/blocks/'+index,id=block.id;
  if(!identifier(id)||ids.has(id)){issue(at+'/id','块 id 不合式或重复');continue;}ids.add(id);
  const declaration=TABLE.kinds.find(row=>row.kind===block.kind)!;
  if(!declaration.enabled){meta.deferred.push({pointer:at,missing:'missing'in declaration?String(declaration.missing):'缺该块运行器能力',next_action:'next_action'in declaration?String(declaration.next_action):'维护者补声明后重开运行'});continue;}
  if(block.kind==='CAPTURE_COMPARE'){
   const left=meta.registers.get(block.left),right=meta.registers.get(block.right);
   if(!left||!right||block.left===block.right)issue(at,'捕获比较必须引用前序两个不同的捕获，不能比较自身或前向引用');
   if(right&&block.output!==right.block)issue(at+'/output','比较的 output 必须精确指向第二个捕获块');
   if(left&&right&&left.step>=right.step)issue(at,'left 必须先于 right 捕获');
   if(!TABLE.relations.includes(block.relation))issue(at+'/relation','比较关系不在包声明的闭集中');
   const common={...block,id,op:'abs_found',output:block.output};
   expectation(common,steps.length,at,{register:block.left,actual_register:block.right,comparison:block.relation});
   if(block.relation==='same')expectation({...common,id:id+'_reverse'},steps.length,at,{register:block.right,actual_register:block.left,comparison:'same'});
   continue;
  }
  if(block.kind==='SELECT_CELL'){
   const captured=meta.registers.get(block.from);
   if(!captured||captured.cell)issue(at+'/from','取一格必须引用本条前面保存的完整设备输出');
   if(block.call.args.length||Object.keys(block.call.keywords).length)issue(at+'/call','取一格的参数由已声明的表格和选择条件生成，call只写对象和方法');
   if(block.table.format==='key_value'&&(block.table.separator===''||block.table.columns!==2))issue(at+'/table','键值行需要非空字面分隔符和两列');
   if(block.table.separator===''&&block.table.columns!==1)issue(at+'/table','没有分隔符时只能声明单列');
   if(typeof block.column==='number'&&block.column>block.table.columns)issue(at+'/column','取值列超出声明列数');
   for(const [conditionIndex,condition]of (block.select.where??[]).entries())if(condition.column>block.table.columns)issue(at+'/select/where/'+conditionIndex+'/column','选行列超出声明列数');
   const step:PlanStep={...block.call,...cellArguments({table:block.table,column:block.column,select:block.select}),id,origin:at+'/call',block_kind:block.kind,description:'按声明的行列结构取一格',input_register:block.from,cell_input:true,save_as:block.register};
   steps.push(step);meta.steps.set(id,steps.length);capture(block.register,id,steps.length,at+'/register',step.object,true);continue;
  }
  const call=block.call as PlanStep,step:PlanStep={...call,args:[...call.args],keywords:{...call.keywords},id,origin:at+'/call',block_kind:block.kind,...(block.cleanup===true||block.kind==='RESTORE_FROM'?{cleanup:true}:{})};
  const output=block.kind==='OBSERVE_ASSERT'||block.kind==='OBSERVE_ONLY'||block.kind==='CAPTURE'||block.kind==='EXPECT_FROM'||block.kind==='STEP'&&block.output!==undefined;
  if(output){step.output=true;if(block.kind==='STEP'&&block.output!==id)issue(at+'/output','STEP 的 output 必须是本块 id');}
  steps.push(step);meta.steps.set(id,steps.length);
  if(block.input_register!==undefined){
   const captured=meta.registers.get(block.input_register);
   if(!captured?.cell)issue(at+'/input_register','普通命令的输入必须引用本条前面取出的单格');
   if(!call.args.length||!cellTemplate(call.args[0])||call.args.slice(1).some(value=>value.includes('{')||value.includes('}'))||Object.values(call.keywords).some(value=>typeof value==='string'&&(value.includes('{')||value.includes('}'))))issue(at+'/call','单格回填只在首位置参数写一个{}或重复的{0}');
   step.input_register=block.input_register;step.cell_input=true;
  }
  if(block.kind==='CAPTURE'||block.kind==='STEP'&&block.register!==undefined){
   if(!output)issue(at,'捕获必须有产生原文的观察');capture(block.register,id,steps.length,at+'/register',call.object);step.save_as=block.register;
  }
  if(block.kind==='OBSERVE_ASSERT')for(const [ai,assertion]of block.assertions.entries()){
   if(assertion.output!==id)issue(at+'/assertions/'+ai+'/output','断言必须明确指向本次产生原文的观察');
   expectation(assertion,steps.length,at+'/assertions/'+ai);
  }
  if(block.kind==='EXPECT_FROM'){
   if(!meta.registers.has(block.expected_from))issue(at+'/expected_from','期望寄存器必须先捕获后引用');
   if(block.output!==id)issue(at+'/output','EXPECT_FROM 的 output 必须指向本次观察');
   expectation({...block,op:block.op==='found'?'abs_found':block.op},steps.length,at,{register:block.expected_from});
  }
  if(block.kind==='RESTORE_FROM'){
   const captured=meta.registers.get(block.register),target=meta.steps.get(block.for);
   if(!captured||captured.cell||!target||captured.step>=target||target>=steps.length)issue(at,'恢复必须引用改动前的捕获及前序配置块');
   if(captured&&captured.object!==call.object)issue(at,'捕获和恢复必须是同一设备对象');
   step.restore_for=target;step.input_register=block.register;
   if(call.args.length!==1||call.args[0]!=='{}')issue(at+'/call/args','捕获还原只接收完整原文参数 {}，由声明的守卫方法核验后执行；不拼接或解析回显');
  }
 }
 const slots:PlanSlots={...(value.recomposition!==undefined?{recomposition:value.recomposition as PlanSlots['recomposition']}:{}),bucket:String(value.bucket),blocks:blocks,steps,expects,replacements:value.replacements as PlanSlots['replacements'],...(Object.hasOwn(value,'command_identities')?{command_identities:value.command_identities}:{}),...(value.block_context!==undefined?{block_context:value.block_context as Record<string,any>}:{}),...(value.criteria!==undefined?{criteria:value.criteria as Array<Record<string,any>>}:{}),...(value.obligations!==undefined?{obligations:value.obligations as Array<Record<string,any>>}:{})};
 normalized.set(slots,meta);return problems.length?{ok:false,problems}:{ok:true,slots};
}
/** Escape a declared literal for a regex-backed checkpoint; no author-provided regex is executed or inferred. */
export function escapedLiteral(text:string):string{let out='';for(const character of text){if('\\^$.*+?()[]{}|'.includes(character))out+='\\';out+=character;}return out;}
