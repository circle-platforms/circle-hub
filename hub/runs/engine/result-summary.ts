// The summary record of a validation result (model 43, W08 R[6], decision 153; issue 200). A list of tasks needs a few
// facts of each task's current result: whether it was accepted, what it comes to, which grounds it names. Reading the
// whole result for them cost a megabyte or more a row. The summary is those facts, projected from the result where the
// result is stored, as a record of its own: verified like any record when it is read, and never the authority over the
// result. A result without a summary is read whole and gives the same facts, so nothing depends on the summaries being
// complete.
import { ResultSummaryBody } from '../../../contracts/src/result-summary.ts';
import type { ValidationResult } from '../../../contracts/src/validation.ts';
import { verifiedBodyDigest, type RecordStore, type StoredRecord, type Transaction } from '../../records/api.ts';
import { step } from '../../telemetry/api.ts';
import { resultStatistics } from '../statistics.ts';
import { boundOf, groundsOf } from './ground-extraction.ts';
import { INDEX, SCHEMAS, putResult } from './store.ts';

export type ResultSummary = ResultSummaryBody;
const STORED = '1';

/**
 * Whether a stored summary has the summary's shape depends on its content alone, and the digest the store verified it
 * under stands for that content. A page of waiting requests asked for the summary of the same result once a request, and
 * checked its hundred-odd grounds against the reference grammar each time. The check is kept by the record's digest; the
 * record is still read and verified on every call.
 */
const SHAPED_LIMIT = 4096;
const shaped = new Map<string, true>();
function hasSummaryShape(record: StoredRecord<unknown>): boolean {
  const digest = verifiedBodyDigest(record.body) === record.digest ? record.digest : undefined;
  if (digest !== undefined && shaped.has(digest)) { shaped.delete(digest); shaped.set(digest, true); return true; }
  if (!ResultSummaryBody.safeParse(record.body).success) return false;
  if (digest !== undefined) { shaped.set(digest, true); if (shaped.size > SHAPED_LIMIT) shaped.delete(shaped.keys().next().value!); }
  return true;
}

/** The summary of a result: a function of the result and its digest alone. */
export function summarize(result: ValidationResult, digest: string): ResultSummary {
  return {
    run: result.run,
    result: digest,
    submission: result.submission,
    acceptance: result.acceptance,
    system_input: result.system_input !== undefined,
    statistics: resultStatistics(result),
    grounds: groundsOf(result),
    bound: boundOf(result),
    unavailable_references: [...(result.unavailable_references ?? [])],
  };
}

async function putSummary(store: RecordStore, result: StoredRecord<ValidationResult>, tx?: Transaction): Promise<void> {
  const body = ResultSummaryBody.parse(summarize(result.body, result.digest));
  await step('append-record', () => store.put<ResultSummary>({ kind: 'result_summary', schema: SCHEMAS.summary, provenance: 'projected', body, created_at: result.created_at, index: [{ key: INDEX.summaryResult, value: result.digest }] }, tx));
}

/** Stores a result and, in the same transaction, its summary record. */
export async function saveResult(store: RecordStore, result: ValidationResult, createdAt: string, tx?: Transaction): Promise<StoredRecord<ValidationResult>> {
  const write = async (t: Transaction): Promise<StoredRecord<ValidationResult>> => {
    const stored = await putResult(store, result, createdAt, t, [{ key: INDEX.resultSummarized, value: STORED }]);
    await putSummary(store, stored, t);
    return stored;
  };
  return tx === undefined ? store.withTransaction(write) : write(tx);
}

/** The summary record of the result `digest` of `run`, read and verified as a record; null when it has none that names this result and run. */
export async function storedSummaryOf(store: RecordStore, run: string, digest: string): Promise<ResultSummary | null> {
  // The oldest summary of a result is the one stored with it: a record appended later cannot take its place.
  const found = (await store.find<unknown>({ kind: 'result_summary', key: INDEX.summaryResult, value: digest, limit: 1 })).items[0];
  if (found === undefined || found.schema !== SCHEMAS.summary || !hasSummaryShape(found)) return null;
  const body = found.body as ResultSummary;
  return body.result === digest && body.run === run ? body : null;
}

/** The same facts from the result itself, read whole: for a result with no summary. Null when it is not this run's or is gone. */
export async function summarizeStored(store: RecordStore, run: string, digest: string): Promise<ResultSummary | null> {
  const record = await store.get<ValidationResult>(digest);
  return record?.kind === 'validation_result' && record.schema === SCHEMAS.result && record.body.run === run ? summarize(record.body, digest) : null;
}

/**
 * The summary of the result `digest` of `run`: its summary record when it has one, otherwise the same facts from the result
 * itself. `whole` reads a result that has no summary; a caller that lists many tasks gives one that reads apart from its
 * own scope, so that a megabyte read for one row is released before the next.
 */
export async function resultSummaryOf(store: RecordStore, run: string, digest: string, whole: (run: string, digest: string) => Promise<ResultSummary | null> = (id, result) => summarizeStored(store, id, result)): Promise<ResultSummary | null> {
  return await storedSummaryOf(store, run, digest) ?? whole(run, digest);
}
