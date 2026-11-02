import { createDocumentCache } from '../../refs/api.ts';
import {withQueryReads} from './query-scope.ts';
import {requestReadable} from './grounds.ts';
import { abandonRun } from './management.ts';
import { maintainRuns } from './maintenance.ts';
import { requestsOf } from './requests.ts';
// createRunsService: the RunsService of hub/ports.ts plus the engine's extras (results, runs of a pack, the production result
// of a start, Hub-side runs for standing obligations). Every call that carries a CallContext reports the real reasons behind
// its answers to that call's admin note (CallContext.adminNote) as well as to the process-wide adminLog.
import type { Page, Principal } from '../../records/api.ts';
import type { CallContext, RunDetail, RunsService } from '../../ports.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { createEngineContext, type EngineContext, type RunsEngineDeps } from './deps.ts';
import { unavailableError } from './errors.ts';
import { previewReference, type ResolveAnswer } from './preview.ts';
import { getResult, getRun, getRunSummary, listRuns, runsFor, resultState, type StoredResult } from './queries.ts';
import { refused, startRun, type StartRunAnswer, type StartRunDetail } from './start.ts';
import { backfillCitations } from './store.ts';
import { submitResult, type SubmitAnswer } from './submit.ts';
import { wellFormed } from './util.ts';

/** Longest single message one call's admin note takes from the engine, in code points (the server clips the joined note again). */
export const MAX_NOTE_MESSAGE = 1000;

function clipped(text: string): string {
  const points = [...text];
  return points.length <= MAX_NOTE_MESSAGE ? text : `${points.slice(0, MAX_NOTE_MESSAGE - 1).join('')}…`;
}

/**
 * The engine context of one call: what it logs also goes to the call's admin note, as `<what>: <detail>`, so that a reason
 * reaches the call it belongs to even when two calls share a trace id. A note that cannot be kept never changes an answer.
 */
function forCall(ctx: EngineContext, call: CallContext|undefined): EngineContext {
  const scoped={...ctx,documents:createDocumentCache(32)};
  const note = call?.adminNote;
  if (typeof note !== 'function') return scoped;
  return {
    ...scoped,
    log: (entry) => {
      ctx.log(entry);
      try {
        note(clipped(`${wellFormed(entry.what)}: ${wellFormed(entry.detail)}`));
      } catch {
        // The admin note must never change an answer.
      }
    },
  };
}

/** Parsed sources can be much larger than their immutable bytes. A service instance must never own them across calls. */
async function withDocuments<T>(ctx:EngineContext,call:CallContext|undefined,operation:(scoped:EngineContext)=>Promise<T>):Promise<T>{
  const scoped=forCall(ctx,call);
  try{return await operation(scoped);}finally{scoped.documents.dispose?.();}
}

export interface RunsEngine extends RunsService {
  maintain():Promise<void>;
  startMaintenance():Promise<void>;
  stopMaintenance():Promise<void>;
  /** For a run whose requirements are all facts the answer carries `result`: the reference and counts of the result computed at once. */
  startRun(user: Principal, input: Parameters<RunsService['startRun']>[1], context: CallContext): Promise<StartRunAnswer>;
  submitResult(user: Principal, args: Record<string, unknown>, context: CallContext): Promise<SubmitAnswer>;
  resolveReference(user: Principal, input: Parameters<RunsService['resolveReference']>[1], context: CallContext): Promise<ResolveAnswer>;
  /**
   * start_run with what the text of the answer can use: the whole production result, the run record digest, the expected
   * sources that could not be bound and what the expected-sources function reported (its failure included).
   */
  startRunDetailed(user: Principal, input: Parameters<RunsService['startRun']>[1], context: CallContext): Promise<StartRunDetail>;
  /**
   * A run the Hub executes for a standing obligation (execution host hub, trigger standing_obligation): only packs whose
   * requirements are all facts (W09 R[3]); `configurer` is the admin who configured it and must be assigned the pack (W09 R[1]).
   */
  startHubRun(configurer: Principal, input: Parameters<RunsService['startRun']>[1], context: CallContext): Promise<StartRunDetail>;
  /** One result of a run: by the digest of the submission as received, or the latest accepted one. */
  getResult(user: Principal, run: string, submission?: string): Promise<StoredResult | null>;
  /** The runs of one pack the user may see, newest first. */
  runsFor(user: Principal, pack: string, query?: { limit?: number; cursor?: string | null }): Promise<Page<RunRecord>>;
}

