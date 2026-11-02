import {withdrawalState,groundsReadableBy,runReadableBy,resultReadableBy} from './grounds.ts';
import {criterionNotices} from './criterion-changes.ts';
import { isReason,labelOf } from '../../../contracts/generated/vocabulary.ts';
import { abandonDecision } from './management.ts';
import { requestsOf } from './requests.ts';
// Queries for the server and console (R02): owners retain access; team admins and grants remain subject to current grounds.
// Absent and forbidden give the same null or empty page. Phase and counts are derived, never stored.
import { CORE_VIOLATION_CODES, PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import type { RunRecord, RunRecordView } from '../../../contracts/src/run.ts';
import {hasRulingSummary,summaryOf} from './start.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { RecordsError, type RecordStore, type Page, type Principal, type StoredRecord } from '../../records/api.ts';
import type { RunDetail, RunSummary, RunSubmissionView, RunListing, LoadedWorkflow } from '../../ports.ts';
import type { EngineContext } from './deps.ts';
import { canSeeRun, canViewRun } from './readers.ts';
import { actionOfSubmission, isVerbatimObject, latestAccepted, listRunRecords, resultFor, resultsOf, runById, submissionsOf, INDEX, keyOwner } from './store.ts';
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
async function selectedHead(ctx:EngineContext,user:Principal,stored:StoredRecord<RunRecord>){
  const store=ctx.deps.records.store,run=stored.body.run;
  const technicalLatest=await latestAccepted(store,run),management=await abandonDecision(ctx,run);
  const managementResult=management?(await store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultSystemInput,value:'rec:'+management.digest,limit:1})).items[0]??null:null;
  const selected=management?managementResult:technicalLatest;
  const latest=selected!==null&&!await resultReadableBy(ctx,stored.body,selected.body,user)?null:selected;
  return {latest,...(management?{management:{record:management.digest,disposition:'abandon' as const,result:latest?.digest??null}}:{})};
}

/** Summaries never enumerate receipts, request answers or unrelated historical result grounds to draw a list/chart. */
export async function getRunSummary(ctx:EngineContext,user:Principal,run:string):Promise<RunSummary|null>{
  const stored=await visibleRun(ctx,user,run);if(!stored)return null;
  const [candidates,head]=await Promise.all([resultsOf(ctx.deps.records.store,run),selectedHead(ctx,user,stored)]);
  let production:RunSummary['production']=null;
  // Full detail takes the last readable production result, preserving its ordering even for legacy records.
  for(const candidate of candidates.toReversed())if(candidate.body.submission===stored.digest&&candidate.body.system_input===undefined&&await resultReadableBy(ctx,stored.body,candidate.body,user)){
    production={record:candidate.digest,result:candidate.body};break;
  }
  return {run:await withRulingSummary(ctx,stored.body),latest:head.latest?{record:head.latest.digest,result:head.latest.body}:null,production,...(head.management?{management:head.management}:{})};
}

export async function getRun(ctx: EngineContext, user: Principal, run: string): Promise<RunDetail | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  // A shared view includes accepted validation bodies only; rejected receipts fall back to public action codes.
  const owner = canSeeRun(user, stored.body);
  const candidates=await resultsOf(store,run),readable=await Promise.all(candidates.map(record=>resultReadableBy(ctx,stored.body,record.body,user)));
  const results=candidates.filter((_,i)=>readable[i]);
  const byDigest = new Map(results.filter(r=>r.body.system_input===undefined).map((r) => [r.body.submission, r]));
  const submissions: RunSubmissionView[] = await Promise.all((await submissionsOf(store,run)).map(async record=>{
    const action = await actionOfSubmission(store, record.digest);
    const detail = action !== null && isObject(action.body.detail) ? action.body.detail : {};
    const submission = typeof detail.submission === 'string' ? detail.submission : isVerbatimObject(record) ? null : receivedDigest(record.body).digest;
    const result = submission === null ? undefined : byDigest.get(submission);
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
  const {latest,management}=await selectedHead(ctx,user,stored);
  const production = results.filter(result => result.body.submission === stored.digest&&result.body.system_input===undefined).at(-1);
  const notices=await criterionNotices(ctx,stored.body);
  const withdrawn=await withdrawalState(ctx,results.map(row=>row.body),user,true);
  return { ...(withdrawn.grounds_withdrawn.length||withdrawn.grounds_withdrawn_hidden_count?withdrawn:{}),...await ruleWithdrawal(ctx,user,stored.body),run: {...await withRulingSummary(ctx,stored.body),...(notices.length?{criterion_changes:notices}:{})},submissions,...(management?{management}:{}), requests: await requestsOf(ctx,user,run), latest: latest === null ? null : { record: latest.digest, result: latest.body },
    production: production === undefined ? null : {record:production.digest,result:production.body} };
}

export async function listRuns(ctx: EngineContext, user: Principal, query: { pack?: string; limit?: number; cursor?: string | null } = {}): Promise<RunListing> {
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
  if(store.runCandidates){
    let candidateAfter:readonly [string,string]|undefined=after?[after.at,after.id]:undefined;
    while(rows.length<=limit){
      const count=Math.min(500,Math.max(32,limit+1-rows.length));
      let candidates:StoredRecord<RunRecord>[];
      try{candidates=await store.runCandidates<RunRecord>({...(candidateAfter?{after:candidateAfter}:{}),...(query.pack===undefined?{}:{pack:query.pack}),limit:count});}
      catch(error){if(error instanceof TypeError||error instanceof RangeError||error instanceof RecordsError&&error.name==='RecordsError')return {items:[],next:null};throw error;}
      const readable=await Promise.all(candidates.map(record=>runReadableBy(ctx,user,record.body)));
      for(let i=0;i<candidates.length&&rows.length<=limit;i++)if(readable[i])rows.push(candidates[i].body);
      if(candidates.length<count)break;
      const last=candidates.at(-1)!;candidateAfter=[last.body.started_at,last.body.run];
    }
  }else{
   let cursor: string | null = null;
   do {
    let page: Page<StoredRecord<RunRecord>>;
    try { page = await listRunRecords(ctx.deps.records.store, query.pack === undefined ? {} : {pack:query.pack}, { limit:500, cursor }); }
    catch (error) {
      if (error instanceof TypeError || error instanceof RangeError || error instanceof RecordsError && error.name === 'RecordsError') return {items:[],next:null};
      throw error;
    }
    const readable=await Promise.all(page.items.map(record=>runReadableBy(ctx,user,record.body)));
    rows.push(...page.items.filter((_,i)=>readable[i]).map(record=>record.body));
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
  if (user.role !== 'admin') throw new RecordsError('只有管理员可查看未裁定的形状', {code:'SOURCE_UNAVAILABLE'});
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
