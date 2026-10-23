// Queries for the server and the console (R02): a user sees their own runs, an admin every run, a Hub-side run only an
// admin; absent and forbidden give the same null or the same empty page. Phase and counts are derived, never stored.
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { RecordsError, type Page, type Principal, type StoredRecord } from '../../records/api.ts';
import type { RunDetail, RunSubmissionView } from '../../ports.ts';
import type { EngineContext } from './deps.ts';
import { canSeeRun } from './readers.ts';
import { actionOfSubmission, isVerbatimObject, latestAccepted, listRunRecords, resultFor, resultsOf, runById, submissionsOf } from './store.ts';
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
  const byDigest = new Map(results.map((r) => [r.body.submission, r]));
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
      acceptance: hubError ? null : result?.body.acceptance ?? action?.body.acceptance ?? 'not_accepted',
      errors: hubError ? [{code: action?.body.error_code ?? 'check_error', message: '未校验（Hub 来源读取失败）', ...(typeof detail.fix === 'string' ? {fix: detail.fix} : {})}] : result?.body.errors ?? codes.map((code) => ({ code, message: Object.hasOwn(PROTOCOL_CODES, code) ? PROTOCOL_CODES[code as keyof typeof PROTOCOL_CODES].when : '' })),
      result: result !== undefined && result.body.acceptance === 'accepted' ? result.digest : null,
    });
  }
  const latest = await latestAccepted(store, run);
  const production = results.find(result => result.body.submission === stored.digest);
  return { run: stored.body, submissions, latest: latest === null ? null : { record: latest.digest, result: latest.body },
    production: production === undefined ? null : {record:production.digest,result:production.body} };
}

export async function listRuns(ctx: EngineContext, user: Principal, query: { pack?: string; limit?: number; cursor?: string | null } = {}): Promise<Page<RunRecord>> {
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
  return { items: page.items.map((r) => r.body).filter((r) => canSeeRun(user, r)), next: page.next };
}

/** One validation result of a run: of a submission by its digest as received, or the latest accepted one. */
export async function getResult(ctx: EngineContext, user: Principal, run: string, submission?: string): Promise<StoredResult | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  const found = submission === undefined ? await latestAccepted(store, run) : await resultFor(store, run, submission);
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
