// Symbolic restore obligations are not CommandIdentity values. Only an executor-declared pre-send guard may resolve them.
import {blockMeta} from './blocks.ts';
import {runtimeBlocks} from './block-runtime.ts';
import {runtimeMethod,type RuntimeContract} from './runtime-contract.ts';
import type {RuntimeProfile} from './profile.ts';
import type {PlanSlots} from './slots.ts';
import type {AuthorityGap} from './typed-authority.ts';
import {bindArguments} from './binding.ts';
import {readCommandPolicy,within,pathSegments} from './command-policy.ts';
import {isRecord} from './text.ts';
import {canonicalJson} from './canonical-json.ts';
import type {CommandIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
export function prepareRestores(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,catalog:unknown,identities:ReadonlyMap<string,CommandIdentity>,manifestSha?:string):AuthorityGap[]{
 if(!blockMeta(slots))return [];
 const cap=runtimeBlocks(contract),policy=readCommandPolicy(isRecord(catalog)?catalog.policy:undefined),gaps:AuthorityGap[]=[];
 const note=(pointer:string,message:string,refute=false)=>gaps.push({document:'blocks',pointer,message,verdict:refute?'refute':'unknown'});
 for(const step of slots.steps.filter(step=>step.restore_for!==undefined)){
  const at=step.origin??'/blocks',configured=slots.steps[(step.restore_for??0)-1];
  if(!configured||!isRecord(catalog)||typeof catalog.root!=='string'||!policy||!manifestSha){note(at,'缺捕获恢复的锁根目录、产品逆关系或冻结清单原字节摘要；下一步：绑定完整 inventory 与 command-policy 后重核');continue;}
  const entry=runtimeMethod(contract,configured.object,configured.method),allowed=profile.allowed.find(call=>call.object===configured.object&&call.method===configured.method);
  const lines=entry?bindArguments(entry,configured,at).values.filter(value=>allowed?.parameters[value.name]==='device_cli'&&typeof value.value==='string'):[];
  const identity=lines.length===1?identities.get(String(lines[0].value)):null;
  if(!identity){note(at,'恢复对象没有唯一的已完整解析配置身份；先修原配置，不能从回显猜身份');continue;}
  if(policy.read_only.some(prefix=>within(identity.path,prefix))){note(at,'只读观察不是可由捕获恢复的配置操作',true);continue;}
  const rules=policy.inverse_rules.filter(rule=>within(identity.path,rule.source_prefix)).sort((a,b)=>pathSegments(b.source_prefix)!.length-pathSegments(a.source_prefix)!.length),rule=rules[0];
  if(!rule||rule.leading_parameters===undefined||rules[1]?.source_prefix===rule.source_prefix){note(at,'缺捕获恢复的唯一逆路径及显式前导身份参数数量；下一步：产品包维护者补 inverse_rules 后重新育苗');continue;}
  const path='/'+[...pathSegments(rule.inverse_prefix)!,...pathSegments(identity.path)!.slice(pathSegments(rule.source_prefix)!.length)].join('/');
  const entries=Array.isArray(catalog.authority_entries)?catalog.authority_entries:Array.isArray(catalog.entries)?catalog.entries:[];
  if(!entries.some(row=>isRecord(row)&&Array.isArray(row.words)&&'/commands/'+row.words.map(word=>encodeURIComponent(String(word))).join('/')===path)){note(at,'锁定目录缺捕获恢复的目标命令路径；下一步：重新读取逆路径声明后核验');continue;}
  const guard=Array.isArray(cap?.restore_methods)?cap.restore_methods.find((row:any)=>isRecord(row)&&row.object===step.object&&row.method===step.method):null;
  if(!guard||typeof guard.root_parameter!=='string'||typeof guard.target_parameter!=='string'){note(at,'缺守卫方法 root_parameter / target_parameter 声明；下一步：执行器维护者补原合约后发布');continue;}
  const method=runtimeMethod(contract,step.object,step.method),a=method?.authority;
  if(!a?.effects.some(effect=>effect.command_scope?.some(prefix=>within(path,prefix)))){note(at,'恢复目标不在捕获还原方法的效果范围里',true);continue;}
  const target={tree_root:catalog.root,path,leading_parameters:[...identity.parameters].sort((a,b)=>a.position-b.position).slice(0,rule.leading_parameters),bed:profile.bed,manifest_sha256:manifestSha};
  for(const [key,value]of [[guard.root_parameter,catalog.root],[guard.target_parameter,canonicalJson(target)]] as Array<[string,string]>){if(Object.hasOwn(step.keywords,key)&&step.keywords[key]!==value)note(at+'/keywords/'+key,'模型填写的守卫绑定不等于冻结输入的机械派生值',true);else step.keywords[key]=value;}
  step.restore_target=target;
 }
 return gaps;
}
