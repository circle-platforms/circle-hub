import {ReleaseTrace,ReleaseDiagnosticError,releaseField,releaseDifferences,type ReleaseCheck} from './release-diagnostics.ts';
import {parseReference} from '../refs/api.ts';
import type { Principal, RecordsKit } from '../records/api.ts';
import type { RunDetail, RunsService, WorkflowStore } from '../ports.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import { canonicalize, isSha256 } from '../records/api.ts';
import { at, type ExecutorDefinition } from './definition.ts';
export type VerificationPort = Pick<RunsService, 'getRun'>;
export interface VerifiedInput {
  judgments?:Claim[];
  product?: string; root?: string; build_base?: string;
  run: string; user: string; lineage: string; ancestors: string[]; item: string; items: string[];
  plan_run: string; sha256: string; target: string; manifest_sha256: string; build: string; generator: unknown; result: string;
}
export class InputVerificationError extends ReleaseDiagnosticError {}
function validClaim(c: Claim, now: Date): boolean {
  return c.statement.verdict === 'support' && c.validity.status === 'valid' && (!c.validity.expires_at || Date.parse(c.validity.expires_at) > now.getTime());
}
export function lockedBuildBase(run:RunDetail['run']):string|undefined {
  const bases=new Set((run.target_basis ?? []).flatMap(c=>{
    const data=c.statement.data;
    return at(data,'/field')==='build' && at(data,'/value')===run.build && c.validity.status==='valid' && typeof at(data,'/base')==='string' ? [String(at(data,'/base'))] : [];
  }));
  if(bases.size>1)throw new InputVerificationError('运行锁定的构建依据不一致；请核对原始构建选择记录');
  return bases.values().next().value;
}
/** Inspect exactly the predicates used by dispatch; missing dependencies remain unchecked, never guessed. */
export async function inspectInput(by:Principal,id:string,d:ExecutorDefinition,records:RecordsKit,runs:VerificationPort,workflows:Pick<WorkflowStore,'byDigest'>,now:Date):Promise<{checks:ReleaseCheck[];input?:VerifiedInput}>{
 const trace=new ReleaseTrace();const add=trace.check.bind(trace);const f=releaseField;
 add('proof.warrant_id','声明了指定核验函数',!!d.proof.warrant_id,[f('proof.warrant_id','nonempty',d.proof.warrant_id,!!d.proof.warrant_id)]);
 const detail=await trace.read('run.read','核验运行读取完成',()=>runs.getRun(by,id));
 add('run.available','核验运行可读取',detail!==null,[f('run','readable',!!detail,!!detail)]);
 add('run.management','核验运行未被管理放弃',detail?detail.management?.disposition!=='abandon':null,[f('run.management.disposition','not_abandon',detail?.management?.disposition,detail?detail.management?.disposition!=='abandon':null)]);
 add('run.runner','核验运行有发起用户',detail?!!detail.run.runner:null,[f('run.runner','present',!!detail?.run.runner,detail?!!detail.run.runner:null)]);
 add('run.package','核验包等于执行器声明',detail?detail.run.pack.split('@')[0]===d.proof.package:null,[f('run.pack.package',d.proof.package,detail?.run.pack.split('@')[0],detail?detail.run.pack.split('@')[0]===d.proof.package:null)]);
 const result=detail?.latest?.result;
 add('result.acceptance','最近核验结果已受理',detail?result?.acceptance==='accepted':null,[f('result.acceptance','accepted',result?.acceptance,detail?result?.acceptance==='accepted':null)]);
 const workflow=detail?await trace.read('workflow.read','冻结任务包读取完成',()=>workflows.byDigest(detail.run.pack_digest)):null;
 add('workflow.identity','冻结包的版本及摘要相符',detail?!!workflow&&`${workflow.pack.id}@${workflow.pack.version}`===detail.run.pack&&workflow.pack.digest===detail.run.pack_digest:null,[f('workflow.pack',detail?.run.pack,workflow?`${workflow.pack.id}@${workflow.pack.version}`:undefined,detail&&workflow?`${workflow.pack.id}@${workflow.pack.version}`===detail.run.pack:null),f('workflow.pack_digest',detail?.run.pack_digest,workflow?.pack.digest,detail&&workflow?workflow.pack.digest===detail.run.pack_digest:null)]);
 add('result.run','核验结果属于本运行',result?result.run===id:null,[f('result.run',id,result?.run,result?result.run===id:null)]);
 add('result.errors','核验结果没有未消除错误',result?result.errors.length===0:null,[f('result.errors',[],result?.errors,result?result.errors.length===0:null)]);
 add('result.partitions','所有条目都在交付分区',result?Object.entries(result.partitions).every(([key,list])=>key==='delivered'||list.length===0):null,Object.entries(result?.partitions??{}).filter(([key])=>key!=='delivered').map(([key,list])=>f('result.partitions.'+key,[],list,list.length===0)));
 const projected=detail?.run.items.map(item=>item.id).sort();
 add('run.items','核验运行明确且只有一个目标条目',detail?projected!.length===1:null,[f('run.items.length',1,projected?.length,detail?projected!.length===1:null)]);
 add('result.coverage','交付结果覆盖投影条目',result&&projected?canonicalize(projected)===canonicalize(result.partitions.delivered.map(item=>item.item).sort()):null,[f('result.partitions.delivered.items',projected,result?.partitions.delivered.map(item=>item.item).sort(),result&&projected?canonicalize(projected)===canonicalize(result.partitions.delivered.map(item=>item.item).sort()):null)]);
 const required=workflow?.requirements.filter(requirement=>requirement.required)??[];
 if(!workflow)add('requirements.available','必需要求项声明可读取',null);
 for(const [index,requirement] of required.entries()){
  const values=requirement.target==='item'?result?.partitions.delivered.map(item=>item.requirements.find(row=>row.requirement===requirement.key)?.status):result?.cross_item.filter(claim=>claim.requirement===requirement.key);
  const pass=!!values?.length&&(requirement.target==='item'?values.every(value=>value==='satisfied'):(values as Claim[]).every(claim=>validClaim(claim,now)));
  const fields=[f('workflow.requirements.'+workflow!.requirements.indexOf(requirement)+'.key',requirement.key,requirement.key,true)];
  if(requirement.target==='item'&&result)for(const [itemIndex,item]of result.partitions.delivered.entries()){
   const position=item.requirements.findIndex(row=>row.requirement===requirement.key),value=item.requirements[position];
   fields.push(f('result.partitions.delivered.'+itemIndex+'.requirements'+(position>=0?'.'+position+'.status':''),'satisfied',value?.status,value?.status==='satisfied'));
  }else if(result)for(const claim of result.cross_item.filter(claim=>claim.requirement===requirement.key)){
   const position=result.cross_item.indexOf(claim);fields.push(f('result.cross_item.'+position+'.validity','valid_support',claim.validity,validClaim(claim,now)));
  }
  add('requirements.'+index,requirement.target==='item'?'条目必需要求项满足':'运行必需要求项有有效支持主张',result?pass:null,fields);
 }
 const proofRequirement=required.find(requirement=>requirement.key===d.proof.requirement);
 add('proof.requirement','派发要求项是必需事实要求项',workflow?!!proofRequirement&&proofRequirement.accepted_producer==='fact':null,[f('proof.requirement',d.proof.requirement,proofRequirement?.key,workflow?!!proofRequirement:null),f('proof.requirement.accepted_producer','fact',proofRequirement?.accepted_producer,workflow?proofRequirement?.accepted_producer==='fact':null)]);
 const all=result?[...result.cross_item,...result.partitions.delivered.flatMap(item=>item.requirements.filter(row=>row.requirement===d.proof.requirement).flatMap(row=>row.claims))].filter(claim=>claim.requirement===d.proof.requirement):[];
 const facts=all.filter(claim=>claim.qualifier.nature==='fact'),functions=facts.filter(claim=>claim.warrant.producer==='function'),designated=functions.filter(claim=>claim.warrant.id===d.proof.warrant_id),claims=designated.filter(claim=>validClaim(claim,now));
 add('proof.claims.nature','存在对应的事实主张',result?facts.length>0:null,all.map((claim,index)=>f('proof.claims.'+index+'.qualifier.nature','fact',claim.qualifier.nature,claim.qualifier.nature==='fact')));
 add('proof.claims.producer','存在函数生产的核验事实',result?functions.length>0:null,facts.map((claim,index)=>f('proof.claims.'+index+'.warrant.producer','function',claim.warrant.producer,claim.warrant.producer==='function')));
 add('proof.claims.warrant_id','核验函数身份等于执行器指定身份',result?designated.length>0:null,functions.length?functions.map((claim,index)=>f('proof.claims.'+index+'.warrant.id',d.proof.warrant_id,claim.warrant.id,claim.warrant.id===d.proof.warrant_id)):[f('proof.claims.warrant.id',d.proof.warrant_id,undefined,false)]);
 add('proof.claims.validity','指定核验事实支持且有效未过期',result?claims.length>0:null,designated.flatMap((claim,index)=>[f('proof.claims.'+index+'.statement.verdict','support',claim.statement.verdict,claim.statement.verdict==='support'),f('proof.claims.'+index+'.validity.status','valid',claim.validity.status,claim.validity.status==='valid'),f('proof.claims.'+index+'.validity.expires_at','after_now_or_absent',claim.validity.expires_at,!claim.validity.expires_at||Date.parse(claim.validity.expires_at)>now.getTime())]));
 const consistent=claims.length>0&&claims.every(claim=>canonicalize(claim.statement.data??null)===canonicalize(claims[0].statement.data??null));
 add('proof.claims.consistency','有效核验事实的数据相互一致',result?consistent:null,claims.flatMap((claim,index)=>releaseDifferences('proof.claims.'+index+'.statement.data',claims[0]?.statement.data,claim.statement.data)));
 const data=claims[0]?.statement.data,planRun=at(data,d.proof.plan_run),sha256=at(data,d.proof.sha256),ids=at(data,d.proof.items),target=at(data,d.proof.target),manifest=at(data,d.proof.manifest_sha256),build=at(data,d.proof.build),generator=at(data,d.proof.generator);
 const hasData=consistent;
 add('proof.plan_run','产物的计划运行等于本运行前驱',hasData?typeof planRun==='string'&&!!planRun&&planRun===detail?.run.predecessor:null,[f('proof.plan_run',detail?.run.predecessor,planRun,hasData?typeof planRun==='string'&&!!planRun&&planRun===detail?.run.predecessor:null)]);
 const shapes:Array<[string,unknown,string,boolean]>=[['sha256',sha256,'sha256',typeof sha256==='string'&&isSha256(sha256)],['items',ids,'single_unique_nonempty_string',Array.isArray(ids)&&ids.length===1&&ids.every(value=>typeof value==='string'&&!!value&&value.length<=200)&&new Set(ids).size===ids.length],['target',target,'string',typeof target==='string'],['manifest_sha256',manifest,'sha256',typeof manifest==='string'&&isSha256(manifest)],['build',build,'nonempty_string',typeof build==='string'&&!!build],['generator',generator,'present_nonnull',generator!==undefined&&generator!==null]];
 for(const [key,value,shape,pass] of shapes)add('proof.fields.'+key,'派发身份字段符合声明形状',hasData?pass:null,[f('proof.'+key,shape,value,hasData?pass:null)]);
 const sourceHas=(sha:unknown,slot?:string)=>typeof sha==='string'&&!!detail?.run.sources.some(source=>{try{const ref=parseReference(source.reference);return ref.scheme==='src'&&ref.sha256===sha&&(slot===undefined||source.slot===slot&&source.role==='artifact_under_verification');}catch{return false;}});
 add('proof.artifact_slot','核验字节绑定在声明的待核验产物槽',hasData?sourceHas(sha256,d.proof.slot):null,[f('proof.slot',d.proof.slot,detail?.run.sources.filter(source=>source.slot===d.proof.slot).map(source=>({slot:source.slot,role:source.role,reference:source.reference})),hasData?sourceHas(sha256,d.proof.slot):null)]);
 add('proof.bound_sources','核验字节与清单都已绑定本运行',hasData?sourceHas(sha256)&&sourceHas(manifest):null,[f('run.sources.sha256',sha256,sourceHas(sha256)?sha256:undefined,hasData?sourceHas(sha256):null),f('run.sources.manifest_sha256',manifest,sourceHas(manifest)?manifest:undefined,hasData?sourceHas(manifest):null)]);
 add('proof.executor_identity','核验目标与清单等于执行器声明',hasData?target===d.target&&manifest===d.manifest_sha256:null,[f('target',d.target,target,hasData?target===d.target:null),f('manifest_sha256',d.manifest_sha256,manifest,hasData?manifest===d.manifest_sha256:null)]);
 add('proof.build','核验构建等于运行锁定构建',hasData?detail?.run.build===undefined||detail.run.build===build:null,[f('build',detail?.run.build,build,hasData?detail?.run.build===undefined||detail.run.build===build:null)]);
 const owner=detail?.run.runner?await trace.read('runner.read','发起用户读取完成',()=>records.principals.get(detail.run.runner!)):null;
 add('runner.enabled','运行发起用户存在且启用',detail?!!owner&&!owner.disabled:null,[f('run.runner.enabled',true,owner?!owner.disabled:undefined,detail?!!owner&&!owner.disabled:null)]);
 const ancestors:string[]=[],lineageFields:import('./release-diagnostics.ts').ReleaseField[]=[];let ancestor=detail;let lineageValid=!!detail&&!!owner;
 while(ancestor&&owner){
  lineageFields.push(f('run.lineage.'+ancestors.length+'.runner',owner.id,ancestor.run.runner,ancestor.run.runner===owner.id),f('run.lineage.'+ancestors.length+'.run','unseen_bounded_run',ancestor.run.run,!ancestors.includes(ancestor.run.run)&&ancestors.length<100));
  if(ancestors.includes(ancestor.run.run)||ancestors.length>=100||ancestor.run.runner!==owner.id){lineageValid=false;break;}
  ancestors.push(ancestor.run.run);const predecessor=ancestor.run.predecessor;
  ancestor=predecessor?await trace.read('lineage.read.'+ancestors.length,'血缘前驱读取完成',()=>runs.getRun(by,predecessor)):null;
  if(predecessor&&!ancestor){lineageValid=false;break;}
 }
 add('run.lineage','血缘无环、有界、同一发起用户且前驱可读',detail&&owner?lineageValid:null,lineageFields);
 let buildBase:string|undefined;
 try{if(detail)buildBase=lockedBuildBase(detail.run);add('run.build_basis','锁定构建依据没有冲突',detail?true:null);}
 catch{add('run.build_basis','锁定构建依据没有冲突',false,[f('run.target_basis','unique_build_base',detail?.run.target_basis,false)]);}
 const judgments=result?.partitions.delivered.flatMap(item=>item.requirements.filter(requirement=>required.some(template=>template.key===requirement.requirement)).flatMap(requirement=>requirement.claims)).filter(claim=>claim.qualifier.nature==='judgment'&&claim.warrant.producer==='model'&&claim.statement.data?.judgment_source!==undefined)??[];
 if(judgments.length)add('proof.judgment_premises','模型判断前提绑定到当前提交且仍有效',judgments.every(claim=>claim.validity.status==='valid'&&(!claim.validity.expires_at||Date.parse(claim.validity.expires_at)>now.getTime())&&at(claim.statement.data,'/judgment_source/submission')===result?.submission&&claim.validity.bound.includes(result!.submission)&&claim.statement.data?.model===claim.warrant.id),judgments.flatMap((claim,index)=>[f('proof.judgment_premises.'+index+'.source',result?.submission,at(claim.statement.data,'/judgment_source/submission'),at(claim.statement.data,'/judgment_source/submission')===result?.submission),f('proof.judgment_premises.'+index+'.validity.status','valid',claim.validity.status,claim.validity.status==='valid'),f('proof.judgment_premises.'+index+'.validity.expires_at','after_now_or_absent',claim.validity.expires_at,!claim.validity.expires_at||Date.parse(claim.validity.expires_at)>now.getTime()),f('proof.judgment_premises.'+index+'.validity.bound',result?.submission,claim.validity.bound,!!result&&claim.validity.bound.includes(result.submission)),f('proof.judgment_premises.'+index+'.model',claim.warrant.id,claim.statement.data?.model,claim.statement.data?.model===claim.warrant.id)]));
 if(trace.checks.some(check=>check.satisfied!==true)||!detail||!owner||!result)return {checks:trace.checks};
 return {checks:trace.checks,input:{...(judgments.length?{judgments}:{}),...(buildBase?{build_base:buildBase}:{}),...(detail.run.product?{product:detail.run.product}:{}),...(detail.run.root?{root:detail.run.root}:{}),run:id,plan_run:planRun as string,user:owner.id,lineage:ancestors.at(-1)!,ancestors,item:detail.run.items[0].id,items:ids as string[],sha256:sha256 as string,target:target as string,manifest_sha256:manifest as string,build:build as string,generator,result:detail.latest!.record}};
}
export async function verifyInput(by:Principal,id:string,d:ExecutorDefinition,records:RecordsKit,runs:VerificationPort,workflows:Pick<WorkflowStore,'byDigest'>,now:Date):Promise<VerifiedInput>{
 const report=await inspectInput(by,id,d,records,runs,workflows,now);
 if(!report.input)throw new InputVerificationError('派发前提核对未完成；请管理员查看放行条件诊断后重新核验',report.checks);
 return report.input;
}
