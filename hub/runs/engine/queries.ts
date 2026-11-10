import {withdrawalState,groundsReadableBy,runReadableBy,resultReadableBy} from './grounds.ts';
import {criterionNotices} from './criterion-changes.ts';
import { isReason,labelOf } from '../../../contracts/generated/vocabulary.ts';
import { abandonDecision } from './management.ts';
import { requestsOf } from './requests.ts';
// Queries for the server and console (R02): owners retain access; team admins and grants remain subject to current grounds.
// Absent and forbidden give the same null or empty page. Phase and counts are derived, never stored.
import { CORE_VIOLATION_CODES, PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import {RunId,IsoTime} from '../../../contracts/src/common.ts';
import type { RunRecord, RunRecordView } from '../../../contracts/src/run.ts';
import {hasRulingSummary,summaryOf} from './start.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { RecordsError, type RecordStore, type Page, type Principal, type StoredRecord } from '../../records/api.ts';
import type { RunDetail, RunSummary, RunSubmissionView, RunListing, LoadedWorkflow, RunHistoryOptions } from '../../ports.ts';
import type { EngineContext } from './deps.ts';
import { canSeeRun, canViewRun } from './readers.ts';
import { actionOfSubmission, isVerbatimObject, latestAccepted, listRunRecords, resultFor, resultsOf, runById, submissionByDigest, submissionsOf, INDEX, keyOwner } from './store.ts';
import { isObject, receivedDigest } from './util.ts';

export interface StoredResult {
  /** Current package state; never rewrite the result named by record. */
  rule_withdrawn?: true;
  grounds_withdrawn?:string[];
  grounds_withdrawn_hidden_count?:number;
  /** Digest of the validation_result record. */
  record: string;
  result: ValidationResult;
}

async function visibleRun(ctx: EngineContext, user: Principal, run: string): Promise<StoredRecord<RunRecord> | null> {
  const stored = await runById(ctx.deps.records.store, run);
  return stored !== null && await runReadableBy(ctx,user,stored.body) ? stored : null;
}

export async function resultState(ctx:EngineContext,user:Principal,result:ValidationResult):Promise<{readable:boolean;grounds_withdrawn:string[];grounds_withdrawn_hidden_count:number}>{
  const stored=await visibleRun(ctx,user,result.run);
  const readable=stored!==null&&await resultReadableBy(ctx,stored.body,result,user);
  return {readable,...(readable?await withdrawalState(ctx,result,user,true):{grounds_withdrawn:[],grounds_withdrawn_hidden_count:0})};
}

async function withRulingSummary(ctx:EngineContext,record:RunRecord,packages=new Map<string,Promise<LoadedWorkflow|null>>()):Promise<RunRecordView>{
  if(hasRulingSummary(record))return record;
  const key=(record.pack_space??'team')+'/'+record.pack_digest;
  let loading=packages.get(key);
  if(!loading){loading=ctx.deps.workflows.byDigest(record.pack_digest,record.pack_space);packages.set(key,loading);}
  const workflow=await loading;
  return {...record,requirements:summaryOf(record,workflow??undefined).requirements};
}

/** Read the exact frozen version through the existing metadata port, after run visibility has been checked. */
async function ruleWithdrawal(ctx:EngineContext,user:Principal,run:RunRecord):Promise<{rule_withdrawn:true}|Record<string,never>>{
  return await ctx.deps.workflows.absence?.(user,run.pack,run.pack_space)==='withdrawn'?{rule_withdrawn:true}:{};
}

/** The same management/technical head and visibility rule for summaries and full detail. Never fall back past a hidden head. */
async function selectedHead(ctx:EngineContext,user:Principal,stored:StoredRecord<RunRecord>,results?:readonly StoredRecord<ValidationResult>[]){
  const store=ctx.deps.records.store,run=stored.body.run;
  const technicalLatest=results?results.findLast(result=>result.body.acceptance==='accepted')??null:await latestAccepted(store,run),management=await abandonDecision(ctx,run);
  const managementResult=management?(await store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultSystemInput,value:'rec:'+management.digest,limit:1})).items[0]??null:null;
  const selected=management?managementResult:technicalLatest;
  const latest=selected!==null&&!await resultReadableBy(ctx,stored.body,selected.body,user)?null:selected;
  return {latest,...(management?{management:{record:management.digest,disposition:'abandon' as const,result:latest?.digest??null}}:{})};
}

