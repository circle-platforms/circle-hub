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
function forCall(ctx: EngineContext, call: CallContext): EngineContext {
  const note = call?.adminNote;
  if (typeof note !== 'function') return ctx;
  return {
    ...ctx,
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

export interface RunsEngine extends RunsService {
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
  return {
    listRequests(user,run) { return requestsOf(ctx,user,run); },
    async startRun(user, input, context) {
      return (await startRun(forCall(ctx, context), user, input, context, { host: 'local_circle' })).answer;
    },
    startRunDetailed(user, input, context) {
      return startRun(forCall(ctx, context), user, input, context, { host: 'local_circle' });
    },
    async startHubRun(configurer, input, context) {
      if (configurer.role !== 'admin') return refused([unavailableError('/pack')]);
      return startRun(forCall(ctx, context), configurer, input, context, { host: 'hub' });
    },
    submitResult(user, args, context) {
      return submitResult(forCall(ctx, context), user, args, context);
    },
    resolveReference(user, input, context) {
      return previewReference(forCall(ctx, context), user, input, context);
    },
    getRun(user, run): Promise<RunDetail | null> {
      return getRun(ctx, user, run);
    },
    listRuns(user, query) {
      return listRuns(ctx, user, query);
    },
    getResult(user, run, submission) {
      return getResult(ctx, user, run, submission);
    },
    runsFor(user, pack, query) {
      return runsFor(ctx, user, pack, query);
    },
  };
}
