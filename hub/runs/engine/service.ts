// createRunsService: the RunsService of hub/ports.ts plus the engine's extras (results, runs of a pack, the production result
// of a start, Hub-side runs for standing obligations).
import type { Page, Principal } from '../../records/api.ts';
import type { CallContext, RunDetail, RunsService } from '../../ports.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import { createEngineContext, type RunsEngineDeps } from './deps.ts';
import { unavailableError } from './errors.ts';
import { previewReference, type ResolveAnswer } from './preview.ts';
import { getResult, getRun, listRuns, runsFor, type StoredResult } from './queries.ts';
import { startRun, type StartRunAnswer, type StartRunDetail } from './start.ts';
import { submitResult, type SubmitAnswer } from './submit.ts';

export interface RunsEngine extends RunsService {
  startRun(user: Principal, input: Parameters<RunsService['startRun']>[1], context: CallContext): Promise<StartRunAnswer>;
  submitResult(user: Principal, args: Record<string, unknown>, context: CallContext): Promise<SubmitAnswer>;
  resolveReference(user: Principal, input: Parameters<RunsService['resolveReference']>[1], context: CallContext): Promise<ResolveAnswer>;
  /** start_run with, for a run whose requirements are all facts, the validation result the Hub computed at once. */
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
    async startRun(user, input, context) {
      return (await startRun(ctx, user, input, context, { host: 'local_circle' })).answer;
    },
    startRunDetailed(user, input, context) {
      return startRun(ctx, user, input, context, { host: 'local_circle' });
    },
    async startHubRun(configurer, input, context) {
      if (configurer.role !== 'admin') return { answer: { call_result: 'error', errors: [unavailableError('/pack')] }, production: null };
      return startRun(ctx, configurer, input, context, { host: 'hub' });
    },
    submitResult(user, args, context) {
      return submitResult(ctx, user, args, context);
    },
    resolveReference(user, input, context) {
      return previewReference(ctx, user, input, context);
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
