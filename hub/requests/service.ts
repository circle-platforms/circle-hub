// B07 shared append-only request storage. Runtime policy and package routing stay with their callers.
import { z } from 'zod';
import {RequestRecord as Request} from '../../contracts/src/request.ts';
import { Sha256 } from '../../contracts/src/common.ts';
import { digestOf, ConflictError, type Principal, type StoredRecord, type Page, type RecordsKit,type Transaction } from '../records/api.ts';
interface RequestContext {deps:{records:Pick<RecordsKit,'store'>};now:()=>Date;transaction?:Transaction;canReadRun?:(by:Principal,run:string)=>Promise<boolean>}
export type RequestBody=z.infer<typeof Request>;
export const RequestBodySchema=Request;
/**
 * A request as it is listed: `answered_by` is the record that closed it (null while it waits). `superseded` is set when that
 * record is a later accepted result that voided it (B07 R[10]) rather than an answer.
 */
export type RequestView=RequestBody & {record:string;answered_by:string|null;superseded?:true};
/** The identity a request is deduplicated by: the parsed body without its deadline. */
export function requestKey(body:RequestBody):string{
  // The deadline is fixed on first creation, not extended by reading or resubmitting the same problem.
  const {due:_,...identity}=body;
  return digestOf(identity);
}
/** The key of a listed request, the same one its creation indexed. */
export function requestKeyOf(view:RequestView):string{
  const {record:_record,answered_by:_answer,superseded:_superseded,...body}=view;
  return requestKey(body);
}
export async function putRequest(ctx:RequestContext,input:RequestBody):Promise<StoredRecord<RequestBody>>{
  const body=Request.parse(input);
  const key=requestKey(body);
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
/**
 * B07 R[10]: voids waiting requests because `source`, a later accepted result of the same run, issued its own. A request that
 * was answered or voided meanwhile keeps what closed it. Returns how many were voided.
 */
export async function supersedeRequests(ctx:RequestContext,requests:readonly string[],source:string):Promise<number>{
  Sha256.parse(source);
  if(!requests.length)return 0;
  if(await ctx.deps.records.store.get(source,ctx.transaction)===null)throw new Error('作废来源记录不存在');
  let written=0;
  for(let from=0;from<requests.length;from+=SCOPE_BATCH){
    const batch=requests.slice(from,from+SCOPE_BATCH),closed=await newestAnswers(ctx,batch),records=await ctx.deps.records.store.getMany<RequestBody>(batch,ctx.transaction);
    for(const request of batch){
      if(closed.get(request)?.by)continue;
      await closing(ctx,request,records.get(request),source,{request,answer:source,superseded:true});
      written++;
    }
  }
  return written;
}
/**
 * Lets voided requests wait again: `source` is a result of the submission that issued them, which is the run's result once
 * more (the same content submitted again after another). Only a voided request is reinstated, never an answered one.
 * Returns how many wait again.
 */
export async function reinstateRequests(ctx:RequestContext,requests:readonly string[],source:string):Promise<number>{
  Sha256.parse(source);
  if(!requests.length)return 0;
  if(await ctx.deps.records.store.get(source,ctx.transaction)===null)throw new Error('恢复来源记录不存在');
  let written=0;
  for(let from=0;from<requests.length;from+=SCOPE_BATCH){
    const batch=requests.slice(from,from+SCOPE_BATCH),closed=await newestAnswers(ctx,batch),records=await ctx.deps.records.store.getMany<RequestBody>(batch,ctx.transaction);
    for(const request of batch){
      const now=closed.get(request);
      if(!now?.by||!now.superseded)continue;
      await closing(ctx,request,records.get(request),source,{request,reinstated_by:source});
      written++;
    }
  }
  return written;
}
/** Appends the newest closing record of a request: listings read the newest one, and one without an answer means it waits. */
async function closing(ctx:RequestContext,request:string,record:StoredRecord<RequestBody>|undefined,source:string,detail:Record<string,unknown>):Promise<void>{
  if(record?.kind!=='request')throw new Error('请求记录不存在');
  const at=ctx.now().toISOString();
  await ctx.deps.records.store.put({kind:'action',schema:'action@1',provenance:'observed',created_at:at,body:{action:'validate',run:record.body.run??null,item:record.body.item??null,inputs:[`rec:${request}`,`rec:${source}`],component:'requests@1',lease:null,started_at:at,ended_at:at,result:'completed',error_code:null,acceptance:null,codes:[],detail},index:[{key:'runs.request.answer',value:request}]},ctx.transaction);
}
const REQUEST_PAGE=500;
const SCOPE_BATCH=128;
export async function requestRecords(ctx:RequestContext,run?:string):Promise<RequestView[]>{
  const out:RequestView[]=[];let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<RequestBody>>=run===undefined?await ctx.deps.records.store.list<RequestBody>({kind:'request',limit:REQUEST_PAGE,cursor},ctx.transaction):await ctx.deps.records.store.find<RequestBody>({kind:'request',key:'runs.request.run',value:run,limit:REQUEST_PAGE,cursor},ctx.transaction);
    const requests=page.items.filter(record=>record.schema==='request@1');
    const answers=await newestAnswers(ctx,requests.map(record=>record.digest));
    for(const record of requests)out.push(viewOf(record.body,record.digest,answers.get(record.digest)));
    cursor=page.next;
  }while(cursor!==null);
  return out;
}
/** A narrowed read of the requests: those bound to these runs or packs, and these requests themselves. */
export interface RequestScope {runs?:readonly string[];packs?:readonly string[];records?:readonly string[]}
/**
 * The requests of a scope, each once, in no order: what a reader that knows what changed asks for instead of every request. A
 * request's escalations carry its run and pack, so the requests of a run or pack hold the whole of any escalation chain.
 */
