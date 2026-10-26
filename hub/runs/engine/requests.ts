import {isReason} from '../../../contracts/generated/vocabulary.ts';
import { isAbandonedResult } from './management.ts';
// Run-specific B07 routing. Shared storage is owned by hub/requests.
import { ReferenceUri } from '../../../contracts/src/reference.ts';
import { bindRecovery, routeOf, EXIT_BY_REASON } from './terminals.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { ConflictError, type Principal, type StoredRecord } from '../../records/api.ts';
import type { EngineContext } from './deps.ts';
import { canSeeRun } from './readers.ts';
import { runById, keyOwner } from './store.ts';
import { createRequestService, type RequestBody, type RequestView } from '../../requests/api.ts';
export { createRequestService, RequestBodySchema } from '../../requests/api.ts';
export type { RequestBody, RequestView } from '../../requests/api.ts';
function service(ctx:EngineContext){return createRequestService(ctx.deps.records,ctx.now,{canReadRun:async(by,run)=>{const stored=await runById(ctx.deps.records.store,run);return stored!==null&&canSeeRun(by,stored.body);}});}
export const putRequest=(ctx:EngineContext,input:RequestBody)=>service(ctx).write(input);
export const answerRequest=(ctx:EngineContext,request:string,source:string)=>service(ctx).answer(request,source);
export const requestRecords=(ctx:EngineContext,run?:string):Promise<RequestView[]>=>service(ctx).all(run);
export const requestsOf=(ctx:EngineContext,by:Principal,run?:string):Promise<RequestView[]>=>service(ctx).list(by,run);
export async function recordResultRequests(ctx:EngineContext,run:RunRecord,result:ValidationResult,roundsUsed:ReadonlyMap<string,number>=new Map(),input?:unknown):Promise<void>{
  if(isAbandonedResult(result))return;
  for(const error of result.errors){
    if(error.rounds_left!==0||!error.requirement||error.code!=='repair_exhausted'&&(run.requirements.find(r=>r.key===error.requirement)?.repair_rounds??0)===0)continue;
    if(result.acceptance==='accepted'&&Object.values(result.partitions).flat().some(item=>(!error.item||item.item===error.item)&&item.requirements.some(r=>r.requirement===error.requirement&&r.layers.some(l=>l.exit!==undefined))))continue;
    const runner=run.runner??run.configurer;
    if(!runner)throw new Error('修复请求缺少具名运行者');
    const request=await putRequest(ctx,{run:run.run,kind:'repair',audience:runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),missing:'缺少修复后的完整提交：'+error.message,next_action:'用 submit_result 对同一运行重交完整的新提交，仍可取代本次结果；需要换输入或规则时用 start_run 以本运行为 predecessor 开新修订',source:result.submission,code:error.code,...(error.item?{item:error.item}:{}),requirement:error.requirement});
    error.fix=`${error.fix??''}；请求 rec:${request.digest}：${request.body.next_action}`;
  }
  if(result.acceptance!=='accepted')return;
  const workflow=await ctx.deps.workflows.byDigest(run.pack_digest);
  for(const error of [...result.errors]) {
    const template=workflow?.requirements.find(t=>t.key===error.requirement);
    const row=routeOf(template?.error_handling??[],error.code,isReason(error.code)?error.code:undefined);
    if(row?.action!=='unknown'&&row?.action!=='request')continue;
    const audience=run.runner??run.configurer;
    if(!audience)throw new Error('请求缺少具名运行者');
    const request=await putRequest(ctx,{run:run.run,kind:row.action==='unknown'?'judgment':'repair',audience,due:new Date(ctx.now().getTime()+86400000).toISOString(),missing:error.message,next_action:'由作者以外的账号以本运行为 predecessor 用 start_run 开复核运行，或用 submit_result 重交完整修复',source:result.submission,code:error.code,...(error.item?{item:error.item}:{}),...(error.requirement?{requirement:error.requirement}:{})});
    error.fix=`${error.fix??''}；请求 rec:${request.digest}：${request.body.next_action}`;
    if(row.action==='unknown') {
      const hypothesis=await hypothesisFor(ctx,request,error.message);
      error.fix=(error.fix??'')+'；假设集 rec:'+hypothesis;
    }
  }
  for(const claim of result.cross_item){
    if(claim.qualifier.nature!=='unknown'||!claim.requirement)continue;
    const owner=await ctx.deps.workflows.ownerOf?.(run.pack_digest);
    const administrator=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled)?.id;
    const runner=run.runner??run.configurer;
    if(!owner||!administrator||!runner)throw new Error('整份检查未知缺少具名出口身份');
    const reason=claim.statement.reason??'check_error';
    const template=workflow?.requirements.find(t=>t.key===claim.requirement);
    const row=routeOf(template?.error_handling??[],undefined,reason);
    const rounds_left=Math.max(0,(run.requirements.find(r=>r.key===claim.requirement)?.repair_rounds??0)-(roundsUsed.get(claim.requirement)??0));
    const layer=bindRecovery({layer:'static',terminal:'unchecked',reason},{owner,administrator,runner,due:new Date(ctx.now().getTime()+86400000).toISOString(),location:'整份检查 '+claim.requirement},[{verdict:'unknown',reason,missing:claim.statement.text,statement:claim.statement.text,grounds:[],tier:'advisory'}]);
    const exit=layer.exit!;
    const sourceRows=claim.statement.data?.unread_sources;
    const sources=Array.isArray(sourceRows)?sourceRows.flatMap(row=>typeof row==='object'&&row!==null&&'reason'in row&&row.reason==='credential_unreadable'&&'reference'in row&&ReferenceUri.safeParse(row.reference).success?[String(row.reference)]:[]):[];
    if(sources.length){exit.request_kind='disposition';exit.audience={user:administrator};}
    const repair=row?.action==='repair'&&claim.qualifier.source_role==='artifact_under_verification';
    if(repair||row?.action==='request'||row?.action==='unknown'){exit.request_kind=row.action==='unknown'?'judgment':'repair';exit.audience={user:runner};}
    if(!('user'in exit.audience))throw new Error('整份检查没有绑定具名请求');
    const request=await putRequest(ctx,{run:run.run,...(EXIT_BY_REASON[reason].recipient==='owner'&&exit.request_kind==='repair'&&!repair?{pack_digest:run.pack_digest}:{}),...(sources.length?{sources:[...new Set(sources)]}:{}),kind:exit.request_kind!,audience:exit.audience.user,due:exit.due,missing:layer.missing!,source:result.submission,code:repair&&rounds_left===0?'repair_exhausted':reason,requirement:claim.requirement,next_action:repair?'用 submit_result 重交完整的跨条目声明，仍可取代本次结果':EXIT_BY_REASON[reason].next_action});
    const path=claim.pointer?.startsWith('/cross_item/')?claim.pointer:'/cross_item';
    const prior=result.errors.find(e=>e.requirement===claim.requirement&&e.path===path&&e.message===request.body.missing);
    const problem={code:request.body.code,message:request.body.missing,requirement:claim.requirement,path,rounds_left,fix:'请求 rec:'+request.digest+'：'+request.body.next_action};
    if(prior)Object.assign(prior,problem);else result.errors.push(problem);
    if(row?.action==='unknown'){const hypothesis=await hypothesisFor(ctx,request,claim.statement.text);const problem=result.errors.find(e=>e.requirement===claim.requirement&&e.path===path&&e.message===request.body.missing)!;problem.fix=(problem.fix??'')+'；假设集 rec:'+hypothesis;}
  }
  const disposed=new Set(result.partitions.rejected.filter(i=>i.code==='EFFECT_UNKNOWN_DISPOSED').map(i=>i.item));
  for(const item of Object.values(result.partitions).flat())for(const requirement of item.requirements)for(const layer of requirement.layers){
    if(layer.layer==='dynamic'&&(disposed.has(item.item)||requirement.unsatisfied_reason==='abandoned')&&layer.reason!=='check_error')continue;
    const primary=layer.missing&&layer.exit?{missing:layer.missing,exit:layer.exit,reason:layer.reason??'check_error'}:null;
    const gaps=[...(primary?[primary]:[]),...(layer.gaps??[])];
    for(const gap of gaps){
      if(gap.exit.action!=='request'||!('user'in gap.exit.audience))continue;
      const observation=workflow?.requirements.find(r=>r.key===requirement.requirement)?.observation;
      const next_action=observation==='dispatch@1'&&layer.layer==='dynamic'
        ?gap.reason==='check_error'?'管理员核对观察记录和接口所缺字段；原件确未写的只记缺失事件，不回填过去的受众或期限；修复读取后重评，不重交原效果':gap.reason==='awaiting_step'?'原派发已证明没有执行；运行者以本运行为 predecessor 开新修订，重新核验并按允许效果表授权新一次执行和观察，不把原意图当新授权':'管理员用 circle-hub job resume <missing 中的原作业号> 核对原请求；补不齐完整性时重证基线，以本运行为 predecessor 重跑，原效果与冻结/解除记录不改写'
        :gap.exit.request_kind==='disposition'&&gap.exit.audience.user!==(run.runner??run.configurer)
          ?'管理员核对只保留的来源，用 circle-hub source accept <原件摘要> --note <接受依据> 接受允许接受的来源，然后原样重交以便 Hub 重评；实际凭据回显原件不可接受，须脱敏后新修订重跑'
          :EXIT_BY_REASON[gap.reason].next_action;
      const sources=requirement.claims.flatMap(claim=>{
        const rows=claim.statement.data?.unread_sources;
        return Array.isArray(rows)?rows.flatMap(row=>typeof row==='object'&&row!==null&&'reason'in row&&row.reason==='credential_unreadable'&&'reference'in row&&ReferenceUri.safeParse(row.reference).success?[String(row.reference)]:[]):[];
      });
      const request=await putRequest(ctx,{run:run.run,...(EXIT_BY_REASON[gap.reason].recipient==='owner'&&observation!=='dispatch@1'&&gap.exit.request_kind==='repair'?{pack_digest:run.pack_digest}:{}),...(sources.length?{sources:[...new Set(sources)]}:{}),kind:gap.exit.request_kind!,audience:gap.exit.audience.user,due:gap.exit.due,missing:gap.missing,next_action,source:result.submission,code:gap===primary?layer.code??gap.reason:gap.reason,item:item.item,requirement:requirement.requirement});
      gap.exit.due=request.body.due;
      const recipient=await ctx.deps.records.principals?.get(request.body.audience);
      if(recipient&&recipient.role!=='admin'&&recipient.id!==run.runner){
        const admin=(await ctx.deps.records.principals?.list?.())?.find(p=>p.role==='admin'&&!p.disabled);
        if(!admin)throw new Error('请求送达缺少具名管理员');
        await putRequest(ctx,{run:run.run,kind:'clarification',audience:admin.id,due:gap.exit.due,missing:'包作者 '+recipient.id+' 不在本运行可见范围内，缺少经审核可交给作者的最小复现',next_action:'管理员用 get_nodes 核对请求 rec:'+request.digest+'，在 Circle 中制作经许可的最小复现后交给具名包作者；由作者发布修复版本。原运行和原件不自动分享',source:result.submission,code:'awaiting_step',item:item.item,requirement:requirement.requirement});
      }

      const error=result.errors.find(e=>e.item===item.item&&e.requirement===requirement.requirement&&(gap===primary?(e.code===gap.reason||e.code===layer.code):e.code===gap.reason&&e.message===gap.missing));
      const hint=`缺失事实：${gap.missing}；请求 rec:${request.digest}，受众 ${request.body.audience}，期限 ${request.body.due}：${next_action}`;
      const rounds_left=Math.max(0,(run.requirements.find(r=>r.key===requirement.requirement)?.repair_rounds??0)-(roundsUsed.get(requirement.requirement)??0));
      const path=requestPath(input,item.item);
      if(error){error.path??=path;error.rounds_left??=rounds_left;if(!error.fix?.includes('rec:'+request.digest))error.fix=`${error.fix??''}；${hint}`;}
      else result.errors.push({code:gap.reason,message:gap.missing,item:item.item,requirement:requirement.requirement,path,rounds_left,fix:hint});
    }
  }
}
export async function answerRepairedRequests(ctx:EngineContext,run:RunRecord,result:ValidationResult,record:string):Promise<void>{
  if(result.acceptance!=='accepted')return;
  for(const request of await requestRecords(ctx,run.run)){
    if(request.answered_by!==null||request.kind!=='repair')continue;
    if(request.pack_digest||request.audience!==run.runner){if(request.source!==result.submission)continue;}
    const item=Object.values(result.partitions).flat().find(i=>i.item===request.item);
    const settled=item?.requirements.find(r=>r.requirement===request.requirement);
    const cross=result.cross_item.filter(c=>c.requirement===request.requirement);
    if(settled?.status==='satisfied'||request.item===undefined&&cross.length>0&&!result.errors.some(e=>e.requirement===request.requirement)&&cross.every(c=>c.qualifier.nature!=='unknown'&&c.statement.verdict!=='refute'))await answerRequest(ctx,request.record,record);
  }
}

