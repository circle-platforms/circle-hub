import { ReferenceUri } from '../../../contracts/src/reference.ts';
// B07 append-only requests. Answers name the record that actually performed the requested next step.
import { z } from 'zod';
import { RequestKindSchema } from '../../../contracts/generated/vocabulary.ts';
import { RunId, UserId, Sha256, IsoTime } from '../../../contracts/src/common.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { digestOf, type Principal, type StoredRecord, type Page } from '../../records/api.ts';
import type { EngineContext } from './deps.ts';
import { canSeeRun } from './readers.ts';
import { runById } from './store.ts';

const Request = z.strictObject({run:RunId.optional(),pack_digest:Sha256.optional(),sources:z.array(ReferenceUri).optional(),kind:RequestKindSchema,audience:UserId,due:IsoTime,missing:z.string().trim().min(1),next_action:z.string().trim().min(1),source:Sha256,code:z.string().min(1),item:z.string().optional(),requirement:z.string().optional()}).refine(r=>r.run!==undefined||r.pack_digest!==undefined,'a request binds a run or published pack');
export type RequestBody=z.infer<typeof Request>;
export type RequestView=RequestBody & {record:string;answered_by:string|null};
export async function putRequest(ctx:EngineContext,input:RequestBody):Promise<StoredRecord<RequestBody>>{
  const body=Request.parse(input);
  // The deadline is fixed on first creation, not extended by reading or resubmitting the same problem.
  const {due:_,...identity}=body;
  const key=digestOf(identity);
  const old=await ctx.deps.records.store.find<RequestBody>({kind:'request',key:'runs.request.key',value:key,limit:1});
  if(old.items[0])return old.items[0];
  return ctx.deps.records.store.put({kind:'request',schema:'request@1',provenance:'observed',body,created_at:ctx.now().toISOString(),index:[{key:'runs.request.key',value:key},...(body.run?[{key:'runs.request.run',value:body.run}]:[]),...(body.pack_digest?[{key:'runs.request.pack',value:body.pack_digest}]:[])]});
}
export async function answerRequest(ctx:EngineContext,request:string,source:string):Promise<void>{
  Sha256.parse(source);
  if(await ctx.deps.records.store.get(source)===null)throw new Error('回答来源记录不存在');
  const record=await ctx.deps.records.store.get<RequestBody>(request);
  if(record?.kind!=='request')throw new Error('请求记录不存在');
  const old=await ctx.deps.records.store.find({kind:'action',key:'runs.request.answer',value:request,limit:1});
  if(old.items.length)return;
  const at=ctx.now().toISOString();
  await ctx.deps.records.store.put({kind:'action',schema:'action@1',provenance:'observed',created_at:at,body:{action:'validate',run:record.body.run??null,item:record.body.item??null,inputs:[`rec:${request}`,`rec:${source}`],component:'runs.engine@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{request,answer:source}},index:[{key:'runs.request.answer',value:request}]});
}
export async function requestRecords(ctx:EngineContext,run?:string):Promise<RequestView[]>{
  const out:RequestView[]=[];let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<RequestBody>>=run===undefined?await ctx.deps.records.store.list<RequestBody>({kind:'request',limit:500,cursor}):await ctx.deps.records.store.find<RequestBody>({kind:'request',key:'runs.request.run',value:run,limit:500,cursor});
    for(const record of page.items){
      if(record.schema!=='request@1')continue;
      const answer=await ctx.deps.records.store.find<{detail:{answer:string}}>({kind:'action',key:'runs.request.answer',value:record.digest,limit:1});
      out.push({...record.body,record:record.digest,answered_by:answer.items[0]?.body.detail.answer??null});
    }
    cursor=page.next;
  }while(cursor!==null);
  return out;
}
export async function requestsOf(ctx:EngineContext,user:Principal,run?:string):Promise<RequestView[]>{
  if(run!==undefined){
    const record=await runById(ctx.deps.records.store,run);
    return record&&canSeeRun(user,record.body)?requestRecords(ctx,run):[];
  }
  const visible:RequestView[]=[];
  for(const request of await requestRecords(ctx)){
    if(user.role==='admin'){visible.push(request);continue;}
    if(request.run){const record=await runById(ctx.deps.records.store,request.run);if(record&&canSeeRun(user,record.body))visible.push(request);}
    else if(request.audience===user.id)visible.push(request);
  }
  return visible;
}
export async function recordResultRequests(ctx:EngineContext,run:RunRecord,result:ValidationResult):Promise<void>{
  if(result.acceptance!=='accepted')return;
  const workflow=await ctx.deps.workflows.byDigest(run.pack_digest);
  for(const error of [...result.errors]) {
    const template=workflow?.requirements.find(t=>t.key===error.requirement);
    const row=template?.error_handling.find(r=>r.code===error.code||r.reason===error.code)??template?.error_handling.find(r=>r.code==='*');
    if(row?.action!=='unknown'&&row?.action!=='request')continue;
    const audience=run.runner??run.configurer;
    if(!audience)throw new Error('请求缺少具名运行者');
    const request=await putRequest(ctx,{run:run.run,kind:row.action==='unknown'?'judgment':'repair',audience,due:new Date(ctx.now().getTime()+86400000).toISOString(),missing:error.message,next_action:'由作者以外的账号以本运行为 predecessor 用 start_run 开复核运行，或用 submit_result 重交完整修复',source:result.submission,code:error.code,...(error.item?{item:error.item}:{}),...(error.requirement?{requirement:error.requirement}:{})});
    error.fix=`${error.fix??''}；请求 rec:${request.digest}：${request.body.next_action}`;
    if(row.action==='unknown') {
      const old=await ctx.deps.records.store.find({kind:'claim',key:'runs.hypothesis.request',value:request.digest,limit:1});
      if(!old.items.length)await ctx.deps.records.store.put({kind:'claim',schema:'hypothesis-set@1',provenance:'projected',created_at:ctx.now().toISOString(),body:{run:run.run,item:error.item??null,requirement:error.requirement??null,question:error.message,source:result.submission,hypotheses:[],residual:{statement:'其他',status:'open' satisfies import('../../../contracts/generated/vocabulary.ts').HypothesisStatus},next_observation:`rec:${request.digest}`},index:[{key:'runs.hypothesis.request',value:request.digest}]});
    }
  }
  for(const item of Object.values(result.partitions).flat())for(const requirement of item.requirements)for(const layer of requirement.layers){
    const gaps=[...(layer.missing&&layer.exit?[{missing:layer.missing,exit:layer.exit,reason:layer.reason??'check_error'}]:[]),...(layer.gaps??[])];
    for(const gap of gaps){
      if(gap.exit.action!=='request'||!('user'in gap.exit.audience))continue;
      const next_action=gap.exit.audience.user===(run.runner??run.configurer)
        ?'用 submit_result 对同一运行重交完整提交；完整的新提交仍可取代本次结果。更改输入或规则时，以本运行为 predecessor 用 start_run 开新修订'
        :gap.exit.request_kind==='disposition'?'管理员核对只保留的来源，用 circle-hub source accept <原件摘要> --note <接受依据> 接受允许接受的来源，然后原样重交以便 Hub 重评；实际凭据回显原件不可接受，须脱敏后新修订重跑':'包作者发布修好的版本后，运行者以本运行为 predecessor 用 start_run 开新修订';
      const sources=requirement.claims.flatMap(claim=>{
        const rows=claim.statement.data?.unread_sources;
        return Array.isArray(rows)?rows.flatMap(row=>typeof row==='object'&&row!==null&&'reason'in row&&row.reason==='credential_unreadable'&&'reference'in row&&ReferenceUri.safeParse(row.reference).success?[String(row.reference)]:[]):[];
      });
      const request=await putRequest(ctx,{run:run.run,...(sources.length?{sources:[...new Set(sources)]}:{}),kind:gap.exit.request_kind!,audience:gap.exit.audience.user,due:gap.exit.due,missing:gap.missing,next_action,source:result.submission,code:layer.code??gap.reason,item:item.item,requirement:requirement.requirement});
      gap.exit.due=request.body.due;
      const error=result.errors.find(e=>e.item===item.item&&e.requirement===requirement.requirement&&(e.code===gap.reason||e.code===layer.code));
      const hint=`请求 rec:${request.digest}，受众 ${request.body.audience}，期限 ${request.body.due}：${next_action}`;
      if(error)error.fix=`${error.fix??''}；${hint}`;
      else result.errors.push({code:gap.reason,message:gap.missing,item:item.item,requirement:requirement.requirement,fix:hint});
    }
  }
}
export async function answerRepairedRequests(ctx:EngineContext,run:RunRecord,result:ValidationResult,record:string):Promise<void>{
  if(result.acceptance!=='accepted')return;
  for(const request of await requestRecords(ctx,run.run)){
    if(request.answered_by!==null||request.source===result.submission||request.audience!==run.runner||request.kind!=='repair')continue;
    const item=Object.values(result.partitions).flat().find(i=>i.item===request.item);
    const settled=item?.requirements.find(r=>r.requirement===request.requirement);
    if(settled?.status==='satisfied')await answerRequest(ctx,request.record,record);
  }
}