export async function requestRecordsIn(ctx:RequestContext,scope:RequestScope):Promise<RequestView[]>{
  const store=ctx.deps.records.store,found=new Map<string,StoredRecord<RequestBody>>();
  const indexed=async(key:string,values:readonly string[])=>{
    for(let at=0;at<values.length;at+=SCOPE_BATCH)for(const record of await store.findMany<RequestBody>({kind:'request',key,values:values.slice(at,at+SCOPE_BATCH)},ctx.transaction))found.set(record.digest,record);
  };
  await indexed('runs.request.run',scope.runs??[]);
  await indexed('runs.request.pack',scope.packs??[]);
  const named=scope.records??[];
  for(let at=0;at<named.length;at+=SCOPE_BATCH)for(const record of (await store.getMany<RequestBody>(named.slice(at,at+SCOPE_BATCH),ctx.transaction)).values())if(record.kind==='request')found.set(record.digest,record);
  const requests=[...found.values()].filter(record=>record.schema==='request@1'),out:RequestView[]=[];
  for(let at=0;at<requests.length;at+=REQUEST_PAGE){
    const page=requests.slice(at,at+REQUEST_PAGE),answers=await newestAnswers(ctx,page.map(record=>record.digest));
    for(const record of page)out.push(viewOf(record.body,record.digest,answers.get(record.digest)));
  }
  return out;
}
/**
 * The newest answer of each request, read for a page of requests at once (one lookup per request made a listing of every
 * request cost one round trip each). Every answer action carries its request in detail.request, the value it is indexed
 * under; should one not, the page falls back to the lookup per request, so the answer is the same either way.
 */
interface Closing {by:string|null;superseded:boolean}
const closingOf=(detail:{answer?:unknown;superseded?:unknown}|undefined):Closing=>({by:typeof detail?.answer==='string'?detail.answer:null,superseded:detail?.superseded===true});
const viewOf=(body:RequestBody,record:string,closing:Closing|undefined):RequestView=>({...body,record,answered_by:closing?.by??null,...(closing?.by&&closing.superseded?{superseded:true as const}:{})});
async function newestAnswers(ctx:RequestContext,requests:readonly string[]):Promise<Map<string,Closing>>{
  const out=new Map<string,Closing>();
  if(!requests.length)return out;
  const wanted=new Set(requests);
  const rows=await ctx.deps.records.store.findMany<{detail?:{request?:unknown;answer?:unknown;superseded?:unknown}}>({kind:'action',key:'runs.request.answer',values:requests},ctx.transaction);
  if(rows.every(row=>typeof row.body.detail?.request==='string'&&wanted.has(row.body.detail.request))){
    // findMany returns the matches oldest first, so the last answer seen for a request is its newest.
    for(const row of rows)out.set(row.body.detail!.request as string,closingOf(row.body.detail));
    return out;
  }
  for(const request of requests){
    const answer=await ctx.deps.records.store.find<{detail:{answer:string;superseded?:unknown}}>({kind:'action',key:'runs.request.answer',value:request,limit:1,newestFirst:true},ctx.transaction);
    out.set(request,closingOf(answer.items[0]?.body.detail));
  }
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
    // inspect/all/within are trusted internal reads, never untrusted client entry points.
    inspect:async(id:string):Promise<RequestView|null>=>{if(!Sha256.safeParse(id).success)return null;const record=await records.store.get(id);if(record?.kind!=='request'||record.schema!=='request@1')return null;const parsed=Request.safeParse(record.body);if(!parsed.success)return null;const answer=await records.store.find<{detail:{answer:string;superseded?:unknown}}>({kind:'action',key:'runs.request.answer',value:id,limit:1,newestFirst:true});return viewOf(parsed.data,id,closingOf(answer.items[0]?.body.detail));},
    all:(run?:string)=>requestRecords(ctx,run),
    within:(scope:RequestScope)=>requestRecordsIn(ctx,scope),
    write:(input:RequestBody)=>putRequest(ctx,input),
    list:(by:Principal,run?:string)=>requestsOf(ctx,by,run),
    answer:(request:string,source:string)=>answerRequest(ctx,request,source),
    supersede:(requests:readonly string[],source:string)=>supersedeRequests(ctx,requests,source),
    reinstate:(requests:readonly string[],source:string)=>reinstateRequests(ctx,requests,source),
  };
}