/** What a record-level read needs of a run: whether `getRun` would answer, and the fields `canSeeRun` decides on. Never reads the history. */
export async function runHeader(ctx:EngineContext,user:Principal,run:string):Promise<Pick<RunRecord,'runner'|'host'|'pack_space'>|null>{
  const stored=await visibleRun(ctx,user,run);if(stored===null)return null;
  const {runner,host,pack_space}=stored.body;return {host,...(runner===undefined?{}:{runner}),...(pack_space===undefined?{}:{pack_space})};
}
/** The visibility rule of `getRun`, which answers null exactly when this is false; it reads the run record and its grounds only, never the history. */
export async function runVisible(ctx:EngineContext,user:Principal,run:string):Promise<boolean>{return await visibleRun(ctx,user,run)!==null;}

/** Summaries never enumerate receipts, request answers or unrelated historical result grounds to draw a list/chart. */
export async function getRunSummary(ctx:EngineContext,user:Principal,run:string):Promise<RunSummary|null>{
  const stored=await visibleRun(ctx,user,run);if(!stored)return null;
  const store=ctx.deps.records.store,technicalLatest=await latestAccepted(store,run,1),head=await selectedHead(ctx,user,stored,technicalLatest?[technicalLatest]:[]);
  let production:RunSummary['production']=null,cursor:string|null=null;
  do{
    const page:Page<StoredRecord<ValidationResult>>=await store.find<ValidationResult>({key:INDEX.resultSubmission,value:run+':'+stored.digest,kind:'validation_result',limit:1,cursor,newestFirst:true});
    const candidate=page.items[0];
    if(candidate&&candidate.body.submission===stored.digest&&candidate.body.system_input===undefined&&await resultReadableBy(ctx,stored.body,candidate.body,user)){
      production={record:candidate.digest,result:candidate.body};break;
    }
    cursor=page.next;
  }while(cursor!==null);
  return {run:await withRulingSummary(ctx,stored.body),latest:head.latest?{record:head.latest.digest,result:head.latest.body}:null,production,...(head.management?{management:head.management}:{})};
}

/** The newest readable result of this index value (a submission of the run, or the run's own production), without reading older ones once found. */
async function newestReadable(ctx:EngineContext,user:Principal,run:RunRecord,value:string):Promise<StoredRecord<ValidationResult>|null>{
  let cursor:string|null=null;
  do{
    const page:Page<StoredRecord<ValidationResult>>=await ctx.deps.records.store.find<ValidationResult>({key:INDEX.resultSubmission,value,kind:'validation_result',limit:4,cursor,newestFirst:true});
    for(const record of page.items)if(await resultReadableBy(ctx,run,record.body,user))return record;
    cursor=page.next;
  }while(cursor!==null);
  return null;
}

/**
 * One window of a run's submissions, newest first by cursor, listed oldest first. The submission behind the current result is pinned
 * to the newest window when it is older, so the page never shows a result without the submission that produced it. A cursor the store
 * cannot use ends the paging with an empty window rather than failing the read.
 */
async function submissionWindow(ctx:EngineContext,user:Principal,stored:StoredRecord<RunRecord>,history:NonNullable<RunHistoryOptions['history']>,headSubmission:string|undefined){
  const store=ctx.deps.records.store,limit=Math.max(1,Math.min(200,Math.trunc(history.limit)||1));
  let items:StoredRecord<unknown>[]=[],next:string|null=null;
  try{const page=await store.find<unknown>({key:INDEX.submissionRun,value:stored.body.run,kind:'submission',limit,cursor:history.before??null,newestFirst:true});items=page.items.toReversed();next=page.next;}
  catch(error){if(!(error instanceof TypeError||error instanceof RangeError||error instanceof RecordsError))throw error;}
  let pinned:string|undefined;
  if((history.before===undefined||history.before===null)&&headSubmission!==undefined){
    const behind=await submissionByDigest(store,stored.body.run,headSubmission);
    if(behind!==null&&!items.some(row=>row.digest===behind.digest)){items=[behind,...items];pinned=behind.digest;}
  }
  return {items,next,limit,pinned};
}

