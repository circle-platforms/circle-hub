// B07 shared append-only request storage. Runtime policy and package routing stay with their callers.
import { z } from 'zod';
import {RequestRecord as Request} from '../../contracts/src/request.ts';
import { Sha256 } from '../../contracts/src/common.ts';
import { digestOf, ConflictError, type Principal, type StoredRecord, type Page, type RecordsKit,type Transaction } from '../records/api.ts';
interface RequestContext {deps:{records:Pick<RecordsKit,'store'>};now:()=>Date;transaction?:Transaction;canReadRun?:(by:Principal,run:string)=>Promise<boolean>}
export type RequestBody=z.infer<typeof Request>;
export const RequestBodySchema=Request;
export type RequestView=RequestBody & {record:string;answered_by:string|null};
export async function putRequest(ctx:RequestContext,input:RequestBody):Promise<StoredRecord<RequestBody>>{
  const body=Request.parse(input);
  // The deadline is fixed on first creation, not extended by reading or resubmitting the same problem.
  const {due:_,...identity}=body;
  const key=digestOf(identity);
  const old=await ctx.deps.records.store.find<RequestBody>({kind:'request',key:'runs.request.key',value:key,limit:1},ctx.transaction);
  if(old.items[0])return old.items[0];
  return ctx.deps.records.store.put({kind:'request',schema:'request@1',provenance:'observed',body,created_at:ctx.now().toISOString(),index:[{key:'runs.request.key',value:key},...(body.run?[{key:'runs.request.run',value:body.run}]:[]),...(body.pack_digest?[{key:'runs.request.pack',value:body.pack_digest}]:[])]},ctx.transaction);
}
export async function answerRequest(ctx:RequestContext,request:string,source:string):Promise<void>{
  Sha256.parse(source);
  if(await ctx.deps.records.store.get(source,ctx.transaction)===null)throw new Error('回答来源记录不存在');
  const record=await ctx.deps.records.store.get<RequestBody>(request,ctx.transaction);
  if(record?.kind!=='request')throw new Error('请求记录不存在');
  const old=await ctx.deps.records.store.find<{detail:{answer:string}}>({kind:'action',key:'runs.request.answer',value:request,limit:1,newestFirst:true},ctx.transaction);
  if(old.items.length){if(old.items[0].body.detail.answer===source)return;throw new ConflictError('请求已有其他作答来源，不覆盖原回答',{fix:'查看原作答；如需另一项回答，另建明确的请求'});}
  const at=ctx.now().toISOString();
  await ctx.deps.records.store.put({kind:'action',schema:'action@1',provenance:'observed',created_at:at,body:{action:'validate',run:record.body.run??null,item:record.body.item??null,inputs:[`rec:${request}`,`rec:${source}`],component:'requests@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail:{request,answer:source}},index:[{key:'runs.request.answer',value:request}]},ctx.transaction);
}
export async function requestRecords(ctx:RequestContext,run?:string):Promise<RequestView[]>{
  const out:RequestView[]=[];let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<RequestBody>>=run===undefined?await ctx.deps.records.store.list<RequestBody>({kind:'request',limit:500,cursor},ctx.transaction):await ctx.deps.records.store.find<RequestBody>({kind:'request',key:'runs.request.run',value:run,limit:500,cursor},ctx.transaction);
    const records=page.items.filter(record=>record.schema==='request@1');
    const queries=records.map(record=>({kind:'action' as const,key:'runs.request.answer',value:record.digest,limit:1,newestFirst:true}));
    const answers=ctx.deps.records.store.findBatch?await ctx.deps.records.store.findBatch<{detail:{answer:string}}>(queries,ctx.transaction):await Promise.all(queries.map(query=>ctx.deps.records.store.find<{detail:{answer:string}}>(query,ctx.transaction)));
    records.forEach((record,i)=>out.push({...record.body,record:record.digest,answered_by:answers[i].items[0]?.body.detail.answer??null}));
    cursor=page.next;
  }while(cursor!==null);
  return out;
}
export async function requestsOf(ctx:RequestContext,user:Principal,run?:string):Promise<RequestView[]>{
  const records=await requestRecords(ctx,run);
  const allowed=await Promise.all(records.map(request=>user.role==='admin'?true:request.run?ctx.canReadRun?.(user,request.run):request.audience===user.id));
  return records.filter((_,i)=>allowed[i]);
}

/** Trusted components verify responding identity and the actual answering step before calling answer. */
export function createRequestService(records:Pick<RecordsKit,'store'>,now:()=>Date=()=>new Date(),options:{canReadRun?:(by:Principal,run:string)=>Promise<boolean>;transaction?:Transaction}={}){
  const ctx:RequestContext={deps:{records},now,canReadRun:options.canReadRun,transaction:options.transaction};
  return {
    // inspect/all are trusted internal reads, never untrusted client entry points.
    inspect:async(id:string):Promise<RequestView|null>=>{if(!Sha256.safeParse(id).success)return null;const record=await records.store.get(id);if(record?.kind!=='request'||record.schema!=='request@1')return null;const parsed=Request.safeParse(record.body);if(!parsed.success)return null;const answer=await records.store.find<{detail:{answer:string}}>({kind:'action',key:'runs.request.answer',value:id,limit:1,newestFirst:true});return{...parsed.data,record:id,answered_by:answer.items[0]?.body.detail.answer??null};},
    all:(run?:string)=>requestRecords(ctx,run),
    write:(input:RequestBody)=>putRequest(ctx,input),
    list:(by:Principal,run?:string)=>requestsOf(ctx,by,run),
    answer:(request:string,source:string)=>answerRequest(ctx,request,source),
  };
}
