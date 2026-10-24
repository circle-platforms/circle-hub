// Queries for the server and the console (R02): a user sees their own runs, an admin every run, a Hub-side run only an
// admin; absent and forbidden give the same null or the same empty page. Phase and counts are derived, never stored.
import { PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { Submission } from '../../../contracts/src/submission.ts';
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { RecordsError, type Page, type Principal, type StoredRecord } from '../../records/api.ts';
import type { RunDetail, RunSubmissionView } from '../../ports.ts';
import type { EngineContext } from './deps.ts';
import { canSeeRun, canViewRun } from './readers.ts';
import { actionOfSubmission, isVerbatimObject, latestAccepted, listRunRecords, resultFor, resultsOf, runById, submissionsOf } from './store.ts';
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
  const items = following.slice(0,limit);
  const last = items.at(-1);
  const next = following.length > limit && last ? Buffer.from(JSON.stringify({reader:user.id,pack,at:last.started_at,id:last.run})).toString('base64url') : null;
  return { items, next };
}

/** One validation result of a run: of a submission by its digest as received, or the latest accepted one. */
export async function getResult(ctx: EngineContext, user: Principal, run: string, submission?: string): Promise<StoredResult | null> {
  const stored = await visibleRun(ctx, user, run);
  if (stored === null) return null;
  const store = ctx.deps.records.store;
  const found = submission === undefined ? await latestAccepted(store, run) : await resultFor(store, run, submission);
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
