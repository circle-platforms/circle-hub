import { abandonDecision,isAbandonedResult } from './management.ts';
import { requestsOf } from './requests.ts';
// Queries for the server and the console (R02): a user sees their own runs, an admin every run, a Hub-side run only an
// admin; absent and forbidden give the same null or the same empty page. Phase and counts are derived, never stored.
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { RecordsError, type Page, type Principal, type StoredRecord } from '../../records/api.ts';
import type { RunDetail, RunSubmissionView, RunListing } from '../../ports.ts';
import type { EngineContext } from './deps.ts';
import { canSeeRun } from './readers.ts';
import { actionOfSubmission, isVerbatimObject, latestAccepted, listRunRecords, resultFor, resultsOf, runById, submissionsOf, INDEX, keyOwner } from './store.ts';
import { isObject, receivedDigest } from './util.ts';

export interface StoredResult {
  /** Digest of the validation_result record. */
  record: string;
  result: ValidationResult;
}

async function visibleRun(ctx: EngineContext, user: Principal, run: string): Promise<StoredRecord<RunRecord> | null> {
  const stored = await runById(ctx.deps.records.store, run);
  return stored !== null && canSeeRun(user, stored.body) ? stored : null;
}

export async function getRun(ctx: EngineContext, user: Principal, run: string): Promise<RunDetail | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  const results = await resultsOf(store, run);
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
      errors: action===null&&result===undefined ? [{code:'check_error',message:'未校验（中断）',fix:'Hub 将自动重验；也可带原会话原样重交'}] : hubError ? [{code: action?.body.error_code ?? 'check_error', message: '未校验（中断）', ...(typeof detail.fix === 'string' ? {fix: detail.fix} : {})}] : result?.body.errors ?? codes.map((code) => ({ code, message: Object.hasOwn(PROTOCOL_CODES, code) ? PROTOCOL_CODES[code as keyof typeof PROTOCOL_CODES].when : '' })),
      result: result !== undefined && result.body.acceptance === 'accepted' ? result.digest : null,
    });
  }
  const technicalLatest = await latestAccepted(store, run);
  const management=await abandonDecision(ctx,run);
  const managementResult=management?(await store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultSystemInput,value:'rec:'+management.digest,limit:1})).items[0]??null:null;
  const latest=management?managementResult:technicalLatest;
  const production = results.filter(result => result.body.submission === stored.digest&&result.body.system_input===undefined).at(-1);
  return { run: stored.body,submissions,...(management?{management:{record:management.digest,disposition:'abandon' as const,result:latest?.digest??null}}:{}), requests: await requestsOf(ctx,user,run), latest: latest === null ? null : { record: latest.digest, result: latest.body },
    production: production === undefined ? null : {record:production.digest,result:production.body} };
}

export async function listRuns(ctx: EngineContext, user: Principal, query: { pack?: string; limit?: number; cursor?: string | null } = {}): Promise<RunListing> {
  const filter = { ...(user.role === 'admin' ? {} : { user: user.id }), ...(query.pack !== undefined ? { pack: query.pack } : {}) };
  let page: Page<StoredRecord<RunRecord>>;
  try {
    page = await listRunRecords(ctx.deps.records.store, filter, { limit: query.limit, cursor: query.cursor ?? null });
  } catch (error) {
    // A cursor or limit the store refuses is the caller's mistake: the same empty page as nothing visible. Integrity and
    // other faults of the store (its RecordsError subclasses) are not.
    if (error instanceof TypeError || error instanceof RangeError || (error instanceof RecordsError && error.name === 'RecordsError')) return { items: [], next: null };
    throw error;
  }
  const items=page.items.map(r=>r.body).filter(r=>canSeeRun(user,r));
  let requests=(await requestsOf(ctx,user)).filter(r=>r.answered_by===null);
  if(query.pack){const matches=[] as typeof requests;for(const request of requests){const linked=request.run?await runById(ctx.deps.records.store,request.run):null;const pack=linked?.body.pack??(request.pack_digest?(await ctx.deps.workflows.byDigest(request.pack_digest))?.pack.id:null);if(pack?.split('@')[0]===query.pack)matches.push(request);}requests=matches;}
  const overdue_requests=requests.filter(request=>Date.parse(request.due)<=ctx.now().getTime());
  const open_runs:string[]=[];
  for(const run of items){const superseded=await hasSuccessor(ctx,run);if((superseded||await abandonDecision(ctx,run.run))&&!requests.some(r=>r.run===run.run))continue;const latest=await latestAccepted(ctx.deps.records.store,run.run);if(!latest||requests.some(r=>r.run===run.run)||latest.body.partitions.incomplete.length||latest.body.partitions.quarantined.length||latest.body.errors.some(e=>(e.rounds_left??0)>0))open_runs.push(run.run);}
  return {items,next:page.next,...(overdue_requests.length?{overdue_requests}:{}),...(requests.length?{requests}:{}),...(open_runs.length?{open_runs}:{})};
}

/** One validation result of a run: of a submission by its digest as received, or the latest accepted one. */
export async function getResult(ctx: EngineContext, user: Principal, run: string, submission?: string): Promise<StoredResult | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  const management=submission===undefined?await abandonDecision(ctx,run):null;
  const found = management ? (await store.find<ValidationResult>({kind:'validation_result',key:INDEX.resultSystemInput,value:'rec:'+management.digest,limit:1})).items[0]??null : submission===undefined?await latestAccepted(store,run):await resultFor(store,run,submission);
  return found === null ? null : { record: found.digest, result: found.body };
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
