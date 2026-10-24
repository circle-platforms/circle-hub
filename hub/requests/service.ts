// B07 shared append-only request storage. Runtime policy and package routing stay with their callers.
import { z } from 'zod';
import { ReferenceUri } from '../../contracts/src/reference.ts';
import { RequestKindSchema, ExitActionSchema } from '../../contracts/generated/vocabulary.ts';
import { RunId, UserId, Sha256, IsoTime } from '../../contracts/src/common.ts';
import { digestOf, ConflictError, type Principal, type StoredRecord, type Page, type RecordsKit } from '../records/api.ts';
interface RequestContext {deps:{records:Pick<RecordsKit,'store'>};now:()=>Date;canReadRun?:(by:Principal,run:string)=>Promise<boolean>}
const Request = z.strictObject({answer_action:ExitActionSchema.optional(),run:RunId.optional(),pack_digest:Sha256.optional(),job:Sha256.optional(),sources:z.array(ReferenceUri).optional(),kind:RequestKindSchema,audience:UserId,due:IsoTime,missing:z.string().refine(s=>s.trim().length>0,'must name the concrete fact or next action'),next_action:z.string().refine(s=>s.trim().length>0,'must name the concrete fact or next action'),source:Sha256,code:z.string().min(1),item:z.string().optional(),requirement:z.string().optional()}).refine(r=>r.run!==undefined||r.pack_digest!==undefined,'a request binds a run or published pack');
export type RequestBody=z.infer<typeof Request>;
export const RequestBodySchema=Request;
export type RequestView=RequestBody & {record:string;answered_by:string|null};
export async function putRequest(ctx:RequestContext,input:RequestBody):Promise<StoredRecord<RequestBody>>{
  const body=Request.parse(input);
  // The deadline is fixed on first creation, not extended by reading or resubmitting the same problem.
  const {due:_,...identity}=body;
  const key=digestOf(identity);
  const old=await ctx.deps.records.store.find<RequestBody>({kind:'request',key:'runs.request.key',value:key,limit:1});
  if(old.items[0])return old.items[0];
  return ctx.deps.records.store.put({kind:'request',schema:'request@1',provenance:'observed',body,created_at:ctx.now().toISOString(),index:[{key:'runs.request.key',value:key},...(body.run?[{key:'runs.request.run',value:body.run}]:[]),...(body.pack_digest?[{key:'runs.request.pack',value:body.pack_digest}]:[])]});
}
export async function answerRequest(ctx:RequestContext,request:string,source:string):Promise<void>{
  Sha256.parse(source);
  if(await ctx.deps.records.store.get(source)===null)throw new Error('回答来源记录不存在');
  const record=await ctx.deps.records.store.get<RequestBody>(request);
  if(record?.kind!=='request')throw new Error('请求记录不存在');
  const old=await ctx.deps.records.store.find<{detail:{answer:string}}>({kind:'action',key:'runs.request.answer',value:request,limit:1});
  if(old.items.length){if(old.items[0].body.detail.answer===source)return;throw new ConflictError('请求已有其他作答来源，不覆盖原回答',{fix:'查看原作答；如需另一项回答，另建明确的请求'});}
  const at=ctx.now().toISOString();
  await ctx.deps.records.store.put({kind:'action',schema:'action@1',provenance:'observed',created_at:at,body:{action:'validate',run:record.body.run??null,item:record.body.item??null,inputs:[`rec:${request}`,`rec:${source}`],component:'requests@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{request,answer:source}},index:[{key:'runs.request.answer',value:request}]});
}
export async function requestRecords(ctx:RequestContext,run?:string):Promise<RequestView[]>{
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
export async function requestsOf(ctx:RequestContext,user:Principal,run?:string):Promise<RequestView[]>{
  const visible:RequestView[]=[];
  for(const request of await requestRecords(ctx,run)){
    if(user.role==='admin'){visible.push(request);continue;}
    if(request.run){if(await ctx.canReadRun?.(user,request.run))visible.push(request);}
    else if(request.audience===user.id)visible.push(request);
  }
  return visible;
}

/** Trusted components verify responding identity and the actual answering step before calling answer. */
export function createRequestService(records:Pick<RecordsKit,'store'>,now:()=>Date=()=>new Date(),options:{canReadRun?:(by:Principal,run:string)=>Promise<boolean>}={}){
  const ctx:RequestContext={deps:{records},now,canReadRun:options.canReadRun};
  return {
    // inspect/all are trusted internal reads, never untrusted client entry points.
    inspect:async(id:string):Promise<RequestView|null>=>{if(!Sha256.safeParse(id).success)return null;const record=await records.store.get(id);if(record?.kind!=='request'||record.schema!=='request@1')return null;const parsed=Request.safeParse(record.body);if(!parsed.success)return null;const answer=await records.store.find<{detail:{answer:string}}>({kind:'action',key:'runs.request.answer',value:id,limit:1});return{...parsed.data,record:id,answered_by:answer.items[0]?.body.detail.answer??null};},
    all:(run?:string)=>requestRecords(ctx,run),
    write:(input:RequestBody)=>putRequest(ctx,input),
    list:(by:Principal,run?:string)=>requestsOf(ctx,by,run),
    answer:(request:string,source:string)=>answerRequest(ctx,request,source),
  };
}
