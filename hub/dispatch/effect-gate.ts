import {ReleaseTrace,ReleaseDiagnosticError,releaseField,type ReleaseCheck} from './release-diagnostics.ts';
import {ExecutorRegistry} from './executors.ts';
// Prepare P11 inputs once; the actual boundary is checked again immediately before intent.
import {RequirementsFile,type AllowedEffect} from '../../contracts/src/pack.ts';
import type {Principal,RecordsKit,Transaction,ActionBody} from '../records/api.ts';
import {canonicalize,sha256Hex} from '../records/api.ts';
import type {WorkflowStore,EffectCheckReplay,RunDetail} from '../ports.ts';
import {at,type ExecutorDefinition} from './definition.ts';
import {inspectInput,type VerificationPort,type VerifiedInput} from './proof.ts';
import {boundaryPolicy,policyAllows} from './policy.ts';
import {checkEffectBoundary,deny,durationBudget,EffectBoundaryError,type BoundaryContext} from './boundary.ts';
const equal=(a:unknown,b:unknown)=>a!==undefined&&b!==undefined&&canonicalize(a)===canonicalize(b);
export function effectParameters(input:VerifiedInput):Record<string,unknown>{return {target:input.target,manifest_sha256:input.manifest_sha256,build:input.build,sha256:input.sha256,items:input.items,generator:input.generator};}
export async function prepareEffectGate(o:{records:RecordsKit;runs:VerificationPort;workflows:Pick<WorkflowStore,'byDigest'>;recheck?:EffectCheckReplay;by:Principal;run:string;executor:string;definition:ExecutorDefinition;resolved_digest:string;now:()=>Date}){
 const detail=await o.runs.getRun(o.by,o.run);if(!detail)throw new Error('运行对你不可用；请核对运行编号和读取权限');
 const workflow=await o.workflows.byDigest(detail.run.pack_digest);
 const effects=workflow?RequirementsFile.parse(await workflow.readJson('requirements.json')).effects??[]:[];
 const d=o.definition;
 // These are untrusted candidate parameters for row selection only. Clause 3 re-derives them from a verified warrant.
 const claims=detail.latest?[...detail.latest.result.cross_item,...Object.values(detail.latest.result.partitions).flatMap(items=>items.flatMap(item=>item.requirements.flatMap(requirement=>requirement.claims)))]:[];
 const data=claims.find(claim=>claim.requirement===d.proof.requirement&&claim.warrant.id===d.proof.warrant_id&&claim.warrant.producer==='function'&&claim.statement.verdict==='support')?.statement.data;
 const parameters:Record<string,unknown>={};
 for(const [name,pointer] of Object.entries({target:d.proof.target,manifest_sha256:d.proof.manifest_sha256,build:d.proof.build,sha256:d.proof.sha256,items:d.proof.items,generator:d.proof.generator})){const value=at(data,pointer);if(value!==undefined)parameters[name]=value;}
 const replay=async(checks:readonly string[])=>{
   if(!o.recheck||!detail.latest)throw new Error('缺少冻结提交的检查重核接口；请恢复接口后重核');
   return o.recheck({run:o.run,submission:detail.latest.result.submission,result:detail.latest.record,checks});
 };
 const supports=async(checks:readonly string[])=>{
   const outcomes=await replay(checks);
   return checks.every(id=>Array.isArray(outcomes[id])&&outcomes[id].length>0&&outcomes[id].every(outcome=>outcome.verdict==='support'));
 };
 const budget=async(row:AllowedEffect,tx?:Transaction)=>{
   const intents=await o.records.store.findMany<ActionBody>({kind:'action',key:'dispatch.effect_row',values:[`${o.run}:${row.id}`]},tx);
   return {count:intents.length,duration_ms:intents.reduce((sum,intent)=>sum+Number(intent.body.detail.effect_duration_ms),0)};
 };
 const inspectRelease=async(row:AllowedEffect)=>{
   const proof=await inspectInput(o.by,o.run,d,o.records,o.runs,o.workflows,o.now());
   const trace=new ReleaseTrace();trace.checks.push(...proof.checks);
   const derived=proof.input?effectParameters(proof.input):undefined;
   trace.check('release.parameters.keys','派发参数字段集合与核验事实一致',derived?equal(Object.keys(parameters).sort(),Object.keys(derived).sort()):null,[releaseField('parameters.keys',derived?Object.keys(derived).sort():undefined,Object.keys(parameters).sort(),derived?equal(Object.keys(parameters).sort(),Object.keys(derived).sort()):null)]);
   for(const name of ['target','manifest_sha256','build','sha256','items','generator'])trace.check('release.parameters.'+name,'派发参数与重新读取的核验事实一致',derived?equal(parameters[name],derived[name]):null,[releaseField('parameters.'+name,derived?.[name],parameters[name],derived?equal(parameters[name],derived[name]):null)]);
   trace.check('release.artifact','效果行产物要求项等于执行器指定要求项',row.release.artifact===d.proof.requirement,[releaseField('row.release.artifact',d.proof.requirement,row.release.artifact,row.release.artifact===d.proof.requirement)]);
   const latest=await trace.read('release.latest.read','当前受理结果读取完成',()=>o.runs.getRun(o.by,o.run));
   trace.check('release.latest.available','当前受理结果存在',!!latest?.latest,[releaseField('latest','present',!!latest?.latest,!!latest?.latest)]);
   for(const [index,key] of row.release.requirements.entries()){
     const requirement=workflow?.requirements.find(requirement=>requirement.key===key);
     trace.check('release.requirements.'+index+'.declared','效果行的放行要求项在冻结包中声明',!!requirement,[releaseField('row.release.requirements.'+index,key,requirement?.key,!!requirement)]);
     if(requirement?.target==='item'){
       const statuses=latest?.latest?.result.partitions.delivered.map(item=>{const position=item.requirements.findIndex(requirement=>requirement.requirement===key);return {position,status:item.requirements[position]?.status};});
       trace.check('release.requirements.'+index+'.satisfied','当前交付条目的放行要求项全部满足',statuses?statuses.every(value=>value.status==='satisfied'):null,statuses?.map((value,item)=>releaseField('latest.partitions.delivered.'+item+'.requirements'+(value.position>=0?'.'+value.position+'.status':''),'satisfied',value.status,value.status==='satisfied'))??[]);
     }else{
       const values=latest?.latest?.result.cross_item.filter(claim=>claim.requirement===key);
       trace.check('release.requirements.'+index+'.satisfied','当前运行级放行要求项有有效且未过期的支持主张',requirement&&values?values.length>0&&values.every(claim=>claim.statement.verdict==='support'&&claim.validity.status==='valid'&&(!claim.validity.expires_at||Date.parse(claim.validity.expires_at)>o.now().getTime())):null,values?.flatMap((claim)=>{const position=latest!.latest!.result.cross_item.indexOf(claim);return [releaseField('latest.cross_item.'+position+'.statement.verdict','support',claim.statement.verdict,claim.statement.verdict==='support'),releaseField('latest.cross_item.'+position+'.validity.status','valid',claim.validity.status,claim.validity.status==='valid'),releaseField('latest.cross_item.'+position+'.validity.expires_at','after_now_or_absent',claim.validity.expires_at,!claim.validity.expires_at||Date.parse(claim.validity.expires_at)>o.now().getTime())];})??[]);
     }
   }
   return {checks:trace.checks,...(proof.input&&trace.checks.every(check=>check.satisfied===true)?{input:proof.input}:{}),latest};
 };
 const context:Omit<BoundaryContext,'lease'|'content'|'audience'>={effects,parameters,write:d.calls.submit.write??{effect_class:'job',retry_safety:'unsafe',signing:'service_on_behalf'},trigger:'hub_template',started_at:detail.run.started_at,now:o.now,duration_ms:d.max_run_ms,
   parameterPrerequisite:async row=>{
     if(!detail.latest||detail.latest.result.acceptance!=='accepted'||Object.keys(parameters).length!==6){const checks=row?(await inspectRelease(row)).checks:[];throw new EffectBoundaryError({...deny(3,'EFFECT_RELEASE_UNMET','缺少已受理核验事实及其完整派发参数；先完成该运行的产物核验，再派发同一份已核验字节',row),admin_checks:checks});}
   },
   parameterPolicy:async row=>{
     if(!('policy'in row.parameters))return false;
     const id=row.parameters.check;
     if(!o.recheck)throw new EffectBoundaryError({...deny(2,'PACK_POLICY_DENIED',`参数政策检查 ${id} 缺少冻结提交重核接口；未取得参数范围结论，请 Hub 管理员恢复接口后重核，未提交`,row),fix:'请 Hub 管理员恢复冻结提交的检查重核接口，再重核该参数政策；不修改已核验的参数'});
     const outcomes=(await replay([id]))?.[id];
     if(!Array.isArray(outcomes)||!outcomes.length||outcomes.some(outcome=>outcome.verdict==='unknown'))throw new EffectBoundaryError({...deny(2,'PACK_POLICY_DENIED',`参数政策检查 ${id} 缺少完整的范围判定事实；未取得参数范围结论，请检查负责人补齐冻结来源并重新核验，未提交`,row),fix:'请检查负责人补齐该政策检查的冻结来源、支持或驳回结论，再重核同一参数对象'});
     return outcomes.every(outcome=>outcome.verdict==='support'&&equal(at(outcome.data,'/parameters'),parameters));
   },
   release:async row=>{
     const report=await inspectRelease(row);
     if(!report.input)throw new ReleaseDiagnosticError('放行条件核对未完成',report.checks);
     detail.latest=report.latest!.latest;
     return report.input;
   },budget,
   global:async()=>{
     const current=await new ExecutorRegistry(o.records).get(o.executor);if(!current?.definition.enabled||current.resolved_digest!==o.resolved_digest)return false;
     const policy=await boundaryPolicy();if(detail.run.policy!==policy.version||!detail.run.executors||!d.environment)return false;
     const bytes=await o.records.objects.get(detail.run.executors);if(!bytes||sha256Hex(bytes)!==detail.run.executors)return false;
     const registry=JSON.parse(new TextDecoder().decode(bytes));
     return registry[o.executor]===o.resolved_digest&&policyAllows(policy.document,{effect_class:context.write.effect_class,reversible:d.calls.submit.write?.reversible??false,environment:d.environment});
   },policies:row=>supports(row.policy_checks),
 };
 return {detail,context,inspectRelease,
   preflight:()=>checkEffectBoundary({...context,until:4,lease:async()=>({ok:false}),content:async()=>false,audience:async()=>false}),
   reserveBudget:async(row:AllowedEffect,tx:Transaction)=>{
     await o.records.store.lock(`dispatch.effect-budget:${o.run}:${row.id}`,tx);
     const used=await budget(row,tx);
     if(o.now().getTime()>=Date.parse(detail.run.started_at)+row.deadline_ms||used.count+1>row.budget.count||used.duration_ms+d.max_run_ms>durationBudget(row,d.max_run_ms))throw new EffectBoundaryError(deny(4,'EFFECT_BUDGET_EXHAUSTED',`效果行 ${row.id} 的预算已被其他意图占用；请开始新修订`,row));
   }
 };
}
export {EffectBoundaryError} from './boundary.ts';
