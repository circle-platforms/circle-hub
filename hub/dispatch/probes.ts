// Expectations are read from the locked build and bound manifest; wire commands remain deployment data.
import { isIP } from 'node:net';
import { canonicalBytes, parseStrictJson, sha256Hex, type RecordsKit } from '../records/api.ts';
import type { KnowledgePort } from '../ports.ts';
import { at, type ExecutorDefinition } from './definition.ts';
import type { JobBinding, Journal } from './journal.ts';
import { canRetryRead } from './read-policy.ts';
import { RpcClient, ToolReplyError, type Exchange } from './transport.ts';
import {PrecheckFactError} from './precheck-failure.ts';
export type BuildKnowledge = Pick<KnowledgePort,'builds'|'resolveBuild'> & Partial<Pick<KnowledgePort,'rootInfo'>>;
function addresses(values: unknown[]): string[] {
  return [...new Set(values.map(value=>{
    if(typeof value!=='string') throw new Error('接口地址不是文字');
    const [ip,prefix,...rest]=value.trim().split('/'); const family=isIP(ip);
    if(!family || rest.length || prefix!==undefined && (!/^\d+$/.test(prefix) || Number(prefix)>(family===4?32:128)))throw new Error('接口地址格式不符');
    return family===6 ? new URL(`http://[${ip}]/`).hostname.slice(1,-1) : ip;
  }))].sort();
}
export async function assessProbes(records: RecordsKit, knowledge: BuildKnowledge|undefined,binding:JobBinding,d:ExecutorDefinition,client:RpcClient,context:Record<string,unknown>,journal:Journal,sleep:(ms:number)=>Promise<void>):Promise<boolean> {
  const spec=d.probes!; const owner=await records.principals.get(binding.user);
  if(!owner || owner.disabled || !d.manifest_sha256)throw new PrecheckFactError('缺少有效探测主体或绑定清单','管理员恢复预订运行的有效主体，核对清单来源及摘要绑定后再采证');
  let source;
  try{source=await records.artifacts.source(owner,d.manifest_sha256,{consumer:'function'});}catch{throw new PrecheckFactError('绑定清单的读取前提未成立','管理员核对该清单的可见性、凭据扫描及受理状态，恢复允许函数读取的清单后再采证');}
  if(!source?.bytes || sha256Hex(source.bytes)!==d.manifest_sha256)throw new PrecheckFactError('绑定清单字节不可读或完整性未通过','管理员按绑定摘要恢复清单原件，核对可见性与受理状态并验证摘要后再采证');
  let manifest:unknown;
  try{manifest=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(source.bytes));}catch{throw new PrecheckFactError('绑定清单不是有效的 UTF-8 JSON','管理员读取受限清单原件，修复清单格式并重新发布正确摘要后再采证');}
  const devices=spec.devices!==undefined?at(manifest,spec.devices):undefined;
  if(!Array.isArray(devices) || !devices.length)throw new PrecheckFactError('绑定清单里没有可核对的设备集合','管理员核对设备集合指针与绑定清单，补齐设备清单后再采证');
  // Which of the manifest's devices commands are dispatched to is declared, never recognised: without a declaration every
  // listed device is a dispatch target; with one, exactly the devices whose declared type field equals one of the
  // definition's declared target types (P07 R[1], C07 R[4]). Only targets need a probe seat; a device whose type the
  // manifest does not declare cannot be placed and stops the precheck. No name or keyword decides anything here.
  const declared=spec.dispatch_targets;
  const typeOf=(device:unknown):string|null=>{
    if(declared===undefined)return null;
    const value=at(device,declared.type_field);
    if(typeof value!=='string' || value==='')throw new PrecheckFactError('清单设备没有声明的类型字段，不能判断它是不是派发目标','管理员按清单模式补齐每台设备的类型字段（取值来自声明的闭集），或在执行器定义里改用显式派发座位声明后重新采证');
    return value;
  };
  const targets=declared===undefined?devices:devices.filter(device=>declared.types.includes(typeOf(device) as string));
  if(declared!==undefined && !targets.length)throw new PrecheckFactError('清单里没有一台设备声明为派发目标','管理员核对派发目标的类型闭集与清单的类型字段；没有派发目标就不能采证派发');
  const selected=spec.seats.map(seat=>at(manifest,seat.manifest.device));
  if(targets.length!==selected.length || new Set(selected).size!==targets.length || targets.some(device=>!selected.includes(device)))throw new PrecheckFactError(`缺少覆盖全部 ${targets.length} 个派发目标设备的一一对应探测座位`,'管理员核对设备集合指针、派发目标的类型闭集与各座位声明，为每个派发目标补一个座位、去掉非派发目标的座位后再采证');
  // Listed for the precheck answer: manifest devices that are not dispatch targets, by manifest position and declared type.
  const unprobed=devices.map((device,index)=>({device,index})).filter(row=>!targets.includes(row.device)).map(row=>({index:row.index,type:typeOf(row.device)}));
  if(typeof context.build!=='string')throw new PrecheckFactError('缺少锁定构建','管理员提供含锁定构建的预订运行，或在预检上下文登记已核实的构建身份后再采证');
  const names=new Set([context.build]);
  if(knowledge) {
    if(typeof context.product!=='string')throw new PrecheckFactError('缺少产品绑定，不能核对知识库构建别名','管理员核对预订所属产品并绑定产品身份后再采证');
    const current=await knowledge.resolveBuild(context.product,context.build);
    const base=typeof context.build_base==='string' ? context.build_base : current?.base;
    if(!base)throw new PrecheckFactError('知识库没有锁定构建的身份记录','管理员核对构建出处并同步构建名字与基础名的身份记录后再采证');
    names.add(base);
    if(current?.base===base)names.add(current.name);
    for(const alias of await knowledge.builds(context.product))if(alias.base===base)names.add(alias.name);
  }
  let verified=true; const assessments:string[]=[];
  probeLoop: for(const seat of spec.seats)for(const [key,check] of Object.entries({version:seat.version,interfaces:seat.interfaces})) {
    let response:Exchange|undefined;let refused=false;let failedSource:string|undefined;
    for(let attempt=1;attempt<=3;attempt++) {
      try{ response=await client.declaredRead(spec.call,{...context,command:check.command,seat_index:seat.index},`probe.${seat.index}.${key}`);break; }
      catch(error) {const retry=canRetryRead(error,d,context);if(error instanceof ToolReplyError)failedSource=error.source; await journal.append(binding,'probe.retry','read','error',{seat:seat.seat,check:key,attempt,next_action:retry && attempt<3?'自动重读本座位，不提交':'目标拒绝或原件不可保存，修复后重跑 precheck，未提交'});if(!retry){refused=true;break;} if(attempt<3)await sleep(d.poll_ms); }
    }
    let matched=false,actual:string[]=[],expected:string[]=[],reason='回显里没有所需字段';
    try {
      const text=response && at(response.value,spec.output);
      if(typeof text==='string') actual=[...text.matchAll(new RegExp(check.pattern,'gm'))].flatMap(m=>Object.values(m.groups??{})).filter((v):v is string=>typeof v==='string' && v.length>0);
      if(key==='version') {expected=[...names].sort();matched=actual.length===1 && names.has(actual[0]);}
      else { const entries=at(at(manifest,seat.manifest.device),seat.manifest.addresses); if(!Array.isArray(entries) || !entries.length)throw new Error('清单里没有座位接口地址'); expected=addresses(entries.map(e=>at(e,seat.manifest.address))); actual=addresses(actual); matched=JSON.stringify(actual)===JSON.stringify(expected); }
      if(actual.length)reason='回显值与锁定构建或绑定清单不符';
    }catch{reason='清单或回显中缺少有效接口地址；请核对提取规则和清单';}
    if(!response)reason=refused?'目标明确拒绝或原件无法保存；停止后续设备登录，请负责人核对受限原件和读取配置':'只读应答连续三次不可用；恢复读取后重跑预检';
    const refs=response?[response.source]:failedSource?[failedSource]:[];
    const artifact=await records.artifacts.ingest({bytes:canonicalBytes({seat:seat.seat,check:key,matched,actual,expected,reason:matched?null:reason}),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:[`src:${d.manifest_sha256}`,...refs]}},author:{user:null},provenanceType:'projected',visibility:{readers:[binding.user],admins:true,packs:[],shareable:false}});
    assessments.push(`src:${artifact.body.sha256}`);
    await journal.append(binding,'device_probe','validate','completed',{seat:seat.seat,check:key,matched,lease_digest:sha256Hex(canonicalBytes([context.lease_id,context.lease_token])),...(!matched?{missing_fact:`座位 ${seat.seat} 的 ${key}：${reason}`,next_action:key==='version'?'管理员读取该座位受限原件，按锁定构建及已核实别名核对设备版本，恢复正确构建或修正提取声明后再采证':'管理员读取该座位受限原件，逐一核对清单接口全集与实际接口，恢复缺少的接口事实或修正提取声明后再采证'}:{})},[`src:${artifact.body.sha256}`,...refs]);
    verified=verified && matched;
    if(refused)break probeLoop;
  }
  const report=await records.artifacts.ingest({bytes:canonicalBytes({verified,assessments,...(unprobed.length?{unprobed_non_targets:unprobed}:{})}),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:assessments}},author:{user:null},provenanceType:'projected',visibility:{readers:[binding.user],admins:true,packs:[],shareable:false}});
  await journal.append(binding,'result','read_back','completed',{reference:`src:${report.body.sha256}`,probe_assessments:assessments.length,...(unprobed.length?{unprobed_non_targets:unprobed,note:`${unprobed.length} 台清单设备未探测（非派发目标，按声明的类型闭集判定）；它们只按清单身份参与拓扑与地址绑定，不派发命令`}:{})},assessments);
  return verified;
}
