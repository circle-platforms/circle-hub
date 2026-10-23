// Expectations are read from the locked build and bound manifest; wire commands remain deployment data.
import { isIP } from 'node:net';
import { canonicalBytes, parseStrictJson, sha256Hex, type RecordsKit } from '../records/api.ts';
import type { KnowledgePort } from '../ports.ts';
import { at, type ExecutorDefinition } from './definition.ts';
import type { JobBinding, Journal } from './journal.ts';
import { RpcClient, type Exchange } from './transport.ts';
function addresses(values: unknown[]): string[] {
  return [...new Set(values.map(value=>{
    if(typeof value!=='string') throw new Error('接口地址不是文字');
    const [ip,prefix,...rest]=value.trim().split('/'); const family=isIP(ip);
    if(!family || rest.length || prefix!==undefined && (!/^\d+$/.test(prefix) || Number(prefix)>(family===4?32:128)))throw new Error('接口地址格式不符');
    return family===6 ? new URL(`http://[${ip}]/`).hostname.slice(1,-1) : ip;
  }))].sort();
}
export async function assessProbes(records: RecordsKit, knowledge: Pick<KnowledgePort,'builds'|'resolveBuild'>|undefined,binding:JobBinding,d:ExecutorDefinition,client:RpcClient,context:Record<string,unknown>,journal:Journal,sleep:(ms:number)=>Promise<void>):Promise<boolean> {
  const spec=d.probes!; const owner=await records.principals.get(binding.user);
  if(!owner || !d.manifest_sha256)throw new Error('缺少探测主体或绑定清单；请补齐预订和清单');
  const source=await records.artifacts.source(owner,d.manifest_sha256,{consumer:'function'});
  if(!source?.bytes || sha256Hex(source.bytes)!==d.manifest_sha256)throw new Error('绑定清单字节不可读；请恢复清单后重跑预检');
  const manifest=parseStrictJson(new TextDecoder('utf-8',{fatal:true}).decode(source.bytes));
  if(typeof context.build!=='string')throw new Error('缺少锁定构建；请给预订运行或登记预检构建');
  const names=new Set([context.build]);
  if(knowledge) {
    if(typeof context.product!=='string')throw new Error('缺少产品绑定，不能核对知识库构建别名；请绑定产品后重跑');
    const base=await knowledge.resolveBuild(context.product,context.build);
    if(!base || typeof context.root!=='string' || base.root!==context.root)throw new Error('锁定构建的知识根不可核对；请恢复该根与构建绑定后重跑');
    names.add(base.base); names.add(base.name);
    for(const alias of await knowledge.builds(context.product)) if(alias.base===base.base && alias.root===base.root)names.add(alias.name);
  }
  let verified=true; const assessments:string[]=[];
  for(const seat of spec.seats)for(const [key,check] of Object.entries({version:seat.version,interfaces:seat.interfaces})) {
    let response:Exchange|undefined;
    for(let attempt=1;attempt<=3;attempt++) {
      try{ response=await client.declaredRead(spec.call,{...context,command:check.command,seat_index:seat.index},`probe.${seat.index}.${key}`);break; }
      catch { await journal.append(binding,'probe.retry','read','error',{seat:seat.seat,check:key,attempt,next_action:attempt<3?'自动重读本座位，不提交':'恢复只读连接后重跑 precheck，未提交'}); if(attempt<3)await sleep(d.poll_ms); }
    }
    let matched=false,actual:string[]=[],expected:string[]=[],reason='回显里没有所需字段';
    try {
      const text=response && at(response.value,spec.output);
      if(typeof text==='string') actual=[...text.matchAll(new RegExp(check.pattern,'gm'))].flatMap(m=>Object.values(m.groups??{})).filter((v):v is string=>typeof v==='string' && !!v.trim()).map(v=>v.trim());
      if(key==='version') {expected=[...names].sort();matched=actual.length===1 && names.has(actual[0]);}
      else { const entries=at(at(manifest,seat.manifest.device),seat.manifest.addresses); if(!Array.isArray(entries) || !entries.length)throw new Error('清单里没有座位接口地址'); expected=addresses(entries.map(e=>at(e,seat.manifest.address))); actual=addresses(actual); matched=JSON.stringify(actual)===JSON.stringify(expected); }
      if(actual.length)reason='回显值与锁定构建或绑定清单不符';
    }catch{reason='清单或回显中缺少有效接口地址；请核对提取规则和清单';}
    if(!response)reason='只读应答连续三次不可用；恢复读取后重跑预检';
    const artifact=await records.artifacts.ingest({bytes:canonicalBytes({seat:seat.seat,check:key,matched,actual,expected,reason:matched?null:reason}),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:[`src:${d.manifest_sha256}`,...(response?[response.source]:[])]}},author:{user:null},provenanceType:'projected',visibility:{readers:[binding.user],admins:true,packs:[],shareable:false}});
    assessments.push(`src:${artifact.body.sha256}`);
    await journal.append(binding,'device_probe','validate','completed',{seat:seat.seat,check:key,matched,lease_digest:sha256Hex(canonicalBytes([context.lease_id,context.lease_token])),...(!matched?{missing_fact:`座位 ${seat.seat} 的 ${key}：${reason}`,next_action:'读取受限核对原件，修正环境或声明后重跑预检'}:{})},[`src:${artifact.body.sha256}`,...(response?[response.source]:[])]);
    verified=verified && matched;
  }
  const report=await records.artifacts.ingest({bytes:canonicalBytes({verified,assessments}),mediaType:'application/json',origin:{generated:{generator:'dispatch@1',inputs:assessments}},author:{user:null},provenanceType:'projected',visibility:{readers:[binding.user],admins:true,packs:[],shareable:false}});
  await journal.append(binding,'result','read_back','completed',{reference:`src:${report.body.sha256}`,probe_assessments:assessments.length},assessments);
  return verified;
}