export async function getRun(ctx: EngineContext, user: Principal, run: string, options: RunHistoryOptions = {}): Promise<RunDetail | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  // A shared view includes accepted validation bodies only; rejected receipts fall back to public action codes.
  const owner = canSeeRun(user, stored.body);
  const window=options.history;
  // Bounded: the heads first (they decide which submission is pinned), then results for the listed rows only.
  const boundedHead=window===undefined?null:await selectedHead(ctx,user,stored);
  const page=window===undefined?null:await submissionWindow(ctx,user,stored,window,boundedHead?.latest?.body.submission);
  const boundedProduction=window===undefined?undefined:await newestReadable(ctx,user,stored.body,`${run}:${stored.digest}`);
  const shown=new Map<string,StoredRecord<ValidationResult>>();
  const candidates=window===undefined?await resultsOf(store,run):[],readable=await Promise.all(candidates.map(record=>resultReadableBy(ctx,stored.body,record.body,user)));
  const unboundedResults=candidates.filter((_,i)=>readable[i]);
  const byDigest = new Map(unboundedResults.filter(r=>r.body.system_input===undefined).map((r) => [r.body.submission, r]));
  const submissions: RunSubmissionView[] = await Promise.all((page===null?await submissionsOf(store,run):page.items).map(async record=>{
    const action = await actionOfSubmission(store, record.digest);
    const detail = action !== null && isObject(action.body.detail) ? action.body.detail : {};
    const submission = typeof detail.submission === 'string' ? detail.submission : isVerbatimObject(record) ? null : receivedDigest(record.body).digest;
    let result = submission === null ? undefined : byDigest.get(submission);
    if (window !== undefined && submission !== null) { result = await newestReadable(ctx, user, stored.body, `${run}:${submission}`) ?? undefined; if (result !== undefined) shown.set(result.digest, result); }
    const privateReceipt=!owner||stored.body.runner!==user.id&&!await groundsReadableBy(ctx,stored.body,record.body,user);
    const codes = action?.body.codes ?? [];
    const hubError = action?.body.result === 'error' && detail.hub_error === true;
    return {
      record: record.digest,
      received_at: record.created_at,
      acceptance: hubError || action === null && result === undefined ? null : result?.body.acceptance ?? action?.body.acceptance ?? 'not_accepted',
      errors: privateReceipt && result===undefined ? publicReceiptErrors(codes) : action===null&&result===undefined ? [{code:'check_error',message:'未校验（中断）',fix:'Hub 将自动重验；也可带原会话原样重交'}] : hubError ? [{code: action?.body.error_code ?? 'check_error', message: '未校验（中断）', ...(typeof detail.fix === 'string' ? {fix: detail.fix} : {})}] : result?.body.errors ?? publicReceiptErrors(codes),
      result: result !== undefined && result.body.acceptance === 'accepted' ? result.digest : null,
    };
  }));
  const {latest,management}=boundedHead??await selectedHead(ctx,user,stored);
  const production = window===undefined ? unboundedResults.filter(result => result.body.submission === stored.digest&&result.body.system_input===undefined).at(-1) : boundedProduction??undefined;
  // Withdrawn grounds are judged over the results this read shows: all of them, or the listed rows' results, the current result and the production result.
  const results = window===undefined ? unboundedResults : [...new Map([...shown,...(latest?[[latest.digest,latest] as const]:[]),...(production?[[production.digest,production] as const]:[])]).values()];
  const notices=await criterionNotices(ctx,stored.body);
  const withdrawn=await withdrawalState(ctx,results.map(row=>row.body),user,true);
  // The reader may already read this run; the purge facts name only its own sources, never another account's content.
  const purged=await ctx.deps.records.personalPayloads?.purgedRunOriginals(stored.digest)??[];
  const grounds_purged=purged.length?stored.body.sources.flatMap(source=>{const hit=purged.find(row=>row.artifact===source.artifact);return hit?[{reference:source.reference,at:hit.at}]:[];}):[];
  return { ...(withdrawn.grounds_withdrawn.length||withdrawn.grounds_withdrawn_hidden_count?withdrawn:{}),...(grounds_purged.length?{grounds_purged}:{}),...await ruleWithdrawal(ctx,user,stored.body),run: {...await withRulingSummary(ctx,stored.body),...(notices.length?{criterion_changes:notices}:{})},submissions,...(page===null?{}:{history:{limit:page.limit,next:page.next,...(page.pinned===undefined?{}:{pinned:page.pinned})}}),...(management?{management}:{}), requests: await requestsOf(ctx,user,run), latest: latest === null ? null : { record: latest.digest, result: latest.body },
    production: production === undefined ? null : {record:production.digest,result:production.body} };
}

