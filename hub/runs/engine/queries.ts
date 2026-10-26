import {criterionNotices} from './criterion-changes.ts';
import { isReason,labelOf } from '../../../contracts/generated/vocabulary.ts';
import { abandonDecision } from './management.ts';
import { requestsOf } from './requests.ts';
// Queries for the server and console (R02): owners/admins retain full access; explicit shares add read-only visibility.
// Absent and forbidden give the same null or empty page. Phase and counts are derived, never stored.
import { CORE_VIOLATION_CODES, PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import type { RunRecord, RunRecordView } from '../../../contracts/src/run.ts';
import {hasRulingSummary,summaryOf} from './start.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { RecordsError, type RecordStore, type Page, type Principal, type StoredRecord } from '../../records/api.ts';
import type { RunDetail, RunSubmissionView, RunListing, LoadedWorkflow } from '../../ports.ts';
import type { EngineContext } from './deps.ts';
import { canSeeRun, canViewRun } from './readers.ts';
import { actionOfSubmission, isVerbatimObject, latestAccepted, listRunRecords, resultFor, resultsOf, runById, submissionsOf, INDEX, keyOwner } from './store.ts';
import { isObject, receivedDigest } from './util.ts';

export interface StoredResult {
  /** Digest of the validation_result record. */
  record: string;
  result: ValidationResult;
}

async function visibleRun(ctx: EngineContext, user: Principal, run: string): Promise<StoredRecord<RunRecord> | null> {
  const stored = await runById(ctx.deps.records.store, run);
  return stored !== null && await canViewRun(user, stored.body, ctx.deps.records.store) ? stored : null;
}

async function withRulingSummary(ctx:EngineContext,record:RunRecord,packages=new Map<string,Promise<LoadedWorkflow|null>>()):Promise<RunRecordView>{
  if(hasRulingSummary(record))return record;
  let loading=packages.get(record.pack_digest);
  if(!loading){loading=ctx.deps.workflows.byDigest(record.pack_digest);packages.set(record.pack_digest,loading);}
  const workflow=await loading;
  return {...record,requirements:summaryOf(record,workflow??undefined).requirements};
}

export async function getRun(ctx: EngineContext, user: Principal, run: string): Promise<RunDetail | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  // A shared view includes accepted validation bodies only; rejected receipts fall back to public action codes.
  const owner = canSeeRun(user, stored.body);
  const results = (await resultsOf(store, run)).filter(record => owner || record.body.acceptance === 'accepted');
  const byDigest = new Map(results.filter(r=>r.body.system_input===undefined).map((r) => [r.body.submission, r]));
  const submissions: RunSubmissionView[] = [];
  for (const record of await submissionsOf(store, run)) {
    const action = await actionOfSubmission(store, record.digest);
    const detail = action !== null && isObject(action.body.detail) ? action.body.detail : {};
    const submission = typeof detail.submission === 'string' ? detail.submission : isVerbatimObject(record) ? null : receivedDigest(record.body).digest;
    const result = submission === null ? undefined : byDigest.get(submission);
    const codes = action?.body.codes ?? [];
    const hubError = action?.body.result === 'error' && detail.hub_error === true;
    submissions.push({
      record: record.digest,
      received_at: record.created_at,
      acceptance: hubError || action === null && result === undefined ? null : result?.body.acceptance ?? action?.body.acceptance ?? 'not_accepted',
      errors: !owner && result===undefined ? publicReceiptErrors(codes) : action===null&&result===undefined ? [{code:'check_error',message:'未校验（中断）',fix:'Hub 将自动重验；也可带原会话原样重交'}] : hubError ? [{code: action?.body.error_code ?? 'check_error', message: '未校验（中断）', ...(typeof detail.fix === 'string' ? {fix: detail.fix} : {})}] : result?.body.errors ?? publicReceiptErrors(codes),
      result: result !== undefined && result.body.acceptance === 'accepted' ? result.digest : null,
    });
  }
  const technicalLatest = await latestAccepted(store, run);
  const management=await abandonDecision(ctx,run);
  const managementResult=management?(await store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultSystemInput,value:'rec:'+management.digest,limit:1})).items[0]??null:null;
  const selected=management?managementResult:technicalLatest;
  const latest=selected!==null&&(!owner&&selected.body.acceptance!=='accepted')?null:selected;
  const production = results.filter(result => result.body.submission === stored.digest&&result.body.system_input===undefined).at(-1);
  const notices=await criterionNotices(ctx,stored.body);
  return { run: {...await withRulingSummary(ctx,stored.body),...(notices.length?{criterion_changes:notices}:{})},submissions,...(management?{management:{record:management.digest,disposition:'abandon' as const,result:latest?.digest??null}}:{}), requests: await requestsOf(ctx,user,run), latest: latest === null ? null : { record: latest.digest, result: latest.body },
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
  let cursor: string | null = null;
  do {
    let page: Page<StoredRecord<RunRecord>>;
    try { page = await listRunRecords(ctx.deps.records.store, query.pack === undefined ? {} : {pack:query.pack}, { limit:500, cursor }); }
    catch (error) {
      if (error instanceof TypeError || error instanceof RangeError || error instanceof RecordsError && error.name === 'RecordsError') return {items:[],next:null};
      throw error;
    }
    for (const record of page.items) if (await canViewRun(user,record.body,ctx.deps.records.store)) rows.push(record.body);
    cursor = page.next;
  } while (cursor !== null);
  const compare = (a: string,b: string): number => a === b ? 0 : a < b ? -1 : 1;
  const order = (a: RunRecord,b: RunRecord): number => compare(b.started_at,a.started_at) || compare(b.run,a.run);
  rows.sort(order);
  const following = after === null ? rows : rows.filter(row => row.started_at < after!.at || row.started_at === after!.at && row.run < after!.id);
  const packages=new Map<string,Promise<LoadedWorkflow|null>>();
  const items = await Promise.all(following.slice(0,limit).map(record=>withRulingSummary(ctx,record,packages)));
  const last = items.at(-1);
  const next = following.length > limit && last ? Buffer.from(JSON.stringify({reader:user.id,pack,at:last.started_at,id:last.run})).toString('base64url') : null;
  let requests=(await requestsOf(ctx,user)).filter(r=>r.answered_by===null);
  if(query.pack){const matches=[] as typeof requests;for(const request of requests){const linked=request.run?await runById(ctx.deps.records.store,request.run):null;const pack=linked?.body.pack??(request.pack_digest?(await ctx.deps.workflows.byDigest(request.pack_digest))?.pack.id:null);if(pack?.split('@')[0]===query.pack)matches.push(request);}requests=matches;}
  const overdue_requests=requests.filter(request=>Date.parse(request.due)<=ctx.now().getTime());
  const open_runs:string[]=[];
  for(const run of items){const superseded=await hasSuccessor(ctx,run);if((superseded||await abandonDecision(ctx,run.run))&&!requests.some(r=>r.run===run.run))continue;const latest=await latestAccepted(ctx.deps.records.store,run.run);if(!latest||requests.some(r=>r.run===run.run)||latest.body.partitions.incomplete.length||latest.body.partitions.quarantined.length||latest.body.errors.some(e=>(e.rounds_left??0)>0))open_runs.push(run.run);}
  return {items,next,...(overdue_requests.length?{overdue_requests}:{}),...(requests.length?{requests}:{}),...(open_runs.length?{open_runs}:{})};
}

/** One validation result of a run: of a submission by its digest as received, or the latest accepted one. */
export async function getResult(ctx: EngineContext, user: Principal, run: string, submission?: string): Promise<StoredResult | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  const management=submission===undefined?await abandonDecision(ctx,run):null;
  const found = management ? (await store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultSystemInput,value:'rec:'+management.digest,limit:1})).items[0]??null : submission===undefined?await latestAccepted(store,run):await resultFor(store,run,submission);
  return found === null || !canSeeRun(user,stored.body) && found.body.acceptance !== 'accepted' ? null : { record: found.digest, result: found.body };
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
