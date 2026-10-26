import {releaseFailure,type ReleaseCheck} from './release-diagnostics.ts';
// One ordered, fail-closed P11 boundary. The callbacks reuse their owning packages rather than duplicate their logic.
import type {AllowedEffect} from '../../contracts/src/pack.ts';
import type {WriteDeclaration} from '../../contracts/src/resources.ts';
import type {EffectTrigger,Environment} from '../../contracts/generated/vocabulary.ts';
import type {ProtocolCode} from '../../contracts/generated/protocol.ts';
import {PROTOCOL_CODES} from '../../contracts/generated/protocol.ts';
import {canonicalize} from '../records/api.ts';
import type {VerifiedInput} from './proof.ts';
export interface BoundaryFailure {admin_checks?:ReleaseCheck[];ok:false;clause:number;code:ProtocolCode;message:string;fix:string;row?:string;requirements?:string[]}
export interface BoundaryContext {
 effects:readonly AllowedEffect[];write:Pick<WriteDeclaration,'effect_class'|'signing'|'retry_safety'>;trigger:EffectTrigger;
 parameters:Record<string,unknown>;started_at:string;now:()=>Date;duration_ms:number;
 parameterPrerequisite?:(row?:AllowedEffect)=>Promise<void>;
 parameterPolicy:(row:AllowedEffect)=>Promise<boolean>;
 release:(row:AllowedEffect)=>Promise<VerifiedInput>;
 budget:(row:AllowedEffect)=>Promise<{count:number;duration_ms:number}>;
 lease:()=>Promise<{ok:boolean;code?:Extract<ProtocolCode,'LEASE_UNAVAILABLE'|'LEASE_EXPIRED'|'FENCING_STALE'>;message?:string}>;
 global:(row:AllowedEffect)=>Promise<boolean>;
 policies:(row:AllowedEffect)=>Promise<boolean>;
 content:(input:VerifiedInput)=>Promise<boolean>;
 audience:()=>Promise<boolean>;
 until?:4;
}
export function deny(clause:number,code:ProtocolCode,message:string,row?:AllowedEffect):BoundaryFailure{return {ok:false,clause,code,message,fix:PROTOCOL_CODES[code].fix,...(row?{row:row.id,requirements:row.release.requirements}:{})};}
/** A preflight result is not a release grant for writing or retransmitting. */
export function incompleteEffectBoundary(result:{checked:number;row:AllowedEffect}):BoundaryFailure {
 return {...deny(3,'EFFECT_RELEASE_UNMET',`缺少完整九款效果放行核对事实，当前仅核到 ${result.checked} 款；不得据此写意图或重发`,result.row),fix:'请 Hub 管理员修复完整边界入口后重核九款；已有投递只读对账，不重交'};
}
export function durationBudget(row:AllowedEffect,maximum:number):number {return typeof row.budget.duration_ms==='number'?row.budget.duration_ms:maximum;}
export async function checkEffectBoundary(ctx:BoundaryContext):Promise<{ok:true;row:AllowedEffect;input:VerifiedInput;checked:number}|BoundaryFailure>{
 const candidates=ctx.effects.filter(row=>row.resource_kind==='executor'&&row.action==='submit'&&row.effect_class===ctx.write.effect_class&&row.trigger===ctx.trigger);
 const hint=candidates.length===1?candidates[0]:ctx.effects.length===1?ctx.effects[0]:undefined;
 if(!candidates.length || ctx.write.signing==='own_credential'&&ctx.trigger!=='runner_session')return deny(1,'EFFECT_NOT_ALLOWED','本运行没有允许该动作、实例效果类和真实触发方式的效果行',hint);
 const unavailable=(error:unknown,row?:AllowedEffect):BoundaryFailure=>error instanceof EffectBoundaryError?error.failure:({...deny(2,'PACK_POLICY_DENIED',`参数政策检查 ${row&&'policy'in row.parameters?row.parameters.check:row?.id??'未定行'} 无法重核；未取得参数范围结论，请 Hub 管理员恢复冻结提交的读取和该检查后重核，未提交`,row),fix:'请 Hub 管理员恢复冻结提交的读取和参数政策检查，再重核同一参数对象；未取得范围结论前不提交'});
 try{await ctx.parameterPrerequisite?.(hint);}catch(error){return unavailable(error,hint);}
 const matches:AllowedEffect[]=[],failed:Array<{row:AllowedEffect;error:unknown}>=[];
 for(const row of candidates){let match=false;try{if('values' in row.parameters){const values=row.parameters.values;const keys=Object.keys(ctx.parameters).sort();match=canonicalize(keys)===canonicalize(Object.keys(values).sort())&&keys.every(key=>values[key].some(value=>canonicalize(value)===canonicalize(ctx.parameters[key])));}else match=await ctx.parameterPolicy(row);}catch(error){failed.push({row,error});}if(match)matches.push(row);}
 if(matches.length>1)return deny(2,'EFFECT_PARAMETER_OUT_OF_RANGE','参数同时匹配多行；请包负责人消除范围重叠后开新修订',hint);
 if(failed.length)return unavailable(failed[0].error,failed[0].row);
 if(!matches.length)return deny(2,'EFFECT_PARAMETER_OUT_OF_RANGE','参数未落在唯一的允许范围；请按该行范围重新核验',hint);
 const row=matches[0];let input:VerifiedInput;
 try{input=await ctx.release(row);}catch(error){return {...deny(3,'EFFECT_RELEASE_UNMET','缺少该行要求的有效核验事实或绑定产物；请重新核验',row),admin_checks:releaseFailure(error)};}
 let consumed;try{consumed=await ctx.budget(row);}catch{return deny(4,'EFFECT_BUDGET_EXHAUSTED','无法回读该效果行的意图预算；请管理员恢复原意图记录后重核',row);}
 if(ctx.now().getTime()>=Date.parse(ctx.started_at)+row.deadline_ms || consumed.count+1>row.budget.count || consumed.duration_ms+ctx.duration_ms>durationBudget(row,ctx.duration_ms))return deny(4,'EFFECT_BUDGET_EXHAUSTED',`效果行 ${row.id} 的次数、时长或期限预算用完；请开始新修订或缩小范围`,row);
 if(ctx.until===4)return {ok:true,row,input,checked:4};
 let lease;try{lease=await ctx.lease();}catch{return deny(5,'LEASE_UNAVAILABLE','缺少当前租约与围栏事实；请恢复租约并重证基线',row);}
 if(!lease.ok)return deny(5,lease.code??'LEASE_UNAVAILABLE',lease.message??'当前租约或围栏没有通过',row);
 try{if(!await ctx.global(row))return deny(6,'BOUNDARY_POLICY_DENIED','核心政策、所用执行器登记或声明环境与运行快照不符；请开新修订',row);}catch{return deny(6,'BOUNDARY_POLICY_DENIED','缺少可回读的核心政策或所用执行器快照；请恢复记录后开新修订',row);}
 try{if(!await ctx.policies(row))return deny(7,'PACK_POLICY_DENIED','冻结包的同脚本同政策表重核未通过；请修正后重核',row);}catch{return deny(7,'PACK_POLICY_DENIED','冻结包的政策重核没有完整结论；请修复检查及来源后重核',row);}
 try{if(!await ctx.content(input))return deny(8,'EFFECT_CONTENT_UNVERIFIED','外发字节未通过摘要、重算依据或完整凭据扫描；请修复产物后重新核验',row);}catch{return deny(8,'EFFECT_CONTENT_UNVERIFIED','缺少可回读并完整检查的外发内容；请修复原件或解析能力后重新核验',row);}
 try{if(!await ctx.audience())return deny(9,'AUDIENCE_VISIBILITY_EXCEEDED','所引内容不能覆盖声明的目标受众；请收窄受众或取得有效分享',row);}catch{return deny(9,'AUDIENCE_VISIBILITY_EXCEEDED','缺少完整受众与引用可见性事实；请管理员补齐映射后重新核验',row);}
 return {ok:true,row,input,checked:9};
}

/** Only controlled public reasons cross into a durable boundary refusal. Unexpected exceptions stay private. */
export class EffectBoundaryError extends Error {readonly failure:BoundaryFailure;constructor(failure:BoundaryFailure){super(failure.message);this.failure=failure;}}
