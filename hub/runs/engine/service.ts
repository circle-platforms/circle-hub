import { createDocumentCache } from '../../refs/api.ts';
import { withRequestPermissions } from '../../records/api.ts';
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
import { getResult, getRun, listRuns, runsFor, type StoredResult } from './queries.ts';
import { refused, startRun, type StartRunAnswer, type StartRunDetail } from './start.ts';
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
async function withDocuments<T>(ctx:EngineContext,call:CallContext|undefined,operation:(scoped:EngineContext)=>Promise<T>,principal?:Principal):Promise<T>{
  const scoped=forCall(ctx,call);
  try{return principal ? await withRequestPermissions(scoped.deps.records.artifacts,principal,()=>operation(scoped)) : await operation(scoped);}finally{scoped.documents.dispose?.();}
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
  return {
    abandonRun(user,run,request,reason){return abandonRun(ctx,user,run,request,reason);},
    maintain,
    async startMaintenance(){
      await maintain();
      timer??=setInterval(()=>{void maintain().catch(error=>ctx.log({traceId:null,run:null,what:'run maintenance',detail:String(error)}));},60000);
      timer.unref();
    },
    async stopMaintenance(){if(timer){clearInterval(timer);timer=null;}await ongoing;},
    listRequests(user,run) { return withRequestPermissions(ctx.deps.records.artifacts,user,()=>requestsOf(ctx,user,run)); },
    async startRun(user, input, context) {
      return withDocuments(ctx,context,async current=>(await startRun(current,user,input,context,{host:'local_circle'})).answer,user);
    },
    startRunDetailed(user, input, context) {
      return withDocuments(ctx,context,current=>startRun(current,user,input,context,{host:'local_circle'}),user);
    },
    async startHubRun(configurer, input, context) {
      if (configurer.role !== 'admin') return refused([unavailableError('/pack')]);
      return withDocuments(ctx,context,current=>startRun(current,configurer,input,context,{host:'hub'}),configurer);
    },
    submitResult(user, args, context) {
      return withDocuments(ctx,context,current=>submitResult(current,user,args,context),user);
    },
    resolveReference(user, input, context) {
      return withDocuments(ctx,context,current=>previewReference(current,user,input,context),user);
    },
    getRun(user, run): Promise<RunDetail | null> {
      return withRequestPermissions(ctx.deps.records.artifacts,user,()=>getRun(ctx, user, run));
    },
    listRuns(user, query) {
      return withRequestPermissions(ctx.deps.records.artifacts,user,()=>listRuns(ctx, user, query));
    },
    getResult(user, run, submission) {
      return withRequestPermissions(ctx.deps.records.artifacts,user,()=>getResult(ctx, user, run, submission));
    },
    runsFor(user, pack, query) {
      return withRequestPermissions(ctx.deps.records.artifacts,user,()=>runsFor(ctx, user, pack, query));
    },
  };
}
