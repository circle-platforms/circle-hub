// W10 lifecycle: append requests and their safe answers; never rewrite source bytes or accepted results.
import {Submission,type CriterionChange} from '../../../contracts/src/submission.ts';
import type {RunRecord} from '../../../contracts/src/run.ts';
import type {ValidationResult} from '../../../contracts/src/validation.ts';
import type {EngineContext} from './deps.ts';
import {createRequestService,type RequestView} from '../../requests/api.ts';
import type {Principal,Transaction,StoredRecord,Page} from '../../records/api.ts';
import {authorAccountsOf,lineageOf} from './lineage.ts';
import {runById} from './store.ts';
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
/** Instructions follow the binding interface: source roots are inputs, exact fragments remain quotations. */
export function criterionReviewInstruction(run:string,source:string,change:CriterionChange,administrator:string):{next_action:string;unsupported:string[]}{
 const originals=[...new Set([change.criterion,...change.grounds.map(ground=>ground.reference)])];
 const unsupported=originals.filter(reference=>parseReference(reference).scheme==='tree');
 if(unsupported.length)return {unsupported,next_action:'能力缺口：当前复核输入不能绑定锁定知识树片段 '+unsupported.join('、')+'；管理员 '+administrator+' 安排维护人补齐按复核者现有读权绑定这些片段的只读能力。修复后，作者以外的账号以 '+run+' 为前驱重开 criterion-review，declaration 显式绑定 rec:'+source+'，补绑所列期望片段再确认；不继承作者原件读权。原判据继续生效，接受后开新修订'};
 const refs=[...new Set(originals.map(reference=>{const ref=parseReference(reference);return ref.scheme==='src'?'src:'+ref.sha256:formatReference(ref);} ))];
 const input={pack:'criterion-review',predecessor:run,inputs:{declaration:{reference:'rec:'+source},evidence:refs.map(reference=>({reference}))}};
 return {unsupported,next_action:'作者以外的账号以 start_run 开复核运行，显式绑定声明提交及期望原件，quotes 仍指向原片段：'+JSON.stringify(input)+'；缺原件读权时由管理员补授权或由有权的非作者复核；接受以后以声明运行为前驱开新修订'};
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
   const instruction=criterionReviewInstruction(run.run,source,change,people.find(user=>user.role==='admin')?.id??audience.id);
   const created=await service.write({run:run.run,kind:'judgment',audience:audience.id,due:run.submission_due,missing:(instruction.unsupported.length?'复核入口缺少锁定知识树片段的只读绑定能力；':'')+'判据变更声明尚未由作者以外的账号复核：'+change.assertion,next_action:(eligible.length?'':'管理员先创建非作者账号并明确分享本运行；')+instruction.next_action,source,code:'awaiting_step',item:change.item,declaration:pointer});
   request={...created.body,record:created.digest,answered_by:null};
  }
  result.errors.push({code:'awaiting_step',item:change.item,path:pointer,message:`判据变更声明：${change.assertion}；旧值 ${change.old}；新值 ${change.new}；等待作者以外的账号复核`,fix:`缺失事实：声明尚未复核；请求 rec:${request.record}，受众 ${request.audience}，期限 ${request.due}；${request.next_action}`});
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