export async function listRuns(ctx: EngineContext, user: Principal, query: { pack?: string; limit?: number; cursor?: string | null; requests?: boolean } = {}): Promise<RunListing> {
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return { items: [], next: null };
  const pack = query.pack ?? null;
  let after: { at: string; id: string } | null = null;
  if (query.cursor !== undefined && query.cursor !== null) {
    try {
      const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (value.reader !== user.id || value.pack !== pack || typeof value.at !== 'string' || typeof value.id !== 'string') return { items: [], next: null };
      after = value;
    } catch { return { items: [], next: null }; }
  }
  const rows: RunRecord[] = [];
  const store=ctx.deps.records.store;
  const validHeader=(record:StoredRecord<RunRecord>)=>RunId.safeParse(record.body?.run).success&&IsoTime.safeParse(record.body?.started_at).success;
  const diagnose=(record:StoredRecord<RunRecord>)=>ctx.log({traceId:null,run:RunId.safeParse(record.body?.run).success?record.body.run:null,what:'list_runs',detail:'Malformed run ordering headers; record '+record.digest});
  let fallback=!store.runCandidates;
  if(store.runCandidates){
    let candidateAfter:readonly [string,string]|undefined=after?[after.at,after.id]:undefined;
    while(rows.length<=limit){
      const count=Math.min(500,Math.max(32,limit+1-rows.length));
      let candidates:StoredRecord<RunRecord>[];
      try{candidates=await store.runCandidates<RunRecord>({...(candidateAfter?{after:candidateAfter}:{}),...(query.pack===undefined?{}:{pack:query.pack}),limit:count});}
      catch(error){if(error instanceof TypeError||error instanceof RangeError||error instanceof RecordsError&&error.name==='RecordsError')return {items:[],next:null};throw error;}
      // A malformed header cannot be a continuation boundary. Scan once and skip/log it in the same fallback as adapters.
      if(candidates.some(record=>!validHeader(record))){fallback=true;rows.length=0;break;}
      const readable=await Promise.all(candidates.map(record=>runReadableBy(ctx,user,record.body)));
      for(let i=0;i<candidates.length&&rows.length<=limit;i++)if(readable[i])rows.push(candidates[i].body);
      if(candidates.length<count)break;
      const last=candidates.at(-1)!;candidateAfter=[last.body.started_at,last.body.run];
    }
  }
  if(fallback){
   let cursor: string | null = null;
   do {
    let page: Page<StoredRecord<RunRecord>>;
    try { page = await listRunRecords(ctx.deps.records.store, query.pack === undefined ? {} : {pack:query.pack}, { limit:500, cursor }); }
    catch (error) {
      if (error instanceof TypeError || error instanceof RangeError || error instanceof RecordsError && error.name === 'RecordsError') return {items:[],next:null};
      throw error;
    }
    const candidates=page.items.filter(record=>{if(validHeader(record))return true;diagnose(record);return false;});
    const readable=await Promise.all(candidates.map(record=>runReadableBy(ctx,user,record.body)));
    rows.push(...candidates.filter((_,i)=>readable[i]).map(record=>record.body));
    cursor = page.next;
   } while (cursor !== null);
  }
  const compare = (a: string,b: string): number => a === b ? 0 : a < b ? -1 : 1;
  const order = (a: RunRecord,b: RunRecord): number => compare(b.started_at,a.started_at) || compare(b.run,a.run);
  rows.sort(order);
  const following = after === null ? rows : rows.filter(row => row.started_at < after!.at || row.started_at === after!.at && row.run < after!.id);
  const packages=new Map<string,Promise<LoadedWorkflow|null>>();
  const items = await Promise.all(following.slice(0,limit).map(record=>withRulingSummary(ctx,record,packages)));
  const last = items.at(-1);
  const next = following.length > limit && last ? Buffer.from(JSON.stringify({reader:user.id,pack,at:last.started_at,id:last.run})).toString('base64url') : null;
  // These fields read every request the reader may see, whichever page is listed; a caller that shows none of them opts out.
  if(query.requests===false)return {items,next};
  let requests=(await requestsOf(ctx,user)).filter(r=>r.answered_by===null);
  if(query.pack){const matches=await Promise.all(requests.map(async request=>{const linked=request.run?await runById(ctx.deps.records.store,request.run):null;const pack=linked?.body.pack??(request.pack_digest?(await ctx.deps.workflows.byDigest(request.pack_digest))?.pack.id:null);return pack?.split('@')[0]===query.pack;}));requests=requests.filter((_,i)=>matches[i]);}
  const overdue_requests=requests.filter(request=>Date.parse(request.due)<=ctx.now().getTime());
  const open=await Promise.all(items.map(async run=>{const superseded=await hasSuccessor(ctx,run);if((superseded||await abandonDecision(ctx,run.run))&&!requests.some(r=>r.run===run.run))return false;const latest=await latestAccepted(ctx.deps.records.store,run.run);return !latest||requests.some(r=>r.run===run.run)||latest.body.partitions.incomplete.length>0||latest.body.partitions.quarantined.length>0||latest.body.errors.some(e=>(e.rounds_left??0)>0);}));
  const open_runs=items.filter((_,i)=>open[i]).map(run=>run.run);
  return {items,next,...(overdue_requests.length?{overdue_requests}:{}),...(requests.length?{requests}:{}),...(open_runs.length?{open_runs}:{})};
}

