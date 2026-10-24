// W10 lifecycle: append requests and their safe answers; never rewrite source bytes or accepted results.
import {Submission,type CriterionChange} from '../../../contracts/src/submission.ts';
import type {RunRecord} from '../../../contracts/src/run.ts';
import type {ValidationResult} from '../../../contracts/src/validation.ts';
import type {EngineContext} from './deps.ts';
import {createRequestService,type RequestView} from '../../requests/api.ts';
import type {Principal,Transaction,StoredRecord} from '../../records/api.ts';
import {authorAccountsOf} from './lineage.ts';
import {authorAccount} from './independence.ts';
import {canViewRun,recordReader,identityOf} from './readers.ts';
import {parseReference,formatReference} from '../../refs/api.ts';
import {isObject} from './util.ts';
import {protocolError,Refusal} from './errors.ts';
import type {BoundSource} from './inputs.ts';
import type {LoadedWorkflow} from '../../ports.ts';

const requestService=(ctx:EngineContext,transaction?:Transaction)=>createRequestService(ctx.deps.records,ctx.now,{transaction});
export function criterionKey(item:string,reference:string):string{return JSON.stringify([item,formatReference(parseReference(reference))]);}
export function declarationIndex(pointer:string):number{return Number(pointer.slice('/criterion_changes/'.length));}
async function requestChange(ctx:EngineContext,request:RequestView,tx?:Transaction):Promise<CriterionChange|null>{
 const record=await ctx.deps.records.store.get(request.source,tx);const parsed=Submission.safeParse(record?.body);
 return parsed.success&&request.declaration?parsed.data.criterion_changes?.[declarationIndex(request.declaration)]??null:null;
}
async function safeAnswer(ctx:EngineContext,request:RequestView,source:string,summary:Record<string,unknown>,tx:Transaction,superseded=false):Promise<void>{
 const at=ctx.now().toISOString();
 await ctx.deps.records.store.put({kind:'action',schema:'action@1',provenance:'observed',created_at:at,body:{action:'validate',run:request.run??null,item:request.item??null,inputs:['rec:'+request.record,'rec:'+source],component:'criterion-change@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{request:request.record,answer:source,criterion_answer:summary,...(superseded?{superseded:true}:{})}},index:[{key:'runs.request.answer',value:request.record}]},tx);
}
export async function publishCriterionRequests(ctx:EngineContext,run:RunRecord,source:string,changes:Array<{index:number;change:CriterionChange}>,result:ValidationResult,tx:Transaction):Promise<void>{
 if(!changes.length)return;
 if(!run.submission_due)throw new Error('criterion request requires the frozen submission deadline');
 const authors=await authorAccountsOf(ctx,run.run),people=(await ctx.deps.records.principals?.list?.()??[]).filter(user=>!user.disabled).sort((a,b)=>a.id.localeCompare(b.id));
 const eligible=[] as Principal[];for(const user of people)if(!authors?.accounts.has(user.id)&&(user.role==='admin'||await canViewRun(user,run,ctx.deps.records.store)))eligible.push(user);
 const audience=eligible[0]??people.find(user=>user.role==='admin');
 if(!audience)throw new Error('判据复核请求缺少具名管理员');
 const service=requestService(ctx,tx),old=await service.all(run.run);
 for(const {index,change} of changes){
  const pointer='/criterion_changes/'+index;
  const prior=old.find(request=>request.source===source&&request.declaration===pointer);
  let request=prior;
  if(!request){
   for(const previous of old){if(!previous.declaration)continue;const before=await requestChange(ctx,previous,tx);if(!before||criterionKey(before.item,before.criterion)!==criterionKey(change.item,change.criterion))continue;
    const last=previous.answered_by?await ctx.deps.records.store.get<any>(previous.answered_by,tx):null;
    if(last?.kind==='submission'&&last.digest===source)continue;
    await safeAnswer(ctx,previous,source,{message:'由后一份提交的同名声明取代',replacement:'rec:'+source},tx,true);
   }
   const refs=[...new Set([change.criterion,...change.grounds.map(ground=>ground.reference)])];
   const input={pack:'criterion-review',predecessor:run.run,inputs:{declaration:{reference:'rec:'+source},evidence:refs.map(reference=>({reference}))}};
   const created=await service.write({run:run.run,kind:'judgment',audience:audience.id,due:run.submission_due,missing:'判据变更声明尚未由作者以外的账号复核：'+change.assertion,next_action:(eligible.length?'':'管理员先创建非作者账号并明确分享本运行；')+'作者以外的账号以 start_run 开复核运行，显式绑定声明提交及期望片段：'+JSON.stringify(input)+'；缺原件读权时由管理员补授权或由有权的非作者复核；接受以后以声明运行为前驱开新修订',source,code:'awaiting_step',item:change.item,declaration:pointer});
   request={...created.body,record:created.digest,answered_by:null};
  }
  result.errors.push({code:'awaiting_step',item:change.item,path:pointer,message:'判据变更声明等待作者以外的账号复核',fix:`缺失事实：声明尚未复核；请求 rec:${request.record}，受众 ${request.audience}，期限 ${request.due}；${request.next_action}`});
 }
}
export async function prepareCriterionReview(ctx:EngineContext,user:Principal,workflow:LoadedWorkflow,bound:readonly BoundSource[],previous:RunRecord|null):Promise<{marker:NonNullable<RunRecord['criterion_review']>;context:NonNullable<import('../../../contracts/src/pack.ts').RunContext['criterion_review']>}|null>{
 if(!workflow.workflow.criterion_review)return null;
 const subject=bound.find(input=>input.slot===workflow.workflow.subject),record=subject?.record?await ctx.deps.records.store.get(subject.record.digest):null;
 const submission=Submission.safeParse(record?.body);
 if(!previous||record?.kind!=='submission'||!submission.success||submission.data.run!==previous.run)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION','复核必须显式绑定前驱运行中声明所在的提交记录，不是已受理结果或上传的副本',{path:'/inputs',fix:'按判断请求的 next_action 绑定原提交 rec:，predecessor 写声明运行'})]);
 const requests=(await requestService(ctx).all(previous.run)).filter(request=>request.kind==='judgment'&&request.declaration&&request.source===record.digest&&request.answered_by===null);
 if(!requests.length)throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION','这份提交没有等待复核的判据变更声明',{path:'/inputs',fix:'核对请求是否已回答或被后续提交取代，绑定仍待复核的声明提交'})]);
 return {marker:{submission:record.digest,requests:requests.map(request=>request.record)},context:{submission:'rec:'+record.digest,declarations:requests.map(request=>({pointer:request.declaration!,request:'rec:'+request.record}))}};
}
export async function criterionReviewVisible(ctx:EngineContext,user:Principal,run:RunRecord):Promise<boolean>{return !run.criterion_review||await recordReader(ctx.deps.records.store).read(run.criterion_review.submission,identityOf(user,run.run))!==null;}
export async function answerCriterionReview(ctx:EngineContext,run:RunRecord,result:StoredRecord<ValidationResult>,tx:Transaction):Promise<void>{
 if(!run.criterion_review||result.body.acceptance!=='accepted'||!run.predecessor)return;
 const account=authorAccount(run),authors=await authorAccountsOf(ctx,run.predecessor);if(!account||!authors?.complete||authors.accounts.has(account))return;
 const people=await ctx.deps.records.principals!.get(account);if(!people||people.disabled)return;
 const service=requestService(ctx,tx),requests=await service.all(run.predecessor);
 for(const id of run.criterion_review.requests){
  const request=requests.find(request=>request.record===id);if(!request||request.answered_by!==null)continue;
  const item=run.items.find(item=>item.fields.declaration===request.declaration);
  const settled=Object.values(result.body.partitions).flat().find(row=>row.item===item?.id);
  if(!settled||!settled.requirements.length||!settled.requirements.every(requirement=>requirement.status==='satisfied'))continue;
  const data=settled.requirements.flatMap(requirement=>requirement.claims).map(claim=>claim.warrant.producer==='function'?claim.statement.data?.criterion_review:null).find(value=>isObject(value)&&typeof value.accepted==='boolean'&&typeof value.reason==='string');
  if(!isObject(data)||typeof data.accepted!=='boolean'||typeof data.reason!=='string')continue;
  await safeAnswer(ctx,request,result.digest,{accepted:data.accepted,reason:data.reason,reviewer:account,review:'rec:'+result.digest},tx);
 }
}