/** Answers are append-only. Select the latest one that existed at the caller's snapshot cutoff. */
async function answerAt(ctx:EngineContext,request:string,at:string):Promise<{source:string;summary:Record<string,unknown>;superseded:boolean}|null>{
 let cursor:string|null=null;
 do{
  const page:Page<StoredRecord<any>>=await ctx.deps.records.store.find<any>({kind:'action',key:'runs.request.answer',value:request,limit:100,cursor,newestFirst:true});
  for(const record of page.items)if(record.created_at<=at){const detail=record.body.detail;if(!isObject(detail)||typeof detail.answer!=='string')continue;return {source:detail.answer,summary:isObject(detail.criterion_answer)?detail.criterion_answer:{},superseded:detail.superseded===true};}
  cursor=page.next;
 }while(cursor!==null);
 return null;
}
function declarationRef(request:RequestView):string{return 'rec:'+request.source+'#'+request.declaration;}
async function noticeAt(ctx:EngineContext,request:RequestView,at:string):Promise<import('../../../contracts/src/criterion.ts').CriterionNotice|null>{
 const change=await requestChange(ctx,request),answer=await answerAt(ctx,request.record,at);
 if(!change||!request.declaration)throw new Refusal([protocolError('REFERENCE_UNRESOLVED','判据请求的声明原件或位置缺失',{fix:'管理员从可信备份恢复请求所引的提交记录和声明位置，再重新核验'})]);
 const summary=answer?.summary??{};
 return {...change,request:'rec:'+request.record,declaration:declarationRef(request),audience:request.audience,due:request.due,answered:answer!==null,expired:request.due<=at,...(answer?.superseded?{superseded_by:'rec:'+answer.source}:{}),...(typeof summary.accepted==='boolean'?{accepted:summary.accepted}:{}),...(typeof summary.reviewer==='string'?{reviewer:summary.reviewer}:{}),...(typeof summary.reason==='string'?{reason:summary.reason}:{}),next_action:answer?.superseded?'由后一份提交的同名声明取代；按 '+String(summary.replacement)+' 的新请求复核，不再回答这条旧请求':typeof summary.accepted==='boolean'?(summary.accepted?'接受以后以声明运行为前驱开新运行；本次冻结以后才接受的只进后续修订':'保留原判据；若有新依据，由作者重交声明并请非作者账号重新复核'):request.next_action};
}
/** Hydrate only declarations named by the frozen refs; private review result bodies are never disclosed. */
export async function frozenCriteria(ctx:EngineContext,refs:NonNullable<RunRecord['accepted_criteria']>,seen=new Set<string>()):Promise<import('../../../contracts/src/criterion.ts').FrozenCriterion[]>{
 const out:import('../../../contracts/src/criterion.ts').FrozenCriterion[]=[];
 for(const ref of refs){
  if(seen.has(ref.declaration))throw new Refusal([protocolError('REFERENCE_UNRESOLVED','已接受声明的引用形成循环',{fix:'管理员核对声明链，从最后可证明的声明重新复核后开新修订'})]);
  const parsed=parseReference(ref.declaration),record=parsed.scheme==='rec'?await ctx.deps.records.store.get(parsed.record):null,body=Submission.safeParse(record?.body);
  const pointer=parsed.scheme==='rec'?parsed.pointer:undefined;
  if(!record||!body.success||!pointer||!/^\/criterion_changes\/(0|[1-9][0-9]*)$/.test(pointer))throw new Refusal([protocolError('REFERENCE_UNRESOLVED','冻结声明原记录或位置不可读',{fix:'管理员从可信备份恢复声明记录并重新核验；不回填原运行'})]);
  const change=body.data.criterion_changes?.[declarationIndex(pointer)];if(!change)throw new Refusal([protocolError('REFERENCE_UNRESOLVED','冻结声明的位置不存在',{fix:'管理员恢复原记录并重新核验声明位置'})]);
  let target=change.criterion;
  const sourceRun=await runById(ctx.deps.records.store,body.data.run);
  const before=sourceRun?.body.accepted_criteria?.find(prior=>prior.declaration+'/new'===change.criterion);
  if(before){const chain=new Set(seen);chain.add(ref.declaration);target=(await frozenCriteria(ctx,[before],chain))[0].target;}
  out.push({...change,...ref,target});
 }
 return out;
}
/** Start-time snapshot. Only a same-pack revision inherits criterion changes; a read-only review never does. */
export async function freezeCriteria(ctx:EngineContext,previous:RunRecord|null,pack:string,at:string):Promise<{refs:NonNullable<RunRecord['accepted_criteria']>;requests:string[];criteria:import('../../../contracts/src/criterion.ts').FrozenCriterion[];notices:import('../../../contracts/src/criterion.ts').CriterionNotice[]}>{
 const empty={refs:[],requests:[],criteria:[],notices:[]};
 if(!previous||previous.predecessor_access==='view'||previous.pack.split('@')[0]!==pack)return empty;
 const chain=await lineageOf(ctx.deps.records.store,previous.run);
 const candidates:RequestView[]=[];
 for(const run of chain){if(run.pack.split('@')[0]!==pack||run.predecessor_access==='view')break;for(const request of await requestService(ctx).all(run.run)){const record=await ctx.deps.records.store.get(request.record);if(request.declaration&&record&&record.created_at<=at)candidates.push(request);}}
 // Oldest first means a newly accepted replacement wins; an unanswered proposal cannot cancel a frozen acceptance.
 candidates.reverse();const notices:import('../../../contracts/src/criterion.ts').CriterionNotice[]=[],requests:string[]=[],effective=new Map<string,import('../../../contracts/src/criterion.ts').FrozenCriterion>();
 for(const prior of await frozenCriteria(ctx,previous.accepted_criteria??[]))effective.set(criterionKey(prior.item,prior.target),prior);
 for(const request of candidates){
  const notice=await noticeAt(ctx,request,at);if(!notice)continue;notices.push(notice);requests.push(request.record);
  const answer=await answerAt(ctx,request.record,at);
  if(!answer||answer.superseded||notice.accepted!==true||!notice.reviewer)continue;
  const frozen=(await frozenCriteria(ctx,[{declaration:notice.declaration,review:'rec:'+answer.source,reviewer:notice.reviewer}]))[0];
  effective.set(criterionKey(frozen.item,frozen.target),frozen);
 }
 const criteria=[...effective.values()],refs=criteria.map(({declaration,review,reviewer})=>({declaration,review,reviewer}));
 return {refs,requests,criteria,notices};
}
/** Public request status of this run plus the predecessor decisions visible at its immutable start cutoff. */
export async function criterionNotices(ctx:EngineContext,run:RunRecord):Promise<import('../../../contracts/src/criterion.ts').CriterionNotice[]>{
 const result=[] as import('../../../contracts/src/criterion.ts').CriterionNotice[];
 for(const id of run.criterion_requests??[]){const request=await requestService(ctx).inspect(id);if(request){const notice=await noticeAt(ctx,request,run.started_at);if(notice)result.push(notice);}}
 for(const request of await requestService(ctx).all(run.run))if(request.declaration){const notice=await noticeAt(ctx,request,ctx.now().toISOString());if(notice)result.push(notice);}
 return result;
}

/** Each new declaration reports the effective prior value without editing that declaration's original old quote. */
export async function replacedCriteria(ctx:EngineContext,criteria:import('../../../contracts/src/criterion.ts').FrozenCriterion[]):Promise<Array<import('zod').z.infer<typeof import('../../../contracts/src/criterion.ts').ReplacedCriterion>&{item:string}>>{
 const out=[];
 for(const change of criteria){
  const parsed=parseReference(change.declaration);const source=parsed.scheme==='rec'?await ctx.deps.records.store.get<Submission>(parsed.record):null;
  const run=source?await runById(ctx.deps.records.store,source.body.run):null;
  const prior=(await frozenCriteria(ctx,run?.body.accepted_criteria??[])).find(before=>criterionKey(before.item,before.target)===criterionKey(change.item,change.target));
  out.push({item:change.item,criterion:change.target,old:prior?.new??change.old,new:change.new,declaration:change.declaration,review:change.review,reviewer:change.reviewer});
 }
 return out;
}