/** One validation result of a run: of a submission by its digest as received, or the latest accepted one. */
export async function getResult(ctx: EngineContext, user: Principal, run: string, submission?: string): Promise<StoredResult | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  const management=submission===undefined?await abandonDecision(ctx,run):null;
  const found = management ? (await store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultSystemInput,value:'rec:'+management.digest,limit:1})).items[0]??null : submission===undefined?await latestAccepted(store,run):await resultFor(store,run,submission);
  return found===null||!await resultReadableBy(ctx,stored.body,found.body,user)?null:{...await ruleWithdrawal(ctx,user,stored.body),...await withdrawalState(ctx,found.body,user,true),record:found.digest,result:found.body};
}

/** The runs of one pack the user may see, newest first. */
export async function runsFor(ctx: EngineContext, user: Principal, pack: string, query: { limit?: number; cursor?: string | null } = {}): Promise<Page<RunRecord>> {
  return listRuns(ctx, user, { ...query, pack });
}

/** Whether a stored submission body parses as submission@1 (for the console). */
export function parsesAsSubmission(body: unknown): boolean {
  return Submission.safeParse(body).success;
}

async function hasSuccessor(ctx:EngineContext,run:RunRecord):Promise<boolean>{
  let cursor:string|null=null;
  do{const page:Page<StoredRecord<RunRecord>>=await ctx.deps.records.store.find<RunRecord>({kind:'run',key:INDEX.runPredecessor,value:run.run,limit:200,cursor});if(page.items.some(s=>keyOwner(s.body)===keyOwner(run)&&s.body.pack.split('@')[0]===run.pack.split('@')[0]))return true;cursor=page.next;}while(cursor!==null);
  return false;
}

/** Shared refusal summaries contain registered descriptions only, never instance diagnostics. */
function publicReceiptErrors(codes:readonly string[]){
  return codes.map(code=>({code,message:Object.hasOwn(PROTOCOL_CODES,code)?PROTOCOL_CODES[code as keyof typeof PROTOCOL_CODES].when:Object.hasOwn(CORE_VIOLATION_CODES,code)?CORE_VIOLATION_CODES[code as keyof typeof CORE_VIOLATION_CODES].when:isReason(code)?labelOf('reason',code):''}));
}

/** W04 R[2]: the administrator's inventory, across locked versions; tables never leave storage. */
export async function unruledShapes(store: RecordStore, user: Principal, pack: string): Promise<Array<{requirement:string;interpreter:string;count:number;latest_run:string}>> {
  if (user.role !== 'admin') throw new RecordsError('未裁定的形状存在，只有管理员能查看', {code:'SOURCE_NOT_PERMITTED'});
  const rows = new Map<string,{requirement:string;interpreter:string;count:number;latest_run:string}>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page:Page<StoredRecord<ValidationResult>>=await store.list<ValidationResult>({kind:'validation_result',limit:500,cursor});
    for (const record of page.items) {
      const result=record.body;
      if (result.locks.pack.split('@')[0] !== pack) continue;
      for (const claim of result.cross_item) {
        const data=claim.statement.data;
        if (!claim.qualifier.marks.includes('decision_shape_unruled') || typeof data?.requirement!=='string' || typeof data.interpreter!=='string') continue;
        const key=JSON.stringify([data.requirement,data.interpreter]);
        const occurrence=JSON.stringify([result.run,result.submission,key]);
        if(seen.has(occurrence))continue;
        seen.add(occurrence);
        const row=rows.get(key)??{requirement:data.requirement,interpreter:data.interpreter,count:0,latest_run:result.run};
        row.count++;row.latest_run=result.run;rows.set(key,row);
      }
    }
    cursor=page.next;
  } while(cursor!==null);
  return [...rows.values()].sort((a,b)=>a.requirement.localeCompare(b.requirement)||a.interpreter.localeCompare(b.interpreter));
}