export function createRunsService(deps: RunsEngineDeps): RunsEngine {
  const ctx = createEngineContext(deps);
  // Only an operation-owned context may retain parsed inputs, including in future service methods.
  ctx.documents.dispose?.();
  let ongoing:Promise<void>|null=null;
  let timer:ReturnType<typeof setInterval>|null=null;
  const maintain=():Promise<void>=>ongoing??=(withDocuments(ctx,undefined,current=>maintainRuns(current)).finally(()=>{ongoing=null;}));
  // Submissions stored before citations were indexed get their index in the background: a pass at the start and at every
  // tick until one reaches its end (backfillCitations). Stopping aborts the pass under way; the next one resumes it.
  let indexing:Promise<void>|null=null;
  let indexed=false;
  let stopIndexing=new AbortController();
  const indexCitations=():Promise<void>=>indexing??=(backfillCitations(ctx.deps.records.store,{signal:stopIndexing.signal})
    .then(outcome=>{indexed=outcome.complete;if(outcome.indexed>0)ctx.log({traceId:null,run:null,what:'citation index',detail:`indexed the citations of ${outcome.indexed} submissions stored before citations were indexed (${outcome.examined} examined)`});})
    .catch((error:unknown)=>{if(!stopIndexing.signal.aborted)ctx.log({traceId:null,run:null,what:'citation index',detail:String(error)});})
    .finally(()=>{indexing=null;}));
  return {
    abandonRun(user,run,request,reason){return abandonRun(ctx,user,run,request,reason);},
    maintain,
    async startMaintenance(){
      await maintain();
      if(stopIndexing.signal.aborted)stopIndexing=new AbortController();
      void indexCitations();
      timer??=setInterval(()=>{void maintain().catch(error=>ctx.log({traceId:null,run:null,what:'run maintenance',detail:String(error)}));if(!indexed)void indexCitations();},60000);
      timer.unref();
    },
    async stopMaintenance(){if(timer){clearInterval(timer);timer=null;}stopIndexing.abort();await indexing;await ongoing;},
    listRequests(user,run) { return withQueryReads(ctx,current=>requestsOf(current,user,run)); },
    async startRun(user, input, context) {
      return withDocuments(ctx,context,async current=>(await startRun(current,user,input,context,{host:'local_circle'})).answer);
    },
    startRunDetailed(user, input, context) {
      return withDocuments(ctx,context,current=>startRun(current,user,input,context,{host:'local_circle'}));
    },
    async startHubRun(configurer, input, context) {
      if (configurer.role !== 'admin') return refused([unavailableError('/pack')]);
      return withDocuments(ctx,context,current=>startRun(current,configurer,input,context,{host:'hub'}));
    },
    submitResult(user, args, context) {
      return withDocuments(ctx,context,current=>submitResult(current,user,args,context));
    },
    resolveReference(user, input, context) {
      return withDocuments(ctx,context,current=>previewReference(current,user,input,context));
    },
    getRun(user, run): Promise<RunDetail | null> {
      return withQueryReads(ctx,current=>getRun(current, user, run));
    },
    getRunSummary(user,run){return withQueryReads(ctx,current=>getRunSummary(current,user,run));},
    resultState(user,result){return withDocuments(ctx,undefined,current=>resultState(current,user,result));},
    requestReadable(user,request){return withDocuments(ctx,undefined,current=>requestReadable(current,user,request));},
    listRuns(user, query) {
      return withQueryReads(ctx,current=>listRuns(current, user, query));
    },
    getResult(user, run, submission) {
      return withQueryReads(ctx,current=>getResult(current, user, run, submission));
    },
    runsFor(user, pack, query) {
      return withQueryReads(ctx,current=>runsFor(current, user, pack, query));
    },
  };
}