async function hypothesisFor(ctx:EngineContext,request:StoredRecord<RequestBody>,question:string):Promise<string>{
  const old=await ctx.deps.records.store.find({kind:'claim',key:'runs.hypothesis.request',value:request.digest,limit:1});
  if(old.items.length)return old.items[0].digest;
  const record=await ctx.deps.records.store.put({kind:'claim',schema:'hypothesis-set@1',provenance:'projected',created_at:ctx.now().toISOString(),body:{run:request.body.run??null,item:request.body.item??null,requirement:request.body.requirement??null,question,source:request.body.source,hypotheses:[],residual:{statement:'其他',status:'open' satisfies import('../../../contracts/generated/vocabulary.ts').HypothesisStatus},missing:'尚未提交假设、预测和下一项区分性观察的提议',exit:{action:'request',request_kind:request.body.kind,audience:{user:request.body.audience},due:request.body.due},next_request:'rec:'+request.digest},index:[{key:'runs.hypothesis.request',value:request.digest}]});
  return record.digest;
}

/** A same-owner revision is the existing start_run answer to a continue/rerun disposition, never proof of old success. */
export async function answerSuccessorRequests(ctx:EngineContext,previous:RunRecord,next:StoredRecord<RunRecord>):Promise<void>{
  const owner=previous.runner??previous.configurer;
  if(!owner||keyOwner(next.body)!==keyOwner(previous)||previous.pack.split('@')[0]!==next.body.pack.split('@')[0])return;
  const before=await runById(ctx.deps.records.store,previous.run);
  if(!before)return;
  for(const request of await requestRecords(ctx,previous.run)){
    if(request.answered_by!==null||request.answer_action!=='rerun'||(request.kind!=='disposition'&&request.kind!=='clarification')||request.audience!==owner||request.item||request.requirement||request.job||request.sources?.length||request.pack_digest)continue;
    if(request.source!==before.digest){const source=await ctx.deps.records.store.get<{pack:string;digest:string}>(request.source);if(source?.kind!=='pack_version'||source.body.pack!==previous.pack.split('@')[0]||source.body.digest!==next.body.pack_digest)continue;}
    try{await answerRequest(ctx,request.record,next.digest);}catch(error){if(!(error instanceof ConflictError))throw error;}
  }
}

/** Point into the received submission order, never the projection order or a fabricated slot. */
function requestPath(input:unknown,item:string):string{
  const items=typeof input==='object'&&input!==null&&'items'in input?input.items:undefined;
  if(!Array.isArray(items))return '';
  const at=items.findIndex(value=>typeof value==='object'&&value!==null&&value.item===item);
  return at<0?'/items':'/items/'+at;
}
